/**
 * 정책 v2 관리 API (계약 `.omc/handoffs/v2-contract.md` §1 · T1 메모) — **운영과 같은 `atmark_admin` 롤**로 라우터를 부른다.
 *
 * 덮는 것:
 *   - `GET /api/agents/{id}/policy` 모양(콘솔 모드 이름 · 방향별 allow/block · ruleLimit · version) · `GET /api/agents` 의 모드 이름.
 *   - `POST /api/agents/{id}/rules` · `DELETE …/rules/{ruleId}` · `PATCH …/policy` — 각각 **새 정책 버전**, 스냅샷에 목록 전문,
 *     감사(`owner_actions`) 1행이 **같은 트랜잭션**(감사가 실패하면 행위도 없다).
 *   - CSRF(POST·PATCH·DELETE) · 다른 조직/다른 에이전트의 규칙 404 · 레거시 모드 보기(`legacy`)와 설정 거부 · 상한(1000, 앱 검사 + DB 트리거).
 *   - 지우기는 표시(`removed_at`) — admin 롤 DELETE 0 · 규칙 고치기 불가(트리거) · 앱 롤은 목록에 쓰지 못한다.
 * 실메일 0 · AWS 0.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { toAgentId } from '../../../src/db/schema';
import { loadEvaluationInput } from '../../../src/policy/policy-loader';
import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import { appendPolicyVersionFromLive } from '../db/support/harness';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

describe.skipIf(!AVAILABLE)('정책 v2 관리 API — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let session: Session;
  let organizationId: string;
  const deps = () => adminDeps(admin);

  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = appPool();
    const org = await newOrganization(owner);
    organizationId = org.id;
    session = await login(deps(), mailer, org);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
    await app.end();
  });

  async function newAgent(as: Session = session): Promise<{ id: string; address: string }> {
    const created = await call(deps(), 'POST', '/api/agents', authed(as, { body: { name: 'v2', localPart: `v2-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { agent: { id: string; address: string } }).agent;
  }

  async function version(agentId: string): Promise<number> {
    return (await owner.query<{ v: number }>('SELECT current_version AS v FROM agent_policies WHERE agent_id = $1', [agentId])).rows[0]?.v ?? -1;
  }

  async function actions(agentId: string): Promise<string[]> {
    const rows = await owner.query<{ action: string }>(
      'SELECT action FROM owner_actions WHERE organization_id = $1 AND target_id = $2 ORDER BY created_at, id',
      [organizationId, agentId],
    );
    return rows.rows.map((row) => row.action);
  }

  it('새 에이전트의 정책 — 발신 전체 · 수신 전체(2026-10-13 결정 B) · 빈 목록 · 콘솔 이름 · ruleLimit · 목록 조회에도 콘솔 이름', async () => {
    const agent = await newAgent();
    const got = await call(deps(), 'GET', `/api/agents/${agent.id}/policy`, authed(session));
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({
      outbound: { mode: 'all', legacyMode: null, allow: [], block: [] },
      inbound: { mode: 'all', allow: [], block: [] },
      limits: expect.objectContaining({ per_minute: expect.any(Number) }) as unknown,
      version: 1,
      ruleLimit: 1000,
    });
    const list = (await call(deps(), 'GET', '/api/agents', authed(session))).json() as { id: string; outboundMode: string; inboundMode: string }[];
    expect(list.find((row) => row.id === agent.id)).toMatchObject({ outboundMode: 'all', inboundMode: 'all' });
  });

  it('규칙 더하기·모드 바꾸기·지우기 — 매번 새 버전 · 스냅샷에 목록 · 감사 1행씩 · 지운 행은 남는다', async () => {
    const agent = await newAgent();

    const added = await call(
      deps(),
      'POST',
      `/api/agents/${agent.id}/rules`,
      authed(session, { body: { direction: 'outbound', list: 'allow', value: '  Boss+Team@Partner.Example ' } }),
    );
    expect(added.statusCode, added.body).toBe(201);
    const body = added.json() as { rule: { id: string; kind: string; value: string; createdAt: string }; policy: Record<string, unknown> };
    expect(body.rule).toMatchObject({ kind: 'address', value: 'boss+team@partner.example' });
    // 모드는 그대로(새 에이전트 = 전체) — 목록은 모드와 따로 쌓인다(모드를 허용 목록으로 바꾸면 그때 쓰인다).
    expect(body.policy).toMatchObject({ version: 2, outbound: { mode: 'all', allow: [{ id: body.rule.id, value: 'boss+team@partner.example' }] } });
    expect(await version(agent.id)).toBe(2);

    const domain = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(session, { body: { direction: 'inbound', list: 'block', value: '*.spam.example' } }));
    expect(domain.json()).toMatchObject({ rule: { kind: 'domain', value: '*.spam.example' }, policy: { version: 3 } });

    const patched = await call(
      deps(),
      'PATCH',
      `/api/agents/${agent.id}/policy`,
      authed(session, { body: { outbound: { mode: 'all' }, inbound: { mode: 'blocklist' }, limits: { perMinute: 7 } } }),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ version: 4, outbound: { mode: 'all' }, inbound: { mode: 'blocklist' }, limits: { per_minute: 7 } });

    // 스냅샷 — 이 버전의 모드와 목록 전문(AC-9 "왜 나갔나").
    const snapshot = await owner.query<{ outbound_mode: string; inbound_mode: string; snapshot: Record<string, unknown> }>(
      'SELECT outbound_mode, inbound_mode, snapshot FROM policy_versions WHERE agent_id = $1 AND version = 4',
      [agent.id],
    );
    expect(snapshot.rows[0]).toMatchObject({ outbound_mode: 'unrestricted', inbound_mode: 'blocklist_only' });
    expect(snapshot.rows[0]?.snapshot['contact_rules']).toEqual([
      expect.objectContaining({ direction: 'inbound', list: 'block', kind: 'domain', value: '*.spam.example' }),
      expect.objectContaining({ id: body.rule.id, direction: 'outbound', list: 'allow', kind: 'address', value: 'boss+team@partner.example' }),
    ]);

    const removed = await call(deps(), 'DELETE', `/api/agents/${agent.id}/rules/${body.rule.id}`, authed(session));
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ policy: { version: 5, outbound: { allow: [] }, inbound: { block: [{ value: '*.spam.example' }] } } });
    const v5 = await owner.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM policy_versions WHERE agent_id = $1 AND version = 5', [agent.id]);
    expect(v5.rows[0]?.snapshot['contact_rules']).toEqual([expect.objectContaining({ value: '*.spam.example' })]);
    // 지운 행은 남는다 — 누가 언제 뺐나(admin 롤 DELETE 0).
    const row = await owner.query<{ removed_at: Date | null; removed_by: string | null }>(
      'SELECT removed_at, removed_by FROM agent_contact_rules WHERE id = $1',
      [body.rule.id],
    );
    expect(row.rows[0]?.removed_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.removed_by).toMatch(/^admin:session:/);
    // 같은 규칙을 다시 지우면 404 — 이미 지운 것과 없는 것을 가르지 않는다.
    expect((await call(deps(), 'DELETE', `/api/agents/${agent.id}/rules/${body.rule.id}`, authed(session))).statusCode).toBe(404);
    // 지운 값은 다시 넣을 수 있다(살아 있는 행만 유니크).
    expect(
      (await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(session, { body: { direction: 'outbound', list: 'allow', value: 'boss+team@partner.example' } }))).statusCode,
    ).toBe(201);

    expect(await actions(agent.id)).toEqual([
      'agent.create',
      'agent.rule.add',
      'agent.rule.add',
      'agent.policy.change',
      'agent.rule.remove',
      'agent.rule.add',
    ]);
  });

  it('CSRF — 규칙 더하기·지우기·정책 바꾸기는 X-Atmark-CSRF 없이 403 · 아무것도 바뀌지 않는다', async () => {
    const agent = await newAgent();
    const noCsrf = { cookies: session.cookies } as const;
    const post = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, { ...noCsrf, body: { direction: 'outbound', list: 'allow', value: 'x@example.com' } });
    const patch = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, { ...noCsrf, body: { outbound: { mode: 'all' } } });
    const del = await call(deps(), 'DELETE', `/api/agents/${agent.id}/rules/00000000-0000-4000-8000-000000000000`, noCsrf);
    for (const result of [post, patch, del]) {
      expect(result.statusCode).toBe(403);
      expect((result.json() as { error: string }).error).toBe('csrf_mismatch');
    }
    expect(await version(agent.id)).toBe(1);
  });

  it('다른 에이전트의 규칙은 이 에이전트 경로로 지울 수 없다(404) · 다른 조직 에이전트는 404', async () => {
    const mine = await newAgent();
    const other = await newAgent();
    const added = await call(deps(), 'POST', `/api/agents/${other.id}/rules`, authed(session, { body: { direction: 'outbound', list: 'block', value: 'x@example.com' } }));
    const ruleId = (added.json() as { rule: { id: string } }).rule.id;
    const cross = await call(deps(), 'DELETE', `/api/agents/${mine.id}/rules/${ruleId}`, authed(session));
    expect([cross.statusCode, (cross.json() as { error: string }).error]).toEqual([404, 'rule_not_found']);
    const alive = await owner.query('SELECT 1 FROM agent_contact_rules WHERE id = $1 AND removed_at IS NULL', [ruleId]);
    expect(alive.rowCount).toBe(1);

    const orgB = await newOrganization(owner);
    const sessionB = await login(deps(), mailer, orgB);
    const probe = await call(deps(), 'DELETE', `/api/agents/${other.id}/rules/${ruleId}`, authed(sessionB));
    expect([probe.statusCode, (probe.json() as { error: string }).error]).toEqual([404, 'agent_not_found']);
    const probeGet = await call(deps(), 'GET', `/api/agents/${other.id}/policy`, authed(sessionB));
    expect(probeGet.statusCode).toBe(404);
  });

  it('레거시 모드 — 소유자 롤로 만든 approval_required 는 보기에서 legacy · 콘솔은 그 모드를 고를 수 없다', async () => {
    const agent = await newAgent();
    // 소유자 롤(운영자 셸·데모)이 레거시 버전을 쓴다 — 콘솔에는 그 길이 없다.
    await owner.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot, created_by)
       SELECT agent_id, 2, 'approval_required', jsonb_build_object('outbound_mode', 'approval_required'), 'test:legacy' FROM agent_policies WHERE agent_id = $1`,
      [agent.id],
    );
    await owner.query(`UPDATE agent_policies SET outbound_mode = 'approval_required', current_version = 2 WHERE agent_id = $1`, [agent.id]);
    expect((await call(deps(), 'GET', `/api/agents/${agent.id}/policy`, authed(session))).json()).toMatchObject({
      outbound: { mode: 'legacy', legacyMode: 'approval_required' },
    });
    for (const mode of ['approval_required', 'reply_only', 'legacy']) {
      const rejected = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, authed(session, { body: { outbound: { mode } } }));
      expect([rejected.statusCode, (rejected.json() as { error: string }).error]).toEqual([400, 'legacy_mode_rejected']);
    }
    // 레거시에서 벗어나는 것은 된다.
    const out = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, authed(session, { body: { outbound: { mode: 'allowlist' } } }));
    expect(out.json()).toMatchObject({ outbound: { mode: 'allowlist', legacyMode: null }, version: 3 });
  });

  it('옛 PATCH 모양(mode·autoApproveVerificationSenders)은 invalid_body — 조용히 무시하지 않는다', async () => {
    const agent = await newAgent();
    for (const body of [{ mode: 'disabled' }, { autoApproveVerificationSenders: false }, { outbound: 'all' }, { outbound: { mode: 'all', extra: 1 } }]) {
      const result = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, authed(session, { body }));
      expect([result.statusCode, (result.json() as { error: string }).error], JSON.stringify(body)).toEqual([400, 'invalid_body']);
    }
    const empty = await call(deps(), 'PATCH', `/api/agents/${agent.id}/policy`, authed(session, { body: {} }));
    expect((empty.json() as { error: string }).error).toBe('no_change');
    expect(await version(agent.id)).toBe(1);
  });

  it('상한 1000 — 앱 검사가 409 rule_limit · 그 검사를 우회한 쓰기는 DB 트리거가 막는다', async () => {
    const agent = await newAgent();
    // 목록 변경은 새 정책 버전과 한 트랜잭션이어야 커밋된다(202609241040).
    const bulk = await owner.connect();
    try {
      await bulk.query('BEGIN');
      await bulk.query(
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
         SELECT $1, 'inbound', 'block', 'address', 'u' || g || '@bulk.example', 'test:limit' FROM generate_series(1, 1000) g`,
        [agent.id],
      );
      await appendPolicyVersionFromLive(bulk, toAgentId(agent.id));
      await bulk.query('COMMIT');
    } finally {
      bulk.release();
    }
    const over = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(session, { body: { direction: 'inbound', list: 'block', value: 'one.more@bulk.example' } }));
    expect([over.statusCode, (over.json() as { error: string }).error]).toEqual([409, 'rule_limit']);
    await expect(
      owner.query(
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value) VALUES ($1, 'inbound', 'block', 'address', 'raw@bulk.example')`,
        [agent.id],
      ),
    ).rejects.toThrow(/agent_contact_rules_limit/);
    // 다른 목록은 따로 센다.
    const otherList = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(session, { body: { direction: 'inbound', list: 'allow', value: 'ok@bulk.example' } }));
    expect(otherList.statusCode).toBe(201);
  });

  // 202609241040 보정 테스트는 조직을 따로 쓴다 — 조직당 에이전트 상한(10)을 위 테스트들과 나누지 않게.
  async function correctionsSession(): Promise<Session> {
    return login(deps(), mailer, await newOrganization(owner));
  }

  it('★ 목록 변경 = 새 버전 (202609241040 — 검증 M3) · 버전 없는 admin 롤 직접 쓰기는 커밋되지 않고, 관문은 살아 있는 행이 아니라 스냅샷을 판정한다', async () => {
    const own = await correctionsSession();
    const agent = await newAgent(own);
    const added = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(own, { body: { direction: 'outbound', list: 'allow', value: 'friend@partner.example' } }));
    expect(added.statusCode).toBe(201);
    expect(await version(agent.id)).toBe(2);
    const liveCount = async (): Promise<number> =>
      (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_contact_rules WHERE agent_id = $1 AND removed_at IS NULL', [agent.id])).rows[0]?.n ?? -1;

    // ① admin 롤의 직접 INSERT(버전 없음) → 커밋 실패.
    await expect(
      admin.query(
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by) VALUES ($1, 'outbound', 'allow', 'address', 'sneak@x.example', 'raw')`,
        [agent.id],
      ),
    ).rejects.toThrow(/새 정책 버전/);
    // ② 버전을 쓰긴 했는데 그 스냅샷이 살아 있는 목록과 다르다(옛 목록을 복사) → 커밋 실패.
    const forged = await admin.connect();
    try {
      await forged.query('BEGIN');
      await forged.query(
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by) VALUES ($1, 'outbound', 'allow', 'address', 'sneak@x.example', 'raw')`,
        [agent.id],
      );
      await forged.query(
        `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
         SELECT agent_id, 3, outbound_mode, inbound_mode, snapshot, 'raw' FROM policy_versions WHERE agent_id = $1 AND version = 2`,
        [agent.id],
      );
      await forged.query('UPDATE agent_policies SET current_version = 3 WHERE agent_id = $1', [agent.id]);
      await expect(forged.query('COMMIT')).rejects.toThrow(/새 정책 버전/);
    } finally {
      forged.release();
    }
    expect([await version(agent.id), await liveCount()]).toEqual([2, 1]);

    // ③ 트리거를 끈 소유자 롤(=DB 를 우회한 쓰기)이 살아 있는 행만 바꿔도 관문의 판정은 버전 2 의 스냅샷이다.
    const bypass = await owner.connect();
    try {
      await bypass.query('BEGIN');
      // 트리거를 끄는 가장 좁은 길 — 이 트랜잭션만(`SET LOCAL`), 테이블 잠금 없이(공유 DB 의 다른 테스트를 멈추지 않게). 소유자(슈퍼유저)만 된다.
      await bypass.query('SET LOCAL session_replication_role = replica');
      await bypass.query(
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
         VALUES ($1, 'outbound', 'allow', 'address', 'sneak@x.example', 'raw'), ($1, 'outbound', 'block', 'address', 'friend@partner.example', 'raw')`,
        [agent.id],
      );
      await bypass.query('COMMIT');
    } finally {
      bypass.release();
    }
    expect(await liveCount()).toBe(3);
    const input = await loadEvaluationInput(createPostgresPolicySource(app), {
      agentId: toAgentId(agent.id),
      now: new Date(),
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
      attempt: { routeId: 'send', fromAddress: agent.address, recipients: ['sneak@x.example'], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
    });
    expect([input.policy.version, input.policy.allowlist, input.policy.blocklist]).toEqual([2, ['friend@partner.example'], []]);
    // 새 에이전트는 발신 "전체"(2026-10-13 결정 B)라 목록을 읽지 않는다 — 판정이 스냅샷 목록을 쓰는지는 허용 목록 모드로 본다.
    expect(
      evaluateOutboundMode(input.ctx, { ...input.policy, outboundMode: 'allowlist_only' }, { policyVersion: 2, policyVersionId: input.policy.versionId, evaluatedAt: new Date() })
        .reasons,
    ).toEqual(['recipient_not_allowlisted']);
  });

  it('규칙 값 (202609241040 — 검증 L1·M2) — 발신 allow 의 atmark.ai 도메인은 rule_platform_domain · 따옴표·끝 점·점 로컬파트는 invalid_rule_value', async () => {
    const own = await correctionsSession();
    const agent = await newAgent(own);
    const post = async (direction: string, list: string, value: string) => {
      const result = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(own, { body: { direction, list, value } }));
      return [result.statusCode, (result.json() as { error?: string }).error ?? 'ok'];
    };
    for (const value of ['atmark.ai', '*.atmark.ai', 'Mail.Atmark.AI']) expect(await post('outbound', 'allow', value), value).toEqual([400, 'rule_platform_domain']);
    for (const value of ['"bad"@x.example', 'bad@x.example.', '.bad@x.example', 'b..ad@x.example', 'bad\\@x.example']) {
      expect(await post('outbound', 'block', value), value).toEqual([400, 'invalid_rule_value']);
    }
    // 다른 에이전트는 정확한 주소로 · 차단 쪽·수신 쪽의 atmark.ai 도메인은 좁은 쪽이라 받는다.
    expect(await post('outbound', 'allow', 'peer@atmark.ai')).toEqual([201, 'ok']);
    expect(await post('outbound', 'block', 'atmark.ai')).toEqual([201, 'ok']);
    expect(await post('inbound', 'allow', 'atmark.ai')).toEqual([201, 'ok']);
  });

  it('DB 가드 — admin 롤은 DELETE 불가 · 규칙 값 고치기 불가 · 지우기 표시는 한 번 · 앱 롤은 목록에 쓰지 못한다 · 값 모양 CHECK', async () => {
    const agent = await newAgent();
    const added = await call(deps(), 'POST', `/api/agents/${agent.id}/rules`, authed(session, { body: { direction: 'outbound', list: 'allow', value: 'keep@example.com' } }));
    const ruleId = (added.json() as { rule: { id: string } }).rule.id;
    await expect(admin.query('DELETE FROM agent_contact_rules WHERE id = $1', [ruleId])).rejects.toThrow(/permission denied/);
    await expect(owner.query('DELETE FROM agent_contact_rules WHERE id = $1', [ruleId])).rejects.toThrow();
    await expect(admin.query(`UPDATE agent_contact_rules SET value = 'evil@example.com' WHERE id = $1`, [ruleId])).rejects.toThrow(/permission denied/);
    await expect(owner.query(`UPDATE agent_contact_rules SET value = 'evil@example.com' WHERE id = $1`, [ruleId])).rejects.toThrow(/고칠 수 없다/);
    // 지우기 표시 한 번 — 두 번째는 트리거가 즉시 거부한다(롤백되는 트랜잭션 안에서: 버전 없는 목록 변경은 커밋되지 않는다 — 202609241040).
    const removeTwice = await admin.connect();
    try {
      await removeTwice.query('BEGIN');
      await removeTwice.query(`UPDATE agent_contact_rules SET removed_at = now(), removed_by = 'x' WHERE id = $1`, [ruleId]);
      await expect(removeTwice.query(`UPDATE agent_contact_rules SET removed_at = now(), removed_by = 'y' WHERE id = $1`, [ruleId])).rejects.toThrow(/이미 지운/);
    } finally {
      await removeTwice.query('ROLLBACK');
      removeTwice.release();
    }
    // 버전 없는 지우기 표시(admin 롤 직접 UPDATE)는 커밋되지 않는다 — 판정 근거(스냅샷)와 목록이 갈라지지 않게.
    await expect(admin.query(`UPDATE agent_contact_rules SET removed_at = now(), removed_by = 'x' WHERE id = $1`, [ruleId])).rejects.toThrow(
      /새 정책 버전/,
    );
    await expect(
      app.query(`INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value) VALUES ($1, 'outbound', 'allow', 'address', 'a@example.com')`, [agent.id]),
    ).rejects.toThrow(/permission denied/);
    // 종류와 값이 어긋난 행 · 대문자 · `@domain` · 점 없는 도메인은 DB 가 받지 않는다(모양 밖 값에 함수가 NULL 을 줘도 — 202609241030).
    // 롤백되는 트랜잭션 안에서 본다 — 가드가 무너진 날 이 테스트가 공유 DB 에 쓰레기 행을 남기지 않게.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const [kind, value] of [['domain', 'a@example.com'], ['address', 'A@example.com'], ['address', '@example.com'], ['domain', 'example']] as const) {
        await client.query('SAVEPOINT probe');
        await expect(
          client.query(`INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value) VALUES ($1, 'outbound', 'block', $2, $3)`, [agent.id, kind, value]),
          `${kind} ${value}`,
        ).rejects.toThrow(/agent_contact_rules_value_kind/);
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
