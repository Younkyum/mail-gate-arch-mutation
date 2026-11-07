/**
 * `pnpm log:verify <bundle.json | inclusion.json> [--key <vkey> | --key-file <path>] [--anchor-key <base64 SPKI>]… [--rekor-key <vkey>]… [--origin <origin>]
 *                  [--state-dir <dir>] [--accept-new-log] [--json]`
 *
 * 콘솔 "무결성 → 검증 번들 내려받기" 로 받은 번들을 **Atmark 코드 없이** 검증한다(ADR-0008 §2.6). 본체는
 * `scripts/tlog-verify/verifier.ts`(`src/**` import 0 — arch 테스트).
 *
 *   --key / --key-file  체크포인트 키(vkey)를 **고정**한다. 채널: ADR-0008 본문 · DNS TXT `_tlog.id.atmark.ai` · `https://id.atmark.ai/log/key`
 *                       · Rekor 첫 항목(Q10 — 넷을 대조하라). 없으면 번들의 키를 쓰고 경고한다.
 *   --anchor-key        Rekor 앵커 키(P-256 SPKI DER base64)를 고정한다 — ADR-0008 §9 기록 · DNS TXT `_tlog-anchor.id.atmark.ai`(런북 §4).
 *                       없으면 번들이 준 앵커 키를 쓰고 경고한다.
 *   --rekor-key         Rekor v2 샤드의 체크포인트 키(C2SP vkey) — Sigstore trusted root(런북 §5). 없으면 Rekor 체크포인트 서명을 확인하지
 *                       못했다고 보고한다.
 *   --origin            로그 origin(기본 `id.atmark.ai/log/v1`).
 *   --state-dir         지난번 검증에서 본 체크포인트·조직 헤드(`<dir>/origin-<sha256(origin) 앞 32자>.json`, 기본 `~/.atmark-log`). 새 번들이
 *                       그것과 **이어져야** 통과한다(범위 밖이면 `&since=<저장한 에폭>` 으로 내려받은 번들의 link 증명) — 통과하면 앞으로만
 *                       갱신한다. 소유자가 곧 자기 조직의 증인이다. 파일은 **origin 으로** 고른다 — 번들이 대는 조직 로그 id 로 고르면 새 id
 *                       하나로 저장 상태(전역 체크포인트 연결 포함)를 통째로 건너뛴다(적대적 검증 M1). 조직 로그 id 는 첫 통과 때 고정된다.
 *   --accept-new-log    저장한 조직 로그 id 와 다른 번들을 받는다(조직을 정말 바꿨을 때만). 전역 체크포인트 연결은 그대로 본다.
 *                       여러 조직을 검증하면 조직마다 --state-dir 를 따로 둬라.
 * 포함 증명 한 건(콘솔 로그 상세 "포함 증명 내려받기" — `format: atmark-tlog-inclusion/v1`)도 받는다: 서명된 체크포인트(고정한 --key) →
 * 전역 잎 → 조직 헤드 → 잎 포함을 본다(`verifyInclusionProof`). 저장 상태는 읽지도 쓰지도 않는다(--state-dir 무시).
 * 신원 블록 파일(콘솔 신원 탭 "내려받기" — `format: atmark-identity-blocks/v1`, US-013)도 받는다: 잎 해시와 블록 체인(SHA-256(이전 ‖ 잎))을
 * 다시 계산하고, 모든 잎이 한 조직 로그의 것인지 본다(`verifyIdentityBlocks`). **`--key` 로 고정한 체크포인트로 파일의 공통 닻을 열고 블록마다
 * 포함 증명이 맞을 때만 0**이다. 체인만 맞으면(증명 없음 · 키 고정 안 함 · 체크포인트 전 블록) 또는 앞이 잘린 파일이면 **3**("일관성만,
 * 증명 아님" — 적대적 검증 M4).
 * 종료 코드: 0 통과 · 1 검증 실패(모양이 틀린 번들 포함) · 2 사용법/파일 오류 · 3 신원 블록 일관성만(증명 아님)·잘림.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_ORIGIN,
  IDENTITY_BLOCKS_FORMAT,
  INCLUSION_FORMAT,
  verifyBundle,
  verifyIdentityBlocks,
  verifyInclusionProof,
  type SavedState,
  type VerifyReport,
} from './tlog-verify/verifier';

interface Args {
  readonly bundle: string;
  readonly key?: string;
  readonly anchorKeys: readonly string[];
  readonly rekorKeys: readonly string[];
  readonly origin?: string;
  readonly stateDir: string;
  readonly acceptNewLog: boolean;
  readonly json: boolean;
}

/** 저장 상태 파일 — origin 하나에 하나(번들이 대는 값으로 고르지 않는다). */
export function statePathFor(stateDir: string, origin: string): string {
  return join(stateDir, `origin-${createHash('sha256').update(origin, 'utf8').digest('hex').slice(0, 32)}.json`);
}

function parseArgs(argv: readonly string[]): Args {
  let bundle: string | undefined;
  let key: string | undefined;
  let origin: string | undefined;
  const anchorKeys: string[] = [];
  const rekorKeys: string[] = [];
  let stateDir = join(homedir(), '.atmark-log');
  let json = false;
  let acceptNewLog = false;
  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 에 값이 없다`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--key') key = value(++i, arg);
    else if (arg === '--key-file') key = readFileSync(value(++i, arg), 'utf8').trim();
    else if (arg === '--anchor-key') anchorKeys.push(value(++i, arg));
    else if (arg === '--rekor-key') rekorKeys.push(value(++i, arg));
    else if (arg === '--origin') origin = value(++i, arg);
    else if (arg === '--state-dir') stateDir = argv[++i] ?? stateDir;
    else if (arg === '--json') json = true;
    else if (arg === '--accept-new-log') acceptNewLog = true;
    else if (!arg.startsWith('--') && bundle === undefined) bundle = arg;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (bundle === undefined) throw new Error('번들 파일 경로가 필요하다');
  return { bundle, ...(key === undefined ? {} : { key }), ...(origin === undefined ? {} : { origin }), anchorKeys, rekorKeys, stateDir, acceptNewLog, json };
}

export function runCli(argv: readonly string[], out: (line: string) => void = console.log): number {
  let args: Args;
  let parsed: unknown;
  try {
    args = parseArgs(argv);
    parsed = JSON.parse(readFileSync(args.bundle, 'utf8'));
  } catch (error) {
    out(`사용법: pnpm log:verify <bundle.json> [--key <vkey>] [--state-dir <dir>] [--accept-new-log] [--json] — ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if ((parsed as { format?: unknown } | null)?.format === INCLUSION_FORMAT) {
    const inclusion = verifyInclusionProof(parsed, {
      ...(args.key === undefined ? {} : { pinnedVkey: args.key }),
      ...(args.origin === undefined ? {} : { origin: args.origin }),
    });
    printReport(out, inclusion, args.json, '포함 증명');
    return inclusion.ok ? 0 : 1;
  }
  if ((parsed as { format?: unknown } | null)?.format === IDENTITY_BLOCKS_FORMAT) {
    const blocks = verifyIdentityBlocks(parsed, {
      ...(args.key === undefined ? {} : { pinnedVkey: args.key }),
      ...(args.origin === undefined ? {} : { origin: args.origin }),
    });
    printReport(out, blocks, args.json, '신원 블록');
    if (blocks.errors.length > 0) return 1;
    return blocks.ok ? 0 : 3;
  }
  const statePath = statePathFor(args.stateDir, args.origin ?? DEFAULT_ORIGIN);
  let previous: SavedState | null;
  try {
    previous = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as SavedState) : null;
  } catch (error) {
    out(`상태 파일을 읽지 못했다(${statePath}) — ${error instanceof Error ? error.message : String(error)}. 파일을 고치거나 옮긴 뒤 다시 돌려라.`);
    return 2;
  }
  let report: VerifyReport;
  try {
    report = verifyBundle(parsed, {
      ...(args.key === undefined ? {} : { pinnedVkey: args.key }),
      ...(args.origin === undefined ? {} : { origin: args.origin }),
      ...(args.anchorKeys.length === 0 ? {} : { anchorKeys: args.anchorKeys }),
      ...(args.rekorKeys.length === 0 ? {} : { rekorVkeys: args.rekorKeys }),
      previous,
      acceptNewLog: args.acceptNewLog,
    });
  } catch (error) {
    // 검증기는 모양이 틀린 번들로 던지지 않게 쓰였다 — 그래도 던지면 스택 대신 실패(1)로 끝낸다.
    out(`✗ 번들 검증 실패 — ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return 1;
  }
  // 상태는 **통과했을 때만**, 앞으로만 쓴다(검증기가 저장한 것보다 뒤의 범위면 그대로 돌려준다).
  if (report.ok && report.state !== null) {
    mkdirSync(args.stateDir, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(report.state, null, 2)}\n`);
  }
  printReport(out, report, args.json, '번들');
  return report.ok ? 0 : 1;
}

function printReport(out: (line: string) => void, result: VerifyReport, json: boolean, what: string): void {
  if (json) {
    const assurance = result.assurance === undefined ? {} : { assurance: result.assurance };
    out(JSON.stringify({ ok: result.ok, ...assurance, errors: result.errors, warnings: result.warnings, stats: result.stats, anchors: result.anchors }, null, 2));
    return;
  }
  if (result.errors.length === 0 && result.assurance === 'consistency_only') out(`△ ${what} — 일관성만, 증명 아님(consistency_only)`);
  else if (result.errors.length === 0 && result.assurance === 'truncated') out(`△ ${what} — 앞 블록이 잘렸다(truncated) · 일관성만, 증명 아님`);
  else out(result.ok ? `✓ ${what} 검증 통과` : `✗ ${what} 검증 실패 — 오류 ${String(result.errors.length)}건`);
  for (const issue of result.errors) out(`  ✗ ${issue.code}: ${issue.detail}`);
  for (const warning of result.warnings) out(`  ! ${warning}`);
  for (const anchor of result.anchors) out(`  · ${anchor}`);
  out(`  (${Object.entries(result.stats).map(([key, value]) => `${key}=${String(value)}`).join(' ')})`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
