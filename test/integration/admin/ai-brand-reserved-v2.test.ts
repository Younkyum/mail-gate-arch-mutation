/**
 * **AI 브랜드 예약 확장 · claude@ 삭제 가능**(202610141200·1201, 진윤겸 2026-10-14) — 실제 Postgres.
 *
 * 되돌리면 빨개져야 하는 것:
 *   ① DB 예약 목록 = TS `RESERVED_LOCAL_PARTS`(값·순서) · 운영자 목록 = TS `OPERATOR_ASSIGNABLE_ADDRESSES`(claude@ 없음) · 1201 이 CHECK 를 검증했다.
 *   ② 새 이름은 콘솔에서 400 — 만들기 `invalid_local_part` · 별칭 `reserved_local_part`, 대소문자로도 못 피한다. 비슷한 이름(`grok-fan`)은 된다.
 *   ①-b 브랜드 비교 키 = TS `AGENT_BRAND_RESERVED_KEYS` — 구분자 변형(`claude.code`·`chat-gpt`·`open_ai`·`gpt_5`·`hyperclova_x`)도 DB 23514(리뷰 L2).
 *   ③ 예약 이전 행(`atmark_reserved_grandfathered_address_keys()` — (id, 주소) 쌍)은 그대로 쓴다 — 별칭 폐기가 된다. 같은 이름의 **새** 행은 23514.
 *   ⑤ 주소 행은 지울 수 없다(소유자 롤도) · 지우는 트리거를 꺼서 굳힌 행을 지워도 같은 id 로 다른 예약 이름을 넣으면 23514(리뷰 L1 — 쌍).
 *   ④ 예약 이전 `claude@` 를 쥔 에이전트는 이제 지워진다(`operator_reserved` 아님 · 트리거 42501 아님). 지운 뒤 `claude@` 는
 *      같은 조직 · 다른 조직 · 퇴역 31일 뒤 · 운영자 허가 어느 길로도 다시 생기지 않는다(보류가 풀린 뒤에도 예약 CHECK 23514).
 *
 * 예약 이전 행은 공유 테스트 DB 에 남기지 않는다 — 소유자 트랜잭션 안에서 함수를 그 쌍으로 바꿔 심고 끝나면 되돌린다(운영 DB 에서 1200 이
 * 적용 순간의 쌍을 굳히는 것과 같은 모양 — 실제 적용 경로는 test/integration/db/ai-brand-reserved-v2-apply.test.ts).
 */

import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { deleteAgentOp } from '../../../src/admin/ops/agents';
import { transactionPool } from '../../../src/admin/ops/transaction';
import type { AgentId } from '../../../src/db/schema';
import { AGENT_BRAND_RESERVED_KEYS, OPERATOR_ASSIGNABLE_ADDRESSES, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}

describe.skipIf(!AVAILABLE)('AI 브랜드 예약 확장 · claude@ 삭제 (202610141200)', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    deps = adminDeps(admin, { features: { addressAliases: true } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  async function fixture(): Promise<{ orgId: string; session: Session; agentId: string }> {
    const org = await newOrganization(owner, 'beta');
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'brands', localPart: `br-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return { orgId: org.id, session, agentId: (created.json() as { agent: { id: string } }).agent.id };
  }

  /** 소유자 트랜잭션 — 끝나면 되돌린다. */
  async function rolledBack(run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await run(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  async function attempt(client: PoolClient, run: () => Promise<unknown>): Promise<string> {
    await client.query('SAVEPOINT s');
    const state = await codeOf(run);
    await client.query(state === 'ok' ? 'RELEASE SAVEPOINT s' : 'ROLLBACK TO SAVEPOINT s');
    return state;
  }

  /** 예약 이전 행을 심는다 — 1200 이 운영 DB 에서 하는 것처럼 함수가 그 (id, 주소) 쌍을 돌려주게 바꾼 뒤 그 id 로 INSERT 한다. */
  async function legacy(client: PoolClient, agentId: string, address: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `DO $do$ BEGIN EXECUTE format('CREATE OR REPLACE FUNCTION atmark_reserved_grandfathered_address_keys() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::text[] $b$',
         (atmark_reserved_grandfathered_address_keys() || ARRAY['${id} ${address}'])::text); END $do$`,
    );
    await client.query(`INSERT INTO agent_addresses (id, agent_id, address, domain, is_primary) VALUES ($1, $2, $3, 'atmark.ai', false)`, [id, agentId, address]);
    return id;
  }

  const insertAddress = (client: PoolClient, agentId: string, address: string, primary = false) =>
    client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', $3)`, [agentId, address, primary]);

  it('① DB 목록 = TS(값·순서) · 운영자 목록에 claude@ 없음 · claude 는 예약 · CHECK 검증됨', async () => {
    const row = (
      await owner.query<{ parts: string[]; operators: string[]; validated: boolean }>(
        `SELECT atmark_reserved_local_parts() AS parts, atmark_operator_assignable_addresses() AS operators,
                (SELECT convalidated FROM pg_constraint WHERE conname = 'agent_addresses_not_reserved_local_part') AS validated`,
      )
    ).rows[0];
    expect(row?.parts).toEqual([...RESERVED_LOCAL_PARTS]);
    expect(row?.operators).toEqual([...OPERATOR_ASSIGNABLE_ADDRESSES]);
    expect(row?.operators).not.toContain('claude@atmark.ai');
    expect(row?.parts).toContain('claude');
    expect(row?.validated).toBe(true);
    const keys = await owner.query<{ keys: string[] }>('SELECT atmark_brand_reserved_keys() AS keys');
    expect(keys.rows[0]?.keys).toEqual([...AGENT_BRAND_RESERVED_KEYS]);
  });

  it('①-b 구분자 변형 — DB 23514 · 콘솔 400 · 접두·접미 이름과 고객 도메인 · 운영 예약의 변형은 된다', async () => {
    const f = await fixture();
    const variants = ['claude.code', 'claude_code', 'chat-gpt', 'open_ai', 'gpt_5', 'hyperclova_x', 'c.l.a.u.d.e', 'deep-seek', 'x.ai'];
    await rolledBack(async (client) => {
      for (const local of variants) expect(await attempt(client, () => insertAddress(client, f.agentId, `${local}@atmark.ai`)), local).toBe('23514');
      // 브랜드 키가 아닌 것 — 접두·접미(`grok-fan`) · 운영 예약은 정확 일치만(`no_reply` 는 `no-reply` 가 아니다).
      for (const local of [`grok-fan-${suffix()}`, `chat-gpt-helper-${suffix()}`, `no_reply-${suffix()}`]) {
        expect(await attempt(client, () => insertAddress(client, f.agentId, `${local}@atmark.ai`)), local).toBe('ok');
      }
    });
    for (const localPart of ['claude.code', 'chat-gpt', 'open_ai', 'gpt_5', 'hyperclova_x']) {
      const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: 'squat', localPart } }));
      expect(created.statusCode, localPart).toBe(400);
      expect(created.json(), localPart).toMatchObject({ error: 'invalid_local_part' });
    }
  });

  it('② 새 이름 — 콘솔 만들기 · 별칭 모두 400 · 비슷한 이름은 된다', async () => {
    const f = await fixture();
    for (const localPart of ['grokbot', 'GPT-5', 'naver', 'hyperclova-x', 'claudebot', 'deepseek-ai']) {
      const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: 'squat', localPart } }));
      expect(created.statusCode, localPart).toBe(400);
      expect(created.json(), localPart).toMatchObject({ error: 'invalid_local_part' });
      const alias = await call(deps, 'POST', `/api/agents/${f.agentId}/aliases`, authed(f.session, { body: { localPart } }));
      expect(alias.statusCode, localPart).toBe(400);
      expect(alias.json(), localPart).toMatchObject({ error: 'reserved_local_part' });
    }
    const near = await call(deps, 'POST', `/api/agents/${f.agentId}/aliases`, authed(f.session, { body: { localPart: `grok-fan-${suffix()}` } }));
    expect(near.statusCode, near.body).toBe(201);
  });

  it('③ 예약 이전 행(grokbot@)은 그대로 쓴다 — 폐기가 된다 · 같은 이름의 새 행은 23514', async () => {
    const f = await fixture();
    const other = await fixture();
    await rolledBack(async (client) => {
      const id = await legacy(client, f.agentId, 'grokbot@atmark.ai');
      expect(await attempt(client, () => insertAddress(client, other.agentId, 'xai@atmark.ai'))).toBe('23514');
      expect(await attempt(client, () => client.query('UPDATE agent_addresses SET retired_at = now() WHERE id = $1', [id]))).toBe('ok');
      // 같은 조직 곧바로(재발급 보류가 허용하는 길)도 새 행이라 CHECK 가 막는다.
      expect(await attempt(client, () => insertAddress(client, f.agentId, 'grokbot@atmark.ai'))).toBe('23514');
    });
  });

  it('④ 예약 이전 claude@ 를 쥔 에이전트는 지워진다 — 그 뒤 claude@ 는 어느 길로도 다시 생기지 않는다(예약 CHECK)', async () => {
    const holder = await fixture();
    const other = await fixture();
    await rolledBack(async (client) => {
      await legacy(client, holder.agentId, 'claude@atmark.ai');
      const deleted = await deleteAgentOp(transactionPool(client), holder.orgId, holder.agentId as AgentId);
      expect(deleted.addresses).toContain('claude@atmark.ai');
      const state = await client.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1', [holder.agentId]);
      expect(state.rows[0]?.status).toBe('disabled');
      const held = await client.query<{ live: number }>(`SELECT count(*)::int AS live FROM agent_addresses WHERE address = 'claude@atmark.ai' AND retired_at IS NULL`);
      expect(held.rows[0]?.live).toBe(0);

      // 같은 조직의 새 에이전트(재발급 보류는 같은 조직을 곧바로 허용한다) — CHECK 23514.
      const fresh = (await client.query<{ id: string }>(`SELECT replace(gen_random_uuid()::text, '-', '') AS id`)).rows[0]?.id ?? '';
      await client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'again', 'active', 'beta', 0)`, [
        fresh,
        holder.orgId,
      ]);
      expect(await attempt(client, () => insertAddress(client, fresh, 'claude@atmark.ai', true))).toBe('23514');
      expect(await attempt(client, () => insertAddress(client, fresh, 'claude@atmark.ai'))).toBe('23514');
      // 다른 조직 — 보류 기간 안은 재발급 보류 트리거(BEFORE INSERT — CHECK 보다 먼저)가 23505 · 31일 뒤 보류가 풀려도 예약 CHECK 가 23514.
      expect(await attempt(client, () => insertAddress(client, other.agentId, 'claude@atmark.ai'))).toBe('23505');
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_retire_guard');
      await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '31 days' WHERE address = 'claude@atmark.ai'`);
      await client.query('ALTER TABLE agent_addresses ENABLE TRIGGER agent_addresses_retire_guard');
      expect(await attempt(client, () => insertAddress(client, other.agentId, 'claude@atmark.ai'))).toBe('23514');
      // 운영자 허가도 받지 않는다(허가 표 모양 CHECK — 운영자 목록 밖).
      expect(
        await attempt(client, () =>
          client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('claude@atmark.ai', $1, 'test', 'test')`, [
            holder.orgId,
          ]),
        ),
      ).toBe('23514');
    });
  });

  it('⑤ 주소 행은 지울 수 없다(소유자 롤도) · 굳힌 행을 지워도 같은 id 로 다른 예약 이름은 23514 — 쌍으로 묶였다(리뷰 L1)', async () => {
    const f = await fixture();
    await rolledBack(async (client) => {
      const id = await legacy(client, f.agentId, 'grokbot@atmark.ai');
      expect(await attempt(client, () => client.query('DELETE FROM agent_addresses WHERE id = $1', [id]))).not.toBe('ok');
      // 지우는 트리거를 끈 소유자(마이그레이션 밖의 쓰기)라도 — 같은 id 로 다른 예약 이름은 CHECK 가 막는다.
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_no_delete');
      await client.query('DELETE FROM agent_addresses WHERE id = $1', [id]);
      await client.query('ALTER TABLE agent_addresses ENABLE TRIGGER agent_addresses_no_delete');
      for (const other of ['openai@atmark.ai', 'claude@atmark.ai', 'chat-gpt@atmark.ai']) {
        expect(
          await attempt(client, () =>
            client.query(`INSERT INTO agent_addresses (id, agent_id, address, domain, is_primary) VALUES ($1, $2, $3, 'atmark.ai', false)`, [id, f.agentId, other]),
          ),
          other,
        ).toBe('23514');
      }
    });
  });
});
