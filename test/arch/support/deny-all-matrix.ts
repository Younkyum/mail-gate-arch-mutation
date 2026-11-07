/**
 * Layer D 의 **생성기** (계획 §5.0 "Layer D", §4.5).
 *
 * 차단 테스트를 사람이 쓰면 사람이 잊는다. 매니페스트를 순회해 **경로 × 거부 축**의
 * 전수 케이스를 기계가 만든다 — 새 경로가 `OUTBOUND_ROUTES` 에 등록되는 순간 차단
 * 테스트가 저절로 붙고, 붙지 않게 하려면 매니페스트에서 빼는 수밖에 없는데 그러면
 * Layer C 가 막는다. **두 층이 맞물려 빠져나갈 구멍을 없앤다.**
 *
 * 여기는 케이스 **기술(descriptor)** 만 만든다. 실제 구동(라우트 호출 → SES 모의 호출
 * 횟수 0 단언)은 P1a 후반의 `test/integration/outbound/deny-all-matrix.test.ts` 가
 * 이 생성기를 import 해서 수행한다. 생성과 구동을 분리한 이유: 구동에는 관문·엔진이
 * 필요하지만(worker-3), **생성기는 지금 존재해야** 위상이 코드보다 먼저 선다.
 */

import type { OutboundRoute, OutboundRouteKind } from '../../../src/policy/manifest';

/**
 * 거부 축 — 계획 §5.0 Layer D 의 "동일 매트릭스를 다른 거부 축으로 반복".
 * 각 축은 서로 다른 Stage 에서 발생하는 거부이며, 어느 축이든 결과는 같아야 한다:
 * **SES 호출 0회 + audit 행 정확히 1개.**
 */
export const DENY_AXES = [
  'outbound_mode_disabled',
  'suppression_list',
  'blocklist',
  'budget_exhausted',
  'warmup_cap',
  'from_forgery',
] as const;

export type DenyAxis = (typeof DENY_AXES)[number];

export interface DenyCase {
  /** 테스트 타이틀로 그대로 쓰는 문자열. */
  readonly name: string;
  readonly routeId: string;
  readonly routeKind: OutboundRouteKind;
  readonly file: string;
  readonly axis: DenyAxis;
  readonly expect: {
    readonly verdict: 'policy_denied';
    /** AC-5 의 문자 그대로의 증명 — 모의 전송단의 호출 횟수. */
    readonly sesSendCalls: 0;
    /** §4.3 audit 불변식: 시도 1건당 행 1개. */
    readonly auditRows: 1;
  };
}

/** 경로 × 거부 축 전수 조합. */
export function buildDenyAllMatrix(routes: readonly OutboundRoute[]): DenyCase[] {
  return routes.flatMap((route) =>
    DENY_AXES.map((axis) => ({
      name: `${route.id} × ${axis} → policy_denied, SES 호출 0회`,
      routeId: route.id,
      routeKind: route.kind,
      file: route.file,
      axis,
      expect: { verdict: 'policy_denied', sesSendCalls: 0, auditRows: 1 },
    })),
  );
}

export interface IdempotencyKeyCase {
  readonly name: string;
  readonly routeId: string;
  readonly file: string;
  readonly expect: {
    readonly status: 400;
    readonly error: 'idempotency_key_required';
  };
}

/**
 * `kind: 'http'` 경로마다 "`Idempotency-Key` 없이 호출하면 400" 케이스를 생성한다.
 *
 * 계획 §4.5: SQS 는 at-least-once 이고 관문이 exactly-once 지점이므로 http 경로 전부가
 * 이 헤더를 요구한다. r3 이전에는 `POST /v1/messages` 하나만 규칙 안에 있었고 나머지
 * 넷이 규칙 밖으로 샜다 — **새 라우트마다 케이스가 자동 생성되게 해서 그 종류의
 * 누락을 구조적으로 없앤다.**
 */
export function buildIdempotencyKeyMatrix(routes: readonly OutboundRoute[]): IdempotencyKeyCase[] {
  return routes
    .filter((route) => route.kind === 'http')
    .map((route) => ({
      name: `${route.id} — Idempotency-Key 없이 호출하면 400`,
      routeId: route.id,
      file: route.file,
      expect: { status: 400, error: 'idempotency_key_required' },
    }));
}
