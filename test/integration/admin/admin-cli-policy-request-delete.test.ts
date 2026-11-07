/**
 * 운영자 CLI `pnpm admin:policy-request` · `pnpm admin:agent-delete` — 실제 Postgres(소유자 롤) 위에서. 콘솔과 **같은 연산**을 부르는지,
 * 행위자가 운영자로 남고 사용자 세션을 흉내 내지 않는지 본다. 실메일 0 · AWS 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 승인 → 새 정책 버전 · `created_by = admin:policy-request:<운영자> policy_request:<id>` · 요청 `decided_by` 운영자 · `decided_user_id` NULL ·
 *     **지속 감사** `owner_actions` 1행(`agent.policy_request.approve` — 콘솔과 같은 코드 · 세션 · 키 칸 없음 · 운영자 행위자 · 사유
 *     `policy_request:<id>` · 투명성 로그 outbox 사건).
 *   - 거절 → 정책 그대로 · 감사 `agent.policy_request.reject`(+ `--reason`) · 두 번 결정은 `policy_request_decided`(감사 행 더 없음).
 *   - stale(이미 그 상태) → exit 1 · 요청 stale(already_applied) · 정책 그대로 · 감사 `agent.policy_request.stale`.
 *   - 서열기 능력이 없으면 감사 INSERT 가 55000 — 결정도 함께 되돌아간다(요청 pending · 정책 그대로, 되돌림 트랜잭션).
 *   - 오염된 요청은 `--ack-risk` 없이 `risk_ack_required`(쓰기 0) · 있으면 승인.
 *   - 삭제 → disabled · 주소 · 토큰 폐기 · **지속 감사** `owner_actions` 1행(행위자 `admin:agent-delete:<운영자>` · 사유 — 202610131610, 세션 · 키 칸 없음 ·
 *     투명성 로그 잎 `c.operator`) · 재생은 replayed(바뀐 것 없으면 감사 행 없음) · 운영자 예약 주소 `operator_reserved` ·
 *     운영자 정지 `operator_suspension` · `--reason` 없으면 연결 전 거부.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { transactionPool } from '../../../src/admin/ops/transaction';
import { approveRequest } from '../../../src/approval/service';
import { ApprovalBlockedByAgentDeletedError, createPostgresApprovalStore } from '../../../src/db/repositories/approval-store';
import type { ApiRequest } from '../../../src/api/http';
import { handleCreatePolicyRequest, type PolicyRequestRouteDependencies } from '../../../src/api/routes/policy-requests';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories';
import { createPostgresPolicyRequestStore } from '../../../src/db/repositories/policy-request-store';
import { agentDelete, parseAgentDeleteArgs, runAgentDelete } from '../../../scripts/admin/agent-delete';
import { classifyTarget, type AdminIo } from '../../../scripts/admin/common';
import { killSwitch } from '../../../scripts/admin/kill-switch';
import { parsePolicyRequestArgs, policyRequest, runPolicyRequest } from '../../../scripts/admin/policy-request';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, OWNER_URL, ownerPool, suffix, type Session } from './support';
import { recordTlogCapabilities } from '../db/support/harness';

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

const env = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, USER: 'ops-test' });
const ACTOR = 'admin:policy-request:ops-test';

describe.skipIf(!AVAILABLE)('운영자 CLI — 정책 변경 요청 결정 · 에이전트 삭제', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let api: PolicyRequestRouteDependencies;
  const deps = () => adminDeps(admin);

  beforeAll(async () => {
    await recordTlogCapabilities();
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = appPool();
    api = { tokens: createPostgresAgentTokenStore(app), policyRequests: createPostgresPolicyRequestStore(app), now: () => new Date() };
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
    await app.end();
  });

  interface Fixture {
    readonly orgId: string;
    readonly session: Session;
    readonly agentId: string;
    readonly address: string;
    readonly token: string;
  }

  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    const session = await login(deps(), mailer, org);
    const created = await call(deps(), 'POST', '/api/agents', authed(session, { body: { name: 'cli-target', localPart: `cli-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { agent: { id: string; address: string }; token: string };
    return { orgId: org.id, session, agentId: body.agent.id, address: body.agent.address, token: body.token };
  }

  function bearer(token: string, body?: unknown): ApiRequest {
    return { headers: { authorization: `Bearer ${token}` }, query: {}, body };
  }

  async function requestChange(f: Fixture, value: string): Promise<string> {
    const response = await handleCreatePolicyRequest(
      api,
      bearer(f.token, { action: 'add_rule', direction: 'outbound', list: 'allow', value, reason: `Need to email the partner about the contract renewal and the attached invoice. ${'x'.repeat(80)}` }),
      { agentId: 'me' },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return String((response.body as Record<string, unknown>)['request_id']);
  }

  async function run(argv: string[]): Promise<{ code: number; io: Io }> {
    const out = io();
    const code = await policyRequest(argv, { env: env(), io: out });
    return { code, io: out };
  }

  async function policyVersion(agentId: string): Promise<number> {
    const row = await owner.query<{ v: number }>('SELECT current_version AS v FROM agent_policies WHERE agent_id = $1', [agentId]);
    return row.rows[0]?.v ?? -1;
  }

  async function ownerActions(orgId: string, prefix: string): Promise<number> {
    const row = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action LIKE $2', [orgId, `${prefix}%`]);
    return row.rows[0]?.n ?? 0;
  }

  interface OperatorAudit {
    readonly id: string;
    readonly action: string;
    readonly target_id: string | null;
    readonly session_id: string | null;
    readonly org_api_key_id: string | null;
    readonly operator_actor: string | null;
    readonly operator_reason: string | null;
  }

  async function policyAudits(orgId: string): Promise<OperatorAudit[]> {
    const rows = await owner.query<OperatorAudit>(
      `SELECT id::text AS id, action, target_id, session_id::text AS session_id, org_api_key_id::text AS org_api_key_id, operator_actor, operator_reason
         FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.policy_request.%' ORDER BY created_at, id`,
      [orgId],
    );
    return rows.rows;
  }

  async function requestRow(id: string) {
    const row = await owner.query<{ status: string; decided_by: string | null; decided_user_id: string | null; applied_version: number | null; stale_reason: string | null }>(
      'SELECT status, decided_by, decided_user_id::text AS decided_user_id, applied_version, stale_reason FROM policy_change_requests WHERE id = $1::uuid',
      [id],
    );
    return row.rows[0];
  }

  async function taint(f: Fixture): Promise<void> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const message = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, $2, $3, $4, 'no_header_ids', 'mallory@evil.example', 'evil.example', false, 'invoice', false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(), 'test-v0', 'none', false, 'unknown')
       RETURNING id::text AS id`,
      [f.agentId, f.address, ses, thread.rows[0]?.id],
    );
    await owner.query(
      `INSERT INTO agent_exposures (agent_id, inbound_message_id, part, surface, level, thread_id, sender)
       VALUES ($1, $2::uuid, 'body', 'message_detail', 2, $3::uuid, 'mallory@evil.example')`,
      [f.agentId, message.rows[0]?.id, thread.rows[0]?.id],
    );
  }

  // -------------------------------------------------------------------------
  // admin:policy-request
  // -------------------------------------------------------------------------

  it('--list: 대기 + 최근 · id/상태/변경/위험/이유(표시 규칙 · 잘림)', async () => {
    const f = await fixture();
    const id = await requestChange(f, 'partner@example.com');
    const listed = await run(['--agent', f.agentId, '--list']);
    expect(listed.code).toBe(0);
    expect(listed.io.outLines).toHaveLength(1);
    const cols = listed.io.outLines[0]?.split('\t') ?? [];
    expect(cols.slice(0, 4)).toEqual([id, 'pending', 'outbound allow + partner@example.com', '-']);
    expect(cols[5]).toMatch(/^Need to email the partner.*…$/);
    expect((cols[5] ?? '').length).toBeLessThanOrEqual(60);
    expect(listed.io.errLines.join('\n')).toContain('대기 1건');
  });

  it('--approve: 콘솔과 같은 연산 — 새 버전 · created_by 에 운영자 + 요청 id · decided_by 운영자 · decided_user_id NULL · 지속 감사 1행(운영자 행위자)', async () => {
    const f = await fixture();
    const id = await requestChange(f, 'Partner@Example.com');
    const before = await policyVersion(f.agentId);
    const approved = await run(['--agent', f.agentId, '--approve', id]);
    expect(approved.code, approved.io.all()).toBe(0);
    expect(approved.io.outLines[0]).toBe(`approved\t${id}\tv${String(before + 1)}`);
    expect(await policyVersion(f.agentId)).toBe(before + 1);
    const version = await owner.query<{ created_by: string }>('SELECT created_by FROM policy_versions WHERE agent_id = $1 AND version = $2', [f.agentId, before + 1]);
    expect(version.rows[0]?.created_by).toBe(`${ACTOR} policy_request:${id}`);
    const rule = await owner.query<{ value: string }>(`SELECT value FROM agent_contact_rules WHERE agent_id = $1 AND direction = 'outbound' AND list = 'allow'`, [f.agentId]);
    expect(rule.rows.map((r) => r.value)).toEqual(['partner@example.com']);
    expect(await requestRow(id)).toEqual({ status: 'approved', decided_by: ACTOR, decided_user_id: null, applied_version: before + 1, stale_reason: null });
    // 지속 감사 — 콘솔과 같은 행위 코드 · 세션 · 키 칸 없이 운영자 행위자(세션을 흉내 내지 않는다) · 사유 = 요청 id.
    const audits = await policyAudits(f.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'agent.policy_request.approve',
      target_id: f.agentId,
      session_id: null,
      org_api_key_id: null,
      operator_actor: ACTOR,
      operator_reason: `policy_request:${id}`,
    });
    // 투명성 로그 — 기존 트리거가 그 행의 사건을 outbox 에 적었다(잎 `owner.action` · `c.operator` 는 서열기가 만든다).
    const outbox = await owner.query("SELECT 1 FROM tlog_outbox WHERE source_table = 'owner_actions' AND source_id = $1", [audits[0]?.id]);
    expect(outbox.rowCount).toBe(1);
    expect(approved.io.errLines.join('\n')).toContain('agent.policy_request.approve');
    // 두 번 결정은 공유 연산이 거부한다 — 감사 행도 더 생기지 않는다(한 트랜잭션).
    await expect(run(['--agent', f.agentId, '--reject', id])).rejects.toMatchObject({ code: 'policy_request_decided' });
    expect(await ownerActions(f.orgId, 'agent.policy_request')).toBe(1);
  });

  it('--reject: 정책 그대로 · decided_by 운영자(--by) · 감사 reject 1행(사유에 --reason)', async () => {
    const f = await fixture();
    const id = await requestChange(f, 'nobody@example.com');
    const before = await policyVersion(f.agentId);
    const rejected = await run(['--agent', f.agentId, '--reject', id, '--by', 'jin', '--reason', 'unknown recipient']);
    expect(rejected.code).toBe(0);
    expect(rejected.io.outLines[0]).toBe(`rejected\t${id}`);
    expect(await policyVersion(f.agentId)).toBe(before);
    expect(await requestRow(id)).toMatchObject({ status: 'rejected', decided_by: 'admin:policy-request:jin', decided_user_id: null });
    expect((await policyAudits(f.orgId)).map((row) => [row.action, row.target_id, row.operator_actor, row.operator_reason, row.session_id])).toEqual([
      ['agent.policy_request.reject', f.agentId, 'admin:policy-request:jin', `policy_request:${id} · unknown recipient`, null],
    ]);
  });

  it('stale — 요청 뒤 이미 그 상태가 됐으면 exit 1 · 요청은 stale(already_applied) · 정책은 그대로', async () => {
    const f = await fixture();
    const id = await requestChange(f, 'same@example.com');
    const added = await call(deps(), 'POST', `/api/agents/${f.agentId}/rules`, authed(f.session, { body: { direction: 'outbound', list: 'allow', value: 'same@example.com' } }));
    expect(added.statusCode, added.body).toBe(201);
    const before = await policyVersion(f.agentId);
    const stale = await run(['--agent', f.agentId, '--approve', id]);
    expect(stale.code).toBe(1);
    expect(stale.io.outLines[0]).toBe(`stale\t${id}\talready_applied`);
    expect(await policyVersion(f.agentId)).toBe(before);
    expect(await requestRow(id)).toMatchObject({ status: 'stale', stale_reason: 'already_applied', decided_by: ACTOR });
    expect((await policyAudits(f.orgId)).map((row) => [row.action, row.operator_actor, row.operator_reason])).toEqual([
      ['agent.policy_request.stale', ACTOR, `policy_request:${id}`],
    ]);
  });

  it('서열기 능력(owner_action_operator_actor)이 없으면 감사 INSERT 55000 — 결정도 함께 되돌아간다(요청 pending · 정책 그대로 · 감사 0, 되돌림 트랜잭션)', async () => {
    const f = await fixture();
    const id = await requestChange(f, 'cap@example.com');
    const before = await policyVersion(f.agentId);
    for (const flag of ['--approve', '--reject']) {
      const command = parsePolicyRequestArgs(['--agent', f.agentId, flag, id]);
      if (command === null) throw new Error('명령이 없다');
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tlog_capabilities');
        await expect(runPolicyRequest(transactionPool(client), classifyTarget(OWNER_URL, {}), command, { env: env(), io: io() })).rejects.toMatchObject({ code: '55000' });
        const inside = await client.query<{ status: string; decided_by: string | null }>('SELECT status, decided_by FROM policy_change_requests WHERE id = $1::uuid', [id]);
        expect(inside.rows[0]).toEqual({ status: 'pending', decided_by: null });
        const version = await client.query<{ v: number }>('SELECT current_version AS v FROM agent_policies WHERE agent_id = $1', [f.agentId]);
        expect(version.rows[0]?.v).toBe(before);
        const audits = await client.query("SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.policy_request.%'", [f.orgId]);
        expect(audits.rowCount).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    // 되돌림 뒤 — 능력은 그대로라 같은 결정이 이제 감사와 함께 된다.
    expect(await requestRow(id)).toMatchObject({ status: 'pending' });
    const approved = await run(['--agent', f.agentId, '--approve', id]);
    expect(approved.code, approved.io.all()).toBe(0);
    expect((await policyAudits(f.orgId)).map((row) => row.action)).toEqual(['agent.policy_request.approve']);
  });

  it('위험 경고 — 오염된 요청은 --ack-risk 없이 risk_ack_required(쓰기 0) · 있으면 승인', async () => {
    const f = await fixture();
    await taint(f);
    const id = await requestChange(f, 'mallory@evil.example');
    const listed = await run(['--agent', f.agentId, '--list']);
    expect(listed.io.outLines[0]?.split('\t')[3]).toBe('tainted(요청 때)');
    const before = await policyVersion(f.agentId);
    await expect(run(['--agent', f.agentId, '--approve', id])).rejects.toMatchObject({ code: 'risk_ack_required' });
    expect(await policyVersion(f.agentId)).toBe(before);
    expect(await requestRow(id)).toMatchObject({ status: 'pending' });
    const acked = await run(['--agent', f.agentId, '--approve', id, '--ack-risk']);
    expect(acked.code, acked.io.all()).toBe(0);
    expect(await requestRow(id)).toMatchObject({ status: 'approved', decided_by: ACTOR });
  });

  it('L4 — 다른 에이전트의 실제 pending 요청 id 로는 결정하지 못한다(policy_request_not_found) · 그 에이전트의 정책 · 요청 그대로', async () => {
    const a = await fixture();
    const b = await fixture();
    const bRequest = await requestChange(b, 'cross@example.com');
    const bVersion = await policyVersion(b.agentId);
    await expect(run(['--agent', a.agentId, '--approve', bRequest])).rejects.toMatchObject({ code: 'policy_request_not_found' });
    await expect(run(['--agent', a.agentId, '--reject', bRequest])).rejects.toMatchObject({ code: 'policy_request_not_found' });
    expect(await policyVersion(b.agentId)).toBe(bVersion);
    expect(await requestRow(bRequest)).toMatchObject({ status: 'pending', decided_by: null });
    const listed = await run(['--agent', a.agentId, '--list']);
    expect(listed.io.outLines).toEqual([]);
  });

  it('입력 — 동작 하나만 · --ack-risk 는 --approve 와만 · 없는 요청 id 는 not found', async () => {
    const f = await fixture();
    await expect(run(['--agent', f.agentId])).rejects.toThrow(/정확히 하나/);
    await expect(run(['--agent', f.agentId, '--reject', randomUUID(), '--ack-risk'])).rejects.toThrow(/--ack-risk/);
    await expect(run(['--agent', f.agentId, '--approve', randomUUID()])).rejects.toMatchObject({ code: 'policy_request_not_found' });
    await expect(run(['--agent', f.agentId, '--list', '--reason', 'x'])).rejects.toThrow(/--reason/);
    await expect(run(['--agent', f.agentId, '--reject', randomUUID(), '--reason', 'a\nb'])).rejects.toThrow(/한 줄/);
    await expect(run(['--agent', f.agentId, '--reject', randomUUID(), '--reason', 'x'.repeat(501)])).rejects.toThrow(/500/);
  });

  // -------------------------------------------------------------------------
  // admin:agent-delete
  // -------------------------------------------------------------------------

  async function del(argv: string[]): Promise<{ code: number; io: Io }> {
    const out = io();
    const code = await agentDelete(argv, { env: env(), io: out });
    return { code, io: out };
  }

  it('삭제 — deleteAgentOp 와 같은 결과(disabled · 주소 · 토큰 폐기 · 대기 요청 닫힘) · 지속 감사 1행(운영자 행위자 · 사유) · 재생은 replayed', async () => {
    const f = await fixture();
    const pending = await requestChange(f, 'later@example.com');
    const deleted = await del(['--agent', f.agentId, '--reason', 'abuse report #12', '--by', 'jin']);
    expect(deleted.code, deleted.io.all()).toBe(0);
    expect(deleted.io.outLines).toEqual([
      `agent\t${f.agentId}`,
      'replayed\tfalse',
      `addresses\t${f.address}`,
      'revoked_tokens\t1',
      'cancelled_scheduled\t0',
      'disabled_webhooks\t0',
      'audited\ttrue',
    ]);
    expect(deleted.io.errLines.join('\n')).toContain('admin:agent-delete:jin');
    const state = await owner.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1', [f.agentId]);
    expect(state.rows[0]?.status).toBe('disabled');
    const live = await owner.query('SELECT 1 FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL', [f.agentId]);
    expect(live.rowCount).toBe(0);
    const tokens = await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [f.agentId]);
    expect(tokens.rowCount).toBe(0);
    expect(await requestRow(pending)).toMatchObject({ status: 'stale', stale_reason: 'agent_deleted' });
    // 지속 감사(202610131610) — 세션 · 키 칸 없이 운영자 행위자 · 사유. 투명성 로그 outbox 에 그 행의 사건이 적혔다(잎은 서열기가 만든다).
    const audit = await owner.query<{ id: string; session_id: string | null; org_api_key_id: string | null; operator_actor: string; operator_reason: string; target_id: string }>(
      `SELECT id::text AS id, session_id, org_api_key_id, operator_actor, operator_reason, target_id FROM owner_actions WHERE organization_id = $1 AND action = 'agent.delete'`,
      [f.orgId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ session_id: null, org_api_key_id: null, operator_actor: 'admin:agent-delete:jin', operator_reason: 'abuse report #12', target_id: f.agentId });
    const outbox = await owner.query("SELECT 1 FROM tlog_outbox WHERE source_table = 'owner_actions' AND source_id = $1", [audit.rows[0]?.id]);
    expect(outbox.rowCount).toBe(1);

    const replay = await del(['--agent', f.agentId, '--reason', 'retry']);
    expect(replay.code).toBe(0);
    expect(replay.io.outLines.slice(1, 4)).toEqual(['replayed\ttrue', `addresses\t${f.address}`, 'revoked_tokens\t0']);
    expect(replay.io.outLines.at(-1)).toBe('audited\tfalse');
    expect(replay.io.errLines.join('\n')).toContain('바뀐 것 없음');
    expect(await ownerActions(f.orgId, 'agent.delete')).toBe(1);
  });

  it('운영자 예약 주소를 쥔 에이전트는 operator_reserved — 쓰기 0(되돌림 픽스처)', async () => {
    const f = await fixture();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('onve@atmark.ai', $1, 'test', 'cli test')`, [f.orgId]);
      await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, 'onve@atmark.ai', 'atmark.ai', false)`, [f.agentId]);
      const command = parseAgentDeleteArgs(['--agent', f.agentId, '--reason', 'x']);
      if (command === null) throw new Error('명령이 없다');
      await expect(runAgentDelete(transactionPool(client), classifyTarget(OWNER_URL, {}), command, { env: env(), io: io() })).rejects.toMatchObject({
        code: 'operator_reserved',
        status: 409,
      });
      const state = await client.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1', [f.agentId]);
      expect(state.rows[0]?.status).toBe('active');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  async function agentState(agentId: string, db: Pool = owner): Promise<{ status: string; suspended_by: string | null } | undefined> {
    const row = await db.query<{ status: string; suspended_by: string | null }>(
      'SELECT status::text AS status, suspended_by::text AS suspended_by FROM agents WHERE id = $1',
      [agentId],
    );
    return row.rows[0];
  }

  async function schedule(f: Fixture): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO scheduled_sends
         (id, agent_id, idempotency_key, request_hash, from_address, recipients, send_at, content_storage_key, cost_cents, agent_cancellable)
       VALUES ($1::uuid, $2, $3, repeat('a', 64), $4, ARRAY['to@example.com'], now() + interval '1 hour', 'outbound/scheduled/' || $1::text || '.json', 0, true)`,
      [id, f.agentId, `idem-${id}`, f.address],
    );
    return id;
  }

  it('운영자 정지한 에이전트는 기본 operator_suspension(콘솔과 같은 공유 의미) · 운영자 정지가 아니면 --from-operator-suspension 거부', async () => {
    const f = await fixture();
    await expect(del(['--agent', f.agentId, '--reason', 'x', '--from-operator-suspension'])).rejects.toMatchObject({ code: 'not_operator_suspended' });
    expect(await agentState(f.agentId)).toEqual({ status: 'active', suspended_by: null });
    expect(await killSwitch(['--agent', f.agentId, 'on'], { env: env(), io: io() })).toBe(0);
    await expect(del(['--agent', f.agentId, '--reason', 'x'])).rejects.toMatchObject({ code: 'operator_suspension' });
    expect(await agentState(f.agentId)).toEqual({ status: 'suspended', suspended_by: 'operator' });
  });

  it('M1 — --from-operator-suspension: 해제와 삭제가 한 트랜잭션 · 커밋 전 다른 연결은 suspended 만 본다 · 커밋 뒤 disabled · 예약 취소 · 승인 불가', async () => {
    const f = await fixture();
    const scheduled = await schedule(f);
    const approval = await owner.query<{ id: string }>(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES (gen_random_uuid(), $1, 'message', now(), now() + interval '1 day') RETURNING id::text AS id`,
      [f.agentId],
    );
    const approvalId = approval.rows[0]?.id ?? '';
    expect(await killSwitch(['--agent', f.agentId, 'on'], { env: env(), io: io() })).toBe(0);

    const command = parseAgentDeleteArgs(['--agent', f.agentId, '--reason', 'abuse', '--from-operator-suspension']);
    if (command === null) throw new Error('명령이 없다');
    const out = io();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      expect(await runAgentDelete(transactionPool(client), classifyTarget(OWNER_URL, {}), command, { env: env(), io: out })).toBe(0);
      // 커밋 전 — 다른 연결(예약 워커 · 승인 릴리스와 같은 자리)은 커밋된 운영자 정지만 본다. 'active' 는 어디에도 보이지 않는다.
      expect(await agentState(f.agentId, app)).toEqual({ status: 'suspended', suspended_by: 'operator' });
      expect(await agentState(f.agentId)).toEqual({ status: 'suspended', suspended_by: 'operator' });
      // 행 잠금을 쥐고 있다 — 토큰 발급 · 별칭 추가가 잡는 FOR SHARE 는 기다려야 한다(NOWAIT 로 확인).
      const probe = await owner.connect();
      try {
        await probe.query('BEGIN');
        await expect(probe.query('SELECT 1 FROM agents WHERE id = $1 FOR SHARE NOWAIT', [f.agentId])).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined);
        probe.release();
      }
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await agentState(f.agentId)).toEqual({ status: 'disabled', suspended_by: null });
    const reason = await owner.query<{ operator_reason: string }>(`SELECT operator_reason FROM owner_actions WHERE organization_id = $1 AND action = 'agent.delete'`, [f.orgId]);
    expect(reason.rows.map((row) => row.operator_reason)).toEqual(['abuse · from_operator_suspension']);
    expect(out.outLines).toContain('audited\ttrue');
    expect((await owner.query<{ status: string }>('SELECT status::text AS status FROM scheduled_sends WHERE id = $1', [scheduled])).rows[0]?.status).toBe('cancelled');
    await expect(
      approveRequest(createPostgresApprovalStore(app), { approvalId, decidedBy: 'owner:test', now: new Date(), scope: 'recipient', confirmScope: null }),
    ).rejects.toBeInstanceOf(ApprovalBlockedByAgentDeletedError);
    const tokens = await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [f.agentId]);
    expect(tokens.rowCount).toBe(0);
  });

  it('입력 — --reason 없으면 · 없는 에이전트면 거부', async () => {
    const f = await fixture();
    await expect(del(['--agent', f.agentId])).rejects.toThrow(/--reason/);
    await expect(del(['--agent', 'f'.repeat(32), '--reason', 'x'])).rejects.toMatchObject({ code: 'agent_not_found' });
  });
});
