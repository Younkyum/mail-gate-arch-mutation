/**
 * R22 — **워밍업 캡이 동시 요청에서도 지켜지는가.**
 *
 * 계획 R22 는 *"남은 제동장치는 `limits.ts` 의 워밍업 캡뿐"* 이라고 선언했다. 그런데
 * P1b 의 평가 경로는 이렇게 생겼다:
 *
 *   ① `prepareOutbound` 가 `messages` 를 **`pending`** 으로 INSERT
 *   ② `policy-source.load` 가 **`REPEATABLE READ READ ONLY`** 스냅샷에서 카운터를 읽는다
 *      — `COUNTED_STATUSES = ('dispatching','sent')` 라 방금 넣은 행도, 동시 진행 중인
 *      다른 시도들도 보이지 않는다
 *   ③ `isWarmupCapExceeded` 가 `orgRecipientsLastDay + recipients.length > cap` 판정
 *   ④ **그 뒤에야** `leases.acquire` 가 `dispatching` 으로 올린다
 *
 * ②~④ 사이에 잠금이 하나도 없다. 읽기 트랜잭션은 read-only 스냅샷이라 정의상 아무것도
 * 잠그지 않는다. 그래서 캡 20 · 현재 19 수신자일 때 동시 요청 N 개가 전부 `19 + 1 ≤ 20`
 * 을 통과한다 — **캡 아래에서 19 + N 수신자가 나간다.**
 *
 * P1b 데모는 순차 실행이라 이 창이 드러나지 않았다. 이 테스트가 그 창을 연다:
 * **고치기 전에는 실패해야 하고**, 그 실패가 곧 "무엇을 고쳤는가" 의 정의다.
 *
 * **실 Postgres 위에서만 성립하는 명제다.** 가짜 저장소로는 스냅샷 격리도 advisory lock 도
 * 재현되지 않고, 재현되지 않는 것을 "증명" 하면 가짜의 성질을 증명한 것이 된다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { ApiRequest, ApiResponse } from '../../../src/api/http';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { handleSend } from '../../../src/api/routes/send';
import {
  createPostgresAgentTokenStore,
  createPostgresGateStores,
  createPostgresOutboundSerializer,
} from '../../../src/db/repositories';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { WARMUP_DAILY_CAPS } from '../../../src/policy/rules/limits';
import { countingTransport } from '../outbound/support/fakes';
import { closeTestPool, DATABASE_AVAILABLE, newIndependentPool, provisioningPool, seedFixture, seedMessage, testPool } from './support/harness';
import type { Fixture } from './support/harness';
import type { Pool } from 'pg';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const RECIPIENT = 'warmup-race-probe@example.com';

/** Day 1 캡. 표에서 직접 읽는다 — 숫자를 베끼면 표가 바뀌는 날 테스트가 거짓말을 한다. */
const DAY_ONE_CAP = WARMUP_DAILY_CAPS[0]?.cap ?? 20;

/** 캡 직전까지 채워 둘 수신자 수. 남은 여유는 정확히 1명이다. */
const PRESEEDED_RECIPIENTS = DAY_ONE_CAP - 1;

/**
 * 동시 시도 수. 캡의 여유가 1명이므로 **정확히 1건만** 통과해야 한다.
 * 5 는 로컬 Postgres 에서 창이 안정적으로 열리는 최소치다 — 2 로 줄이면 경쟁이
 * 재현되지 않는 실행이 섞여 회귀 테스트가 간헐적으로 green 이 된다.
 */
const CONCURRENCY = 5;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

// ---------------------------------------------------------------------------
// 두 테스트가 공유하는 무대 — 다른 것은 **누가 직렬화기를 쥐고 있는가** 하나뿐이다
// ---------------------------------------------------------------------------

/** 캡 직전(잔여 1명)까지 채운 조직 하나와, 그 에이전트의 토큰. 관찰은 공유 풀로 한다. */
async function seedScenario(): Promise<{ readonly fixture: Fixture; readonly plaintext: string }> {
  const pool = testPool();
  // Day 1 — 오늘이 기준일이다.
  const fixture = await seedFixture(pool, { allowlist: [RECIPIENT], sendingStartedAt: new Date() });

  // 캡의 눈금은 **수신자 수**다. 한 행에 몰아 넣어도 `sum(recipient_count)` 는 같다.
  await seedMessage(pool, fixture.agentId, {
    status: 'sent',
    recipientCount: PRESEEDED_RECIPIENTS,
  });

  const token = issueAgentToken(fixture.agentId);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: token.tokenHash,
    capabilities: token.capabilities,
    expiresAt: null,
  });
  return { fixture, plaintext: token.plaintext };
}

/**
 * 한 "프로세스" 의 발송 의존성 전부. **직렬화기는 풀마다 새로 만든다** —
 * `createPostgresOutboundSerializer` 의 조직별 큐는 그 인스턴스 안의 `Map` 이므로,
 * 인스턴스가 둘이면 큐도 둘이고 그 순간 남는 상호배제는 advisory lock 뿐이다.
 */
function serviceOn(pool: Pool): OutboundServiceDependencies {
  const gateStores = createPostgresGateStores(pool);
  return {
    source: gateStores.source,
    audit: gateStores.audit,
    dispatchStore: gateStores.leases,
    serializer: createPostgresOutboundSerializer(pool),
    sendEvidence: gateStores.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content: createInMemoryContentStore(),
    leaseTtlSeconds: 300,
    riskSignals: inertRiskSignals(),
    dlp: inertDlp(),
    now: () => new Date(),
  };
}

/**
 * **키는 전부 다르다.** 같은 키였다면 멱등 인덱스가 막아 경쟁이 드러나지 않는다 —
 * 이 테스트가 보는 것은 "서로 다른 요청들이 같은 캡을 동시에 읽는" 창이다.
 */
function requestFor(fixture: Fixture, plaintext: string, index: number): ApiRequest {
  return {
    headers: {
      authorization: `Bearer ${plaintext}`,
      'idempotency-key': `warmup-race-${fixture.agentId}-${String(index)}`,
    },
    query: {},
    body: {
      agent_id: fixture.agentId,
      from: fixture.address,
      to: [RECIPIENT],
      subject: 'R22 워밍업 캡 경쟁',
      text: '동시 요청',
      cost_cents: 0,
    },
  };
}

/** **이 함수가 R22 그 자체다.** 고치기 전에는 `19 + 5 = 24` 가 나온다. */
async function expectCapHeld(
  organizationId: string,
  responses: readonly ApiResponse[],
  transportCalls: number,
): Promise<void> {
  // 조직 전체가 실제로 소비한 수신자 수. `dispatching`·`sent` 가 카운터의 정의다.
  const consumed = await testPool().query<{ recipients: string }>(
    `SELECT coalesce(sum(m.recipient_count), 0)::text AS recipients
       FROM messages m
       JOIN agents a ON a.id = m.agent_id
      WHERE a.organization_id = $1
        AND m.direction = 'outbound'
        AND m.status IN ('dispatching', 'sent')`,
    [organizationId],
  );

  expect(Number(consumed.rows[0]?.recipients ?? 0)).toBeLessThanOrEqual(DAY_ONE_CAP);
  expect(transportCalls).toBe(1);

  const sent = responses.filter((response) => response.status === 200);
  const denied = responses.filter((response) => response.status === 403);
  expect(sent).toHaveLength(1);
  expect(denied).toHaveLength(responses.length - 1);
  for (const response of denied) {
    expect(response.body['error']).toBe('policy_denied');
    const decision = response.body['decision'] as { readonly reasons: readonly string[] };
    // HTTP 응답이라 공개 이름이다(`warmup_daily_cap` → `daily_send_limit`, `src/api/public-codes.ts`). audit 행은 내부 이름 그대로다.
    expect(decision.reasons).toContain('daily_send_limit');
  }
}

describe.skipIf(!DATABASE_AVAILABLE)('R22 — 워밍업 캡의 check-then-act 경쟁', () => {
  /**
   * **축 ①: 한 프로세스 안의 동시 요청.** 직렬화기 하나가 조직별 큐로 줄을 세운다.
   *
   * 이 구성은 advisory lock 을 **지워도 통과한다** — 큐가 먼저 막기 때문이다. 그래서
   * 이 테스트가 지키는 것은 정확성이 아니라 **풀 안전**(잠금 커넥션을 쥔 채 기다리는
   * 시도가 조직당 하나뿐이라는 성질)이다. 정확성은 아래 축 ②가 지킨다.
   */
  it(`단일 풀 · 단일 직렬화기 · 동시 ${String(CONCURRENCY)}건 → 나간 수신자는 캡을 넘지 않는다`, async () => {
    const { fixture, plaintext } = await seedScenario();
    const pool = testPool();
    const tokens = createPostgresAgentTokenStore(pool);
    const transport = countingTransport();
    const service = serviceOn(pool);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, index) =>
        handleSend({ tokens, service, transport }, requestFor(fixture, plaintext, index)),
      ),
    );

    await expectCapHeld(fixture.organizationId, responses, transport.calls());
  });

  /**
   * **축 ②: 프로세스가 여럿일 때.** 풀도 직렬화기도 시도마다 따로다 — 람다 N 개가
   * 동시에 뜬 배포가 정확히 이 모양이다.
   *
   * **이 구성에서 프로세스 내 큐는 아무 일도 하지 않는다.** 큐는 인스턴스의 `Map` 이고
   * 인스턴스가 N 개이므로 각 큐에는 시도가 하나씩밖에 없다. 남는 상호배제는
   * `pg_advisory_xact_lock` 하나뿐이고, 따라서 **이 테스트는 그 한 줄을 지우면 실패한다.**
   * 축 ①만 있던 동안 다중 인스턴스 배포의 유일한 보호 장치에 회귀 커버리지가 0 이었다.
   *
   * 풀을 시도마다 따로 두는 것이 굶주림을 피하는 이유이기도 하다: 잠금을 기다리는
   * 시도가 쥔 커넥션은 **자기 풀의** 예산이라, 잠금을 이긴 시도가 정책을 읽으려고
   * 요청하는 커넥션과 경쟁하지 않는다(단일 풀이었다면 `max` 가 동시성 이하일 때 교착).
   */
  it(`독립 풀 ${String(CONCURRENCY)}개 · 독립 직렬화기 ${String(CONCURRENCY)}개(다중 프로세스) → 캡을 넘지 않는다`, async () => {
    const { fixture, plaintext } = await seedScenario();
    const pools = Array.from({ length: CONCURRENCY }, () => newIndependentPool({ max: 4 }));
    // 전송단만 공유한다 — 실제로 SES 를 부른 횟수는 프로세스 경계와 무관한 전역 사실이다.
    const transport = countingTransport();

    try {
      const responses = await Promise.all(
        pools.map((pool, index) =>
          handleSend(
            { tokens: createPostgresAgentTokenStore(pool), service: serviceOn(pool), transport },
            requestFor(fixture, plaintext, index),
          ),
        ),
      );

      await expectCapHeld(fixture.organizationId, responses, transport.calls());
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});
