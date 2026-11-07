/**
 * **콘솔 — AI 의심 메일 감시(ADR-0017) · 실제 Postgres 위 · admin 롤(`atmark_admin`) GRANT 안에서.** 실메일 0.
 *
 *   ① `GET /api/settings/ai-watch` — 허용 목록 없음 `{feature:false, enabled:false}` · 있음 `{feature:true}`
 *   ② 켜기: 허용 목록 없으면 403 `feature_not_enabled`(앱 판정) · 있으면 200 changed · 같은 상태 다시 = changed:false(감사 행 없음) ·
 *      끄기는 허용 목록이 빠져도 된다 · 감사 `org.ai_watch.on`/`off` 각 1행
 *   ③ 역할: 관리자는 켜지 못한다(403 forbidden_role) · 끌 수는 있다 · 모르는 키 400
 *   ④ DB 가드(P0A07): 허용 목록 없이 admin 롤이 칸을 직접 true 로 바꾸면 거부된다(앱 검사를 건너뛰어도)
 *   ⑤ 수신 로그: 작업 없는 행 = 키 없음 · flagged(밴드 · 모델 버전 · 늦음) · clear · 마감 전 pending · 마감 지난 pending = skipped ·
 *      skipped · 그림자 작업 = 키 없음 · 상세도 같은 값
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

interface Fixture {
  readonly orgId: string;
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
}

describe.skipIf(!AVAILABLE)('콘솔 — AI 의심 메일 감시', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
  });

  async function fixture(feature: boolean): Promise<Fixture> {
    const org = await newOrganization(owner);
    if (feature) await owner.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'ai_mail_watch', 'aw-test')`, [org.id]);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'aw', localPart: `aw-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { orgId: org.id, session, agentId: agent.id, address: agent.address };
  }

  const patch = (session: Session, body: unknown) => call(deps, 'PATCH', '/api/settings/ai-watch', authed(session, { body }));
  const audit = async (orgId: string): Promise<string[]> =>
    (await owner.query<{ action: string }>(`SELECT action FROM owner_actions WHERE organization_id = $1 AND action LIKE 'org.ai_watch.%' ORDER BY created_at`, [orgId])).rows.map((r) => r.action);

  it('① ② 읽기 · 켜기 · 같은 상태 다시 · 끄기 · 감사', async () => {
    const off = await fixture(false);
    expect((await call(deps, 'GET', '/api/settings/ai-watch', authed(off.session))).json()).toEqual({ feature: false, enabled: false });
    const denied = await patch(off.session, { enabled: true });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'feature_not_enabled' });
    // 꺼진 것을 끄기 — 바뀐 것 없음, 감사 없음.
    expect((await patch(off.session, { enabled: false })).json()).toEqual({ feature: false, enabled: false, changed: false });
    expect(await audit(off.orgId)).toEqual([]);

    const on = await fixture(true);
    expect((await call(deps, 'GET', '/api/settings/ai-watch', authed(on.session))).json()).toEqual({ feature: true, enabled: false });
    expect((await patch(on.session, { enabled: true })).json()).toEqual({ feature: true, enabled: true, changed: true });
    expect((await patch(on.session, { enabled: true })).json()).toEqual({ feature: true, enabled: true, changed: false });
    const stored = await owner.query<{ v: boolean }>('SELECT ai_mail_watch_enabled AS v FROM organizations WHERE id = $1', [on.orgId]);
    expect(stored.rows[0]?.v).toBe(true);
    // 운영자가 허용 목록에서 빼도 끌 수는 있다.
    await owner.query(`DELETE FROM org_features WHERE organization_id = $1 AND feature = 'ai_mail_watch'`, [on.orgId]);
    expect((await patch(on.session, { enabled: false })).json()).toEqual({ feature: false, enabled: false, changed: true });
    expect(await audit(on.orgId)).toEqual(['org.ai_watch.on', 'org.ai_watch.off']);
  });

  it('③ 관리자는 켜지 못하고 끌 수는 있다 · 모르는 키 · 불리언 아닌 값', async () => {
    const f = await fixture(true);
    const email = `aw-admin-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'admin', 'invite')`, [userId, f.orgId]);
    const asAdmin = await login(deps, mailer, { id: f.orgId, ownerEmail: email });
    const denied = await patch(asAdmin, { enabled: true });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden_role' });
    await owner.query('UPDATE organizations SET ai_mail_watch_enabled = true WHERE id = $1', [f.orgId]);
    expect((await patch(asAdmin, { enabled: false })).json()).toMatchObject({ enabled: false, changed: true });
    expect((await patch(f.session, { enabled: 'yes' })).statusCode).toBe(400);
    expect((await patch(f.session, { enabled: true, extra: 1 })).statusCode).toBe(400);
  });

  it('④ DB 가드 — 허용 목록 없이 admin 롤이 직접 켜면 P0A07', async () => {
    const f = await fixture(false);
    await expect(admin.query('UPDATE organizations SET ai_mail_watch_enabled = true WHERE id = $1', [f.orgId])).rejects.toMatchObject({ code: 'P0A07' });
  });

  it('⑤ 수신 로그 — 상태 · 밴드 · 그림자 · 상세', async () => {
    const f = await fixture(true);
    /** 작업(있으면)을 먼저 만들고 그 id 로 행을 넣는다 — `ai_watch_job_id` 는 INSERT 뒤에 NULL 로만 바뀐다(DB 가드). */
    async function message(subject: string, at: Date, job?: { fields: string; values: unknown[] }): Promise<string> {
      const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
      const ses = `0100${randomUUID().replace(/-/g, '')}`;
      let jobId: string | null = null;
      if (job !== undefined) {
        const created = await owner.query<{ job_id: string }>(
          `INSERT INTO ai_watch_jobs (organization_id, ses_message_id${job.fields === '' ? '' : `, ${job.fields}`})
           VALUES ($1, $2${job.values.map((_, i) => `, $${String(i + 3)}`).join('')}) RETURNING job_id`,
          [f.orgId, ses, ...job.values],
        );
        jobId = created.rows[0]?.job_id ?? null;
      }
      const row = await owner.query<{ id: string }>(
        `INSERT INTO inbound_messages
           (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
            subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
            raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
            scanner_version, injection_risk, quarantined, sender_trust, ai_watch_job_id)
         VALUES ($1, $2, $3, $4, 'no_header_ids', 'x@partner.example', 'partner.example', false, $5, false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
                 'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, $6, 'test-v0', 'none', false, 'unknown', $7)
         RETURNING id`,
        [f.agentId, f.address, ses, thread.rows[0]?.id, subject, at, jobId],
      );
      return row.rows[0]?.id ?? '';
    }
    const base = Date.now() - 60_000;
    const at = (i: number): Date => new Date(base - i * 1000);
    const model = 'laya-ml-aw-test-int8';
    const none = await message('none', at(0));
    const flagged = await message('flagged', at(1), { fields: 'state, verdict, band, model_version, decided_at, late', values: ['done', 'flagged', 'high', model, new Date(), true] });
    const clear = await message('clear', at(2), { fields: 'state, verdict, band, model_version, decided_at', values: ['done', 'clear', 'low', model, new Date()] });
    const pending = await message('pending', at(3), { fields: '', values: [] });
    const overdue = await message('overdue', at(4), { fields: 'enqueued_at, deadline', values: [new Date(Date.now() - 120_000), new Date(Date.now() - 100_000)] });
    const skipped = await message('skipped', at(5), { fields: 'state, decided_at, skip_reason', values: ['skipped', new Date(), 'enqueue_failed'] });
    const shadow = await message('shadow', at(6), { fields: 'shadow, state, verdict, band, model_version, decided_at', values: [true, 'done', 'flagged', 'mid', model, new Date()] });

    const listed = await call(deps, 'GET', '/api/logs', authed(f.session, { query: 'type=inbound&limit=50' }));
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (listed.json() as { items: Array<{ id: string; aiWatch?: unknown }> }).items;
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(none)).not.toHaveProperty('aiWatch');
    expect(byId.get(flagged)?.aiWatch).toEqual({ status: 'flagged', band: 'high', modelVersion: 'laya-ml-aw-test-int8', late: true });
    expect(byId.get(clear)?.aiWatch).toEqual({ status: 'clear', band: 'low', modelVersion: 'laya-ml-aw-test-int8', late: false });
    expect(byId.get(pending)?.aiWatch).toEqual({ status: 'pending', band: null, modelVersion: null, late: false });
    expect(byId.get(overdue)?.aiWatch).toEqual({ status: 'skipped', band: null, modelVersion: null, late: false });
    expect(byId.get(skipped)?.aiWatch).toEqual({ status: 'skipped', band: null, modelVersion: null, late: false });
    expect(byId.get(shadow)).not.toHaveProperty('aiWatch');

    const detail = await call(deps, 'GET', `/api/logs/inbound/${flagged}`, authed(f.session));
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as { item?: { aiWatch?: unknown }; aiWatch?: unknown };
    expect((body.item ?? body).aiWatch).toEqual({ status: 'flagged', band: 'high', modelVersion: 'laya-ml-aw-test-int8', late: true });
  });
});
