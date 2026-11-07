/**
 * `createPostgresAgentTokenStore` — agent-scoped 토큰 저장소 (§47).
 *
 * 이 층이 잡는 것은 두 가지다:
 *   ① **ENUM 배열이 문자열로 돌아오지 않는가.** `node-postgres` 는 사용자 정의 ENUM
 *      배열의 OID 를 모르므로 캐스팅 없이는 `'{messages:send}'` 라는 원시 문자열이 온다.
 *      그 값은 어떤 권한 검사도 통과하지 못하고, 증상은 "모든 요청이 권한 없음" 이다.
 *   ② **폐기가 행 삭제가 아닌가.** audit 가 "어느 토큰이 보냈는가" 에 답해야 한다.
 *
 * **발급·폐기는 소유자 롤로, 조회·인증(읽기)은 앱 롤로 한다.** 운영에서 발급·폐기는 CLI(소유자 롤)·admin
 * (`atmark_admin`)만 하고, 앱 롤(api)은 `agent_api_keys` 에 SELECT 뿐이다(202609230750 — 앱 롤이 INSERT·`revoked_at`
 * UPDATE 를 가지면 api 탈취가 토큰을 발급하거나 폐기한 토큰을 되살린다, 2차 검증 H-A·H-B).
 *
 * **`touch`(마지막 사용 시각)는 예외다(202609241400, US-007) — 앱 롤도 `last_used_at` 한 칸만 UPDATE 할 수 있다.**
 * 인증 경로(api·mcp)가 매 요청 인증 성공마다 부르는 것이 바로 앱 롤이기 때문이다. 이 파일의 touch 테스트는
 * 그래서 소유자 롤(`writer`)과 앱 롤(`store`) 양쪽으로 돈다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import {
  authenticateAgentToken,
  hashAgentToken,
  issueAgentToken,
} from '../../../src/identity/agent-token';
import { closeTestPool, DATABASE_AVAILABLE, hex64, provisioningPool, seedFixture, testPool } from './support/harness';

describe.skipIf(!DATABASE_AVAILABLE)('PostgresAgentTokenStore', () => {
  afterAll(closeTestPool);

  it('발급한 토큰을 해시로 찾고, 권한이 **문자열 배열**로 온다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());

    const issued = issueAgentToken(fixture.agentId, ['messages:send', 'audit:read']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const record = await store.findByHash(issued.tokenHash);
    expect(record?.agentId).toBe(fixture.agentId);
    expect(record?.capabilities).toEqual(['messages:send', 'audit:read']);
    expect(record?.revokedAt).toBeNull();
    expect(record?.expiresAt).toBeNull();
  });

  it('평문 토큰으로 인증이 끝까지 통과한다 — 저장소와 규칙이 같은 해시를 본다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());

    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const result = await authenticateAgentToken(store, issued.plaintext, new Date());
    expect(result).toMatchObject({
      kind: 'authenticated',
      principal: { agentId: fixture.agentId, capabilities: ['messages:send'] },
    });
  });

  it('없는 해시는 `null` — 예외가 아니다', async () => {
    const pool = testPool();
    expect(await createPostgresAgentTokenStore(pool).findByHash(hex64())).toBeNull();
  });

  it('폐기는 행을 지우지 않고 `revoked_at` 을 찍는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());

    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const revokedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(await writer.revoke(issued.tokenHash, revokedAt)).toBe(true);
    // 재폐기는 최초 시각을 덮어쓰지 않는다 — 그 시각이 사고 조사의 경계선이다.
    expect(await writer.revoke(issued.tokenHash, new Date())).toBe(false);

    const record = await store.findByHash(issued.tokenHash);
    expect(record?.revokedAt?.toISOString()).toBe(revokedAt.toISOString());

    const auth = await authenticateAgentToken(store, issued.plaintext, new Date());
    expect(auth).toEqual({ kind: 'rejected', reason: 'token_revoked' });
  });

  it('행 삭제는 DB 트리거가 거부한다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    await expect(
      pool.query('DELETE FROM agent_api_keys WHERE token_hash = $1', [issued.tokenHash]),
    ).rejects.toThrow();
  });

  it('권한 변경은 UPDATE 가 아니다 — 트리거가 거부한다 (폐기 + 재발급이 경로다)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['audit:read']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    await expect(
      pool.query(
        `UPDATE agent_api_keys SET capabilities = '{messages:send}'::agent_token_capability[]
          WHERE token_hash = $1`,
        [issued.tokenHash],
      ),
    ).rejects.toThrow();
  });

  it('권한 0개는 DB CHECK 가 막는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());

    await expect(
      writer.insert({
        agentId: fixture.agentId,
        tokenHash: hashAgentToken('atk_agent_x'),
        capabilities: [],
        expiresAt: null,
      }),
    ).rejects.toThrow();
  });

  it('같은 해시를 두 번 넣을 수 없다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    const insert = {
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    };

    await writer.insert(insert);
    await expect(writer.insert(insert)).rejects.toThrow();
  });

  it('last_used_at 은 갱신할 수 있다 — 분 단위로 절삭된다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const usedAt = new Date('2026-10-02T00:00:37.123Z');
    await store.touch(issued.tokenHash, usedAt);

    const row = await pool.query<{ last_used_at: Date }>(
      'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
      [issued.tokenHash],
    );
    // 초·밀리초는 없다 — `date_trunc('minute', …)`.
    expect(row.rows[0]?.last_used_at.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('앱 롤(`store`)이 last_used_at 을 갱신할 수 있다 (202609241400, US-007) — 같은 분 안의 반복 호출은 0행', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    const readLastUsedAt = async (): Promise<string | null> => {
      const row = await pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
        [issued.tokenHash],
      );
      return row.rows[0]?.last_used_at?.toISOString() ?? null;
    };

    const firstCall = new Date('2026-10-02T00:00:10.000Z');
    await store.touch(issued.tokenHash, firstCall);
    expect(await readLastUsedAt()).toBe('2026-10-02T00:00:00.000Z');

    // 같은 분 안의 두 번째 호출 — 쓰기 증폭 방지, UPDATE 0행(값이 바뀌지 않는다).
    const secondCall = new Date('2026-10-02T00:00:50.000Z');
    await store.touch(issued.tokenHash, secondCall);
    expect(await readLastUsedAt()).toBe('2026-10-02T00:00:00.000Z');

    // 다음 분 — 다시 갱신된다.
    const nextMinute = new Date('2026-10-02T00:01:05.000Z');
    await store.touch(issued.tokenHash, nextMinute);
    expect(await readLastUsedAt()).toBe('2026-10-02T00:01:00.000Z');
  });

  it('폐기된 토큰은 touch 해도 last_used_at 이 갱신되지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresAgentTokenStore(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });
    await writer.revoke(issued.tokenHash, new Date('2026-10-02T00:00:00.000Z'));

    await store.touch(issued.tokenHash, new Date('2026-10-02T00:05:00.000Z'));

    const row = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM agent_api_keys WHERE token_hash = $1',
      [issued.tokenHash],
    );
    expect(row.rows[0]?.last_used_at).toBeNull();
  });

  it('앱 롤은 last_used_at 이외의 칸(revoked_at 포함)을 바꿀 수 없다 — permission denied (202609241400)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });

    await expect(
      pool.query('UPDATE agent_api_keys SET revoked_at = now() WHERE token_hash = $1', [issued.tokenHash]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('last_used_at 은 뒤로 갈 수 없다 — 소유자 롤이라도(가드 트리거, 202609241400)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const writer = createPostgresAgentTokenStore(provisioningPool());
    const owner = provisioningPool();
    const issued = issueAgentToken(fixture.agentId, ['messages:send']);
    await writer.insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });
    await writer.touch(issued.tokenHash, new Date('2026-10-02T00:05:00.000Z'));

    await expect(
      owner.query('UPDATE agent_api_keys SET last_used_at = $2 WHERE token_hash = $1', [
        issued.tokenHash,
        new Date('2026-10-01T00:00:00.000Z'),
      ]),
    ).rejects.toThrow(/cannot move backward/);
  });
});
