/**
 * 앵커 이름 비충돌(ADR-0014 2026-10 개정 · 202610021101 — 진윤겸 "겹치지 않도록 꼭") — 실제 Postgres.
 *
 *   ① **사용자 입력 `ax--` 거부**(DB 가드 — 앱 검증을 지나쳐도): admin · 앱 경로의 INSERT 는 형식 오류 23514(대표 · 별칭 · 고객 도메인 모두) ·
 *      소유자 롤이어도 대표 앵커 모양(`ax--[a-z2-7]{20}@atmark.ai`, is_primary)만.
 *   ② **프로비저닝**(정의자 `atmark_provision_custom_primary` — admin 롤): 새 에이전트에 앵커 + 고객 별칭 + 선택(provision) · 유효 대표 = 고객 주소 ·
 *      앵커는 잠든다 · 주소가 있는 에이전트 · atmark.ai 주소 · verified 아닌 도메인은 거부(재시도하지 않는다).
 *   ③ **충돌 재시도**: 같은 난수가 이미 쓰인 앵커 · **사람 이메일 claim**(조직 소유자 주소)과 겹치면 P0A10 → 새 난수로 다시(2번째에 성공) ·
 *      상한을 넘으면 오류.
 *   ④ **동시 생성 경합**: 두 트랜잭션이 같은 앵커 이름으로 동시에 — 하나는 기다렸다가 P0A10 → 새 난수로 성공.
 *   ⑤ **마이그레이션 사전 조회**: `ax--` 주소가 하나라도 있으면 1101 의 사전 조회가 멈춘다.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOMAIN_SQLSTATES } from '../../../src/domains/contract';
import { AnchorNameExhaustedError, generateAnchorLocalPart, loadEffectivePrimary, provisionCustomPrimary } from '../../../src/identity/primary';
import { adminRolePool, ADMIN_ROLE_URL } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, newAgentId, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { verifiedCustomDomain } from '../policy/support';
import { OWNER_URL } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

async function stateOf(client: PoolClient, sql: string, params: readonly unknown[] = []): Promise<string> {
  await client.query('SAVEPOINT s');
  try {
    await client.query(sql, [...params]);
    await client.query('RELEASE SAVEPOINT s');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return (error as { code?: string }).code ?? 'no-code';
  }
}

/** 주소가 하나도 없는 새 에이전트(소유자 롤 · 커밋). */
async function bareAgent(organizationId: string): Promise<string> {
  const id = newAgentId();
  await provisioningPool().query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'anchor', 'active', 'free', 0)`, [
    id,
    organizationId,
  ]);
  return id;
}

/** 고정된 바이트 열을 차례로 내는 난수 원천(다 쓰면 진짜 난수). */
function scripted(...sequences: Uint8Array[]): (size: number) => Uint8Array {
  const queue = [...sequences];
  return (size) => queue.shift()?.slice(0, size) ?? randomBytes(size);
}

describe.skipIf(!AVAILABLE)('앵커 이름 비충돌', () => {
  let admin: Pool;
  let f: Fixture;
  let domain: string;

  beforeAll(async () => {
    admin = adminRolePool();
    f = await seedFixture(testPool());
    ({ domain } = await verifiedCustomDomain(f.organizationId));
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPool();
  });

  async function inAdmin<T>(run: (client: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const value = await run(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it('① 사용자 입력 ax-- 은 DB 에서도 형식 오류(23514) — admin · 앱 경로, 대표 · 별칭 · 고객 도메인 · 소유자 롤도 모양 밖이면', async () => {
    const agent = await bareAgent(f.organizationId);
    const local = generateAnchorLocalPart();
    await inAdmin(async (client) => {
      const insert = (address: string, primary: boolean): Promise<string> =>
        stateOf(client, `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, split_part($2, '@', 2), $3)`, [agent, address, primary]);
      expect(await insert(`${local}@atmark.ai`, true)).toBe('23514');
      expect(await insert(`ax--mine@atmark.ai`, true)).toBe('23514');
      expect(await insert(`ax--mine@${domain}`, false)).toBe('23514');
      expect(await insert(`max--ok-${randomBytes(3).toString('hex')}@atmark.ai`, true)).toBe('ok'); // 접두사만 막는다
    });
    const owner = await provisioningPool().connect();
    try {
      await owner.query('BEGIN');
      const insert = (address: string, primary: boolean): Promise<string> =>
        stateOf(owner, `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, split_part($2, '@', 2), $3)`, [agent, address, primary]);
      expect(await insert(`ax--short@atmark.ai`, true)).toBe('23514');
      expect(await insert(`${local}@atmark.ai`, false)).toBe('23514');
      expect(await insert(`${local}@${domain}`, false)).toBe('23514');
      expect(await insert(`${local}@atmark.ai`, true)).toBe('ok'); // 운영자 셸 — 모양 그대로면
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });

  it('② 프로비저닝 — 앵커 + 고객 별칭 + 선택 · 유효 대표 = 고객 주소 · 앵커는 잠든다 · 잘못된 입력은 재시도 없이 그대로', async () => {
    const agent = await bareAgent(f.organizationId);
    const result = await inAdmin((client) => provisionCustomPrimary(client, { agentId: agent, customAddress: `hello-${agent.slice(0, 6)}@${domain}` }), true);
    expect(result.attempts).toBe(1);
    expect(result.anchorAddress).toMatch(/^ax--[a-z2-7]{20}@atmark\.ai$/);
    const rows = await provisioningPool().query<{ address: string; is_primary: boolean }>('SELECT address, is_primary FROM agent_addresses WHERE agent_id = $1 ORDER BY is_primary DESC', [agent]);
    expect(rows.rows).toEqual([
      { address: result.anchorAddress, is_primary: true },
      { address: `hello-${agent.slice(0, 6)}@${domain}`, is_primary: false },
    ]);
    expect(await loadEffectivePrimary(testPool(), agent)).toBe(`hello-${agent.slice(0, 6)}@${domain}`);
    const cause = await provisioningPool().query<{ cause: string }>('SELECT cause FROM agent_primary_changes WHERE agent_id = $1', [agent]);
    expect(cause.rows.map((row) => row.cause)).toEqual(['provision']);
    // 잘못된 입력 — 재시도하지 않는다(사용자가 고른 주소 · 호출자 결함).
    await inAdmin(async (client) => {
      await expect(provisionCustomPrimary(client, { agentId: agent, customAddress: `x@${domain}` })).rejects.toMatchObject({ code: '23514' }); // 주소가 이미 있는 에이전트
    });
    const fresh = await bareAgent(f.organizationId);
    await inAdmin(async (client) => {
      await expect(provisionCustomPrimary(client, { agentId: fresh, customAddress: 'x@atmark.ai' })).rejects.toMatchObject({ code: '22023' });
    });
    await inAdmin(async (client) => {
      await expect(provisionCustomPrimary(client, { agentId: fresh, customAddress: `x@agents.unverified-${randomBytes(3).toString('hex')}.com` })).rejects.toMatchObject({
        code: DOMAIN_SQLSTATES.domainNotVerified,
      });
    });
    // 직접 부를 때도 모양 밖 앵커는 거부.
    await inAdmin(async (client) => {
      await expect(client.query('SELECT * FROM atmark_provision_custom_primary($1, $2, $3)', [fresh, 'ax--short', `y@${domain}`])).rejects.toMatchObject({ code: '22023' });
    });
  });

  it('③ 충돌 재시도 — 이미 쓰인 앵커 · 사람 이메일 claim 과 같은 난수면 P0A10 → 새 난수로(2번째) · 상한을 넘으면 오류', async () => {
    const taken = randomBytes(13);
    const first = await bareAgent(f.organizationId);
    const made = await inAdmin((client) => provisionCustomPrimary(client, { agentId: first, customAddress: `one-${first.slice(0, 6)}@${domain}` }, { random: scripted(taken) }), true);
    expect(made.attempts).toBe(1);
    const second = await bareAgent(f.organizationId);
    const retried = await inAdmin(
      (client) => provisionCustomPrimary(client, { agentId: second, customAddress: `two-${second.slice(0, 6)}@${domain}` }, { random: scripted(taken) }),
      true,
    );
    expect(retried.attempts).toBe(2);
    expect(retried.anchorAddress).not.toBe(made.anchorAddress);

    // 사람 이메일 claim(human_member)과 겹치는 이름. 지금 스키마는 사람 주소가 atmark.ai 일 수 없다(users · organizations CHECK) — 그래도 claim 표에
    //   그 키가 있으면(백필 · 옛 행 · 다른 경로) 앵커는 P0A01 → P0A10 으로 비켜 간다(심층 방어). claim 은 정의자 함수로 직접 심는다.
    const human = randomBytes(13);
    const humanLocal = generateAnchorLocalPart(scripted(human));
    await provisioningPool().query(`SELECT atmark_claim_mail_identity($1, 'human_member', 'users', $2)`, [`${humanLocal}@atmark.ai`, randomUUID()]);
    const third = await bareAgent(f.organizationId);
    const afterHuman = await inAdmin(
      (client) => provisionCustomPrimary(client, { agentId: third, customAddress: `three-${third.slice(0, 6)}@${domain}` }, { random: scripted(human) }),
      true,
    );
    expect(afterHuman.attempts).toBe(2);
    expect(afterHuman.anchorAddress).not.toBe(`${humanLocal}@atmark.ai`);

    const fourth = await bareAgent(f.organizationId);
    await inAdmin(async (client) => {
      await expect(
        provisionCustomPrimary(client, { agentId: fourth, customAddress: `four-${fourth.slice(0, 6)}@${domain}` }, { random: () => taken.slice(), maxAttempts: 3 }),
      ).rejects.toBeInstanceOf(AnchorNameExhaustedError);
    });
  });

  it('④ 동시 생성 경합 — 같은 앵커 이름으로 두 트랜잭션 → 하나는 기다렸다가 P0A10 → 새 난수로 성공', async () => {
    const same = randomBytes(13);
    const a = await bareAgent(f.organizationId);
    const b = await bareAgent(f.organizationId);
    const first = await admin.connect();
    const secondClient = await admin.connect();
    try {
      await first.query('BEGIN');
      await secondClient.query('BEGIN');
      const madeA = await provisionCustomPrimary(first, { agentId: a, customAddress: `ra-${a.slice(0, 6)}@${domain}` }, { random: scripted(same) });
      const pendingB = provisionCustomPrimary(secondClient, { agentId: b, customAddress: `rb-${b.slice(0, 6)}@${domain}` }, { random: scripted(same) });
      await new Promise((resolve) => setTimeout(resolve, 150)); // B 가 유니크 색인에서 A 를 기다린다
      await first.query('COMMIT');
      const madeB = await pendingB;
      await secondClient.query('COMMIT');
      expect([madeA.attempts, madeB.attempts]).toEqual([1, 2]);
      expect(madeB.anchorAddress).not.toBe(madeA.anchorAddress);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await secondClient.query('ROLLBACK').catch(() => undefined);
      first.release();
      secondClient.release();
    }
  });

  it('⑤ 마이그레이션 사전 조회 — ax-- 주소가 하나라도 있으면 멈춘다(지금 DB 에는 위 테스트의 앵커가 있다)', async () => {
    const sql = readFileSync(join(__dirname, '../../../src/db/migrations/202610021101_anchor_namespace.sql'), 'utf8');
    const preflight = /DO \$\$[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? '';
    expect(preflight).toContain("LIKE 'ax--%'");
    const owner = await provisioningPool().connect();
    try {
      await owner.query('BEGIN');
      const agent = newAgentId();
      await owner.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'p', 'active', 'free', 0)`, [agent, f.organizationId]);
      await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [agent, `${generateAnchorLocalPart()}@atmark.ai`]);
      await expect(owner.query(preflight)).rejects.toThrow(/ax--/);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });
});
