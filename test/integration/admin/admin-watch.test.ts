/**
 * **콘솔 — 감시 탭 받기 등급(ADR-0016 2026-10-08) · 실제 Postgres 위 · admin 롤(`atmark_admin`) GRANT 안에서.** 실메일 0.
 *
 *   ① 조직 설정: 신뢰 발신자 읽기 · 통째로 바꾸기(접기 · 겹침 하나로 · 빠진 항목은 지우기) · 같은 목록 = changed:false(감사 없음) · 감사 1행 ·
 *      모양이 틀린 줄 400 · 201개 400 · 모르는 키 400 · **관리자 403**(소유자만) · 멤버 보기 200
 *   ② 에이전트 설정: 기본값(deliver · 알림 켬 · updatedAt null) · 바꾸기 · 같은 값 = changed:false · 잘못된 값 400 · 빈 본문 400 ·
 *      다른 조직의 에이전트 404 · 멤버 403
 *   ③ 보류 목록: 차단 · 판정 없음 · 위험 보류만(보이는 메일 · 정책 차단 없음) · 최근 것부터 · 쪽 나누기 · agentId 거르기 · 본문 · 제목 · 주소 없음 ·
 *      판정 없음은 releasable:false · 다른 조직의 메일 없음
 *   ④ 풀기: 200 · 감사 `watch.release` · 다시 = replayed(감사 없음) · 판정 없음 409 · 정책 차단 409 · 숨지 않은 메일 409 · 다른 조직 404 ·
 *      잘못된 id 400 · 멤버 403 · 풀린 메일은 목록에서 빠진다
 *   ⑤ admin 롤은 설정 표 · inbound_messages 를 직접 쓰지 못한다(정의자 함수만)
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import type { AgentId } from '../../../src/db/schema';
import type { InjectionScanResult } from '../../../src/security/injection/scanner';
import { closeTestPool, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from '../inbound/support';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

interface Fixture {
  readonly orgId: string;
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
}

function scanner(risk: InjectionScanResult['injectionRisk'], families: readonly [string, boolean][]) {
  return (): InjectionScanResult =>
    ({
      injectionRisk: risk,
      scannerVersion: 'test-admin-watch-1',
      quarantine: risk === 'medium' || risk === 'high',
      findings: families.map(([family, damped], index) => ({
        ruleId: `test.${family}`,
        family,
        field: 'text',
        view: 'raw',
        fieldIndex: 0,
        start: index,
        end: index + 1,
        weight: 1,
        damped,
      })),
    }) as unknown as InjectionScanResult;
}

const SUBJECT_SENTINEL = 'SUBJ-WATCH-SENTINEL';
const BODY_SENTINEL = 'BODY-WATCH-SENTINEL';

describe.skipIf(!AVAILABLE)('콘솔 — 감시 탭 받기 등급', () => {
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
    await closeTestPool();
  });

  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    await owner.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [org.id]);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'wt', localPart: `wt-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { orgId: org.id, session, agentId: agent.id, address: agent.address };
  }

  async function asRole(f: Fixture, role: 'admin' | 'member'): Promise<Session> {
    const email = `wt-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, f.orgId, role]);
    return login(deps, mailer, { id: f.orgId, ownerEmail: email });
  }

  async function receive(f: Fixture, scan: () => InjectionScanResult, from = `sender-${suffix()}@partner.example`): Promise<string> {
    const sesMessageId = newSesMessageId();
    const outcome = await deliver(
      { ...consumerDeps(testPool(), newObjectStore()), scanner: scan },
      eml({ from, subject: SUBJECT_SENTINEL, text: BODY_SENTINEL }),
      { sesMessageId, recipients: [f.address], commonFrom: [from], dmarc: 'PASS' },
    );
    expect(outcome).toBe('stored');
    const row = await owner.query<{ id: string }>('SELECT id FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [f.agentId, sesMessageId]);
    const id = row.rows[0]?.id;
    if (id === undefined) throw new Error('행이 없다');
    return id;
  }

  const audit = async (orgId: string): Promise<{ action: string; target_id: string | null }[]> =>
    (
      await owner.query<{ action: string; target_id: string | null }>(
        `SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action LIKE 'watch.%' ORDER BY created_at, id`,
        [orgId],
      )
    ).rows;

  it('① 조직 설정 — 신뢰 발신자 읽기 · 통째로 바꾸기 · 감사 · 검증 · 소유자만', async () => {
    const f = await fixture();
    const get = await call(deps, 'GET', '/api/watch/settings', authed(f.session));
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json()).toEqual({
      trustedSenders: [],
      maxTrustedSenders: 200,
      updatedAt: null,
      agentSelfEnroll: false,
      enrollDailyCap: 5,
      maxEnrollDailyCap: 20,
      notifyOnEnroll: true,
      notifyOnSignup: true,
    });

    const patch = (session: Session, body: unknown) => call(deps, 'PATCH', '/api/watch/settings', authed(session, { body }));
    const saved = await patch(f.session, { trustedSenders: [' Partner.Example ', 'boss@corp.example', 'partner.example'] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      changed: true,
      added: 2,
      removed: 0,
      trustedSenders: [
        { kind: 'address', value: 'boss@corp.example' },
        { kind: 'domain', value: 'partner.example' },
      ],
    });
    expect((saved.json() as { updatedAt: string | null }).updatedAt).not.toBeNull();
    expect((await patch(f.session, { trustedSenders: ['partner.example', 'boss@corp.example'] })).json()).toMatchObject({ changed: false });
    expect((await patch(f.session, { trustedSenders: ['partner.example'] })).json()).toMatchObject({ changed: true, added: 0, removed: 1 });
    expect(await audit(f.orgId)).toEqual([
      { action: 'watch.trusted_senders.set', target_id: f.orgId },
      { action: 'watch.trusted_senders.set', target_id: f.orgId },
    ]);

    for (const bad of [['*.partner.example'], ['not a domain'], ['@partner.example'], [42], 'partner.example']) {
      const rejected = await patch(f.session, { trustedSenders: bad });
      expect(rejected.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(f.session, { trustedSenders: Array.from({ length: 201 }, (_, i) => `d${String(i)}.example`) })).json()).toMatchObject({
      error: 'too_many_trusted_senders',
    });
    expect((await patch(f.session, { trustedSenders: [], extra: 1 })).statusCode).toBe(400);

    const asAdmin = await asRole(f, 'admin');
    const denied = await patch(asAdmin, { trustedSenders: [] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden_role', required: 'owner' });
    const asMember = await asRole(f, 'member');
    expect((await call(deps, 'GET', '/api/watch/settings', authed(asMember))).statusCode).toBe(200);
  });

  it('② 에이전트 설정 — 기본값 · 바꾸기 · 검증 · 다른 조직 404 · 멤버 403', async () => {
    const f = await fixture();
    const path = `/api/agents/${f.agentId}/watch`;
    expect((await call(deps, 'GET', path, authed(f.session))).json()).toEqual({ agentId: f.agentId, riskHandling: 'deliver', riskNotify: true, sendApproval: 'auto', updatedAt: null });
    const changed = await call(deps, 'PATCH', path, authed(f.session, { body: { riskHandling: 'hold' } }));
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ agentId: f.agentId, riskHandling: 'hold', riskNotify: true, changed: true });
    expect((await call(deps, 'PATCH', path, authed(f.session, { body: { riskHandling: 'hold' } }))).json()).toMatchObject({ changed: false });
    expect((await call(deps, 'PATCH', path, authed(f.session, { body: { riskNotify: false } }))).json()).toMatchObject({ riskHandling: 'hold', riskNotify: false, changed: true });
    expect((await call(deps, 'GET', path, authed(f.session))).json()).toMatchObject({ riskHandling: 'hold', riskNotify: false });
    expect(await audit(f.orgId)).toEqual([
      { action: 'watch.agent.set', target_id: f.agentId },
      { action: 'watch.agent.set', target_id: f.agentId },
    ]);

    for (const body of [{}, { riskHandling: 'drop' }, { riskNotify: 'yes' }, { riskHandling: 'hold', sendApproval: 'sometimes' }, { other: 1 }]) {
      expect((await call(deps, 'PATCH', path, authed(f.session, { body }))).statusCode, JSON.stringify(body)).toBe(400);
    }
    const other = await fixture();
    expect((await call(deps, 'GET', `/api/agents/${other.agentId}/watch`, authed(f.session))).statusCode).toBe(404);
    expect((await call(deps, 'PATCH', `/api/agents/${other.agentId}/watch`, authed(f.session, { body: { riskHandling: 'hold' } }))).statusCode).toBe(404);
    const asMember = await asRole(f, 'member');
    expect((await call(deps, 'GET', path, authed(asMember))).statusCode).toBe(200);
    expect((await call(deps, 'PATCH', path, authed(asMember, { body: { riskHandling: 'deliver' } }))).statusCode).toBe(403);
    // 풀기(hold → deliver)는 소유자만 — 관리자는 403 · 값 그대로. 조이기(deliver → hold)는 관리자도 된다. DB 함수도 owner 멤버십이 아니면 거부(42501).
    const asAdmin = await asRole(f, 'admin');
    const loosen = await call(deps, 'PATCH', path, authed(asAdmin, { body: { riskHandling: 'deliver' } }));
    expect(loosen.statusCode).toBe(403);
    expect((await call(deps, 'GET', path, authed(f.session))).json()).toMatchObject({ riskHandling: 'hold' });
    const adminUser = await owner.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE organization_id = $1 AND role = 'admin'`, [f.orgId]);
    await expect(
      admin.query('SELECT outcome FROM atmark_watch_set_agent($1, $2, $3, NULL, $4)', [f.orgId, f.agentId, 'deliver', adminUser.rows[0]?.user_id]),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await call(deps, 'PATCH', path, authed(f.session, { body: { riskHandling: 'deliver' } }))).json()).toMatchObject({ changed: true });
    expect((await call(deps, 'PATCH', path, authed(asAdmin, { body: { riskHandling: 'hold' } }))).json()).toMatchObject({ changed: true });
  });

  it('⑥ 발신 승인 — auto ↔ always 는 정책 새 버전 · 행과 스냅샷 · 감사 watch.send_approval.set · 같은 값은 버전 없음', async () => {
    const f = await fixture();
    const path = `/api/agents/${f.agentId}/watch`;
    const version = async (): Promise<{ v: number; row: boolean; snap: unknown; by: string | null }> => {
      const r = await owner.query<{ v: number; row: boolean; snap: unknown; by: string | null }>(
        `SELECT p.current_version AS v, p.require_approval AS row, pv.snapshot -> 'require_approval' AS snap, pv.created_by AS by
           FROM agent_policies p JOIN policy_versions pv ON pv.agent_id = p.agent_id AND pv.version = p.current_version WHERE p.agent_id = $1`,
        [f.agentId],
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error('정책 행이 없다');
      return row;
    };
    const before = await version();
    expect(before).toMatchObject({ row: false, snap: null });

    const on = await call(deps, 'PATCH', path, authed(f.session, { body: { sendApproval: 'always' } }));
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ sendApproval: 'always', changed: true, sendApprovalChanged: true });
    expect(await version()).toMatchObject({ v: before.v + 1, row: true, snap: true });
    expect((await call(deps, 'GET', path, authed(f.session))).json()).toMatchObject({ sendApproval: 'always' });

    // 같은 값 — 버전을 올리지 않는다 · 감사 없음.
    expect((await call(deps, 'PATCH', path, authed(f.session, { body: { sendApproval: 'always' } }))).json()).toMatchObject({ changed: false, sendApprovalChanged: false });
    expect((await version()).v).toBe(before.v + 1);

    // 함께 바꾸기 — 위험 처리와 발신 승인을 한 번에(한 트랜잭션 · 감사 한 행).
    const both = await call(deps, 'PATCH', path, authed(f.session, { body: { sendApproval: 'auto', riskHandling: 'hold' } }));
    expect(both.json()).toMatchObject({ sendApproval: 'auto', riskHandling: 'hold', changed: true, sendApprovalChanged: true });
    expect(await version()).toMatchObject({ v: before.v + 2, row: false, snap: null });
    expect(await audit(f.orgId)).toEqual([
      { action: 'watch.send_approval.set', target_id: f.agentId },
      { action: 'watch.send_approval.set', target_id: f.agentId },
    ]);
    // 정책 화면(PATCH /api/agents/{id}/policy)의 변경이 발신 승인을 지우지 않는다.
    await call(deps, 'PATCH', path, authed(f.session, { body: { sendApproval: 'always' } }));
    const mode = await call(deps, 'PATCH', `/api/agents/${f.agentId}/policy`, authed(f.session, { body: { outbound: { mode: 'all' } } }));
    expect(mode.statusCode, mode.body).toBe(200);
    expect(await version()).toMatchObject({ row: true, snap: true });

    const asMember = await asRole(f, 'member');
    expect((await call(deps, 'PATCH', path, authed(asMember, { body: { sendApproval: 'auto' } }))).statusCode).toBe(403);
    // 관리자 — always → auto(풀기)는 403, auto → always(조이기)는 된다.
    const asAdmin = await asRole(f, 'admin');
    expect((await call(deps, 'PATCH', path, authed(asAdmin, { body: { sendApproval: 'auto' } }))).statusCode).toBe(403);
    expect(await version()).toMatchObject({ row: true, snap: true });
    await call(deps, 'PATCH', path, authed(f.session, { body: { sendApproval: 'auto' } }));
    expect((await call(deps, 'PATCH', path, authed(asAdmin, { body: { sendApproval: 'always' } }))).json()).toMatchObject({ sendApproval: 'always', changed: true });
  });

  it('③ ④ 보류 목록 · 풀기', async () => {
    const f = await fixture();
    await call(deps, 'PATCH', `/api/agents/${f.agentId}/watch`, authed(f.session, { body: { riskHandling: 'hold' } }));
    const blocked = await receive(f, scanner('high', [['override', false], ['exfiltration', false]]), 'mallory@evil.example');
    const riskHeld = await receive(f, scanner('low', [['narrative', false], ['ai_addressee', false]]));
    const unscanned = await receive(f, () => {
      throw new Error('scanner down');
    });
    const visible = await receive(f, scanner('none', []));

    const list = await call(deps, 'GET', '/api/watch/held', authed(f.session));
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json() as { items: { id: string; level: string; reason: string; families: string[]; releasable: boolean; senderDomain: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.id).sort()).toEqual([blocked, riskHeld, unscanned].sort());
    expect(body.nextCursor).toBeNull();
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(blocked)).toMatchObject({ level: 'block', reason: 'injection_risk', families: ['exfiltration', 'override'], releasable: true, senderDomain: 'evil.example' });
    expect(byId.get(riskHeld)).toMatchObject({ level: 'risk', reason: 'risk_hold', families: ['narrative'], releasable: true });
    expect(byId.get(unscanned)).toMatchObject({ level: 'block', reason: 'scanner_error', releasable: false });
    expect(list.body).not.toContain(SUBJECT_SENTINEL);
    expect(list.body).not.toContain(BODY_SENTINEL);
    expect(list.body).not.toContain('mallory');

    // 쪽 나누기 · 에이전트 거르기 · 잘못된 쿼리.
    const first = (await call(deps, 'GET', '/api/watch/held', authed(f.session, { query: 'limit=2' }))).json() as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await call(deps, 'GET', '/api/watch/held', authed(f.session, { query: `limit=2&cursor=${first.nextCursor ?? ''}` }))).json() as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect([...first.items, ...second.items].map((i) => i.id).sort()).toEqual([blocked, riskHeld, unscanned].sort());
    expect(second.nextCursor).toBeNull();
    const other = await fixture();
    expect(((await call(deps, 'GET', '/api/watch/held', authed(f.session, { query: `agentId=${other.agentId}` }))).json() as { items: unknown[] }).items).toEqual([]);
    for (const query of ['limit=0', 'limit=101', 'cursor=xyz', 'agentId=nope']) {
      expect((await call(deps, 'GET', '/api/watch/held', authed(f.session, { query }))).statusCode, query).toBe(400);
    }

    // 풀기.
    const release = (session: Session, id: string) => call(deps, 'POST', `/api/watch/held/${id}/release`, authed(session, { body: {} }));
    const asMember = await asRole(f, 'member');
    expect((await release(asMember, blocked)).statusCode).toBe(403);
    const released = await release(f.session, blocked);
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json()).toMatchObject({ id: blocked, agentId: f.agentId, releasedFrom: 'injection_risk', level: 'block', replayed: false });
    expect((await release(f.session, blocked)).json()).toMatchObject({ replayed: true });
    const asAdmin = await asRole(f, 'admin');
    expect((await release(asAdmin, riskHeld)).json()).toMatchObject({ releasedFrom: 'risk_hold', level: 'risk', replayed: false });
    expect(await audit(f.orgId)).toEqual([
      { action: 'watch.agent.set', target_id: f.agentId },
      { action: 'watch.release', target_id: blocked },
      { action: 'watch.release', target_id: riskHeld },
    ]);
    const releasedRow = await owner.query<{ released_by: string | null; quarantined: boolean }>('SELECT released_by, quarantined FROM inbound_messages WHERE id = $1', [blocked]);
    expect(releasedRow.rows[0]).toMatchObject({ quarantined: false, released_by: await userIdOf(owner, (await owner.query<{ e: string }>('SELECT owner_email AS e FROM organizations WHERE id = $1', [f.orgId])).rows[0]?.e ?? '') });

    expect((await release(f.session, unscanned)).json()).toMatchObject({ error: 'release_not_scanned' });
    expect((await release(f.session, visible)).json()).toMatchObject({ error: 'message_not_held' });
    expect((await release(f.session, randomUUID())).statusCode).toBe(404);
    expect((await release(f.session, 'not-a-uuid')).statusCode).toBe(400);
    const strangers = await receive(other, scanner('high', [['override', false]]));
    expect((await release(f.session, strangers)).json()).toMatchObject({ error: 'message_not_found' });

    await changePolicyOp(owner, f.agentId as AgentId, resolvePolicyChange({ inboundMode: 'none' }), 'test:admin-watch');
    const policyBlocked = await receive(f, scanner('none', []));
    expect((await release(f.session, policyBlocked)).json()).toMatchObject({ error: 'release_policy_blocked' });

    const after = (await call(deps, 'GET', '/api/watch/held', authed(f.session))).json() as { items: { id: string }[] };
    expect(after.items.map((i) => i.id)).toEqual([unscanned]);
  });

  it('⑤ admin 롤은 설정 표 · inbound_messages 를 직접 쓰지 못한다', async () => {
    const f = await fixture();
    await expect(admin.query(`INSERT INTO agent_watch_settings (agent_id, risk_handling) VALUES ($1, 'hold')`, [f.agentId])).rejects.toThrow(/permission denied/);
    await expect(admin.query(`INSERT INTO org_trusted_senders (organization_id, kind, value) VALUES ($1, 'domain', 'evil.example')`, [f.orgId])).rejects.toThrow(
      /permission denied/,
    );
    await expect(admin.query(`UPDATE inbound_messages SET quarantined = false WHERE agent_id = $1`, [f.agentId])).rejects.toThrow(/permission denied/);
    await expect(admin.query(`INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at) VALUES ($1, $1, 'message.received', 'x', '{}', now())`, [randomUUID()])).rejects.toThrow(
      /permission denied/,
    );
  });
});
