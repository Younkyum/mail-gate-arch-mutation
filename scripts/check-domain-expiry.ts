#!/usr/bin/env tsx
/**
 * check-domain-expiry.ts — 계획 §6 P0 생성 파일, ADR-0002 Follow-ups F5·F6
 *
 * ── 왜 도메인 만료가 코드로 감시할 일인가 ──────────────────────────────
 * ADR-0002 Consequences: **도메인 통제권 = identity 통제권.**
 * did:web:id.atmark.ai:agents:{agentId} 는 https://id.atmark.ai/... 로 해석된다.
 * atmark.ai 가 만료되거나 탈취되면 **발급된 모든 passport가 검증 불가**가 되고,
 * 더 나쁜 경우 공격자가 위조 DID 문서를 서빙해 전 에이전트를 사칭할 수 있다.
 * did:web의 구조적 약점이며 우회 수단이 없다 — 근본 해결은 온체인 앵커뿐이고
 * 그것은 P6 이후다. 그때까지 R13의 방어선은 다음뿐이다:
 *   F4 레지스트라 잠금 + 전송 잠금  (2026-09-22 확인: clientTransferProhibited 적용됨)
 *   F5 자동갱신 + 결제수단 2중화     (2026-09-22 확인: 자동갱신 ON)
 *   F6 만료 D-180 / D-90 / D-30 / D-7 알림  ← **이 스크립트가 그것이다**
 * (10년 선구매는 r5에서 P6로 연기됐다 — 지켜야 할 passport가 P6까지 하나도 발급되지
 *  않으므로 선구매의 가치는 P6에서 처음 생긴다. 그때까지는 위 셋이 전부다.)
 *
 * 조회는 RDAP(WHOIS의 후속 표준, JSON)로 한다. 외부 패키지 금지: node:https 만 쓴다(`src/domains/rdap.ts`).
 * exit 0 = 임계값 여유, exit 1 = D-180 이하(경고) 또는 조회 실패.
 */

import { findExpiration, lookupRdapDomain, type RdapDomain } from '../src/domains/rdap';

const DOMAIN = 'atmark.ai';

/**
 * .ai 는 Identity Digital 레지스트리다. 1순위로 직접 조회하고,
 * 실패하면 IANA 부트스트랩을 대신 해 주는 rdap.org 로 넘어간다(리다이렉트 추적).
 * 조회·파싱은 `src/domains/rdap.ts`(ADR-0014 단계 2 — domain-control 의 고객 apex 만료 확인과 같은 코드)다.
 */
const RDAP_ENDPOINTS = [
  `https://rdap.identitydigital.services/rdap/domain/${DOMAIN}`,
  `https://rdap.org/domain/${DOMAIN}`,
] as const;

/** ADR-0002 F6. 하나라도 걸리면 갱신·결제수단을 사람이 직접 확인해야 한다. */
const ALERT_THRESHOLDS_DAYS = [180, 90, 30, 7] as const;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

function daysUntil(target: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((target.getTime() - now.getTime()) / msPerDay);
}

function lookup(): Promise<RdapDomain> {
  return lookupRdapDomain(RDAP_ENDPOINTS, { timeoutMs: TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, userAgent: 'atmark-check-domain-expiry/1.0' });
}

async function main(): Promise<void> {
  console.log(`\n도메인 만료 점검 — ${DOMAIN} (ADR-0002 F6 / R13)\n`);

  let doc: RdapDomain;
  try {
    doc = await lookup();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\n조회 자체가 실패했다. 네트워크 문제일 수도 있으나, 만료일을 모른 채 넘어가지 않는다.');
    console.error('Cloudflare Registrar 콘솔에서 만료일·자동갱신·결제수단을 직접 확인할 것.\n');
    process.exitCode = 1;
    return;
  }

  const expiration = findExpiration(doc);
  if (expiration === null) {
    console.error('RDAP 응답에 expiration 이벤트가 없다. 레지스트리 응답 형식이 바뀌었을 수 있다.');
    console.error('Cloudflare Registrar 콘솔에서 직접 확인할 것.\n');
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const remaining = daysUntil(expiration, now);
  const statuses = doc.status ?? [];

  console.log(`만료일: ${expiration.toISOString().slice(0, 10)}`);
  console.log(`남은 기간: ${remaining}일`);
  if (statuses.length > 0) console.log(`레지스트리 상태: ${statuses.join(', ')}`);
  // F4의 기계 확인: 전송 잠금이 풀리면 만료보다 먼저 도메인을 잃는다.
  const transferLocked = statuses.some((s) => s.toLowerCase().includes('transfer prohibited'));
  console.log(`전송 잠금(F4): ${transferLocked ? '✓ 적용됨' : '✗ 없음 — 레지스트라에서 즉시 설정할 것'}`);
  console.log('');

  const breached = ALERT_THRESHOLDS_DAYS.filter((t) => remaining <= t);
  const tightest = breached.length > 0 ? Math.min(...breached) : null;

  if (tightest === null && transferLocked) {
    const next = ALERT_THRESHOLDS_DAYS[0];
    console.log(`판정: 여유. 다음 경보 임계값은 D-${next} (${remaining - next}일 뒤).\n`);
    process.exitCode = 0;
    return;
  }

  if (tightest !== null) {
    console.log(`경고: D-${tightest} 임계값을 넘었다 (ADR-0002 F6).`);
    console.log('  1. 자동갱신이 켜져 있는지 확인 (F5)');
    console.log('  2. 등록된 결제수단 2개가 모두 유효한지 확인 (F5) — 만료된 카드가 자동갱신을 조용히 실패시킨다');
    console.log('  3. 레지스트라 잠금·전송 잠금 유지 확인 (F4)');
    if (tightest <= 30) {
      console.log('  4. D-30 이하: 수동 갱신을 즉시 실행한다. 자동갱신을 기다리지 않는다.');
    }
  }
  if (!transferLocked) {
    console.log('경고: 전송 잠금이 확인되지 않는다 — R13의 예방선 하나가 열려 있다 (ADR-0002 F4).');
  }
  console.log('');
  process.exitCode = 1;
}

await main();
