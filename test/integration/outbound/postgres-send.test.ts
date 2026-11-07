/**
 * AC-i1 — **동시 호출에서도 SES 호출 정확히 1회.** 실제 Postgres 위에서만 성립하는 명제다.
 *
 * `send.test.ts` 의 인메모리 저장소는 같은 키의 **순차** 재호출을 막는다. 그런데 계획
 * §4.5-1 이 요구하는 것은 *"동일 `Idempotency-Key` 로 **100회 동시** 호출 시 SES 호출
 * 정확히 1회, `messages` 행 1개, audit 행 1개"* 이고, 그 보장은 애플리케이션 코드가
 * 아니라 **`(agent_id, idempotency_key)` 유니크 인덱스**가 한다. 가짜 맵으로 그것을
 * "증명" 하면 가짜 맵의 성질을 증명한 것이 된다.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다**(`test/integration/db/support/harness.ts`
 * 와 같은 환경 게이트). 건너뛴 사실은 테스트 이름에 드러난다 — DB 없는 기계에서
 * `pnpm test` 가 빨간불이 되면 아무도 그 빨간불을 읽지 않게 된다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresAuditReader } from '../../../src/api/audit-reader';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import type { ApiRequest } from '../../../src/api/http';
import { handleAuditQuery } from '../../../src/api/routes/audit';
import { handleSend } from '../../../src/api/routes/send';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import { countingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const RECIPIENT = 'concurrency-probe@example.com';

/** 동시 호출 수. 100 은 로컬 Postgres 의 커넥션 풀(max 4)을 줄 세우기만 하고 명제는 같다. */
const CONCURRENCY = 20;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('AC-i1 (실 Postgres) — 동시 호출과 멱등성', () => {
  it(`같은 Idempotency-Key 로 ${String(CONCURRENCY)}회 동시 호출 → SES 1회 · messages 1행 · audit 1행`, async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });

    const token = issueAgentToken(fixture.agentId);
    const tokens = createPostgresAgentTokenStore(pool);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: token.tokenHash,
      capabilities: token.capabilities,
      expiresAt: null,
    });

    const gateStores = createPostgresGateStores(pool);
    const transport = countingTransport();
    const service: OutboundServiceDependencies = {
      source: gateStores.source,
      audit: gateStores.audit,
      dispatchStore: gateStores.leases,
      serializer: gateStores.serializer,
      sendEvidence: gateStores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content: createInMemoryContentStore(),
      leaseTtlSeconds: 300,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now: () => new Date(),
    };

    const key = `ac-i1-${fixture.agentId}`;
    const request: ApiRequest = {
      headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': key },
      query: {},
      body: {
        agent_id: fixture.agentId,
        from: fixture.address,
        to: [RECIPIENT],
        subject: 'AC-i1',
        text: '동시 호출',
        cost_cents: 0,
      },
    };

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => handleSend({ tokens, service, transport }, request)),
    );

    // 진 쪽도 오류가 아니라 **최초 시도의 현재 상태**를 받는다. 200(이미 확정)과
    // 202(승자가 아직 전송 중)가 모두 정상이다 — 경합에서 진 호출이 "아직 모른다" 를
    // 200 으로 말하면 클라이언트가 발송을 확정으로 읽는다.
    for (const response of responses) expect([200, 202]).toContain(response.status);

    const messageIds = new Set(responses.map((response) => response.body['message_id']));
    expect(messageIds.size).toBe(1);

    const messageId = [...messageIds][0] as string;
    const rows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE agent_id = $1 AND idempotency_key = $2',
      [fixture.agentId, key],
    );
    const audits = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE message_id = $1',
      [messageId],
    );

    expect(transport.calls()).toBe(1);
    expect(rows.rows[0]?.count).toBe('1');
    expect(audits.rows[0]?.count).toBe('1');

    // 상태기계가 종단에 갔다 — **관문이 아니라 우리가** settleSent 로 확정한 결과다.
    const status = await pool.query<{ status: string; ses_message_id: string | null; recipient_count: number }>(
      'SELECT status, ses_message_id, recipient_count FROM messages WHERE id = $1',
      [messageId],
    );
    expect(status.rows[0]?.status).toBe('sent');
    expect(status.rows[0]?.ses_message_id).not.toBeNull();
    // **워밍업 캡의 눈금.** 수신자 1명이므로 1이어야 한다 — 0 이면 캡에 기여하지 않는 발송이 된다.
    expect(status.rows[0]?.recipient_count).toBe(1);

    // AC-9 — 같은 시도를 조회 API 로도 설명할 수 있다.
    const audit = await handleAuditQuery(
      { tokens, audit: createPostgresAuditReader(pool), now: () => new Date() },
      { headers: { authorization: `Bearer ${token.plaintext}` }, query: { message_id: messageId }, body: null },
    );
    const attempts = audit.body['attempts'] as readonly Record<string, unknown>[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.['decision']).toBe('allowed');
    expect(attempts[0]?.['resolution_reason']).toBe('sent');
  });

  it('allowlist 밖 수신자는 SES 호출 0회로 막히고 audit 에 사유가 남는다 (Round 2 재현 방지)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool, { allowlist: [RECIPIENT] });

    const token = issueAgentToken(fixture.agentId);
    const tokens = createPostgresAgentTokenStore(pool);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: token.tokenHash,
      capabilities: token.capabilities,
      expiresAt: null,
    });

    const gateStores = createPostgresGateStores(pool);
    const transport = countingTransport();
    const service: OutboundServiceDependencies = {
      source: gateStores.source,
      audit: gateStores.audit,
      dispatchStore: gateStores.leases,
      serializer: gateStores.serializer,
      sendEvidence: gateStores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content: createInMemoryContentStore(),
      leaseTtlSeconds: 300,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now: () => new Date(),
    };

    const response = await handleSend(
      { tokens, service, transport },
      {
        headers: {
          authorization: `Bearer ${token.plaintext}`,
          'idempotency-key': `blocked-${fixture.agentId}`,
        },
        query: {},
        body: {
          agent_id: fixture.agentId,
          from: fixture.address,
          to: ['blocked-test@atmark.ai'],
          subject: '차단',
          text: '나가면 안 된다',
        },
      },
    );

    expect(response.status).toBe(403);
    expect(transport.calls()).toBe(0);

    const messageId = response.body['message_id'] as string;
    const audits = await pool.query<{ decision: string; reasons: string[]; policy_version: number | null }>(
      'SELECT decision, reasons, policy_version FROM audit_logs WHERE message_id = $1',
      [messageId],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.decision).toBe('denied');
    expect(audits.rows[0]?.reasons).toContain('recipient_not_allowlisted');
    // 거부에도 정책 버전이 찍힌다 — "어느 정책이 막았는가" 가 사후에 답해진다(AC-9).
    expect(audits.rows[0]?.policy_version).toBe(1);

    // 거부된 시도의 messages 행은 **종단 `denied`** 다 (P1b 리뷰 MAJOR 3).
    // 카운터(`dispatching`/`sent`)에는 여전히 들어가지 않으므로 한도·캡을 소비하지
    // 않는다 — 거부가 처벌이 되면 안 된다는 원래 근거는 그대로다. 달라진 것은
    // `pending` 으로 **영원히 남지 않는다**는 것이고, 그래야 같은 키의 재호출이
    // 최초의 403 을 재현한다(§4.5-1).
    const status = await pool.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [
      messageId,
    ]);
    expect(status.rows[0]?.status).toBe('denied');
  });
});
