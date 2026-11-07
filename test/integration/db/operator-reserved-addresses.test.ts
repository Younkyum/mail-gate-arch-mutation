/**
 * **운영자 예약 주소**(202609301500·1501, 2026-09-30) — 실제 Postgres. 쓰는 것은 전부 **롤백**한다: 주소는 전역 활성 UNIQUE 이고 허가는 주소 PK 라
 * 공유 테스트 DB 에 `support@atmark.ai` 를 남기면 다음 실행이(그리고 로컬 개발이) 그 주소를 쓸 수 없다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   ① DB 목록 = TS `OPERATOR_ASSIGNABLE_ADDRESSES`(값·순서) · `onve` 가 예약 로컬파트다(TS·SQL 둘 다).
 *   ② 허가 없는 조직 → 42501(목록 안의 주소 모두, 대표·별칭 모두) · 허가된 조직 → 된다 · 다른 조직에 허가 → 42501.
 *   ③ 허가 가드가 재발급 보류보다 먼저 돈다 — 허가 없는 조직은 이미 쓰인 주소에도 23505 가 아니라 42501(사용 여부를 탐침하지 못한다).
 *   ④ 목록 밖 예약 주소는 허가 표에도 못 들어가고(23514) 에이전트 주소로도 23514 다.
 *   ⑤ 허가 표는 소유자 전용 — 앱 롤·admin 롤은 읽지도 쓰지도 못한다(42501).
 *   ⑦ 닫힌 채로 실패: 허가 없이 `support@`·`onve@` 를 쥔 행이 있으면 1500 의 DO 블록이 55000 으로 멈춘다(퇴역 30일 경계).
 *      (`claude@` 는 202610141200 에서 운영자 목록을 떠났다 — test/integration/db/ai-brand-reserved-v2.test.ts.)
 *   ⑧ 202609301540 — `abuse@`·`postmaster@` 도 목록 안: 허가 없으면 42501 · 허가된 조직의 에이전트에 별칭으로 된다 · 1540 의 DO 블록이 이미 쥔 행에
 *      55000 · CLI 는 두 주소를 provision(대표 주소)으로 받지 않는다(수신 전용 — alias 만).
 *   ⑥ CLI(`pnpm admin:reserved-address`) grant → provision → alias: 허가 없이 provision 하면 입력 오류 · 두 번 돌려도 같다(멱등) ·
 *      alias 는 요금제 별칭 한도(Free 0)를 보지 않는다 · 주소 잎(`tlog_outbox` agent_addresses insert)이 생긴다 · 콘솔 경로(`addAliasOp`)는
 *      여전히 `reserved_local_part` 다.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runReservedAddress, parseReservedAddressArgs, type ReservedAddressCommand } from '../../../scripts/admin/reserved-address';
import { AdminInputError, classifyTarget, type AdminIo } from '../../../scripts/admin/common';
import { addAliasOp } from '../../../src/admin/ops/addresses';
import { transactionPool } from '../../../src/admin/ops/transaction';
import { createPool } from '../../../src/db/client';
import { toAgentId } from '../../../src/db/schema';
import { OPERATOR_ASSIGNABLE_ADDRESSES, RECEIVE_ONLY_ADDRESSES, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { ADMIN_ROLE_URL, adminRolePool } from '../admin/support';
import { closeTestPool, codeOf, DATABASE_AVAILABLE, newAgentId, rolledBack, seedFixture, testPool } from './support/harness';

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

function io(): AdminIo & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (line) => outLines.push(line), err: (line) => errLines.push(line), interactive: false, ask: async () => '' };
}

describe.skipIf(!AVAILABLE)('운영자 예약 주소 — DB 가드 · 허가 표 · CLI (202609301500)', () => {
  let owner: Pool;
  let admin: Pool;
  const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-reserved-keys-'));
  const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'reserved-test' });

  beforeAll(() => {
    owner = createPool(OWNER_URL, { max: 2 });
    admin = adminRolePool();
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await closeTestPool();
  });

  async function attempt(client: PoolClient, run: () => Promise<unknown>): Promise<string> {
    await client.query('SAVEPOINT s');
    const state = await codeOf(run);
    await client.query(state === 'ok' ? 'RELEASE SAVEPOINT s' : 'ROLLBACK TO SAVEPOINT s');
    return state;
  }

  const insertAddress = (client: PoolClient, agentId: string, address: string, primary = false) =>
    client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', $3)`, [agentId, address, primary]);

  const grant = (client: PoolClient, address: string, organizationId: string) =>
    client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ($1, $2, 'test', 'test')`, [address, organizationId]);

  it('① DB 목록 = TS OPERATOR_ASSIGNABLE_ADDRESSES · onve 는 예약 로컬파트다', async () => {
    const listed = await owner.query<{ addresses: string[]; parts: string[] }>(
      'SELECT atmark_operator_assignable_addresses() AS addresses, atmark_reserved_local_parts() AS parts',
    );
    expect(listed.rows[0]?.addresses).toEqual([...OPERATOR_ASSIGNABLE_ADDRESSES]);
    expect(listed.rows[0]?.parts).toContain('onve');
    expect(RESERVED_LOCAL_PARTS).toContain('onve');
    expect(listed.rows[0]?.parts).toEqual([...RESERVED_LOCAL_PARTS]);
  });

  it('② 허가 없는 조직 42501 · 허가된 조직은 된다 · 다른 조직에 허가돼 있으면 42501', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      for (const address of OPERATOR_ASSIGNABLE_ADDRESSES) {
        expect(await attempt(client, () => insertAddress(client, a.agentId, address)), address).toBe('42501');
      }
      // 대표 주소로 새 에이전트를 만드는 모양도 같다.
      const fresh = newAgentId();
      await client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'x', 'active', 'free', 0)`, [
        fresh,
        a.organizationId,
      ]);
      expect(await attempt(client, () => insertAddress(client, fresh, 'support@atmark.ai', true))).toBe('42501');

      await grant(client, 'support@atmark.ai', a.organizationId);
      await grant(client, 'onve@atmark.ai', a.organizationId);
      expect(await attempt(client, () => insertAddress(client, b.agentId, 'onve@atmark.ai'))).toBe('42501');
      expect(await attempt(client, () => insertAddress(client, fresh, 'support@atmark.ai', true))).toBe('ok');
      expect(await attempt(client, () => insertAddress(client, fresh, 'onve@atmark.ai'))).toBe('ok');
      // ③ 이미 쓰이는 주소 — 허가 없는 조직은 23505(사용 중)가 아니라 42501 을 본다(가드가 재발급 보류보다 먼저).
      expect(await attempt(client, () => insertAddress(client, b.agentId, 'support@atmark.ai'))).toBe('42501');
      // 허가된 조직의 다른 에이전트는 재발급 보류가 막는다(활성 행이 있다).
      expect(await attempt(client, () => insertAddress(client, a.agentId, 'support@atmark.ai'))).toBe('23505');
      // 주소 잎 — 운영자 경로도 투명성 로그를 우회하지 않는다.
      const leaves = await client.query(
        `SELECT 1 FROM tlog_outbox o JOIN agent_addresses d ON o.source_id = d.id::text
          WHERE o.source_table = 'agent_addresses' AND o.event = 'insert' AND d.address = ANY ($1::text[]) AND d.agent_id = $2`,
        [['support@atmark.ai', 'onve@atmark.ai'], fresh],
      );
      expect(leaves.rowCount).toBe(2);
    });
  });

  it('④ 목록 밖 예약 주소 — 허가 표 23514 · 에이전트 주소 23514(허가 표 행이 있어도 CHECK 가 막는다)', async () => {
    const a = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      for (const address of ['billing@atmark.ai', 'login@atmark.ai', 'SUPPORT@atmark.ai', 'support@agents.example.com', 'codex@atmark.ai']) {
        expect(await attempt(client, () => grant(client, address, a.organizationId)), address).toBe('23514');
      }
      expect(await attempt(client, () => insertAddress(client, a.agentId, 'billing@atmark.ai'))).toBe('23514');
      expect(await attempt(client, () => insertAddress(client, a.agentId, 'codex@atmark.ai'))).toBe('23514');
    });
  });

  it('⑤ 허가 표는 소유자 전용 — 앱 롤·admin 롤은 읽기·쓰기 모두 42501', async () => {
    const a = await seedFixture(testPool());
    for (const pool of [testPool(), admin]) {
      expect(await codeOf(() => pool.query('SELECT * FROM operator_address_grants'))).toBe('42501');
      expect(
        await codeOf(() =>
          pool.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('support@atmark.ai', $1, 'x', 'x')`, [
            a.organizationId,
          ]),
        ),
      ).toBe('42501');
    }
  });

  it('⑦ 닫힌 채로 실패 — 허가 없이 support@·onve@ 를 쥔 행(활성 · 30일 안 퇴역)이 있으면 1500 의 DO 블록이 55000 으로 멈춘다', async () => {
    // 마이그레이션 파일의 DO 블록 원문을 그대로 돌린다(적용된 DB 에서는 파일 전체를 다시 돌릴 수 없다).
    const file = readFileSync(resolve(process.cwd(), 'src/db/migrations/202609301500_operator_reserved_addresses.sql'), 'utf8');
    const block = /\nDO \$\$[\s\S]*?\n\$\$;/.exec(file)?.[0];
    if (block === undefined) throw new Error('1500 의 DO 블록을 찾지 못했다');
    const a = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      const run = async (): Promise<{ state: string; message: string }> => {
        await client.query('SAVEPOINT d');
        try {
          await client.query(block);
          await client.query('RELEASE SAVEPOINT d');
          return { state: 'ok', message: '' };
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT d');
          return { state: (error as { code?: string }).code ?? 'no-code', message: (error as Error).message };
        }
      };
      // 허가 가드를 끈 채로 심는다 — 마이그레이션 밖의 쓰기(옛 코드·수동 SQL)가 남겼을 행의 모양.
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_operator_grant_guard');
      expect(await run()).toEqual({ state: 'ok', message: '' });

      // 퇴역한 지 31일이 지난 support@ — 통과한다. 폐기 가드가 `retired_at` 을 now() 로 덮으므로 과거 시각은 그 트리거를 끄고 적는다.
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_retire_guard');
      expect(await attempt(client, () => insertAddress(client, a.agentId, 'support@atmark.ai'))).toBe('ok');
      await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '31 days' WHERE address = 'support@atmark.ai'`);
      expect((await run()).state).toBe('ok');

      // 활성 onve@ — 멈춘다(허가 행이 없다).
      expect(await attempt(client, () => insertAddress(client, a.agentId, 'onve@atmark.ai'))).toBe('ok');
      const held = await run();
      expect(held.state).toBe('55000');
      expect(held.message).toBe('operator-reserved address already held — run deploy §29 pre-check ③');

      // 퇴역한 지 30일이 안 됐으면(29일) 여전히 멈춘다.
      await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '29 days' WHERE address = 'onve@atmark.ai'`);
      expect((await run()).state).toBe('55000');
    });
  });

  it('⑧ abuse@·postmaster@(202609301540) — 허가 없으면 42501 · 허가된 조직의 에이전트에 별칭으로 된다 · 다른 조직 42501 · 목록 밖 역할 주소는 여전히 23514', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        expect(OPERATOR_ASSIGNABLE_ADDRESSES as readonly string[]).toContain(address);
        expect(await attempt(client, () => insertAddress(client, a.agentId, address)), address).toBe('42501');
        await grant(client, address, a.organizationId);
        expect(await attempt(client, () => insertAddress(client, b.agentId, address)), address).toBe('42501');
        expect(await attempt(client, () => insertAddress(client, a.agentId, address)), address).toBe('ok');
      }
      // 같은 RFC 2142 이름이라도 목록 밖(`hostmaster@`·`webmaster@`)은 허가 표에도 에이전트 주소로도 못 들어간다.
      for (const address of ['hostmaster@atmark.ai', 'webmaster@atmark.ai', 'abuse-report@atmark.ai']) {
        expect(await attempt(client, () => grant(client, address, a.organizationId)), address).toBe('23514');
        expect(await attempt(client, () => insertAddress(client, a.agentId, address)), address).toBe('23514');
      }
    });
  });

  it('⑧‴ 보안 검토 L5 — abuse@·postmaster@ 는 대표 주소가 될 수 없다: 허가가 있어도 대표 INSERT 는 23514 · 별칭은 된다 · CHECK 는 1541 이 VALIDATE 했다', async () => {
    const a = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      const fresh = newAgentId();
      await client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'x', 'active', 'free', 0)`, [
        fresh,
        a.organizationId,
      ]);
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        await grant(client, address, a.organizationId);
        expect(await attempt(client, () => insertAddress(client, fresh, address, true)), address).toBe('23514');
        expect(await attempt(client, () => insertAddress(client, fresh, address)), address).toBe('ok');
      }
      // 소유자 롤이 허가 가드를 끄고 써도 표 CHECK 가 마지막 문이다.
      const other = newAgentId();
      await client.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'y', 'active', 'free', 0)`, [
        other,
        a.organizationId,
      ]);
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_operator_grant_guard');
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_reissue_hold');
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        expect(await attempt(client, () => insertAddress(client, other, address, true)), address).toBe('23514');
      }
    });
    const check = await owner.query<{ convalidated: boolean; def: string }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'agent_addresses_role_address_not_primary'`,
    );
    expect(check.rows[0]?.convalidated).toBe(true);
    for (const address of RECEIVE_ONLY_ADDRESSES) expect(check.rows[0]?.def).toContain(address);
  });

  it('⑧′ 닫힌 채로 실패 — 허가 없이 abuse@·postmaster@ 를 쥔 행(활성 · 30일 안 퇴역)이 있으면 1540 의 DO 블록이 55000 으로 멈춘다', async () => {
    const file = readFileSync(resolve(process.cwd(), 'src/db/migrations/202609301540_operator_reserved_abuse_postmaster.sql'), 'utf8');
    const block = /\nDO \$\$[\s\S]*?\n\$\$;/.exec(file)?.[0];
    if (block === undefined) throw new Error('1540 의 DO 블록을 찾지 못했다');
    const a = await seedFixture(testPool());
    await rolledBack(owner, async (client) => {
      const run = async (): Promise<{ state: string; message: string }> => {
        await client.query('SAVEPOINT d');
        try {
          await client.query(block);
          await client.query('RELEASE SAVEPOINT d');
          return { state: 'ok', message: '' };
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT d');
          return { state: (error as { code?: string }).code ?? 'no-code', message: (error as Error).message };
        }
      };
      // 허가 가드를 끈 채로 심는다 — 마이그레이션 밖의 쓰기가 남겼을 행의 모양.
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_operator_grant_guard');
      await client.query('ALTER TABLE agent_addresses DISABLE TRIGGER agent_addresses_retire_guard');
      expect(await run()).toEqual({ state: 'ok', message: '' });
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        expect(await attempt(client, () => insertAddress(client, a.agentId, address)), address).toBe('ok');
        const held = await run();
        expect(held, address).toEqual({ state: '55000', message: 'abuse@/postmaster@ already held — run deploy §33 pre-check ②' });
        await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '29 days' WHERE address = $1`, [address]);
        expect((await run()).state, address).toBe('55000');
        await client.query(`UPDATE agent_addresses SET retired_at = now() - interval '31 days' WHERE address = $1`, [address]);
        expect((await run()).state, address).toBe('ok');
      }
    });
  });

  it('⑧″ CLI — abuse@·postmaster@ 는 provision(대표 주소) 입력 오류 · grant → alias 는 된다', async () => {
    const org = await seedFixture(testPool());
    for (const address of RECEIVE_ONLY_ADDRESSES) {
      expect(() => parseReservedAddressArgs(['provision', '--address', address, '--org', org.organizationId, '--name', 'x']), address).toThrow(/수신 전용/);
    }
    const target = classifyTarget(OWNER_URL, env());
    await rolledBack(owner, async (client) => {
      const pool = transactionPool(client);
      const run = async (argv: string[]) => {
        const out = io();
        const parsed = parseReservedAddressArgs(argv);
        if (parsed === null) throw new Error('help');
        await runReservedAddress(pool, target, parsed, { env: env(), io: out });
        return out.outLines;
      };
      for (const address of RECEIVE_ONLY_ADDRESSES) {
        expect(await run(['grant', '--address', address, '--org', org.organizationId, '--reason', '도메인 평판 — 사람이 받는다'])).toEqual([
          `grant ${address} ${org.organizationId} created`,
        ]);
        expect(await run(['alias', '--agent', org.agentId, '--address', address])).toEqual([`alias ${address} ${org.agentId} created`]);
      }
    });
  });

  it('CHECK — 목록 밖 위반 행이 없으면 1501 이 VALIDATE 했다(reservedLocalPartCheckValidated)', async () => {
    const state = await owner.query<{ offenders: number; validated: boolean }>(
      `SELECT (SELECT count(*)::int FROM agent_addresses
                WHERE NOT (address = ANY (atmark_operator_assignable_addresses()))
                  AND split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2)))) AS offenders,
              (SELECT convalidated FROM pg_constraint WHERE conname = 'agent_addresses_not_reserved_local_part') AS validated`,
    );
    const row = state.rows[0];
    if (row?.offenders === 0) expect(row.validated).toBe(true);
  });

  it('⑥ CLI grant → provision → alias — 허가 먼저 · 멱등 · 요금제 별칭 한도 무시 · 콘솔 경로는 여전히 거부', async () => {
    const org = await seedFixture(testPool(), { plan: null }); // Free — 콘솔 별칭 한도 0.
    const target = classifyTarget(OWNER_URL, env());
    const deps = (out: ReturnType<typeof io>) => ({ env: env(), io: out });
    const command = (argv: string[]): ReservedAddressCommand => {
      const parsed = parseReservedAddressArgs(argv);
      if (parsed === null) throw new Error('help');
      return parsed;
    };
    await rolledBack(owner, async (client) => {
      const pool = transactionPool(client);
      const run = async (argv: string[]) => {
        const out = io();
        const code = await runReservedAddress(pool, target, command(argv), deps(out));
        return { code, out };
      };

      // 허가 없이 provision → 입력 오류(키 보관 전에 멈춘다).
      await expect(run(['provision', '--address', 'support@atmark.ai', '--org', org.organizationId, '--name', 'Atmark Support'])).rejects.toThrow(
        AdminInputError,
      );

      for (const address of ['support@atmark.ai', 'onve@atmark.ai']) {
        const first = await run(['grant', '--address', address, '--org', org.organizationId, '--reason', 'Atmark 지원 수신함']);
        expect(first.out.outLines).toEqual([`grant ${address} ${org.organizationId} created`]);
        const again = await run(['grant', '--address', address.toUpperCase(), '--org', org.organizationId, '--reason', 'again']);
        expect(again.out.outLines).toEqual([`grant ${address} ${org.organizationId} exists`]);
      }
      // 다른 조직으로 다시 허가 → 거부(옮기는 길 없음).
      const other = await seedFixture(testPool());
      await expect(run(['grant', '--address', 'support@atmark.ai', '--org', other.organizationId, '--reason', 'x'])).rejects.toThrow(/다른 조직/);

      const provisioned = await run(['provision', '--address', 'support@atmark.ai', '--org', org.organizationId, '--name', 'Atmark Support']);
      expect(provisioned.code).toBe(0);
      const agentLine = provisioned.out.outLines.find((line) => line.startsWith('agent '));
      const agentId = agentLine?.slice('agent '.length) ?? '';
      expect(provisioned.out.outLines).toContain('address support@atmark.ai');
      expect(provisioned.out.outLines.some((line) => line.startsWith('token atk_agent_'))).toBe(true);
      const mode = await client.query<{ outbound_mode: string; name: string }>(
        'SELECT p.outbound_mode, a.name FROM agents a JOIN agent_policies p ON p.agent_id = a.id WHERE a.id = $1',
        [agentId],
      );
      expect(mode.rows[0]).toEqual({ outbound_mode: 'allowlist_only', name: 'Atmark Support' });

      // 멱등 — 다시 돌리면 같은 에이전트, 토큰 없음.
      const replay = await run(['provision', '--address', 'support@atmark.ai', '--org', org.organizationId, '--name', 'Atmark Support']);
      expect(replay.out.outLines).toEqual([`agent ${agentId}`, 'address support@atmark.ai']);

      // alias — Free(콘솔 한도 0)여도 붙는다 · 두 번째는 exists.
      const alias = await run(['alias', '--agent', agentId, '--address', 'onve@atmark.ai']);
      expect(alias.out.outLines).toEqual([`alias onve@atmark.ai ${agentId} created`]);
      const aliasAgain = await run(['alias', '--agent', agentId, '--address', 'onve@atmark.ai']);
      expect(aliasAgain.out.outLines).toEqual([`alias onve@atmark.ai ${agentId} exists`]);
      // 허가가 없는 주소(postmaster@)를 별칭으로 → 입력 오류.
      await expect(run(['alias', '--agent', agentId, '--address', 'postmaster@atmark.ai'])).rejects.toThrow(/허가가 없다/);
      // 운영자 목록을 떠난 claude@(202610141200) → 운영자 예약 주소가 아니다(허가 · provision · alias 모두).
      await expect(run(['alias', '--agent', agentId, '--address', 'claude@atmark.ai'])).rejects.toThrow(AdminInputError);
      await expect(run(['grant', '--address', 'claude@atmark.ai', '--org', org.organizationId, '--reason', 'x'])).rejects.toThrow(AdminInputError);

      const rows = await client.query<{ address: string; is_primary: boolean }>(
        'SELECT address, is_primary FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL ORDER BY address',
        [agentId],
      );
      expect(rows.rows).toEqual([
        { address: 'onve@atmark.ai', is_primary: false },
        { address: 'support@atmark.ai', is_primary: true },
      ]);

      // 콘솔 경로(공통 판정)는 여전히 예약 로컬파트로 거부한다.
      await expect(addAliasOp(pool, org.organizationId, toAgentId(agentId), 'onve', new Date())).rejects.toMatchObject({ code: 'reserved_local_part' });
    });
  });

  it('⑥′ 인자 — 목록 밖 주소 · 하위 명령 없음 · 빈 사유는 접속 전에 입력 오류', () => {
    expect(() => parseReservedAddressArgs(['grant', '--address', 'billing@atmark.ai', '--org', randomUUID(), '--reason', 'x'])).toThrow(AdminInputError);
    expect(() => parseReservedAddressArgs(['--address', 'support@atmark.ai'])).toThrow(/하위 명령/);
    expect(() => parseReservedAddressArgs(['grant', '--address', 'support@atmark.ai', '--org', randomUUID(), '--reason', ' '])).toThrow(/--reason/);
    expect(() => parseReservedAddressArgs(['alias', '--address', 'onve@atmark.ai', '--agent', `not-${randomBytes(2).toString('hex')}`])).toThrow(/--agent/);
    expect(parseReservedAddressArgs(['--help'])).toBeNull();
  });
});
