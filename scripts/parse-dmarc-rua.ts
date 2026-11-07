#!/usr/bin/env tsx
/**
 * parse-dmarc-rua.ts — AC-c6 (계획 §3.3 "DMARC 램프", "모니터링 지표")
 *
 * ── 이 스크립트가 왜 P0에 있는가 ──────────────────────────────────────
 * r2는 DMARC pass rate를 "rua 리포트 파싱"으로 얻는다고 썼으나 **파서 파일이
 * 계획 전체에 없었다.** 그 지표가 D+15/31/45 램프 전환을 게이팅하고 그 날짜들은
 * P0–P1 구간이므로, 의존 지표의 생산자가 없는 상태로 일정이 진행되도록 적혀 있었다.
 * 이 파일이 그 생산자다.
 *
 * ── 램프 전환 조건 (계획 §3.3, 기준일 = sending_started_at = 최초 발송 성공일) ──
 *   D+0–14   p=none                          무조건
 *   D+15–30  p=quarantine; pct=25            직전 7일 발송 ≥ 50통  AND pass ≥ 98%
 *   D+31–44  p=quarantine; pct=100           직전 7일 발송 ≥ 150통 AND pass ≥ 99%  AND 미확인 발신원 0건
 *   D+45+    p=reject; pct=100               직전 14일 발송 ≥ 400통 AND pass ≥ 99.5%
 *
 * ── 최소 표본 조건 (r3 정정 M7) — 이 스크립트가 반드시 구현해야 하는 이유 ──
 * r2는 "직전 7일 pass rate ≥ 98%"만 요구했는데, **발송 0건 구간에서는 분모가 0이라
 * 비율이 정의되지 않는다.** 램프가 영구 정지할지 공허하게 통과할지 계획이 말하지 않았다.
 * 100통 중 100통 pass와 2통 중 2통 pass는 같은 100%가 아니다 — 후자로 p=reject 로
 * 올리면 우리가 아직 보지 못한 발신원(포워더, 메일링리스트, 미등록 서드파티)이
 * 조용히 거부당하기 시작한다. 그러므로 **표본 미달은 통과가 아니라 정지(HOLD)** 이고,
 * 조건 미달(FAIL)과 사유를 구분해 출력한다.
 *
 * 입력: 인자로 받은 디렉터리 안의 *.xml / *.xml.gz / *.zip
 * 사용: pnpm parse:dmarc-rua <디렉터리> [--days 7]
 *
 * XML 파서 패키지 금지 — 리포트 스키마(RFC 7489 Appendix C)가 단순해 정규식으로 충분하다.
 * 외부 패키지 없이 node:fs / node:zlib / node:path 만 쓴다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

/** 램프 전환 조건표. 최소 표본이 곧 분모의 하한이다. */
const RAMP_STAGES = [
  { label: 'D+15 → p=quarantine; pct=25', windowDays: 7, minVolume: 50, minPassRate: 98.0, requireZeroUnknown: false },
  { label: 'D+31 → p=quarantine; pct=100', windowDays: 7, minVolume: 150, minPassRate: 99.0, requireZeroUnknown: true },
  { label: 'D+45 → p=reject; pct=100', windowDays: 14, minVolume: 400, minPassRate: 99.5, requireZeroUnknown: true },
] as const;

interface DmarcRecord {
  readonly sourceIp: string;
  readonly count: number;
  readonly dkim: string;
  readonly spf: string;
  readonly headerFrom: string;
}

interface DmarcReport {
  readonly file: string;
  readonly orgName: string;
  readonly reportId: string;
  readonly beginAt: Date | null;
  readonly endAt: Date | null;
  readonly records: readonly DmarcRecord[];
}

// ── 압축 해제 ────────────────────────────────────────────────────────────

/**
 * zip 최소 구현. DMARC 집계 리포트의 zip은 엔트리 1개 / method 0(stored) 또는
 * 8(deflate)가 전부다. EOCD → 중앙 디렉터리 → 로컬 헤더 순으로 읽는다.
 */
function unzipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: EOCD를 찾지 못했다');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('zip: 중앙 디렉터리 시그니처 불일치');
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: 로컬 헤더 시그니처 불일치');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`zip: 지원하지 않는 압축 방식 ${method} (${name})`);

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readReportXml(path: string): { name: string; xml: string }[] {
  const buf = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.gz') return [{ name: basename(path), xml: gunzipSync(buf).toString('utf8') }];
  if (ext === '.zip') return unzipEntries(buf).map((e) => ({ name: `${basename(path)}!${e.name}`, xml: e.data.toString('utf8') }));
  return [{ name: basename(path), xml: buf.toString('utf8') }];
}

// ── 파싱 (정규식) ────────────────────────────────────────────────────────

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m?.[1]?.trim() ?? null;
}

function epochToDate(value: string | null): Date | null {
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function parseReport(file: string, xml: string): DmarcReport {
  const metadata = tag(xml, 'report_metadata') ?? '';
  const dateRange = tag(metadata, 'date_range') ?? '';

  const records: DmarcRecord[] = [];
  const recordRe = /<record[^>]*>([\s\S]*?)<\/record>/gi;
  for (let m = recordRe.exec(xml); m !== null; m = recordRe.exec(xml)) {
    const body = m[1] ?? '';
    const row = tag(body, 'row') ?? body;
    // auth_results 안에도 <dkim>/<spf>가 있으므로 반드시 policy_evaluated 블록 안에서만 읽는다.
    const evaluated = tag(row, 'policy_evaluated') ?? '';
    const count = Number.parseInt(tag(row, 'count') ?? '0', 10);
    records.push({
      sourceIp: tag(row, 'source_ip') ?? '(unknown)',
      count: Number.isFinite(count) ? count : 0,
      dkim: (tag(evaluated, 'dkim') ?? 'fail').toLowerCase(),
      spf: (tag(evaluated, 'spf') ?? 'fail').toLowerCase(),
      headerFrom: tag(tag(body, 'identifiers') ?? '', 'header_from') ?? '(unknown)',
    });
  }

  return {
    file,
    orgName: tag(metadata, 'org_name') ?? '(unknown)',
    reportId: tag(metadata, 'report_id') ?? '(unknown)',
    beginAt: epochToDate(tag(dateRange, 'begin')),
    endAt: epochToDate(tag(dateRange, 'end')),
    records,
  };
}

// ── 집계 ─────────────────────────────────────────────────────────────────

/** DMARC는 DKIM 또는 SPF 중 하나만 정렬 통과해도 pass다 (RFC 7489 §6.6.2). */
function isPass(r: DmarcRecord): boolean {
  return r.dkim === 'pass' || r.spf === 'pass';
}

interface SourceStat {
  ip: string;
  total: number;
  pass: number;
  headerFroms: Set<string>;
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) ?? null;
  const daysIdx = args.indexOf('--days');
  const windowDays = daysIdx >= 0 ? Number.parseInt(args[daysIdx + 1] ?? '7', 10) : 7;

  if (dir === null) {
    console.error('사용법: pnpm parse:dmarc-rua <리포트 디렉터리> [--days 7]');
    console.error('  디렉터리 안의 *.xml / *.xml.gz / *.zip 을 모두 읽는다.');
    process.exitCode = 1;
    return;
  }

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.(xml|xml\.gz|gz|zip)$/i.test(f))
      .map((f) => join(dir, f))
      .sort();
  } catch (err: unknown) {
    console.error(`디렉터리를 읽지 못했다: ${dir} — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.error(`리포트 파일이 없다: ${dir}`);
    console.error('rua= 태그가 DMARC 레코드에 있는지 먼저 확인할 것 (pnpm check:dns ⑥).');
    process.exitCode = 1;
    return;
  }

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const reports: DmarcReport[] = [];
  const skipped: string[] = [];

  for (const path of files) {
    try {
      for (const { name, xml } of readReportXml(path)) {
        const report = parseReport(name, xml);
        if (report.endAt !== null && report.endAt < cutoff) {
          skipped.push(`${name} (기간 밖)`);
          continue;
        }
        reports.push(report);
      }
    } catch (err: unknown) {
      skipped.push(`${basename(path)} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const all = reports.flatMap((r) => r.records);
  const total = all.reduce((sum, r) => sum + r.count, 0);
  const passed = all.filter(isPass).reduce((sum, r) => sum + r.count, 0);
  const passRate = total > 0 ? (passed / total) * 100 : 0;

  const bySource = new Map<string, SourceStat>();
  for (const r of all) {
    const stat = bySource.get(r.sourceIp) ?? { ip: r.sourceIp, total: 0, pass: 0, headerFroms: new Set<string>() };
    stat.total += r.count;
    if (isPass(r)) stat.pass += r.count;
    stat.headerFroms.add(r.headerFrom);
    bySource.set(r.sourceIp, stat);
  }
  // "미확인 발신원" = 우리 이름으로 보냈는데 DMARC를 통과하지 못한 IP.
  // 우리가 아는 발신 경로(SES)는 전량 pass여야 하므로, fail이 남는 IP는 정의상 미확인이다.
  const unknownSources = [...bySource.values()].filter((s) => s.pass < s.total).sort((a, b) => b.total - a.total);

  console.log(`\nDMARC 집계 리포트 — 직전 ${windowDays}일 (AC-c6)\n`);
  console.log(`리포트 ${reports.length}건 / 파일 ${files.length}개${skipped.length > 0 ? ` (건너뜀 ${skipped.length}건)` : ''}`);
  for (const r of reports) {
    const begin = r.beginAt?.toISOString().slice(0, 10) ?? '?';
    const end = r.endAt?.toISOString().slice(0, 10) ?? '?';
    const volume = r.records.reduce((s, x) => s + x.count, 0);
    console.log(`  - ${r.orgName}  ${begin}~${end}  ${volume}통  [${r.file}]`);
  }
  for (const s of skipped) console.log(`  · 건너뜀: ${s}`);
  console.log('');

  console.log(`pass / total = ${passed} / ${total} = ${total > 0 ? passRate.toFixed(1) : '—'}%`);
  console.log('');

  console.log(`미확인 발신원 (DMARC fail이 남은 source_ip): ${unknownSources.length}건`);
  for (const s of unknownSources) {
    const froms = [...s.headerFroms].join(', ');
    console.log(`  ✗ ${s.ip}  fail ${s.total - s.pass}/${s.total}통  header_from=${froms}`);
  }
  if (unknownSources.length === 0) console.log('  (없음)');
  console.log('');

  console.log('램프 전환 판정 (계획 §3.3):');
  for (const stage of RAMP_STAGES) {
    const applicable = stage.windowDays === windowDays;
    if (!applicable) {
      console.log(`  ·  ${stage.label} — 판정 불가 (--days ${stage.windowDays} 로 다시 실행)`);
      continue;
    }
    if (total < stage.minVolume) {
      // 표본 부족은 통과가 아니라 대기다 (r3 M7). 조건 미달과 사유를 구분해 출력한다.
      console.log(`  ⏸ ${stage.label} — 정지: 표본 부족 (${total}/${stage.minVolume}통)`);
      continue;
    }
    const rateOk = passRate >= stage.minPassRate;
    const unknownOk = !stage.requireZeroUnknown || unknownSources.length === 0;
    if (rateOk && unknownOk) {
      console.log(`  ✓ ${stage.label} — 전환 가능`);
    } else {
      const reasons = [
        rateOk ? null : `pass rate ${passRate.toFixed(1)}% < ${stage.minPassRate}%`,
        unknownOk ? null : `미확인 발신원 ${unknownSources.length}건`,
      ].filter((v): v is string => v !== null);
      console.log(`  ✗ ${stage.label} — 정지: ${reasons.join(' / ')}`);
    }
  }
  console.log('');
  console.log('※ 램프는 조건 미달 시 멈춘다(되돌리지 않는다). 전환 결과는 일자·수치와 함께');
  console.log('   docs/runbooks/deliverability-warmup.md 에 기록한다.\n');

  process.exitCode = 0;
}

main();
