/**
 * **에이전트 삭제**(2026-10-13 진윤겸 결정 — "별칭 삭제하는 로직이랑 동일하게. 어차피 기록은 계속 남고." · 마이그레이션 202610131000).
 * 라우터는 `atmark_admin` 롤 풀로 돈다(운영 admin Lambda 와 같은 롤). 행 심기·확인은 소유자 롤. 실메일 0 · AWS 호출 0.
 *
 *   ① 삭제 → disabled · 주소 전부(대표 포함) 폐기 · 토큰 폐기(인증 거부) · 예약 취소(console · owner_request) · 웹훅 끔 · 감사 `agent.delete` 1행 ·
 *      수신 라우팅 · 공개 조회에서 빠짐 · 목록에서 빠짐(한 개 읽기는 disabled) · 잎 `identity.address_retired`(대표 포함) · 받은 기록은 남는다.
 *   ② 재생 — 200 `replayed` · 감사 없음.
 *   ③ 요금제 자리 — Free 3개가 꽉 찬 조직이 하나를 지우면 다시 만든다. 총합(×3)은 삭제한 것을 센다.
 *   ④ 재발급 — 같은 조직은 곧바로 같은 주소로 다시 만든다 · 다른 조직은 30일 보류(409 conflict) · 보류가 지나면 된다.
 *   ⑤ 삭제한 에이전트에 쓰기는 409 `agent_deleted`(별칭 · 토큰 발급 · 토큰 전부 교체 · 신원 게시) · 긴급 정지 409 · member 403 · 다른 조직 404 ·
 *      운영자 정지 409 `operator_suspension`.
 *   ⑥ DB 가드 — disabled 는 종단(소유자·admin 롤) · 삭제한 에이전트에 주소 INSERT 거부 · 승인 불가(코드 `ApprovalBlockedByAgentDeletedError` ·
 *      트리거 55000) · 일괄 예약 취소 함수는 disabled 아닌 에이전트에 0 · 공개 신원 폐기 요청(게시된 여권만).
 *   보안 리뷰(2026-10-13) — HIGH-1 토큰 발급이 삭제와 경합해도 409(행 잠금 아래 재확인) · 삭제한 에이전트의 살아 있는 토큰도 인증 거부 · 토큰 INSERT
 *      트리거 / MED-2 웹훅 INSERT 트리거 · 등록 연산 `agent_deleted` / MED-3 raw `status = 'disabled'` 뒤의 재생이 남은 것을 정리(감사 1행) /
 *      MED-4 운영자 예약 주소를 쥔 에이전트는 409 `operator_reserved` · DB 42501.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { deleteAgentOp } from '../../../src/admin/ops/agents';
import { transactionPool } from '../../../src/admin/ops/transaction';
import { approveRequest } from '../../../src/approval/service';
import { createPool } from '../../../src/db/client';
import { ApprovalBlockedByAgentDeletedError, createPostgresApprovalStore } from '../../../src/db/repositories/approval-store';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { authenticateAgentToken } from '../../../src/identity/agent-token';
import type { AgentId } from '../../../src/db/schema';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { registerWebhookEndpoint } from '../../../src/webhooks/management';
import { drainOutboxFully } from '../../support/tlog-drain';
import { adminDeps, adminRolePool, APP_URL, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

interface Fixture {
  readonly orgId: string;
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
  readonly token: string;
}

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe.skipIf(!AVAILABLE)('에이전트 삭제 — atmark_admin 롤', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    tlog = createPool(roleUrl('atmark_tlog'), { max: 2 });
    deps = adminDeps(admin, { features: { addressAliases: true } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end(), tlog.end()]);
  });

  async function create(session: Session, localPart = `del-${suffix()}`): Promise<{ status: number; agentId: string; address: string; token: string; error?: string }> {
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'to-delete', localPart } }));
    const json = created.json() as { agent?: { id: string; address: string }; token?: string; error?: string };
    return { status: created.statusCode, agentId: json.agent?.id ?? '', address: json.agent?.address ?? '', token: json.token ?? '', ...(json.error === undefined ? {} : { error: json.error }) };
  }

  async function fixture(plan: 'free' | 'beta' = 'beta'): Promise<Fixture> {
    const org = await newOrganization(owner, plan === 'free' ? null : plan);
    const session = await login(deps, mailer, org);
    const made = await create(session);
    expect(made.status).toBe(201);
    return { orgId: org.id, session, agentId: made.agentId, address: made.address, token: made.token };
  }

  const del = (session: Session, agentId: string, body: unknown = {}) => call(deps, 'POST', `/api/agents/${agentId}/delete`, authed(session, { body }));

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

  async function webhook(f: Fixture): Promise<string> {
    const result = await owner.query<{ id: string }>(
      `INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'k1') RETURNING id::text AS id`,
      [f.agentId, `https://hook-${randomUUID()}.example.com/`],
    );
    return result.rows[0]?.id ?? '';
  }

  async function roleSession(organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `del-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  const sqlState = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await run();
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  it('풀은 atmark_admin 이다 — 권한 단언이 공허하지 않다', async () => {
    expect((await admin.query<{ user: string }>('SELECT current_user AS user')).rows[0]?.user).toBe('atmark_admin');
  });

  it('① 삭제 — disabled · 주소 전부(대표 포함) 폐기 · 토큰 폐기 · 예약 취소 · 웹훅 끔 · 감사 1행 · 수신·공개 조회·목록에서 빠짐 · 잎 · 기록은 남는다', async () => {
    const f = await fixture('beta');
    const alias = await call(deps, 'POST', `/api/agents/${f.agentId}/aliases`, authed(f.session, { body: { localPart: `al-${suffix()}` } }));
    expect(alias.statusCode, alias.body).toBe(201);
    const aliasAddress = (alias.json() as { item: { address: string } }).item.address;
    const scheduled = await schedule(f);
    const hook = await webhook(f);
    const inbound = createPostgresInboundStore(app);
    expect((await inbound.findAgentsByAddresses([f.address, aliasAddress])).map((m) => m.agentId)).toEqual([f.agentId, f.agentId]);
    const auditBefore = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs WHERE agent_id = $1', [f.agentId]);

    const done = await del(f.session, f.agentId);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({
      agentId: f.agentId,
      replayed: false,
      addresses: [f.address, aliasAddress].sort(),
      revokedTokens: 1,
      cancelledScheduled: 1,
      disabledWebhooks: 1,
    });

    const agent = await owner.query<{ status: string; suspended_by: string | null }>('SELECT status::text AS status, suspended_by FROM agents WHERE id = $1', [f.agentId]);
    expect(agent.rows[0]).toEqual({ status: 'disabled', suspended_by: null });
    // 대표(앵커)까지 폐기 · 행은 남는다.
    const addresses = await owner.query<{ address: string; is_primary: boolean; retired: boolean }>(
      'SELECT address, is_primary, retired_at IS NOT NULL AS retired FROM agent_addresses WHERE agent_id = $1 ORDER BY is_primary DESC, address',
      [f.agentId],
    );
    expect(addresses.rows).toEqual([
      { address: f.address, is_primary: true, retired: true },
      { address: aliasAddress, is_primary: false, retired: true },
    ]);
    expect(await inbound.findAgentsByAddresses([f.address, aliasAddress])).toEqual([]);
    expect(await createPostgresIdentityDirectory(app).findByAddress(f.address)).toBeNull();
    // 토큰 — 인증 거부(API · MCP · 실시간이 같은 인증을 쓴다).
    const auth = await authenticateAgentToken(createPostgresAgentTokenStore(app), f.token, new Date());
    expect(auth.kind).toBe('rejected');
    expect(await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [f.agentId])).toMatchObject({ rowCount: 0 });
    // 예약 · 웹훅.
    const sched = await owner.query('SELECT status::text AS status, cancelled_via, cancel_reason_code FROM scheduled_sends WHERE id = $1', [scheduled]);
    expect(sched.rows[0]).toEqual({ status: 'cancelled', cancelled_via: 'console', cancel_reason_code: 'owner_request' });
    const hooks = await owner.query<{ off: boolean }>('SELECT disabled_at IS NOT NULL AS off FROM webhook_endpoints WHERE id = $1', [hook]);
    expect(hooks.rows[0]?.off).toBe(true);
    // 감사 — 행위 하나(대상 = 에이전트 id). 발송 감사 기록은 그대로.
    const audit = await owner.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action = 'agent.delete'",
      [f.orgId],
    );
    expect(audit.rows).toEqual([{ action: 'agent.delete', target_id: f.agentId }]);
    expect((await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs WHERE agent_id = $1', [f.agentId])).rows[0]?.n).toBe(auditBefore.rows[0]?.n);
    // 목록에서 빠지고(옛 배열 · 쪽 봉투 둘 다) 한 개 읽기는 disabled.
    const legacy = (await call(deps, 'GET', '/api/agents', authed(f.session))).json() as { id: string }[];
    expect(legacy.map((a) => a.id)).not.toContain(f.agentId);
    const paged = (await call(deps, 'GET', '/api/agents', authed(f.session, { query: 'limit=50' }))).json() as { items: { id: string }[] };
    expect(paged.items.map((a) => a.id)).not.toContain(f.agentId);
    const one = await call(deps, 'GET', `/api/agents/${f.agentId}`, authed(f.session));
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: f.agentId, status: 'disabled', activeTokens: 0, address: null });
    // 잎 — 상태 변경(agents update) · 주소마다 폐기(대표 포함). 주소 원문은 잎에 없다.
    await drainOutboxFully(tlog);
    const leaves = await owner.query<{ kind: string; leaf_json: string }>(
      `SELECT l.kind, l.leaf_json FROM tlog_leaves l JOIN agent_addresses d ON d.id::text = l.source_id
        WHERE l.source_table = 'agent_addresses' AND d.agent_id = $1 AND l.kind = 'identity.address_retired'`,
      [f.agentId],
    );
    expect(leaves.rows).toHaveLength(2);
    for (const row of leaves.rows) expect(row.leaf_json).not.toContain('@');
    const status = await owner.query<{ leaf_json: string }>(
      `SELECT leaf_json FROM tlog_leaves WHERE source_table = 'agents' AND source_id = $1 AND event = 'update' ORDER BY seq DESC LIMIT 1`,
      [f.agentId],
    );
    expect(status.rows[0]?.leaf_json).toContain('disabled');
  });

  it('② 재생 — 200 replayed · 감사 없음 · 본문의 모르는 키는 400', async () => {
    const f = await fixture('beta');
    expect((await del(f.session, f.agentId, { confirm: true })).json()).toMatchObject({ error: 'invalid_body' });
    expect((await del(f.session, f.agentId)).statusCode).toBe(200);
    const again = await del(f.session, f.agentId);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ agentId: f.agentId, replayed: true, addresses: [f.address], revokedTokens: 0, cancelledScheduled: 0, disabledWebhooks: 0 });
    const audit = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'agent.delete'", [f.orgId]);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('③ 요금제 자리 — Free 3개가 꽉 차면 409 agent_limit · 하나를 지우면 다시 만든다 · 총합(×3)은 삭제한 것을 센다', async () => {
    const f = await fixture('free');
    const ids = [f.agentId];
    for (let i = 0; i < 2; i += 1) ids.push((await create(f.session)).agentId);
    const full = await create(f.session);
    expect([full.status, full.error]).toEqual([409, 'agent_limit']);
    expect((await del(f.session, ids[0] ?? '')).statusCode).toBe(200);
    const again = await create(f.session);
    expect(again.status).toBe(201);
    // 총합 천장 9(= 3 × 3) — 지우고 만들기를 되풀이해도 9 를 넘지 못한다(주소를 끝없이 가져가지 못한다).
    let last = again.agentId;
    for (let i = 0; i < 5; i += 1) {
      expect((await del(f.session, last)).statusCode).toBe(200);
      const next = await create(f.session);
      expect(next.status, `회차 ${String(i)}`).toBe(201);
      last = next.agentId;
    }
    expect((await del(f.session, last)).statusCode).toBe(200);
    const ceiling = await create(f.session);
    expect([ceiling.status, ceiling.error]).toEqual([409, 'agent_total_limit']);
  });

  /** 보류가 지난 것처럼 — 소유자 롤이 트리거를 끈 세션에서 `retired_at` 을 `days` 일 앞당긴다. */
  async function backdateRetired(agentId: string, days: number): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE agent_addresses SET retired_at = retired_at - make_interval(days => $2::int) WHERE agent_id = $1 AND retired_at IS NOT NULL', [agentId, days]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it('④ 재발급 — 같은 조직은 곧바로 같은 주소 · 다른 조직은 30일 보류 409 conflict · 보류가 지나면 된다', async () => {
    const f = await fixture('beta');
    const localPart = f.address.split('@')[0] ?? '';
    expect((await del(f.session, f.agentId)).statusCode).toBe(200);
    const stranger = await fixture('beta');
    const held = await create(stranger.session, localPart);
    expect([held.status, held.error]).toEqual([409, 'conflict']);
    const mine = await create(f.session, localPart);
    expect(mine.status).toBe(201);
    expect(mine.address).toBe(f.address);
    expect((await createPostgresInboundStore(app).findAgentsByAddresses([f.address])).map((m) => m.agentId)).toEqual([mine.agentId]);

    // 다시 지우고 30일이 지나면 다른 조직이 가져간다.
    expect((await del(f.session, mine.agentId)).statusCode).toBe(200);
    await backdateRetired(f.agentId, 31);
    await backdateRetired(mine.agentId, 31);
    const taken = await create(stranger.session, localPart);
    expect(taken.status).toBe(201);
    expect(taken.address).toBe(f.address);
  });

  it('⑤ 삭제한 에이전트에 쓰기는 409 agent_deleted · 긴급 정지 409 · member 403 · 다른 조직 404 · 운영자 정지 409', async () => {
    const f = await fixture('beta');
    const member = await roleSession(f.orgId, 'member');
    expect((await del(member, f.agentId)).json()).toMatchObject({ error: 'forbidden_role' });
    const stranger = await fixture('beta');
    expect((await del(stranger.session, f.agentId)).statusCode).toBe(404);
    const admin2 = await roleSession(f.orgId, 'admin');
    expect((await del(admin2, f.agentId)).statusCode).toBe(200);

    const alias = await call(deps, 'POST', `/api/agents/${f.agentId}/aliases`, authed(f.session, { body: { localPart: `late-${suffix()}` } }));
    expect([alias.statusCode, (alias.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    const anchor = await call(deps, 'POST', `/api/agents/${f.agentId}/primary`, authed(f.session, { body: { anchor: true } }));
    expect([anchor.statusCode, (anchor.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    const issue = await call(deps, 'POST', `/api/agents/${f.agentId}/tokens`, authed(f.session, { body: { label: 'late' } }));
    expect([issue.statusCode, (issue.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    const rotate = await call(deps, 'POST', `/api/agents/${f.agentId}/token`, authed(f.session, { body: { action: 'rotate' } }));
    expect([rotate.statusCode, (rotate.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    const publish = await call(deps, 'POST', `/api/agents/${f.agentId}/identity/publish`, authed(f.session, { body: {} }));
    expect([publish.statusCode, (publish.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    const kill = await call(deps, 'POST', '/api/kill-switch', authed(f.session, { body: { scope: 'agent', id: f.agentId, on: true } }));
    expect(kill.statusCode).toBe(409);
    expect(await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [f.agentId])).toMatchObject({ rowCount: 0 });

    const held = await fixture('beta');
    await owner.query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [held.agentId]);
    const refused = await del(held.session, held.agentId);
    expect([refused.statusCode, (refused.json() as { error: string }).error]).toEqual([409, 'operator_suspension']);
    expect((await owner.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1', [held.agentId])).rows[0]?.status).toBe('suspended');
  });

  it('⑥ DB 가드 — disabled 종단 · 주소 INSERT 거부 · 승인 불가(코드 · 트리거) · 일괄 예약 취소는 disabled 만 · 공개 신원 폐기 요청', async () => {
    const live = await fixture('beta');
    // 살아 있는 에이전트에는 일괄 취소 함수가 아무것도 하지 않는다.
    const kept = await schedule(live);
    expect((await admin.query<{ n: number }>('SELECT console_cancel_agent_scheduled_sends($1, $2) AS n', [live.orgId, live.agentId])).rows[0]?.n).toBe(0);
    expect((await owner.query<{ status: string }>('SELECT status::text AS status FROM scheduled_sends WHERE id = $1', [kept])).rows[0]?.status).toBe('scheduled');

    const f = await fixture('beta');
    const approval = await owner.query<{ id: string }>(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES (gen_random_uuid(), $1, 'message', now(), now() + interval '1 day') RETURNING id::text AS id`,
      [f.agentId],
    );
    const approvalId = approval.rows[0]?.id ?? '';
    // 여권을 게시된 것처럼(서명 워커 없이) — 삭제 트리거가 폐기 요청을 넣는지 본다.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `UPDATE passports SET status = 'published', metadata_uri = 'https://id.atmark.ai/x', content_hash = repeat('a', 64) WHERE agent_id = $1 AND superseded_at IS NULL`,
        [f.agentId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await del(f.session, f.agentId)).statusCode).toBe(200);
    const revoke = await owner.query<{ kind: string; requested_by: string; status: string }>(
      `SELECT kind::text AS kind, requested_by, status::text AS status FROM passport_publish_requests WHERE agent_id = $1 AND kind = 'revoke'`,
      [f.agentId],
    );
    expect(revoke.rows).toEqual([{ kind: 'revoke', requested_by: 'system:agent_deleted', status: 'pending' }]);

    expect(await sqlState(() => owner.query(`UPDATE agents SET status = 'active' WHERE id = $1`, [f.agentId]))).toBe('23514');
    expect(await sqlState(() => admin.query(`UPDATE agents SET status = 'active' WHERE id = $1`, [f.agentId]))).toBe('23514');
    expect(await sqlState(() => owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.agentId, `back-${suffix()}@atmark.ai`]))).toBe('23514');
    // 폐기는 되돌리지 않는다(쓰기 1회 그대로).
    expect(await sqlState(() => owner.query('UPDATE agent_addresses SET retired_at = NULL WHERE agent_id = $1', [f.agentId]))).toBe('23514');

    await expect(
      approveRequest(createPostgresApprovalStore(app), { approvalId, decidedBy: 'owner:test', now: new Date(), scope: 'recipient', confirmScope: null }),
    ).rejects.toBeInstanceOf(ApprovalBlockedByAgentDeletedError);
    expect(
      await sqlState(() =>
        owner.query(`UPDATE approval_requests SET status = 'approved', decided_at = now(), decided_by = 'owner:test', granted_scope = 'recipient' WHERE id = $1`, [approvalId]),
      ),
    ).toBe('55000');
    // 거절은 된다(안전 방향).
    await owner.query(`UPDATE approval_requests SET status = 'rejected', decided_at = now(), decided_by = 'owner:test' WHERE id = $1`, [approvalId]);
  });

  it('HIGH-1 — 토큰 발급이 삭제와 경합하면 409 agent_deleted(행 잠금 아래 재확인) · 삭제한 에이전트의 살아 있는 토큰은 인증 거부 · 토큰 INSERT 트리거', async () => {
    const f = await fixture('beta');
    // 삭제가 에이전트 행을 쥔 채 커밋 전 — 발급은 트랜잭션 밖 확인(active)을 지나 행 잠금에서 기다렸다가 disabled 를 본다.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE agents SET status = 'disabled' WHERE id = $1`, [f.agentId]);
      const issuing = call(deps, 'POST', `/api/agents/${f.agentId}/tokens`, authed(f.session, { body: { label: 'race' } }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('COMMIT');
      const issued = await issuing;
      expect([issued.statusCode, (issued.json() as { error: string }).error]).toEqual([409, 'agent_deleted']);
    } finally {
      client.release();
    }
    // raw disable 는 토큰을 폐기하지 않았다 — 그래도 인증은 거부(폐기로 읽는다).
    expect(await owner.query('SELECT 1 FROM agent_api_keys WHERE agent_id = $1 AND revoked_at IS NULL', [f.agentId])).toMatchObject({ rowCount: 1 });
    const auth = await authenticateAgentToken(createPostgresAgentTokenStore(app), f.token, new Date());
    expect(auth).toEqual({ kind: 'rejected', reason: 'token_revoked' });
    expect(
      await sqlState(() =>
        owner.query(`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, repeat('b', 64), ARRAY['messages:read']::agent_token_capability[])`, [f.agentId]),
      ),
    ).toBe('23514');
  });

  it('MED-2 — 웹훅 INSERT 트리거 · 등록 연산(에이전트 API 도 지나는 길)이 agent_deleted', async () => {
    const f = await fixture('beta');
    expect((await del(f.session, f.agentId)).statusCode).toBe(200);
    expect(await sqlState(() => webhook(f))).toBe('23514');
    const registered = await registerWebhookEndpoint(app, { agentId: f.agentId as AgentId, url: 'https://hook.example.com/', eventTypes: null, kid: 'k1', via: 'api' }, new Date());
    expect(registered).toEqual({ kind: 'agent_deleted' });
  });

  it('MED-3 — raw status=disabled(admin 롤) 뒤의 재생이 남은 주소 · 토큰 · 예약 · 웹훅을 정리하고 감사 1행 · 다음 재생은 감사 없음', async () => {
    const f = await fixture('beta');
    const scheduled = await schedule(f);
    await webhook(f);
    await admin.query(`UPDATE agents SET status = 'disabled' WHERE id = $1`, [f.agentId]);
    // 아직 주소가 살아 있다(raw UPDATE 는 정리하지 않았다).
    expect((await createPostgresInboundStore(app).findAgentsByAddresses([f.address])).map((m) => m.agentId)).toEqual([f.agentId]);
    const replay = await del(f.session, f.agentId);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ agentId: f.agentId, replayed: true, addresses: [f.address], revokedTokens: 1, cancelledScheduled: 1, disabledWebhooks: 1 });
    expect(await createPostgresInboundStore(app).findAgentsByAddresses([f.address])).toEqual([]);
    expect((await owner.query<{ status: string }>('SELECT status::text AS status FROM scheduled_sends WHERE id = $1', [scheduled])).rows[0]?.status).toBe('cancelled');
    const audits = async (): Promise<number> =>
      (await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'agent.delete'", [f.orgId])).rows[0]?.n ?? 0;
    expect(await audits()).toBe(1);
    expect((await del(f.session, f.agentId)).json()).toMatchObject({ replayed: true, revokedTokens: 0, cancelledScheduled: 0, disabledWebhooks: 0 });
    expect(await audits()).toBe(1);
  });

  it('MED-4 — 운영자 예약 주소를 쥔 에이전트는 409 operator_reserved · DB 42501(되돌림)', async () => {
    const f = await fixture('beta');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('onve@atmark.ai', $1, 'test', 'agent-delete test')`, [f.orgId]);
      await client.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, 'onve@atmark.ai', 'atmark.ai', false)`, [f.agentId]);
      await client.query('SAVEPOINT op');
      await expect(deleteAgentOp(transactionPool(client), f.orgId, f.agentId as AgentId)).rejects.toMatchObject({ code: 'operator_reserved', status: 409 });
      await client.query('ROLLBACK TO SAVEPOINT op');
      expect(await sqlState(() => client.query(`UPDATE agents SET status = 'disabled' WHERE id = $1`, [f.agentId]))).toBe('42501');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('L-1 — 등록(에이전트 API — 행 잠금 없는 앱 롤 길)이 삭제와 겹쳐도 그 엔드포인트까지 끈다(같은 advisory 잠금)', async () => {
    const f = await fixture('beta');
    // 등록 트랜잭션: 등록 경로와 같은 잠금을 쥐고, 삭제 커밋 전(상태 active)에 엔드포인트를 넣은 채 머문다.
    const client = await owner.connect();
    let hookId = '';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('webhook_endpoints_active:' || $1::text, 0))`, [f.agentId]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'k1') RETURNING id::text AS id`,
        [f.agentId, `https://race-${randomUUID()}.example.com/`],
      );
      hookId = inserted.rows[0]?.id ?? '';
      const deleting = del(f.session, f.agentId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('COMMIT');
      const done = await deleting;
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ disabledWebhooks: 1 });
    } finally {
      client.release();
    }
    const row = await owner.query<{ off: boolean }>('SELECT disabled_at IS NOT NULL AS off FROM webhook_endpoints WHERE id = $1', [hookId]);
    expect(row.rows[0]?.off).toBe(true);
  });

  it('L-3 — 운영자가 정지한 에이전트는 소유자 롤로도 disabled 로 만들 수 없다(42501)', async () => {
    const f = await fixture('beta');
    await owner.query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [f.agentId]);
    expect(await sqlState(() => owner.query(`UPDATE agents SET status = 'disabled', suspended_by = NULL WHERE id = $1`, [f.agentId]))).toBe('42501');
    // 비공허: 운영자가 풀면 된다.
    await owner.query(`UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`, [f.agentId]);
    expect((await del(f.session, f.agentId)).statusCode).toBe(200);
  });
});

