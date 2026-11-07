/**
 * **가드 일치 — 같은 입력은 CLI 와 관리 API 에서 같은 코드로 거부된다.** 한쪽만 고쳐지는 날을 막는다.
 *
 * 두 표면이 같은 함수(`src/admin/ops/**`)를 부르므로 이 테스트는 "공유가 실제로 일어났는가" 의 증거다: CLI 쪽 가드를 스크립트
 * 안으로 되돌려 복사하거나(API 만 새 규칙) API 라우트에 자기 검증을 두면(CLI 만 옛 규칙) 코드가 갈라져 여기서 빨개진다.
 *
 * 가드: 목록 값 모양·방향·목록 · 중복 · 발신 allow 자기 주소 · 레거시 모드 거부 · 모르는 모드 · 분당 한도 ·
 * kill-switch 전이 · 토큰 1회 노출 · 폐기 시각 불변 · 프로비저닝 원자성 · DID 비노출.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { agentProvision } from '../../../scripts/admin/agent-provision';
import { agentToken } from '../../../scripts/admin/agent-token';
import type { AdminIo } from '../../../scripts/admin/common';
import { killSwitch } from '../../../scripts/admin/kill-switch';
import { AC7_ACK_FLAG, policy } from '../../../scripts/admin/policy';
import { rules } from '../../../scripts/admin/rules';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, OWNER_URL, ownerPool, type Session } from './support';

const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-parity-keys-'));
const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'parity-test' });

function io(): AdminIo & { outLines: string[] } {
  const outLines: string[] = [];
  return { outLines, out: (line) => outLines.push(line), err: () => undefined, interactive: false, ask: async () => '' };
}

/** CLI 가 던진 거부의 코드. 거부가 아니면 던진다. */
async function cliCode(run: Promise<number>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AdminInputError) return error.code;
    throw error;
  }
  throw new Error('CLI 가 거부하지 않았다');
}

describe.skipIf(!AVAILABLE)('가드 일치 — CLI(소유자 롤) 와 관리 API(atmark_admin 롤) 가 같은 입력을 같은 코드로 거부한다', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let session: Session;
  let orgId: string;
  const deps = () => adminDeps(admin);
  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    const org = await newOrganization(owner);
    orgId = org.id;
    session = await login(deps(), mailer, org);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
  });

  async function newAgent(): Promise<{ id: string; address: string; token: string }> {
    const created = await call(deps(), 'POST', '/api/agents', authed(session, { body: { name: 'parity', localPart: `parity-${Math.random().toString(16).slice(2, 10)}` } }));
    expect(created.statusCode).toBe(201);
    const payload = created.json() as { agent: { id: string; address: string }; token: string };
    return { id: payload.agent.id, address: payload.agent.address, token: payload.token };
  }

  async function apiCode(method: string, path: string, body: unknown): Promise<string> {
    const result = await call(deps(), method, path, authed(session, { body }));
    expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400);
    return (result.json() as { error: string }).error;
  }

  async function policyVersion(agentId: string): Promise<number> {
    return (await owner.query<{ v: number }>('SELECT current_version AS v FROM agent_policies WHERE agent_id = $1', [agentId])).rows[0]?.v ?? -1;
  }

  it('레거시 모드 · 모르는 모드 · 분당 한도 0 — 같은 코드, 그리고 어느 쪽도 버전을 올리지 않는다', async () => {
    const agent = await newAgent();
    const cases: readonly (readonly [readonly string[], Record<string, unknown>, string])[] = [
      [['--outbound', 'approval_required'], { outbound: { mode: 'approval_required' } }, 'legacy_mode_rejected'],
      [['--outbound', 'reply_only'], { outbound: { mode: 'reply_only' } }, 'legacy_mode_rejected'],
      [['--outbound', 'unrestricted'], { outbound: { mode: 'unrestricted' } }, 'invalid_mode'],
      [['--inbound', 'allow_list'], { inbound: { mode: 'allow_list' } }, 'invalid_mode'],
      [['--per-minute', '0'], { limits: { perMinute: 0 } }, 'invalid_per_minute'],
    ];
    for (const [flags, body, code] of cases) {
      expect(await cliCode(policy(['--agent', agent.id, ...flags], { env: env(), io: io() })), flags.join(' ')).toBe(code);
      expect(await apiCode('PATCH', `/api/agents/${agent.id}/policy`, body), JSON.stringify(body)).toBe(code);
    }
    expect(await policyVersion(agent.id)).toBe(1);
    // 옳은 이름이면 둘 다 된다(각자 새 버전).
    expect(await policy(['--agent', agent.id, '--outbound', 'blocklist'], { env: env(), io: io() })).toBe(0);
    const api = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, authed(session, { body: { outbound: { mode: 'all' }, inbound: { mode: 'allowlist' } } }));
    expect(api.statusCode).toBe(200);
    expect(api.json()).toMatchObject({ outbound: { mode: 'all' }, inbound: { mode: 'allowlist' }, version: 3 });
    // AC-7 손잡이는 CLI 에만 있다 — API 는 옛 키를 받지 않는다(조용히 무시하지 않는다).
    expect(await apiCode('PATCH', `/api/agents/${agent.id}/policy`, { autoApproveVerificationSenders: true, ac7Acknowledged: true })).toBe('invalid_body');
    expect(await cliCode(policy(['--agent', agent.id, '--auto-approve-verification-senders', 'on'], { env: env(), io: io() }))).toBe('ac7_unacknowledged');
  });

  it('목록 규칙: 모양·방향·목록 · 중복 · 발신 allow 자기 주소 · 없는 규칙 — 같은 코드, 상태는 그대로', async () => {
    const agent = await newAgent();
    const addCli = (value: string, direction: string, list: string): Promise<number> =>
      rules(['--agent', agent.id, '--add', value, '--direction', direction, '--list', list], { env: env(), io: io() });
    const cases: readonly (readonly [string, string, string, string])[] = [
      ['@example.com', 'outbound', 'allow', 'invalid_rule_value'],
      ['user@exa mple.com', 'outbound', 'allow', 'invalid_rule_value'],
      ['bücher.example', 'inbound', 'block', 'invalid_rule_value'],
      ['x@example.com', 'sideways', 'allow', 'invalid_rule_direction'],
      ['x@example.com', 'outbound', 'maybe', 'invalid_rule_list'],
      [agent.address, 'outbound', 'allow', 'rule_self_address'],
    ];
    for (const [value, direction, list, code] of cases) {
      expect(await cliCode(addCli(value, direction, list)), value).toBe(code);
      expect(await apiCode('POST', `/api/agents/${agent.id}/rules`, { direction, list, value }), value).toBe(code);
    }
    expect(await policyVersion(agent.id)).toBe(1);

    // 중복: CLI 가 먼저 넣고, 같은 값을 두 표면이 같은 코드로 거부한다.
    expect(await addCli('partner.example', 'outbound', 'allow')).toBe(0);
    expect(await cliCode(addCli('Partner.Example', 'outbound', 'allow'))).toBe('rule_duplicate');
    expect(await apiCode('POST', `/api/agents/${agent.id}/rules`, { direction: 'outbound', list: 'allow', value: ' PARTNER.example ' })).toBe('rule_duplicate');
    expect(await policyVersion(agent.id)).toBe(2);

    // 없는 규칙 · 모양 틀린 id — 같은 404 코드.
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await cliCode(rules(['--agent', agent.id, '--remove', missing], { env: env(), io: io() }))).toBe('rule_not_found');
    expect(await apiCode('DELETE', `/api/agents/${agent.id}/rules/${missing}`, undefined)).toBe('rule_not_found');
    expect(await apiCode('DELETE', `/api/agents/${agent.id}/rules/not-a-uuid`, undefined)).toBe('rule_not_found');
    expect(await policyVersion(agent.id)).toBe(2);
  });

  it('kill-switch: provisioning 은 어느 표면으로도 active 로 올리지 않는다(같은 코드)', async () => {
    const agent = await newAgent();
    await owner.query(`UPDATE agents SET status = 'provisioning' WHERE id = $1`, [agent.id]);
    expect(await cliCode(killSwitch(['--agent', agent.id, 'off'], { env: env(), io: io() }))).toBe('invalid_transition');
    expect(await apiCode('POST', '/api/kill-switch', { scope: 'agent', id: agent.id, on: false })).toBe('invalid_transition');
    const status = await owner.query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [agent.id]);
    expect(status.rows[0]?.status).toBe('provisioning');
  });

  it('토큰: 새 평문은 각 표면에서 한 번 · 이미 폐기된 행의 revoked_at 은 어느 표면도 덮지 않는다', async () => {
    const agent = await newAgent();
    const cli = io();
    expect(await agentToken(['--agent', agent.id, '--rotate'], { env: env(), io: cli })).toBe(0);
    const cliToken = cli.outLines.find((line) => line.startsWith('token '))?.slice('token '.length) ?? '';
    expect(cliToken).toMatch(/^atk_agent_/);
    const first = await owner.query<{ token_hash: string; revoked_at: Date }>(
      'SELECT token_hash, revoked_at FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NOT NULL',
      [agent.id],
    );
    expect(first.rows).toHaveLength(1);
    const rotated = await call(deps(), 'POST', `/api/agents/${agent.id}/token`, authed(session, { body: { action: 'rotate' } }));
    const apiToken = (rotated.json() as { token: string; revoked: number }).token;
    expect(rotated.json()).toMatchObject({ revoked: 1 });
    expect(apiToken).toMatch(/^atk_agent_/);
    expect(apiToken).not.toBe(cliToken);
    const again = await owner.query<{ token_hash: string; revoked_at: Date }>('SELECT token_hash, revoked_at FROM agent_api_keys WHERE token_hash = $1', [first.rows[0]?.token_hash]);
    expect(again.rows[0]?.revoked_at.getTime()).toBe(first.rows[0]?.revoked_at.getTime());
    // API 의 revoke-all: 새 토큰 필드가 없다.
    const revoked = await call(deps(), 'POST', `/api/agents/${agent.id}/token`, authed(session, { body: { action: 'revoke-all' } }));
    expect(revoked.json()).toEqual({ revoked: 1 });
    // 감사 행에 토큰이 없다.
    const audit = await owner.query('SELECT * FROM owner_actions WHERE organization_id = $1', [orgId]);
    expect(JSON.stringify(audit.rows)).not.toContain(apiToken);
  });

  it('프로비저닝 원자성: 주소 중복은 두 표면 모두 흔적 0 · DID 는 어느 출력에도 없다', async () => {
    const local = `atomic-${Math.random().toString(16).slice(2, 10)}`;
    const cli = io();
    expect(await agentProvision(['--org', orgId, '--name', `cli-${local}`, '--local-part', local], { env: env(), io: cli })).toBe(0);
    expect(cli.outLines.join('\n')).not.toMatch(/did:/);
    const dup = await call(deps(), 'POST', '/api/agents', authed(session, { body: { name: `api-${local}`, localPart: local } }));
    expect([dup.statusCode, (dup.json() as { error: string }).error]).toEqual([409, 'conflict']);
    await expect(agentProvision(['--org', orgId, '--name', `cli2-${local}`, '--local-part', local], { env: env(), io: io() })).rejects.toThrow();
    const left = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agents WHERE name IN ($1, $2)`,
      [`api-${local}`, `cli2-${local}`],
    );
    expect(left.rows[0]?.n).toBe('0');
    const list = await call(deps(), 'GET', '/api/agents', authed(session));
    expect(list.body).not.toMatch(/did:/);
  });
});
