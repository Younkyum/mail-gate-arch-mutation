/**
 * `pnpm admin:*` — 실제 Postgres(소유자 롤) 위에서. **AWS 를 부르지 않는다**(로컬 DB 대상 = 로컬 custody).
 *
 * 되돌리면 빨개져야 하는 것(검증 규율):
 *   - 프로비저닝 원자성 — 중간(주소 중복) 실패 시 에이전트·키·passport·정책 전무
 *   - DID 비출력(B5) · 토큰 평문 비저장
 *   - seed 21개 거부(기존 + 새 입력의 합) · `--remove` 거부
 *   - `auto_approve_verification_senders on` 은 AC-7 플래그 없이 거부 — 새 버전이 생기지 않는다
 *   - 앱 롤로 붙으면 거부 · TLS 없는 운영 접속은 **프로세스 수준에서** exit 2(접속 시도 전)
 *
 * `TEST_MIGRATION_DATABASE_URL`(소유자 롤)이 없으면 건너뛴다.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { agentProvision } from '../../../scripts/admin/agent-provision';
import { agentToken } from '../../../scripts/admin/agent-token';
import { AdminInputError, type AdminIo } from '../../../scripts/admin/common';
import { killSwitch } from '../../../scripts/admin/kill-switch';
import { orgCreate } from '../../../scripts/admin/org-create';
import { AC7_ACK_FLAG, policy } from '../../../scripts/admin/policy';
import { rules } from '../../../scripts/admin/rules';
import { recordTlogCapabilities } from '../db/support/harness';

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const APP_URL = process.env['TEST_DATABASE_URL'] ?? '';
const AVAILABLE = OWNER_URL.trim() !== '';

const ROOT = resolve(__dirname, '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

interface Io extends AdminIo {
  readonly outLines: string[];
  readonly errLines: string[];
  all(): string;
}

function io(): Io {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    interactive: false,
    ask: async () => '',
    all: () => [...outLines, ...errLines].join('\n'),
  };
}

const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-admin-keys-'));
// 로컬 DB 대상: ATMARK_ENV 없음, 개발 키는 임시 디렉터리로(리포에 키 파일을 남기지 않는다).
const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'admin-test' });
const suffix = (): string => randomBytes(4).toString('hex');
const valueOf = (lines: readonly string[], key: string): string => {
  const line = lines.find((candidate) => candidate.startsWith(`${key} `));
  if (line === undefined) throw new Error(`출력에 ${key} 가 없다: ${lines.join(' | ')}`);
  return line.slice(key.length + 1);
};

describe.skipIf(!AVAILABLE)('admin CLI (소유자 롤, 로컬 DB)', () => {
  let db: Pool;
  beforeAll(async () => {
    await recordTlogCapabilities();
    db = createPool(OWNER_URL, { max: 2 });
  });
  afterAll(async () => {
    await db.end();
  });

  async function newOrg(): Promise<string> {
    const out = io();
    expect(await orgCreate(['--name', `admin-test-${suffix()}`, '--owner-email', 'owner.admin@gmail.com'], { env: env(), io: out })).toBe(0);
    return valueOf(out.outLines, 'organization');
  }

  async function newAgent(orgId: string, extra: string[] = []): Promise<{ agentId: string; address: string; token: string; io: Io }> {
    const out = io();
    const local = `admin-${suffix()}`;
    expect(await agentProvision(['--org', orgId, '--name', `agent-${local}`, '--local-part', local, ...extra], { env: env(), io: out })).toBe(0);
    return { agentId: valueOf(out.outLines, 'agent'), address: valueOf(out.outLines, 'address'), token: valueOf(out.outLines, 'token'), io: out };
  }

  // -------------------------------------------------------------------------

  it('org-create: owner_email 필수 · atmark.ai 거부 · 정상이면 조직 id 를 낸다', async () => {
    await expect(orgCreate(['--name', 'x'], { env: env(), io: io() })).rejects.toThrow(/--owner-email/);
    await expect(orgCreate(['--name', 'x', '--owner-email', 'me@atmark.ai'], { env: env(), io: io() })).rejects.toThrow(/에이전트 도메인/);
    const orgId = await newOrg();
    const row = await db.query<{ owner_email: string }>('SELECT owner_email FROM organizations WHERE id = $1', [orgId]);
    expect(row.rows[0]?.owner_email).toBe('owner.admin@gmail.com');
  });

  it('agent-provision: 한 번에 에이전트·키·draft passport·주소·allowlist_only v1(seed = 발신 allow — "전체" 기본값은 콘솔 세션만)·토큰 — DID 는 출력에 없다(B5)', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId, ['--seeds', 'friend.one@gmail.com,friend.two@naver.com']);

    const state = await db.query<{ status: string; mode: string; version: number; key_ref: string; did: string; pstatus: string }>(
      `SELECT a.status, p.outbound_mode AS mode, p.current_version AS version, k.key_ref, pp.did, pp.status AS pstatus
         FROM agents a JOIN agent_policies p ON p.agent_id = a.id JOIN agent_keypairs k ON k.agent_id = a.id
         JOIN passports pp ON pp.agent_id = a.id WHERE a.id = $1`,
      [agent.agentId],
    );
    const row = state.rows[0];
    expect(row).toMatchObject({ status: 'active', mode: 'allowlist_only', version: 1, pstatus: 'draft' });
    expect(row?.key_ref).toBe(`devfile://${agent.agentId}`);
    // B5 — draft passport 의 DID 가 stdout·stderr 어디에도 없다.
    expect(row?.did).toMatch(/^did:/);
    expect(agent.io.all()).not.toContain(row?.did ?? '(none)');
    expect(agent.io.all()).not.toMatch(/did:/);

    const seedRows = await db.query('SELECT 1 FROM sender_relationships WHERE agent_id = $1 AND trust_category = $2', [agent.agentId, 'seed']);
    expect(seedRows.rowCount).toBe(2);
    // 정책 v2 — seed 가 발신 allow 목록이 되고, 버전 1 스냅샷이 그 목록을 싣는다.
    const allow = await db.query<{ value: string }>(
      `SELECT value FROM agent_contact_rules WHERE agent_id = $1 AND direction = 'outbound' AND list = 'allow' ORDER BY value`,
      [agent.agentId],
    );
    expect(allow.rows.map((r) => r.value)).toEqual(['friend.one@gmail.com', 'friend.two@naver.com']);
    const snapshot = await db.query<{ n: string }>(
      `SELECT jsonb_array_length(snapshot->'contact_rules')::text AS n FROM policy_versions WHERE agent_id = $1 AND version = 1`,
      [agent.agentId],
    );
    expect(snapshot.rows[0]?.n).toBe('2');
  });

  it('agent-provision 원자성: 주소 중복으로 중간 실패 → 두 번째 에이전트의 흔적 전무', async () => {
    const orgId = await newOrg();
    const local = `admin-dup-${suffix()}`;
    expect(await agentProvision(['--org', orgId, '--name', `first-${local}`, '--local-part', local], { env: env(), io: io() })).toBe(0);
    const secondName = `second-${local}`;
    // agents·keypair·passport INSERT 가 **먼저** 성공한 뒤 agent_addresses 의 유니크에서 죽는다.
    await expect(agentProvision(['--org', orgId, '--name', secondName, '--local-part', local], { env: env(), io: io() })).rejects.toThrow();
    const left = await db.query<{ agents: string; keypairs: string; passports: string; policies: string }>(
      `SELECT (SELECT count(*) FROM agents WHERE name = $1)::text AS agents,
              (SELECT count(*) FROM agent_keypairs k JOIN agents a ON a.id = k.agent_id WHERE a.name = $1)::text AS keypairs,
              (SELECT count(*) FROM passports p JOIN agents a ON a.id = p.agent_id WHERE a.name = $1)::text AS passports,
              (SELECT count(*) FROM agent_policies p JOIN agents a ON a.id = p.agent_id WHERE a.name = $1)::text AS policies`,
      [secondName],
    );
    expect(left.rows[0]).toEqual({ agents: '0', keypairs: '0', passports: '0', policies: '0' });
  });

  it('agent-token: 평문은 stdout 한 번 · DB 에는 sha256 만 · 없는 에이전트 거부', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId);
    const out = io();
    expect(await agentToken(['--agent', agent.agentId, '--expires', '30d', '--capabilities', 'messages:read'], { env: env(), io: out })).toBe(0);
    const token = valueOf(out.outLines, 'token');
    expect(token).toMatch(/^atk_agent_/);
    expect(out.all().split(token).length - 1).toBe(1);

    const rows = await db.query<Record<string, unknown>>('SELECT * FROM agent_api_keys WHERE agent_id = $1', [agent.agentId]);
    expect(rows.rows).toHaveLength(2); // 프로비저닝 토큰 + 이번 토큰
    const hash = createHash('sha256').update(token).digest('hex');
    const mine = rows.rows.find((r) => r['token_hash'] === hash);
    expect(mine).toBeDefined();
    expect(mine?.['expires_at']).toBeInstanceOf(Date);
    // 어떤 컬럼에도 평문(또는 그 비밀부)이 없다.
    const secretPart = token.slice('atk_agent_'.length);
    for (const row of rows.rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(secretPart);
      expect(serialized).not.toContain(agent.token);
    }
    await expect(agentToken(['--agent', 'f'.repeat(32)], { env: env(), io: io() })).rejects.toThrow(/에이전트가 없다/);
  });

  it('agent-token --rotate: 살아 있던 토큰 전부 폐기 + 새 토큰 1개 — 한 트랜잭션 · 폐기 시각은 덮지 않는다', async () => {
    // kill-switch 는 토큰 유출의 대안이 아니다 — 정지를 풀면 유출된 토큰도 같이 살아난다(리드, 2026-09-23).
    const orgId = await newOrg();
    const agent = await newAgent(orgId);
    const active = async (): Promise<string[]> =>
      (await db.query<{ token_hash: string }>('SELECT token_hash FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [agent.agentId])).rows.map((r) => r.token_hash);
    const oldHash = createHash('sha256').update(agent.token).digest('hex');
    expect(await active()).toEqual([oldHash]);

    const out = io();
    expect(await agentToken(['--agent', agent.agentId, '--rotate'], { env: env(), io: out })).toBe(0);
    const fresh = valueOf(out.outLines, 'token');
    const freshHash = createHash('sha256').update(fresh).digest('hex');
    expect(await active()).toEqual([freshHash]);
    const oldRow = await db.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM agent_api_keys WHERE token_hash = $1', [oldHash]);
    const firstRevokedAt = oldRow.rows[0]?.revoked_at;
    expect(firstRevokedAt).toBeInstanceOf(Date);

    // --revoke-all: 새 토큰 없이 전부 폐기. 이미 폐기된 옛 토큰의 revoked_at 은 그대로.
    const out2 = io();
    expect(await agentToken(['--agent', agent.agentId, '--revoke-all'], { env: env(), io: out2 })).toBe(0);
    expect(out2.outLines.some((line) => line.startsWith('token '))).toBe(false);
    expect(await active()).toEqual([]);
    const again = await db.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM agent_api_keys WHERE token_hash = $1', [oldHash]);
    expect(again.rows[0]?.revoked_at?.getTime()).toBe(firstRevokedAt?.getTime());

    await expect(agentToken(['--agent', agent.agentId, '--rotate', '--revoke-all'], { env: env(), io: io() })).rejects.toThrow(/함께 쓸 수 없다/);
  });

  it('rules: 더하기·지우기마다 새 policy_versions 행(스냅샷에 목록) · 중복 409 · --show · 모양 거부', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId, ['--seeds', 'a0@example.com']);

    const add = io();
    expect(await rules(['--agent', agent.agentId, '--add', 'Partner.Example', '--direction', 'outbound', '--list', 'allow'], { env: env(), io: add })).toBe(0);
    const ruleId = add.outLines[0]?.split('\t')[0] ?? '';
    expect(ruleId).toMatch(/^[0-9a-f-]{36}$/);
    const v2 = await db.query<{ version: number; n: string; by: string }>(
      `SELECT p.current_version AS version, jsonb_array_length(v.snapshot->'contact_rules')::text AS n, v.created_by AS by
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
        WHERE p.agent_id = $1`,
      [agent.agentId],
    );
    expect(v2.rows[0]).toEqual({ version: 2, n: '2', by: 'admin:rules:admin-test' });

    await expect(
      rules(['--agent', agent.agentId, '--add', 'partner.example', '--direction', 'outbound', '--list', 'allow'], { env: env(), io: io() }),
    ).rejects.toThrow(/이미 목록에 있다/);
    await expect(
      rules(['--agent', agent.agentId, '--add', '@partner.example', '--direction', 'outbound', '--list', 'allow'], { env: env(), io: io() }),
    ).rejects.toThrow(AdminInputError);
    await expect(
      rules(['--agent', agent.agentId, '--add', 'x@example.com', '--direction', 'sideways', '--list', 'allow'], { env: env(), io: io() }),
    ).rejects.toThrow(AdminInputError);

    const show = io();
    expect(await rules(['--agent', agent.agentId, '--show'], { env: env(), io: show })).toBe(0);
    expect(show.outLines.map((line) => line.split('\t').slice(0, 3).join(' '))).toEqual([
      'outbound allow a0@example.com',
      'outbound allow partner.example',
    ]);

    expect(await rules(['--agent', agent.agentId, '--remove', ruleId], { env: env(), io: io() })).toBe(0);
    const v3 = await db.query<{ version: number; n: string }>(
      `SELECT p.current_version AS version, jsonb_array_length(v.snapshot->'contact_rules')::text AS n
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
        WHERE p.agent_id = $1`,
      [agent.agentId],
    );
    expect(v3.rows[0]).toEqual({ version: 3, n: '1' });
    await expect(rules(['--agent', agent.agentId, '--remove', ruleId], { env: env(), io: io() })).rejects.toThrow(/규칙이 없다/);
  });

  it('rules: 발신 allow 에 자기 주소 거부(+tag 변형 포함)', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId);
    const tagged = agent.address.replace('@', '+x@');
    for (const value of [agent.address, tagged]) {
      await expect(
        rules(['--agent', agent.agentId, '--add', value, '--direction', 'outbound', '--list', 'allow'], { env: env(), io: io() }),
      ).rejects.toThrow(/자기 주소/);
    }
    // 차단·수신 목록에는 된다(스스로에게 보내는 길을 여는 것이 아니다).
    expect(
      await rules(['--agent', agent.agentId, '--add', agent.address, '--direction', 'inbound', '--list', 'block'], { env: env(), io: io() }),
    ).toBe(0);
  });

  it('policy: 바꾸면 새 버전(스냅샷 모드 포함) · 레거시 모드 거부 · verification_senders on 은 플래그 없이 거부하고 버전이 늘지 않는다', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId);

    expect(
      await policy(['--agent', agent.agentId, '--outbound', 'blocklist', '--inbound', 'allowlist', '--per-minute', '3'], { env: env(), io: io() }),
    ).toBe(0);
    const v2 = await db.query<{ mode: string; snap_mode: string; in_mode: string; snap_in: string; per_minute: number; by: string }>(
      `SELECT p.outbound_mode AS mode, v.outbound_mode AS snap_mode, p.inbound_mode AS in_mode, v.snapshot->>'inbound_mode' AS snap_in,
              (p.limits->>'per_minute')::int AS per_minute, v.created_by AS by
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
        WHERE p.agent_id = $1 AND p.current_version = 2`,
      [agent.agentId],
    );
    expect(v2.rows[0]).toEqual({
      mode: 'blocklist_only',
      snap_mode: 'blocklist_only',
      in_mode: 'allowlist_only',
      snap_in: 'allowlist_only',
      per_minute: 3,
      by: 'admin:policy:admin-test',
    });

    await expect(policy(['--agent', agent.agentId, '--outbound', 'approval_required'], { env: env(), io: io() })).rejects.toThrow(/레거시/);
    await expect(
      policy(['--agent', agent.agentId, '--auto-approve-verification-senders', 'on'], { env: env(), io: io() }),
    ).rejects.toThrow(/AC-7/);
    const versions = await db.query('SELECT 1 FROM policy_versions WHERE agent_id = $1', [agent.agentId]);
    expect(versions.rowCount).toBe(2);

    expect(
      await policy(['--agent', agent.agentId, '--auto-approve-verification-senders', 'on', `--${AC7_ACK_FLAG}`], { env: env(), io: io() }),
    ).toBe(0);
    const v3 = await db.query<{ on: boolean }>(
      `SELECT (config_json->>'auto_approve_verification_senders')::boolean AS on FROM agent_policies WHERE agent_id = $1 AND current_version = 3`,
      [agent.agentId],
    );
    expect(v3.rows[0]?.on).toBe(true);

    // 전체(all) 는 이제 고를 수 있다(Phase 1 거부 해제).
    expect(await policy(['--agent', agent.agentId, '--outbound', 'all'], { env: env(), io: io() })).toBe(0);
    await expect(policy(['--agent', agent.agentId, '--outbound', 'unrestricted'], { env: env(), io: io() })).rejects.toThrow(AdminInputError);
    const read = io();
    expect(await policy(['--agent', agent.agentId], { env: env(), io: read })).toBe(0);
    expect(read.outLines[0]).toBe('version 4');
    expect(read.outLines[1]).toMatch(/^outbound all/);
  });

  it('kill-switch: 에이전트 active↔suspended · provisioning 은 올리지 않는다 · 조직 abuse_freeze', async () => {
    const orgId = await newOrg();
    const agent = await newAgent(orgId);
    const status = async (): Promise<string | undefined> =>
      (await db.query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [agent.agentId])).rows[0]?.status;

    expect(await killSwitch(['--agent', agent.agentId, 'on'], { env: env(), io: io() })).toBe(0);
    expect(await status()).toBe('suspended');
    expect(await killSwitch(['--agent', agent.agentId, 'off'], { env: env(), io: io() })).toBe(0);
    expect(await status()).toBe('active');

    await db.query(`UPDATE agents SET status = 'provisioning' WHERE id = $1`, [agent.agentId]);
    await expect(killSwitch(['--agent', agent.agentId, 'off'], { env: env(), io: io() })).rejects.toThrow(/provisioning/);
    expect(await status()).toBe('provisioning');

    expect(await killSwitch(['--org', orgId, 'on'], { env: env(), io: io() })).toBe(0);
    const frozen = await db.query<{ f: boolean }>('SELECT abuse_freeze AS f FROM organizations WHERE id = $1', [orgId]);
    expect(frozen.rows[0]?.f).toBe(true);
    expect(await killSwitch(['--org', orgId, 'off', '--reason', 'test unfreeze'], { env: env(), io: io() })).toBe(0);
  });

  it.skipIf(APP_URL.trim() === '')('앱 롤로 붙으면 거부한다', async () => {
    await expect(
      orgCreate(['--name', 'x', '--owner-email', 'owner.admin@gmail.com'], { env: { DATABASE_MIGRATION_URL: APP_URL }, io: io() }),
    ).rejects.toThrow(/소유자 롤/);
  });
});

describe('프로세스 수준 — 진입점 · exit code', () => {
  function run(script: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv) {
    const result = spawnSync(TSX, [resolve(ROOT, 'scripts/admin', script), ...args], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('TLS 없는 운영 접속(터널 포트) → exit 2, 접속 시도 전에 거부 · stdout 비어 있음', () => {
    for (const url of ['postgres://o:pw@localhost:15432/atmark', 'postgres://o:pw@localhost:15432/atmark?sslmode=disable']) {
      const result = run('org-create.ts', ['--name', 'x', '--owner-email', 'owner.admin@gmail.com', '--yes'], { DATABASE_MIGRATION_URL: url });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/TLS 검증 없이/);
      expect(result.stderr).not.toContain('pw@');
      expect(result.stdout).toBe('');
    }
  });

  it('소유자 URL 이 없으면 exit 2 — 앱 롤 URL(DATABASE_URL)로 떨어지지 않는다', () => {
    const result = run('kill-switch.ts', ['--agent', 'a'.repeat(32), 'on'], { DATABASE_URL: 'postgres://atmark_app@localhost:5432/atmark' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/DATABASE_MIGRATION_URL/);
  });
});
