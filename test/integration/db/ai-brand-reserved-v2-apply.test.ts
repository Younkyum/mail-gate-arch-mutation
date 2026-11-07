/**
 * AI 브랜드 예약 확장(202610141200 · 1201) — **옛 행 위에서 1200 → 1201 을 실제로 돌린다**(PR #98 리뷰 I2).
 *
 * 공유 DB(이미 전부 적용됨)로는 1200 의 "적용 순간의 행을 굳힌다" 를 볼 수 없다 — 그래서 빈 스크래치 DB 에 1200 직전까지 적용하고, 운영에 있을
 * 모양의 행을 심은 뒤 나머지를 적용한다:
 *   - Chronostasis 같은 조직: `claude@atmark.ai` 대표(운영자 허가 행과 함께) + `support@` 허가 행(남아야 한다).
 *   - 다른 조직: `grokbot@`(1200 전에는 예약이 아니었다) 대표 · 새 이름 별칭 `naver@` · 구분자 변형 `chat-gpt@`(옛 브랜드 `chatgpt` 의 변형) · 평범한 별칭.
 * 기대: 굳힌 쌍 = 위의 넷(평범한 별칭은 아니다) · CHECK 검증됨(1201) · claude@ 허가 행만 지워짐 · 그 뒤 claude@ 에이전트를 지울 수 있고, 같은 이름의
 * 새 행 · 다른 구분자 변형은 23514.
 *
 * **`TEST_DATABASE_URL`·`TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다.** 스크래치 DB 는 끝에서 지운다.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { loadMigrations, migrate } from '../../../src/db/migrate';
import { DATABASE_AVAILABLE } from './support/harness';

const OWNER_URL = (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim();
const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL !== '';
const TARGET = '202610141200';

const ORG_CHRONO = 'f37fa0fd-231f-4cfe-8540-067eee3e7538';
const ORG_OTHER = '0b9e3c1a-6a55-4f3a-9a0e-2d7c1b8e4f10';
const AGENT_CLAUDE = '214bf71ed6b729a5d3133df3fd0ccd49';
const AGENT_GROK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let admin: Pool;
let scratch: Pool;
let scratchName = '';
const seeded = new Map<string, string>();

async function applyMigrations(keep: (filename: string) => boolean): Promise<void> {
  const client = await scratch.connect();
  try {
    await migrate(client, loadMigrations().filter((file) => keep(file.filename)));
  } finally {
    client.release();
  }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}

async function seed(): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => scratch.query(sql, params);
  await q(`INSERT INTO organizations (id, name) VALUES ($1, 'Chronostasis (scratch)'), ($2, 'Other (scratch)')`, [ORG_CHRONO, ORG_OTHER]);
  await q(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'claude-code', 'active', 'beta', 0), ($3, $4, 'grokbot', 'active', 'beta', 0)`,
    [AGENT_CLAUDE, ORG_CHRONO, AGENT_GROK, ORG_OTHER],
  );
  await q(
    `INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('claude@atmark.ai', $1, 'scratch', 'scratch'), ('support@atmark.ai', $1, 'scratch', 'scratch')`,
    [ORG_CHRONO],
  );
  const add = async (agentId: string, address: string, primary: boolean): Promise<void> => {
    const row = await q(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', $3) RETURNING id::text AS id`, [
      agentId,
      address,
      primary,
    ]);
    seeded.set(address, (row.rows[0] as { id: string }).id);
  };
  await add(AGENT_CLAUDE, 'claude@atmark.ai', true);
  await add(AGENT_GROK, 'grokbot@atmark.ai', true);
  await add(AGENT_GROK, 'naver@atmark.ai', false);
  await add(AGENT_GROK, 'chat-gpt@atmark.ai', false);
  await add(AGENT_GROK, 'plain-helper@atmark.ai', false);
}

describe.skipIf(!AVAILABLE)('AI 브랜드 예약 확장(202610141200) — 스크래치 DB 에서 옛 행 위에 1200 → 1201', () => {
  beforeAll(async () => {
    admin = createPool(OWNER_URL, { max: 1 });
    scratchName = `atmark_brands_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${scratchName}`);
    const url = new URL(OWNER_URL);
    url.pathname = `/${scratchName}`;
    scratch = createPool(url.toString(), { max: 2 });
    // 정리 단계의 `DROP DATABASE … WITH (FORCE)` 가 연결을 끊는다(57P01) — 그 통지만 삼킨다(policy-v2-corrections 와 같다).
    const ignoreForcedDrop = (error: Error & { code?: string }): void => {
      if (error.code !== '57P01') throw error;
    };
    scratch.on('error', ignoreForcedDrop);
    admin.on('error', ignoreForcedDrop);

    await applyMigrations((file) => file < TARGET);
    await seed();
    await applyMigrations(() => true);
  }, 240_000);

  afterAll(async () => {
    await scratch?.end();
    if (admin !== undefined && scratchName !== '') await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin?.end();
  });

  it('굳힌 쌍 = claude@ · grokbot@ · naver@ · chat-gpt@ 의 (id, 주소) — 평범한 별칭은 아니다', async () => {
    const keys = (await scratch.query<{ keys: string[] }>('SELECT atmark_reserved_grandfathered_address_keys() AS keys')).rows[0]?.keys ?? [];
    const expected = ['claude@atmark.ai', 'grokbot@atmark.ai', 'naver@atmark.ai', 'chat-gpt@atmark.ai'].map((address) => `${seeded.get(address) ?? '?'} ${address}`);
    expect([...keys].sort()).toEqual([...expected].sort());
    expect(keys.some((key) => key.endsWith(' plain-helper@atmark.ai'))).toBe(false);
  });

  it('CHECK 검증됨(1201) · claude@ 허가 행만 지워졌다(support@ 는 남는다) · 운영자 목록에 claude@ 없음', async () => {
    const row = (
      await scratch.query<{ validated: boolean; grants: string[]; operators: string[] }>(
        `SELECT (SELECT convalidated FROM pg_constraint WHERE conname = 'agent_addresses_not_reserved_local_part') AS validated,
                (SELECT coalesce(array_agg(address ORDER BY address), '{}') FROM operator_address_grants) AS grants,
                atmark_operator_assignable_addresses() AS operators`,
      )
    ).rows[0];
    expect(row?.validated).toBe(true);
    expect(row?.grants).toEqual(['support@atmark.ai']);
    expect(row?.operators).not.toContain('claude@atmark.ai');
  });

  it('그 뒤 — claude@ 에이전트를 지울 수 있다(트리거 42501 아님) · 같은 이름의 새 행 · 구분자 변형은 23514 · 굳힌 행은 지울 수 없다', async () => {
    const client = await scratch.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE agents SET status = 'disabled', suspended_by = NULL WHERE id = $1`, [AGENT_CLAUDE]);
      expect((await client.query(`UPDATE agent_addresses SET retired_at = now() WHERE agent_id = $1 AND retired_at IS NULL`, [AGENT_CLAUDE])).rowCount).toBe(1);
      await client.query('SAVEPOINT s');
      const reissue = await codeOf(() =>
        client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, 'claude@atmark.ai', 'atmark.ai', false)`, [AGENT_GROK]),
      );
      await client.query('ROLLBACK TO SAVEPOINT s');
      // 다른 조직 · 보류 안 — 보류 트리거(BEFORE INSERT · 23505)가 CHECK 보다 먼저다. 보류가 끝난 뒤의 23514 는 admin/ai-brand-reserved-v2 ④ 가 본다.
      expect(reissue).toBe('23505');
      for (const variant of ['chat_gpt@atmark.ai', 'claude.code@atmark.ai', 'naver@atmark.ai']) {
        await client.query('SAVEPOINT s');
        const state = await codeOf(() =>
          client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [AGENT_GROK, variant]),
        );
        await client.query('ROLLBACK TO SAVEPOINT s');
        expect(state, variant).toBe(variant === 'naver@atmark.ai' ? '23505' : '23514');
      }
      await client.query('SAVEPOINT s');
      expect(await codeOf(() => client.query(`DELETE FROM agent_addresses WHERE address = 'grokbot@atmark.ai'`))).not.toBe('ok');
      await client.query('ROLLBACK TO SAVEPOINT s');
      // 굳힌 별칭은 그대로 폐기된다.
      expect((await client.query(`UPDATE agent_addresses SET retired_at = now() WHERE address = 'naver@atmark.ai' AND retired_at IS NULL`)).rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
