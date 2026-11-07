/**
 * `agent_api_keys.last_used_at` — 토큰 마지막 사용 시각 (202609241400, US-007).
 *
 * REST 경로가 실제로 `src/identity/agent-token.ts` `authenticateAgentToken`(→ `store.touch`)을 지나는지
 * 실 Postgres · **앱 롤 풀**(`testPool()`) 위에서 본다. MCP 쪽의 같은 명제는
 * `test/integration/mcp/mcp-server.test.ts`("MCP 인증도 REST 와 같은 authenticateRequest 를 지난다")에 있다 —
 * 둘 다 `src/api/auth.ts` `authenticateRequest` 하나를 부르므로, 이 파일은 그 함수가 **HTTP 라우트에서** 실제로
 * app-role 권한(202609241400 의 GRANT)으로 갱신에 성공하는지를 본다(순수 로직은 `test/unit/identity/agent-token.test.ts`).
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { afterAll, describe, expect, it } from 'vitest';

import type { AuditReader } from '../../../src/api/audit-reader';
import { authenticateRequest } from '../../../src/api/auth';
import type { ApiRequest } from '../../../src/api/http';
import { handleAuditQuery } from '../../../src/api/routes/audit';
import { getAgentOp } from '../../../src/admin/ops/agents';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

/** `handleAuditQuery` 가 인증 뒤에 부르는 조회 — 행을 찾지 못하게만 하면 된다(우리는 인증만 본다). */
const EMPTY_AUDIT: AuditReader = {
  byMessageId: () => Promise.resolve([]),
  byAgentId: () => Promise.resolve([]),
};

describe.skipIf(!DATABASE_AVAILABLE)('REST 인증 → agent_api_keys.last_used_at (202609241400, US-007)', () => {
  it('성공한 인증마다 last_used_at 이 갱신된다 (앱 롤 풀)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const issued = issueAgentToken(fixture.agentId, ['audit:read']);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const before = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
      [issued.tokenHash],
    );
    expect(before.rows[0]?.last_used_at).toBeNull();

    const request: ApiRequest = {
      headers: { authorization: `Bearer ${issued.plaintext}` },
      query: { message_id: '00000000-0000-0000-0000-000000000000' },
      body: undefined,
    };
    const tokens = createPostgresAgentTokenStore(pool);
    const response = await handleAuditQuery({ tokens, audit: EMPTY_AUDIT, now: () => new Date() }, request);
    // 인증은 통과했고(그렇지 않았다면 401), 존재하지 않는 message_id 라 404 — touch 는 이미 일어난 뒤다.
    expect(response.status).toBe(404);

    const after = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
      [issued.tokenHash],
    );
    expect(after.rows[0]?.last_used_at).not.toBeNull();

    // 관리 API 의 에이전트 응답(`AgentView.lastUsedAt`, 202609241400)도 같은 값을 본다.
    const view = await getAgentOp(pool, fixture.agentId);
    expect(view?.lastUsedAt).not.toBeNull();
    expect(view?.lastUsedAt).toBe(after.rows[0]?.last_used_at?.toISOString());
  });

  it('폐기된 토큰은 401 이고 last_used_at 은 갱신되지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const issued = issueAgentToken(fixture.agentId, ['audit:read']);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    await writer.insert({ agentId: fixture.agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
    await writer.revoke(issued.tokenHash, new Date());

    const request: ApiRequest = {
      headers: { authorization: `Bearer ${issued.plaintext}` },
      query: { message_id: '00000000-0000-0000-0000-000000000000' },
      body: undefined,
    };
    const tokens = createPostgresAgentTokenStore(pool);
    const outcome = await authenticateRequest(tokens, request, new Date());
    expect(outcome.kind).toBe('error');

    const after = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
      [issued.tokenHash],
    );
    expect(after.rows[0]?.last_used_at).toBeNull();
  });

  it('first_used_at(202609301530) — 처음 쓰인 분을 한 번만 적는다(앱 롤 인증 경로) · 뒤의 사용은 바꾸지 않는다 · 직접 쓸 수 없다 · 옛 토큰은 NULL 그대로', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const tokens = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['audit:read']);
    await writer.insert({ agentId: fixture.agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
    const read = async (hash: string) =>
      (await pool.query<{ first_used_at: Date | null; last_used_at: Date | null }>('SELECT first_used_at, last_used_at FROM agent_api_keys WHERE token_hash = $1', [hash]))
        .rows[0];
    expect(await read(issued.tokenHash)).toEqual({ first_used_at: null, last_used_at: null });

    const first = new Date(Date.now() - 10 * 60_000);
    await tokens.touch(issued.tokenHash, first);
    const once = await read(issued.tokenHash);
    expect(once?.first_used_at).toEqual(once?.last_used_at);
    expect(once?.first_used_at?.getTime()).toBe(Math.floor(first.getTime() / 60_000) * 60_000);

    // 몇 분 뒤 다시 쓰인다 — last_used_at 만 앞으로, first_used_at 은 그대로.
    await tokens.touch(issued.tokenHash, new Date(first.getTime() + 5 * 60_000));
    const later = await read(issued.tokenHash);
    expect(later?.first_used_at).toEqual(once?.first_used_at);
    expect(later?.last_used_at?.getTime()).toBeGreaterThan(once?.last_used_at?.getTime() ?? 0);

    // 직접 쓰기 — 앱 롤은 칸 권한이 없고(42501), 소유자 롤도 불변 트리거가 막는다(23514).
    const state = (target: typeof pool, sql: string): Promise<string> =>
      target.query(sql, [issued.tokenHash]).then(
        () => 'ok',
        (error: { code?: string }) => String(error.code),
      );
    expect(await state(pool, 'UPDATE agent_api_keys SET first_used_at = now() WHERE token_hash = $1')).toBe('42501');
    expect(await state(provisioningPool(), 'UPDATE agent_api_keys SET first_used_at = now() WHERE token_hash = $1')).toBe('23514');
    expect(await state(provisioningPool(), 'UPDATE agent_api_keys SET first_used_at = NULL WHERE token_hash = $1')).toBe('23514');

    // 1530 이전에 이미 쓰인 토큰(last_used_at 이 있고 first_used_at 이 NULL) — 뒤의 사용은 "처음" 이 아니다. NULL 로 남는다(소급하지 않는다).
    const old = issueAgentToken(fixture.agentId, ['audit:read']);
    await writer.insert({ agentId: old.agentId, tokenHash: old.tokenHash, capabilities: old.capabilities, expiresAt: null });
    // 옛 상태를 만든다 — 한 트랜잭션 안에서 적는 트리거만 잠시 끄고(다른 세션은 꺼진 상태를 보지 못한다 · 커밋 때 다시 켜져 있다).
    const client = await provisioningPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE agent_api_keys DISABLE TRIGGER agent_api_keys_stamp_first_used_at');
      await client.query(`UPDATE agent_api_keys SET last_used_at = date_trunc('minute', now()) - interval '1 day' WHERE token_hash = $1`, [old.tokenHash]);
      await client.query('ALTER TABLE agent_api_keys ENABLE TRIGGER agent_api_keys_stamp_first_used_at');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await tokens.touch(old.tokenHash, new Date());
    const legacy = await read(old.tokenHash);
    expect(legacy?.first_used_at).toBeNull();
    expect(legacy?.last_used_at).not.toBeNull();
  });

  it('보안 검토 L3 — first_used_at 은 위조할 수 없다: INSERT 는 값을 버린다 · 미래 시각은 now() 로 자른다 · 한 번 적힌 뒤 last_used_at 이 NULL 로 갔다 와도 다시 적지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const owner = provisioningPool();
    const read = async (hash: string) =>
      (await owner.query<{ first_used_at: Date | null; last_used_at: Date | null }>('SELECT first_used_at, last_used_at FROM agent_api_keys WHERE token_hash = $1', [hash])).rows[0];

    // ⓐ INSERT — 소유자 롤이 first_used_at 을 미리 채워도 NULL 로 남는다(BEFORE INSERT 트리거).
    const forged = issueAgentToken(fixture.agentId, ['audit:read']);
    await owner.query(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, first_used_at)
       VALUES ($1, $2, $3::agent_token_capability[], now() - interval '30 days')`,
      [fixture.agentId, forged.tokenHash, forged.capabilities],
    );
    expect(await read(forged.tokenHash)).toEqual({ first_used_at: null, last_used_at: null });

    // ⓑ 처음 쓰일 때 적는 값은 last_used_at 이 아니라 least(last_used_at, now()) — 미래 시각을 밀어 넣어도 지금을 넘지 못한다.
    await owner.query(`UPDATE agent_api_keys SET last_used_at = now() + interval '1 day' WHERE token_hash = $1`, [forged.tokenHash]);
    const stamped = await owner.query<{ first_used_at: Date; not_future: boolean }>(
      'SELECT first_used_at, first_used_at <= now() AS not_future FROM agent_api_keys WHERE token_hash = $1',
      [forged.tokenHash],
    );
    expect(stamped.rows[0]?.not_future).toBe(true);
    const first = stamped.rows[0]?.first_used_at;
    expect(first).toBeInstanceOf(Date);

    // ⓒ last_used_at 이 NULL 로 갔다가 다시 값이 돼도(NULL → 값) first_used_at 은 그대로다.
    await owner.query('UPDATE agent_api_keys SET last_used_at = NULL WHERE token_hash = $1', [forged.tokenHash]);
    expect((await read(forged.tokenHash))?.first_used_at).toEqual(first);
    await owner.query(`UPDATE agent_api_keys SET last_used_at = now() WHERE token_hash = $1`, [forged.tokenHash]);
    expect((await read(forged.tokenHash))?.first_used_at).toEqual(first);
  });
});
