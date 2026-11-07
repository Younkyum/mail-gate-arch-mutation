/**
 * test/support/injection-doubles.ts — 인젝션 구조 방어(ADR-0016) 의존성의 **테스트 대역**.
 *
 * 발송 서비스·읽기 라우트·수신 소비자는 위험 신호 · 발신 DLP · 노출 기록을 **필수**로 받는다(운영 조립 루트가 빠뜨리지 못하게). 이 기능과 무관한 기존
 * 테스트는 여기 대역을 쓴다 — 동작은 기능 이전과 같다(노출 0 · 지문 0 · 기록은 받기만). 기능 자체의 테스트는 Postgres 구현을 쓴다
 * (`test/integration/security/injection-*.test.ts`).
 */

import type { OutboundDlpDependencies } from '../../src/api/outbound-service';
import type { ExposureRecorder, ExposureRecordInput } from '../../src/db/repositories/exposure-store';
import type { RiskHoldMode, RiskSignalSource } from '../../src/policy/risk-signals';
import { parseHmacKeyring, type HmacKeyring } from '../../src/security/hmac-keyring';

/** 고정 DLP 지문 키(테스트 전용 — 운영 키와 무관). */
export const TEST_DLP_KEYRING: HmacKeyring = parseHmacKeyring(`t1:${Buffer.alloc(32, 11).toString('base64url')}`, 'TEST_DLP_KEYS');

/** 노출이 하나도 없는 위험 신호(강제 모드) — 위험 보류는 DLP 계열로만 걸린다. */
export function inertRiskSignals(mode: RiskHoldMode = 'enforce'): RiskSignalSource {
  return { load: () => Promise.resolve({ mode, exposures: [] }) };
}

/** 지문이 하나도 없는 발신 DLP(비밀 패턴은 그대로 본다). */
export function inertDlp(keyring: HmacKeyring = TEST_DLP_KEYRING): OutboundDlpDependencies {
  return { keyring, signals: { load: () => Promise.resolve({ codeFingerprints: [], inboundCopies: [] }) } };
}

/** 받은 노출을 쌓기만 하는 기록기(전부 T0). */
export function recordingExposures(): ExposureRecorder & { readonly recorded: ExposureRecordInput[] } {
  const recorded: ExposureRecordInput[] = [];
  return {
    recorded,
    record(input) {
      recorded.push(input);
      return Promise.resolve({ levels: input.items.map(() => 'T0' as const) });
    },
  };
}
