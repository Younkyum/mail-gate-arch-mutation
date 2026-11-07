/**
 * **AC-i1 ~ AC-i4 — 계획 §4.5 Acceptance 넷을 실제 Postgres 위에서 판정한다.**
 *
 * 이 파일이 따로 있는 이유는 중복이 아니라 **경계**다. `postgres-send.test.ts` 는 AC-i1 의
 * 동시성을, `test/unit/policy/gate.test.ts` 는 AC-i2 를 인메모리로 본다. 여기서 채우는
 * 것은 그 둘이 닿지 못하는 곳이다:
 *
 *   - **AC-i1** 의 눈금을 계획이 쓴 **100** 으로 올린다(기존은 20).
 *   - **AC-i2** 를 실 Postgres 의 조건부 UPDATE 위에서 다시 본다 — 인메모리 맵의 성질이
 *     아니라 lease 의 성질임을 확인한다.
 *   - **AC-i3** 를 관문 전체에서 재현한다. `dispatch.test.ts` 는 lease 저장소 한 층만
 *     보므로, *"transport 직후 프로세스 사망 → 만료 전 재전송 없음 → 만료 후 재전송"* 의
 *     **재전송 판단**은 한 번도 실행되지 않았다. **ADR-0004 이 다루는 것이 정확히 그 판단이다.**
 *   - **AC-i4** 는 P2 에서 **실제 경합**이 됐다 — 승인→릴리스와 TTL 만료를 동시에 트리거한다.
 *     (P1c 는 "해당 없음" 을 단언해 두었고, P2 가 승인 대기를 만들면서 그 단언이 교체됐다.)
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다** — 다른 통합 층과 같은 환경 게이트다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundServiceDependencies,
} from '../../../src/api/outbound-service';
import type { ApiRequest } from '../../../src/api/http';
import { handleSend } from '../../../src/api/routes/send';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresSesEventStore } from '../../../src/db/repositories/ses-event-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { approveRequest, expireRequest } from '../../../src/approval/service';
import { createPostgresApprovalStore } from '../../../src/db/repositories/approval-store';
import { dispatch, type DispatchRequest, type GateDependencies, type SendEvidenceLookup } from '../../../src/policy/gate';
import { runApprovalRelease } from '../../../src/workers/approval-release';
import { closeTestPool, DATABASE_AVAILABLE, newIndependentPool, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const RECIPIENT = 'ac-i-probe@example.com';

/** 계획 §4.5 가 쓴 그 숫자다. 20 으로 줄이면 "100회" 라는 문장이 검증되지 않는다. */
const AC_I1_CONCURRENCY = 100;

/** `GateDependencies.leaseTtlSeconds` 의 프로덕션 값. 아래 시간 계산이 이 값에 걸려 있다. */
const LEASE_TTL_SECONDS = 300;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

interface Harness {
  readonly service: OutboundServiceDependencies;
  readonly transport: ReturnType<typeof countingTransport>;
}

function serviceFor(
  pool: Parameters<typeof createPostgresGateStores>[0],
  now: () => Date = () => new Date(),
): Harness {
  const stores = createPostgresGateStores(pool);
  return {
    transport: countingTransport(),
    service: {
      source: stores.source,
      audit: stores.audit,
      dispatchStore: stores.leases,
      serializer: stores.serializer,
      sendEvidence: stores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content: createInMemoryContentStore(),
      leaseTtlSeconds: LEASE_TTL_SECONDS,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now,
    },
  };
}

// ---------------------------------------------------------------------------
// AC-i1
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-i1 — 동일 Idempotency-Key 100회 동시 호출', () => {
  it(`${String(AC_I1_CONCURRENCY)}회 동시 → SES 1회 · messages 1행 · audit 1행`, async () => {
    // **전용 풀이다.** 공유 풀(max 4)에 100개를 걸면 `connectionTimeoutMillis`(5초)에
    // 걸려 실패하고, 그 실패는 멱등성이 아니라 풀 크기를 말한다.
    const pool = newIndependentPool({ max: 12, connectionTimeoutMillis: 30_000 });
    try {
      const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
      const token = issueAgentToken(fixture.agentId);
      const tokens = createPostgresAgentTokenStore(pool);
      await createPostgresAgentTokenStore(provisioningPool()).insert({
        agentId: fixture.agentId,
        tokenHash: token.tokenHash,
        capabilities: token.capabilities,
        expiresAt: null,
      });

      const { service, transport } = serviceFor(pool);
      const key = `ac-i1-100-${fixture.agentId}`;
      const request: ApiRequest = {
        headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': key },
        query: {},
        body: {
          agent_id: fixture.agentId,
          from: fixture.address,
          to: [RECIPIENT],
          subject: 'AC-i1 100',
          text: '동시 100회',
          cost_cents: 0,
        },
      };

      const responses = await Promise.all(
        Array.from({ length: AC_I1_CONCURRENCY }, () =>
          handleSend({ tokens, service, transport }, request),
        ),
      );

      for (const response of responses) expect([200, 202]).toContain(response.status);

      const messageIds = new Set(responses.map((response) => response.body['message_id']));
      expect(messageIds.size).toBe(1);
      const messageId = [...messageIds][0] as string;

      // **판정 셋 — 계획 §4.5 Acceptance 의 문장 그대로다.**
      expect(transport.calls()).toBe(1);
      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM messages WHERE agent_id = $1 AND idempotency_key = $2',
        [fixture.agentId, key],
      );
      const audits = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM audit_logs WHERE message_id = $1',
        [messageId],
      );
      expect(rows.rows[0]?.count).toBe('1');
      expect(audits.rows[0]?.count).toBe('1');
    } finally {
      await pool.end();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC-i2
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('AC-i2 — 같은 메시지의 3회 재전달', () => {
  it('lease 가 살아 있는 동안 3회 dispatch → SES 1회 · audit 1행', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });

    const prepared = await prepareOutbound(service, {
      routeId: 'send',
      agentId: fixture.agentId,
      idempotencyKey: `ac-i2-${fixture.agentId}`,
      fromAddress: fixture.address,
      recipients: [RECIPIENT],
      subject: 'AC-i2',
      text: '재전달 3회',
      html: null,
      isThreadReply: false,
      traceId: null,
      costCents: 0,
    });
    if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');

    const deps = gateDependenciesFor(service, transport);
    const first = await dispatch(deps, prepared.dispatchRequest);
    await finalizeOutbound(service, prepared, first);

    // **재전달은 같은 잡의 재전달이지 새 시도가 아니다.** leaseId 만 새것으로 바뀐다 —
    // 실제 워커도 그렇게 동작한다(잡마다 새 lease 를 시도한다).
    for (let index = 0; index < 2; index += 1) {
      const redelivery = await dispatch(deps, {
        ...prepared.dispatchRequest,
        leaseId: randomUUID(),
      });
      // 첫 시도가 이미 종단으로 확정했으므로 여기서 죽는다.
      expect(redelivery.kind).toBe('duplicate_suppressed');
    }

    expect(transport.calls()).toBe(1);
    const messageId = prepared.dispatchRequest.messageId as string;
    const audits = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE message_id = $1',
      [messageId],
    );
    expect(audits.rows[0]?.count).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// AC-i3 — ADR-0004 이 다루는 것
// ---------------------------------------------------------------------------

/**
 * **"transport 직후 프로세스 사망" 을 재현한다.**
 *
 * `dispatch` 는 전송을 마치고 결과를 **반환**하지만, 그 결과를 `messages` 행에 확정하는
 * 것은 `finalizeOutbound` 다(관문은 저장하지 않는다). 그러므로 `finalizeOutbound` 를
 * 부르지 않는 것이 정확히 그 시나리오다 — 메일은 나갔고, 행은 `dispatching` 이다.
 */
async function sendThenDie(
  service: OutboundServiceDependencies,
  deps: GateDependencies,
  fixture: Fixture,
  idempotencyKey: string,
): Promise<DispatchRequest> {
  const prepared = await prepareOutbound(service, {
    routeId: 'send',
    agentId: fixture.agentId,
    idempotencyKey,
    fromAddress: fixture.address,
    recipients: [RECIPIENT],
    subject: 'AC-i3',
    text: '전송 직후 사망',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');

  const outcome = await dispatch(deps, prepared.dispatchRequest);
  expect(outcome.kind).toBe('sent');
  // **여기서 죽는다.** finalizeOutbound 를 부르지 않는다.
  return prepared.dispatchRequest;
}

async function statusOf(
  pool: Parameters<typeof createPostgresGateStores>[0],
  messageId: string,
): Promise<{ status: string; ses_message_id: string | null }> {
  const row = await pool.query<{ status: string; ses_message_id: string | null }>(
    'SELECT status, ses_message_id FROM messages WHERE id = $1',
    [messageId],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('messages 행이 없다');
  return found;
}

describe.skipIf(!DATABASE_AVAILABLE)('AC-i3 — transport 직후 사망 (ADR-0004)', () => {
  it('lease 만료 **전** 재전송은 없다', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
    const events = createPostgresSesEventStore(pool);
    const deps = { ...gateDependenciesFor(service, transport), sendEvidence: events };

    const request = await sendThenDie(service, deps, fixture, `ac-i3-live-${fixture.agentId}`);
    expect(transport.calls()).toBe(1);

    // TTL 의 절반만 지났다.
    const beforeExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS / 2) * 1000);
    const retry = await dispatch(deps, { ...request, now: beforeExpiry, leaseId: randomUUID() });

    expect(retry.kind).toBe('duplicate_suppressed');
    expect(transport.calls()).toBe(1);
  });

  it('**Send 이벤트가 있으면 만료 후에도 재전송하지 않고 `sent` 로 확정한다**', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
    const events = createPostgresSesEventStore(pool);
    const deps = { ...gateDependenciesFor(service, transport), sendEvidence: events };

    const request = await sendThenDie(service, deps, fixture, `ac-i3-evidence-${fixture.agentId}`);
    const messageId = request.messageId as string;
    expect((await statusOf(pool, messageId)).status).toBe('dispatching');

    // **`messages_ses_message_id_key` 가 전역 유니크다.** 실제 SES 의 MessageId 도
    // 전역 유일하므로 고정 문자열을 쓰면 테스트 재실행이 그 인덱스에 걸린다 —
    // 값이 유일해야 한다는 사실 자체가 프로덕션의 성질이라 테스트도 그것을 따른다.
    const evidenceSesId = `ses-evidence-${randomUUID()}`;

    // 소비자가 그 사이에 `Send` 이벤트를 기록했다 — SES 가 Message-ID 를 덮어써도
    // **우리 message_id 를 태그로 실어 보냈기 때문에** 이 행이 여기 있다(ADR-0004).
    await events.record({
      eventType: 'send',
      messageId,
      sesMessageId: evidenceSesId,
      eventAt: new Date(),
      dedupeKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    });

    const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
    const retryRequest = { ...request, now: afterExpiry, leaseId: randomUUID() };
    const retry = await dispatch(deps, retryRequest);

    // **재전송하지 않았다.** 이것이 ADR-0004 가 사려는 전부다.
    expect(transport.calls()).toBe(1);
    expect(retry.kind).toBe('sent');
    if (retry.kind !== 'sent') return;
    expect(retry.sesMessageId).toBe(evidenceSesId);

    // 그리고 행이 종단으로 확정된다 — `dispatching` 으로 영원히 남지 않는다.
    await finalizeOutbound(service, { dispatchRequest: retryRequest }, retry);
    const settled = await statusOf(pool, messageId);
    expect(settled.status).toBe('sent');
    expect(settled.ses_message_id).toBe(evidenceSesId);
  });

  it('이벤트가 **없으면** 만료 후 같은 Message-ID 로 재전송한다 (AC-i3 의 나머지 절반)', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
    const deps = {
      ...gateDependenciesFor(service, transport),
      sendEvidence: createPostgresSesEventStore(pool),
    };

    const request = await sendThenDie(service, deps, fixture, `ac-i3-none-${fixture.agentId}`);

    const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
    const retry = await dispatch(deps, { ...request, now: afterExpiry, leaseId: randomUUID() });

    expect(retry.kind).toBe('sent');
    expect(transport.calls()).toBe(2);
    // **같은 헤더로 나갔다** — 행의 `message_id_header` 는 트리거가 불변으로 잠근다.
    const row = await pool.query<{ message_id_header: string }>(
      'SELECT message_id_header FROM messages WHERE id = $1',
      [request.messageId],
    );
    expect(row.rows[0]?.message_id_header).toBe(request.messageIdHeader);
  });

  it('**조회가 실패하면 "이벤트 없음" 으로 읽지 않는다** — 재전송하지 않는다', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });

    // 처음에는 정상 평면으로 보낸다(죽기 전까지는 조회가 필요 없다).
    const healthy: SendEvidenceLookup = createPostgresSesEventStore(pool);
    const deps = { ...gateDependenciesFor(service, transport), sendEvidence: healthy };
    const request = await sendThenDie(service, deps, fixture, `ac-i3-fail-${fixture.agentId}`);

    // 이제 조회가 던진다. **`null`(없음)이 아니라 예외다** — 그 둘의 차이가 이 단언이다.
    const broken: SendEvidenceLookup = {
      findSendEvidence: () => Promise.reject(new Error('db down')),
    };
    const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
    const retry = await dispatch(
      { ...deps, sendEvidence: broken },
      { ...request, now: afterExpiry, leaseId: randomUUID() },
    );

    // 조회 실패를 "안 나갔다" 로 읽었다면 여기서 두 번째 메일이 나간다.
    expect(transport.calls()).toBe(1);
    expect(retry.kind).toBe('duplicate_suppressed');
    // 행은 `dispatching` 으로 남는다 — 그 상태가 곧 "아직 모른다" 이고, 새 lease 가
    // 걸렸으므로 TTL 만큼 다시 잠긴다(다음 시도가 답을 얻을 시간을 산다).
    expect((await statusOf(pool, request.messageId as string)).status).toBe('dispatching');
  });

  it('이벤트 평면이 **배선되지 않았으면** 재전송을 유보한다 (fail closed)', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
    const deps = {
      ...gateDependenciesFor(service, transport),
      sendEvidence: createPostgresSesEventStore(pool),
    };

    const request = await sendThenDie(service, deps, fixture, `ac-i3-unwired-${fixture.agentId}`);

    // `sendEvidence` 를 뺀다 = 관문이 이 평면을 모르는 상태.
    //
    // **이 상태를 `gateDependenciesFor` 로는 더 이상 만들 수 없다** — 서비스 조립
    // 루트에서 `sendEvidence` 가 필수가 되면서, 운영 배포가 지나는 경로에서 미배선은
    // 컴파일되지 않는다. 그래도 관문 자신의 계약(부재 → `unknown` → 유보)은 남아
    // 있고, `GateDependencies.sendEvidence` 가 optional 인 한 워커·데모가 직접
    // 조립하는 경로로 여전히 도달 가능하다. 그래서 여기서 손으로 뺀다.
    const { sendEvidence: _omitted, ...unwired } = gateDependenciesFor(service, transport);
    const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
    const retry = await dispatch(unwired, { ...request, now: afterExpiry, leaseId: randomUUID() });

    // 미배선이 **느슨해지는 쪽**(무조건 재전송)으로 실패하면 ADR-0004 이전으로
    // 조용히 되돌아간다. 막히는 쪽으로 실패하는 것이 설계다.
    expect(transport.calls()).toBe(1);
    expect(retry.kind).toBe('duplicate_suppressed');
  });

  // -------------------------------------------------------------------------
  // `unknown` 의 세 번째 입구 — **증거는 있는데 `ses_message_id` 가 없다.**
  //
  // 앞의 둘(조회 실패·미배선)은 "답을 못 얻었다" 다. 이쪽은 성질이 다르다: 답은
  // 얻었고 그 답이 *"나갔다"* 인데, `messages_state_machine` 이 `sent` 행에 요구하는
  // `ses_message_id` 가 없어 **확정할 수 없다.** 이것을 `none`(증거 없음)으로 접으면
  // 나간 메일에 대해 곧바로 두 번째 발송이 나간다 — 이 파일에서 가장 비싼 오독이다.
  //
  // `ses_events.ses_message_id` 는 nullable 이므로 이 행은 상상이 아니라 스키마가
  // 허용하는 실제 행이다(`202609221700_ses_events.sql`). 그래서 여기서도 가짜
  // lookup 이 아니라 **진짜 저장소에 진짜 행을 넣어** 재현한다.
  // -------------------------------------------------------------------------
  for (const [label, storedSesId] of [
    ['NULL', null],
    ['빈 문자열', ''],
  ] as const) {
    it(`Send 는 있는데 ses_message_id 가 ${label} 이면 **재전송하지 않는다** (ADR-0004 의 셋째 unknown)`, async () => {
      const pool = testPool();
      const { service, transport } = serviceFor(pool);
      const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
      const events = createPostgresSesEventStore(pool);
      const deps = { ...gateDependenciesFor(service, transport), sendEvidence: events };

      const suffix = storedSesId === null ? 'null' : 'empty';
      const request = await sendThenDie(service, deps, fixture, `ac-i3-noid-${suffix}-${fixture.agentId}`);
      const messageId = request.messageId as string;

      // 소비자가 `Send` 를 기록했지만 id 를 싣지 못했다. **나간 것은 분명하다.**
      await events.record({
        eventType: 'send',
        messageId,
        sesMessageId: storedSesId,
        eventAt: new Date(),
        dedupeKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      });
      expect(await events.findSendEvidence(messageId)).toEqual({
        eventType: 'send',
        sesMessageId: storedSesId,
      });

      const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
      const retry = await dispatch(deps, { ...request, now: afterExpiry, leaseId: randomUUID() });

      // **이 한 줄이 이 테스트의 전부다.** `none` 으로 접히면 여기가 2 가 된다.
      expect(transport.calls()).toBe(1);
      expect(retry.kind).toBe('duplicate_suppressed');

      // 그리고 `sent` 로 확정하지도 않는다 — 확정에 필요한 id 가 없으니까.
      // 행은 `dispatching` 으로 남고, 새 lease 가 다음 시도까지의 시간을 산다.
      const settled = await statusOf(pool, messageId);
      expect(settled.status).toBe('dispatching');
      expect(settled.ses_message_id).toBeNull();
    });
  }

  it('Bounce 이벤트는 재전송을 막지 않는다 — 증거 목록은 send·delivery 뿐이다', async () => {
    const pool = testPool();
    const { service, transport } = serviceFor(pool);
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });
    const events = createPostgresSesEventStore(pool);
    const deps = { ...gateDependenciesFor(service, transport), sendEvidence: events };

    const request = await sendThenDie(service, deps, fixture, `ac-i3-bounce-${fixture.agentId}`);
    await events.record({
      eventType: 'bounce',
      messageId: request.messageId as string,
      sesMessageId: `ses-bounced-${randomUUID()}`,
      eventAt: new Date(),
      dedupeKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    });

    const afterExpiry = new Date(request.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
    await dispatch(deps, { ...request, now: afterExpiry, leaseId: randomUUID() });

    // 실제로는 bounce 가 언제나 Send 를 동반하므로 이 조합은 오지 않는다. 그래도
    // 단언해 두는 이유: 누군가 "반송도 나간 증거" 라며 목록에 넣는 날, 그 변경이
    // **재전송을 영구히 막는다**는 사실이 여기서 드러난다.
    expect(transport.calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-i4
// ---------------------------------------------------------------------------

/**
 * **AC-i4 — 릴리스와 TTL 만료를 동시에 트리거한다** (P2 에서 "해당 없음" → 실제 경합으로 교체).
 *
 * P1c 는 이 자리에 "승인 모드는 `evaluation_error` 로 끝나므로 경합 자체가 없다" 를 단언해 두었다.
 * P2 에서 승인 대기가 생겼으므로 그 단언은 거짓이 됐고, 여기서 **실제 경합**으로 바뀐다.
 *
 * 경합하는 것은 `approval_requests` 의 두 전이다 — 승인(`pending→approved`, 이긴 뒤 릴리스가 발송)과
 * 만료(`pending→expired`, 발송 없음). 둘 다 `WHERE status='pending'` 조건부 UPDATE 이고, 먼저 커밋한
 * 쪽이 유일한 전이자다. 진 쪽은 0행이고(no-op), 종단 상태는 트리거가 동결한다.
 *
 * **시계를 둘로 나눈다.** 같은 시각이면 두 전이는 TTL 조건으로 이미 배타적이다(승인은
 * `expires_at > now`, 만료는 `expires_at <= now`) — 그러면 경합이 아니라 시계가 판정한다. 그래서
 * 승인은 TTL 1초 전, 만료는 TTL 1초 뒤의 시각을 들고 **동시에** 들어온다 — 둘 다 자격이 있고,
 * 이기는 것은 행 잠금뿐이다. 분산 시스템에서 스위퍼와 승인 라우트의 시계가 어긋나는 것과 같은 모양이다.
 *
 * **전용 풀이다** — 두 전이가 서로 다른 커넥션에서 실제로 겹쳐야 한다.
 */
describe.skipIf(!DATABASE_AVAILABLE)('AC-i4 — 릴리스와 TTL 만료 동시 트리거', () => {
  const ROUNDS = 12;

  async function approvalFixture(pool: Parameters<typeof seedFixture>[0]): Promise<Fixture> {
    const fixture = await seedFixture(pool, { allowlist: [] });
    // 승인 모드로 v2 를 만든다 — 한도는 넉넉히(12 라운드가 분당 한도에 먼저 걸리면 Stage 7 을 못 본다).
    const limits = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
    await provisioningPool().query(
      `UPDATE agent_policies SET outbound_mode = 'approval_required', limits = $2::jsonb WHERE agent_id = $1`,
      [fixture.agentId, JSON.stringify(limits)],
    );
    await provisioningPool().query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
       VALUES ($1, 2, 'approval_required', '{}'::jsonb)`,
      [fixture.agentId],
    );
    await provisioningPool().query('UPDATE agent_policies SET current_version = 2 WHERE agent_id = $1', [fixture.agentId]);
    return fixture;
  }

  async function openApproval(
    service: OutboundServiceDependencies,
    transport: ReturnType<typeof countingTransport>,
    fixture: Fixture,
    recipient: string,
  ): Promise<{ readonly approvalId: string; readonly expiresAt: Date; readonly messageId: string }> {
    const prepared = await prepareOutbound(service, {
      routeId: 'send',
      agentId: fixture.agentId,
      idempotencyKey: `ac-i4-${recipient}`,
      fromAddress: fixture.address,
      recipients: [recipient],
      subject: 'AC-i4',
      text: '릴리스와 만료의 경합',
      html: null,
      isThreadReply: false,
      traceId: null,
      costCents: 0,
    });
    if (prepared.kind !== 'ready') throw new Error('ready 여야 한다');
    const outcome = await dispatch(gateDependenciesFor(service, transport), prepared.dispatchRequest);
    const finalized = await finalizeOutbound(service, prepared, outcome);
    if (finalized.kind !== 'pending_approval' || finalized.approval === null) {
      throw new Error(`승인 대기여야 한다: ${finalized.kind}`);
    }
    return {
      approvalId: finalized.approval.approvalId,
      expiresAt: finalized.approval.expiresAt,
      messageId: prepared.dispatchRequest.messageId as string,
    };
  }

  /**
   * 요청 행 잠금을 기다리는 **승인/만료 UPDATE** 세션 수. 두 전이가 동시에 막혀 있음을 확인하는 데 쓴다.
   * 문장으로 좁히는 이유: 전체 스위트는 다른 파일이 같은 DB 에서 병렬로 돌고, 그쪽의 잠금 대기를
   * 세면 "둘 다 막혔다" 가 거짓으로 참이 된다.
   */
  async function lockWaiters(pool: Parameters<typeof seedFixture>[0]): Promise<number> {
    const result = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'UPDATE approval_requests%'
          AND pid <> pg_backend_pid()`,
    );
    return result.rows[0]?.waiting ?? 0;
  }

  it(`승인→릴리스 ∥ 만료를 ${String(ROUNDS)}회 경합 — 매 라운드 최종 상태는 하나, SES 는 0 또는 1회`, async () => {
    const pool = newIndependentPool({ max: 8, connectionTimeoutMillis: 30_000 });
    try {
      const fixture = await approvalFixture(pool);
      const { service, transport } = serviceFor(pool);
      const approvals = createPostgresApprovalStore(pool);
      const winners = { approved: 0, expired: 0 };

      for (let round = 0; round < ROUNDS; round += 1) {
        const recipient = `ac-i4-${String(round)}-${fixture.agentId.slice(0, 6)}@example.com`;
        const opened = await openApproval(service, transport, fixture, recipient);
        const sesBefore = transport.calls();

        // ★ **경합을 실제로 만든다.** 이 장치가 없던 첫 버전은 12/12 라운드를 만료가 이겼다 —
        //   승인 쪽이 UPDATE 전에 조회 두 번을 하므로 항상 늦게 도착했고, "승인이 이긴 뒤 만료가 no-op"
        //   경로는 **한 번도 실행되지 않은 채 초록**이었다(이 저장소가 "경쟁 테스트가 큐만 증명" 이라
        //   부른 것과 같은 결함). 지금은 제3의 트랜잭션이 요청 행을 `FOR UPDATE` 로 쥔 채 두 전이를
        //   출발시키고, **둘 다 그 잠금에 막혀 있음을 확인한 뒤** 놓는다. 그러면 두 UPDATE 가 같은 행
        //   위에서 줄을 서고, 진 쪽은 이긴 쪽의 커밋을 보고 `WHERE status='pending'` 을 재평가해 0행이 된다.
        //   출발 순서를 라운드마다 번갈아 두 결말이 모두 나오게 한다.
        const holder = await pool.connect();
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM approval_requests WHERE id = $1 FOR UPDATE', [opened.approvalId]);

        const approveSide = async (): Promise<string> => {
          const decidedAt = new Date(opened.expiresAt.getTime() - 1000);
          const outcome = await approveRequest(approvals, {
            approvalId: opened.approvalId,
            decidedBy: 'owner@example.com',
            now: decidedAt,
            scope: 'recipient',
            confirmScope: null,
          });
          if (outcome.kind === 'approved') {
            // 릴리스는 **승인 시각의 시계**로 돈다 — 일정 행은 `decided_at` 부터 기한이다(승인 전이 트리거).
            // 승인을 TTL 직전 시각으로 찍고 릴리스를 벽시계로 돌리면 "아직 기한 전" 이 되어 아무것도 집지 않는다.
            await runApprovalRelease(
              { service: { ...service, now: () => decidedAt }, approvals, transport },
              { approvalId: opened.approvalId, traceId: null },
            );
          }
          return outcome.kind;
        };
        const expireSide = (): Promise<boolean> =>
          expireRequest(approvals, opened.approvalId, new Date(opened.expiresAt.getTime() + 1000));

        const waitForWaiters = async (count: number): Promise<void> => {
          for (let tries = 0; tries < 500 && (await lockWaiters(pool)) < count; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };

        let approving: Promise<string>;
        let expiring: Promise<boolean>;
        if (round % 2 === 0) {
          approving = approveSide();
          await waitForWaiters(1);
          expiring = expireSide();
        } else {
          expiring = expireSide();
          await waitForWaiters(1);
          approving = approveSide();
        }
        await waitForWaiters(2);
        // 두 전이가 **동시에** 같은 행 잠금에 막혀 있다 — 이것이 경합의 증거다.
        expect(await lockWaiters(pool)).toBeGreaterThanOrEqual(2);
        await holder.query('COMMIT');
        holder.release();

        const [approveKind, expired] = await Promise.all([approving, expiring]);

        const status = await pool.query<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [
          opened.approvalId,
        ]);
        const audit = await pool.query<{ decision: string; resolution_reason: string | null; approved_by: string | null }>(
          'SELECT decision, resolution_reason, approved_by FROM audit_logs WHERE approval_id = $1',
          [opened.approvalId],
        );
        const message = (await statusOf(pool, opened.messageId)).status;
        const sesDelta = transport.calls() - sesBefore;

        // **정확히 한쪽만 이겼다.**
        expect(approveKind === 'approved').not.toBe(expired);
        // 시도당 1행 — 경합이 행을 늘리지 않는다.
        expect(audit.rows).toHaveLength(1);

        if (approveKind === 'approved') {
          winners.approved += 1;
          expect(status.rows[0]?.status).toBe('approved');
          expect(sesDelta).toBe(1);
          expect(audit.rows[0]).toMatchObject({ decision: 'allowed', approved_by: 'owner@example.com', resolution_reason: 'sent' });
          expect(message).toBe('sent');
        } else {
          winners.expired += 1;
          expect(status.rows[0]?.status).toBe('expired');
          // ★ 만료는 절대 발송하지 않는다.
          expect(sesDelta).toBe(0);
          expect(audit.rows[0]).toMatchObject({ decision: 'denied', resolution_reason: 'approval_expired' });
          expect(message).toBe('denied');
        }
      }

      // **두 결말이 모두 실행됐다** — 한쪽만 나오면 다른 쪽의 no-op 은 증명되지 않은 것이다.
      expect(winners.approved).toBeGreaterThan(0);
      expect(winners.expired).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('진 쪽은 no-op 이다 — 만료가 먼저면 승인·릴리스가 SES 0, 승인이 먼저면 만료가 0행', async () => {
    const pool = testPool();
    const fixture = await approvalFixture(pool);
    const { service, transport } = serviceFor(pool);
    const approvals = createPostgresApprovalStore(pool);

    // (a) 만료가 이긴다.
    const lost = await openApproval(service, transport, fixture, `ac-i4-lost-${fixture.agentId.slice(0, 6)}@example.com`);
    expect(await expireRequest(approvals, lost.approvalId, new Date(lost.expiresAt.getTime() + 1000))).toBe(true);
    const late = await approveRequest(approvals, {
      approvalId: lost.approvalId,
      decidedBy: 'owner@example.com',
      now: new Date(lost.expiresAt.getTime() - 1000),
      scope: 'recipient',
      confirmScope: null,
    });
    expect(late).toEqual({ kind: 'not_pending', status: 'expired' });
    // 잡이 그래도 도착했다(큐 재전달) — 만료된 요청에는 릴리스 일정이 없어 관문에 서는 항목이 0이다
    // (그 뒤의 2차 방어선: 관문이 grant 없음으로 아무것도 쓰지 않는다).
    await runApprovalRelease({ service, approvals, transport }, { approvalId: lost.approvalId, traceId: null });
    expect(transport.calls()).toBe(0);

    // (b) 승인이 이긴다 — 뒤늦은 만료는 0행, 이미 나간 메일은 그대로다.
    const won = await openApproval(service, transport, fixture, `ac-i4-won-${fixture.agentId.slice(0, 6)}@example.com`);
    const approved = await approveRequest(approvals, {
      approvalId: won.approvalId,
      decidedBy: 'owner@example.com',
      now: new Date(),
      scope: 'recipient',
      confirmScope: null,
    });
    expect(approved.kind).toBe('approved');
    // 같은 릴리스 잡이 **두 번 동시에** 와도(SQS 재전달) SES 는 1회 — lease 가 죽인다.
    await Promise.all([
      runApprovalRelease({ service, approvals, transport }, { approvalId: won.approvalId, traceId: null }),
      runApprovalRelease({ service, approvals, transport }, { approvalId: won.approvalId, traceId: null }),
    ]);
    expect(transport.calls()).toBe(1);
    expect(await expireRequest(approvals, won.approvalId, new Date(won.expiresAt.getTime() + 1000))).toBe(false);
    expect((await statusOf(pool, won.messageId)).status).toBe('sent');
  });
});
