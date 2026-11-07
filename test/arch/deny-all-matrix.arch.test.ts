/**
 * Layer D — deny-all 매트릭스 **자동 생성**의 증명 (계획 §5.0 "Layer D", §4.5).
 *
 * **주장:** 차단 테스트는 매니페스트에서 기계적으로 파생되며, 경로가 등록되면 사람이
 * 아무것도 하지 않아도 차단 케이스가 생긴다.
 *
 * **이 층이 잡는 것**
 * - 새 발송 경로가 차단 테스트 없이 들어오는 상황(생성이 자동이므로 불가능해진다).
 * - `kind: 'http'` 인데 `Idempotency-Key` 를 요구하지 않는 경로 — 타입(리터럴 `true`)이
 *   1차로 막고, 이 순회가 2차로 막는다.
 * - **생성기 자체의 고장.** 매니페스트가 비어 있는 P1a 에서 "0건 통과"만 확인하면
 *   생성기가 죽어 있어도 green 이다. 그래서 **픽스처 매니페스트로 생성기를 구동해
 *   실제 케이스가 나오는지**를 함께 단언한다.
 *
 * **이 층이 못 잡는 것**
 * - 매니페스트에 등록되지 않은 경로 → **Layer C**(진입점 전수 분할)가 잡는다.
 *   D 는 등록된 것만 본다. 등록 자체를 강제하는 것은 D 의 일이 아니다.
 * - 생성된 케이스가 **실제로 구동됐을 때** 차단되는지 → 그것은 런타임 층이며
 *   `test/integration/outbound/deny-all-matrix.test.ts`(P1a 후반, 관문 도착 후)가 맡는다.
 *   여기서는 위상만 증명한다.
 *
 * **P1a 현재 상태:** `OUTBOUND_ROUTES` 가 비어 있으므로 실제 생성 케이스는 **0건**이다.
 * 0건인 이유는 "발송 경로가 아직 하나도 없기 때문"이고, 그 사실은 Layer C 가 별도로
 * 보증한다(진입점 파일이 생기면 등록을 강요당한다).
 */

import { describe, expect, it } from 'vitest';
import { OUTBOUND_ROUTES, type OutboundRoute } from '../../src/policy/manifest';
import {
  buildDenyAllMatrix,
  buildIdempotencyKeyMatrix,
  DENY_AXES,
} from './support/deny-all-matrix';

/**
 * 생성기 구동용 픽스처. **실제 매니페스트가 아니다** — P1b 에 들어올 경로의 모양을
 * 미리 본뜬 것이며, 오직 "생성기가 살아 있는가"를 증명하기 위해 존재한다.
 */
const FIXTURE_ROUTES: readonly OutboundRoute[] = [
  {
    id: 'fixture_send',
    kind: 'http',
    file: 'src/api/routes/fixture-messages.ts',
    ref: 'POST /v1/fixture/messages',
    requiresIdempotencyKey: true,
  },
  {
    id: 'fixture_scheduled_send',
    kind: 'worker',
    file: 'src/workers/fixture-scheduled-sender.ts',
    ref: 'workers/fixture-scheduled-sender',
  },
];

describe('Layer D — 생성기 비공허성 (픽스처 매니페스트)', () => {
  const denyCases = buildDenyAllMatrix(FIXTURE_ROUTES);
  const idempotencyCases = buildIdempotencyKeyMatrix(FIXTURE_ROUTES);

  it('경로 × 거부 축 전수 조합을 만든다', () => {
    expect(denyCases).toHaveLength(FIXTURE_ROUTES.length * DENY_AXES.length);
    expect(new Set(denyCases.map((c) => c.name)).size).toBe(denyCases.length);
  });

  it('모든 생성 케이스의 기대값이 SES 호출 0회 + audit 행 1개다', () => {
    for (const denyCase of denyCases) {
      expect(denyCase.expect).toEqual({ verdict: 'policy_denied', sesSendCalls: 0, auditRows: 1 });
    }
  });

  it('Idempotency-Key 케이스는 http 경로에만, 그리고 http 경로 전부에 생긴다', () => {
    const httpRoutes = FIXTURE_ROUTES.filter((route) => route.kind === 'http');
    expect(idempotencyCases.map((c) => c.routeId)).toEqual(httpRoutes.map((r) => r.id));
  });
});

describe('Layer D — 실제 매니페스트 순회', () => {
  const denyCases = buildDenyAllMatrix(OUTBOUND_ROUTES);
  const idempotencyCases = buildIdempotencyKeyMatrix(OUTBOUND_ROUTES);

  it('생성 케이스 수 = 경로 수 × 거부 축 수 (P1a: 0 × 6 = 0)', () => {
    expect(denyCases).toHaveLength(OUTBOUND_ROUTES.length * DENY_AXES.length);
  });

  it('kind:"http" 경로는 전부 Idempotency-Key 를 요구한다 (§4.5)', () => {
    const httpRoutes = OUTBOUND_ROUTES.filter((route) => route.kind === 'http');
    const offenders = httpRoutes.filter((route) => route.requiresIdempotencyKey !== true);

    expect(offenders.map((route) => route.id)).toEqual([]);
    expect(idempotencyCases).toHaveLength(httpRoutes.length);
  });

  it('생성된 모든 케이스가 등록된 경로만 가리킨다', () => {
    const ids = new Set<string>(OUTBOUND_ROUTES.map((route) => route.id));
    const strays = [...denyCases, ...idempotencyCases].filter((c) => !ids.has(c.routeId));
    expect(strays).toEqual([]);
  });
});
