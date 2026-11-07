#!/usr/bin/env tsx
/**
 * check-dns.ts — AC-c1 (계획 §3.3 "Acceptance", §6 P0 "Demo")
 *
 * 계획이 요구하는 DNS 레코드 8건을 조회해 ✓/✗ 로 보고한다.
 *   ① MX · ② SPF TXT · ③④⑤ DKIM CNAME 3건 · ⑥ DMARC TXT · ⑦ id.atmark.ai CNAME · ⑧ CAA
 *
 * r4 정정 근거: r3는 선언 8건 / AC-c1 7건 / demo 6건으로 세 곳이 어긋나 있었고,
 * AC-c1에서 빠진 것이 하필 MX였다. 이 스크립트가 P0의 유일한 DNS 게이트이므로
 * 8건을 한 곳에서 센다.
 *
 * notify.atmark.ai 관련 레코드는 의도적으로 제외한다 — Q2(도입 시점)가 열려 있어 조건부다.
 *
 * 외부 패키지 금지: Node 내장 node:dns/promises 만 쓴다.
 * exit 0 = 8/8, exit 1 = 그 외.
 */

import { resolveMx, resolveTxt, resolveCname, resolveCaa } from 'node:dns/promises';

const DOMAIN = 'atmark.ai';
const ID_HOST = `id.${DOMAIN}`;
const DMARC_HOST = `_dmarc.${DOMAIN}`;

/** SES Easy DKIM (RSA-2048, ap-northeast-2) 발급 셀렉터 3건. 2026-09-22 Verified. */
const DKIM_SELECTORS = [
  'mbbtxzajg5mdwjmrbafecwpeofizzymq',
  'ubyaew6zpap26law3thlritpnnthrmpk',
  'oqo3ullaqifoofsoob2qfuu7cuucf2fz',
] as const;

/** ACM(CloudFront) 발급에 필요한 CAA issue 값. 하나라도 있으면 인증서 발급이 가능하다. */
const ACM_CAA_ISSUERS = ['amazon.com', 'amazontrust.com', 'awstrust.com', 'amazonaws.com'] as const;

interface CheckResult {
  readonly no: string;
  readonly name: string;
  readonly host: string;
  readonly ok: boolean;
  readonly actual: string;
  /** ✗일 때 무엇을 넣어야 하는지 한 줄. ✓일 때는 주의사항(있으면). */
  readonly note: string;
}

/** DNS 조회 실패(NXDOMAIN/ENODATA/SERVFAIL)를 null로 접는다. */
async function tryResolve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** TXT 레코드는 255바이트 청크로 쪼개져 오므로 이어 붙인다. */
function flattenTxt(records: readonly string[][] | null): string[] {
  if (records === null) return [];
  return records.map((chunks) => chunks.join(''));
}

async function checkMx(): Promise<CheckResult> {
  const records = await tryResolve(() => resolveMx(DOMAIN));
  const found = records !== null && records.length > 0;
  return {
    no: '①',
    name: 'MX',
    host: DOMAIN,
    ok: found,
    actual: found
      ? (records ?? []).map((r) => `${r.priority} ${r.exchange}`).join(', ')
      : '없음',
    note: found
      ? ''
      : 'P3(inbound 파이프라인)에서 inbound-smtp.ap-northeast-2.amazonaws.com 을 추가한다. ' +
        '지금 걸면 SES 수신 규칙 세트가 없어 들어온 메일이 거부되므로 의도적 미설정이다.',
  };
}

async function checkSpf(): Promise<CheckResult> {
  const txt = flattenTxt(await tryResolve(() => resolveTxt(DOMAIN)));
  const spf = txt.find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
  const hasSes = spf !== null && spf.includes('include:amazonses.com');
  const soft = spf !== null && spf.trim().endsWith('~all');
  return {
    no: '②',
    name: 'SPF TXT',
    host: DOMAIN,
    ok: hasSes,
    actual: spf ?? '없음',
    note: hasSes
      ? soft
        ? '주의: 계획 §3.3 Day-0 문안은 `-all`(hard fail)이다. 현재 `~all`(soft fail)은 ' +
          'SPF 자체는 통과하나, 위조 발신에 대한 수신측 거부 근거가 약하다. DMARC가 ' +
          'p=quarantine 이상으로 올라가기 전(D+15)에 `-all`로 강화할 것.'
        : ''
      : `atmark.ai TXT에 "v=spf1 include:amazonses.com -all" 을 추가한다.`,
  };
}

async function checkDkim(selector: string, no: string): Promise<CheckResult> {
  const host = `${selector}._domainkey.${DOMAIN}`;
  const expected = `${selector}.dkim.amazonses.com`;
  const cnames = await tryResolve(() => resolveCname(host));
  const actual = cnames?.[0] ?? null;
  const ok = actual !== null && actual.replace(/\.$/, '') === expected;
  return {
    no,
    name: 'DKIM CNAME',
    host,
    ok,
    actual: actual ?? '없음',
    note: ok ? '' : `CNAME ${host} → ${expected} 을 추가한다 (SES Easy DKIM).`,
  };
}

async function checkDmarc(): Promise<CheckResult> {
  const txt = flattenTxt(await tryResolve(() => resolveTxt(DMARC_HOST)));
  const dmarc = txt.find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const hasPolicy = dmarc !== null && /\bp\s*=\s*(none|quarantine|reject)\b/i.test(dmarc);
  // rua가 없으면 집계 리포트가 한 통도 오지 않는다 → parse-dmarc-rua.ts(AC-c6)의 입력이
  // 영구히 비고, D+15/31/45 램프 전환 조건("pass rate ≥ 98%")을 판정할 방법이 사라진다.
  // 따라서 rua는 선택 태그가 아니라 이 게이트의 필수 조건이다.
  const hasRua = dmarc !== null && /\brua\s*=\s*mailto:/i.test(dmarc);
  return {
    no: '⑥',
    name: 'DMARC TXT',
    host: DMARC_HOST,
    ok: hasPolicy && hasRua,
    actual: dmarc ?? '없음',
    note:
      hasPolicy && hasRua
        ? ''
        : !hasPolicy
          ? `_dmarc.atmark.ai TXT에 "v=DMARC1; p=none; rua=mailto:dmarc@atmark.ai; pct=100; fo=1" 을 추가한다.`
          : 'rua= 태그가 없어 집계 리포트가 수신되지 않는다. ' +
            `"v=DMARC1; p=none; rua=mailto:dmarc@atmark.ai; pct=100; fo=1" 로 교체할 것 — ` +
            'AC-c6(pnpm parse:dmarc-rua)과 DMARC 램프 전환 판정이 전적으로 이 태그에 달려 있다.',
  };
}

async function checkIdCname(): Promise<CheckResult> {
  const cnames = await tryResolve(() => resolveCname(ID_HOST));
  const actual = cnames?.[0] ?? null;
  return {
    no: '⑦',
    name: 'id CNAME',
    host: ID_HOST,
    ok: actual !== null,
    actual: actual ?? '없음',
    note:
      actual !== null
        ? actual.endsWith('.cloudfront.net') || actual.endsWith('.cloudfront.net.')
          ? ''
          : '주의: CloudFront 배포(*.cloudfront.net)를 가리키지 않는다. ADR-0002의 did:web 해석 ' +
            '경로가 이 호스트에 고정되므로 오리진을 확인할 것.'
        : `CNAME ${ID_HOST} → <CloudFront 배포>.cloudfront.net 을 추가한다. ` +
          'did:web:id.atmark.ai:agents:{id} 해석 경로의 지반이며, ACM 인증서 검증이 달력-시간이라 P0에 건다.',
  };
}

async function checkCaa(): Promise<CheckResult> {
  // CAA는 하위 도메인이 자기 레코드를 갖지 않으면 상위에서 상속되므로 루트에 고정한다
  // (ADR-0002 F6: "id.atmark.ai CAA 레코드 고정").
  const records = await tryResolve(() => resolveCaa(DOMAIN));
  const issuers = (records ?? [])
    .map((r) => r.issue ?? r.issuewild ?? null)
    .filter((v): v is string => v !== null)
    .map((v) => v.trim().toLowerCase());
  const ok = issuers.some((i) => ACM_CAA_ISSUERS.some((allowed) => i === allowed || i.startsWith(`${allowed};`)));
  return {
    no: '⑧',
    name: 'CAA',
    host: DOMAIN,
    ok,
    actual: issuers.length > 0 ? issuers.join(', ') : '없음',
    note: ok
      ? ''
      : `atmark.ai CAA에 ${ACM_CAA_ISSUERS.map((i) => `0 issue "${i}"`).join(' / ')} 를 추가한다. ` +
        '고정하지 않으면 임의 CA가 atmark.ai 인증서를 발급할 수 있고, did:web은 TLS를 신뢰의 근거로 쓴다.',
  };
}

async function main(): Promise<void> {
  const results: CheckResult[] = [
    await checkMx(),
    await checkSpf(),
    ...(await Promise.all(
      DKIM_SELECTORS.map((selector, i) => checkDkim(selector, ['③', '④', '⑤'][i] ?? '·')),
    )),
    await checkDmarc(),
    await checkIdCname(),
    await checkCaa(),
  ];

  console.log(`\nAtmark DNS 점검 — ${DOMAIN} (AC-c1: 8건 전부 ✓ 여야 통과)\n`);
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.no} ${r.name}  [${r.host}]`);
    console.log(`     현재: ${r.actual}`);
    if (r.note !== '') console.log(`     ${r.ok ? '비고' : '조치'}: ${r.note}`);
    console.log('');
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`결과: ${passed}/${results.length} 통과`);
  if (passed === results.length) {
    console.log('AC-c1 통과 — P0 DNS 게이트가 열렸다.\n');
    process.exitCode = 0;
    return;
  }
  console.log(
    `AC-c1 미통과 — 남은 ${results.length - passed}건은 infra/dns/cloudflare-records.md 의 "P0 잔여" 표를 따른다.\n`,
  );
  process.exitCode = 1;
}

await main();
