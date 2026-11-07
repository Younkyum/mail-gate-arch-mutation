/**
 * 고객 도메인 API(ADR-0014 단계 4 M3b) — 콘솔 `/api/domains*` · 조직 API `/org-api/v1/domains*`(`domains:manage`). 라우터는 `atmark_admin` 롤 풀.
 *
 *   ① 역할: member 는 목록 · 한 개만(추가 · 지금 확인 · 제거 403 `forbidden_role`).
 *   ② 기능 꺼짐: 추가 · 지금 확인 403 `feature_not_enabled` · 목록 · 한 개 · 제거는 열림.
 *   ③ 이름: apex · IDN · 공용 메일 · atmark.ai · 길이 → 400(판정 사유 코드) · 같은 조직의 같은 도메인 409.
 *   ④ 한도: 요금제(pending 포함) 409 `plan_custom_domains_exceeded` · pending 셋째 409 `custom_domains_pending_exceeded`.
 *   ⑤ 다른 조직 id = 없는 id(같은 상태 · 같은 몸통).
 *   ⑥ 지금 확인: 202 · 같은 도메인 60초 429 · 조직 시간당 20 429 `domain_check_rate_limited` · 감사 `domain.check`.
 *   ⑦ 제거: 주소를 남긴다(기본) · `releaseAddresses` 면 폐기 · 대표로 쓰던 에이전트 수 · 재생 · 감사 `domain.remove` 한 번.
 *   ⑧ 조직 API: `domains:manage` 없으면 403 · 있으면 같은 연산 · 키 행위자 감사.
 *   ⑨ 레코드(2026-10 one-shot 순서): 소유 증명 TXT(서브도메인 이름) · 수신 MX · MAIL FROM · DKIM(토큰이 행에 있으면 — `recordsReady`) · DMARC(권장) · 72시간 만료.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { MANUAL_CHECKS_PER_ORG_PER_HOUR, PENDING_EXPIRY_MS } from '../../../src/domains/contract';
import { enableCustomDomains } from '../policy/support';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

const newRegistrable = (): string => `cd${suffix()}${suffix()}.com`;

interface DomainItem {
  id: string;
  domain: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  records?: { purpose: string; type: string; name: string; value: string }[];
}

describe.skipIf(!AVAILABLE)('고객 도메인 API — atmark_admin 롤', { timeout: 180_000 }, () => {
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
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  async function org(plan: 'beta' | 'team' | 'scale' = 'team', enabled = true): Promise<{ id: string; session: Session }> {
    const organization = await newOrganization(owner, plan);
    if (enabled) await enableCustomDomains(organization.id);
    return { id: organization.id, session: await login(deps, mailer, organization) };
  }

  async function roleSession(organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `dom-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  const add = (session: Session, domain: string) => call(deps, 'POST', '/api/domains', authed(session, { body: { domain } }));
  const errorOf = (result: { json: () => unknown }): string => (result.json() as { error: string }).error;

  async function added(session: Session, domain = `agents.${newRegistrable()}`): Promise<DomainItem> {
    const result = await add(session, domain);
    expect(result.statusCode, result.body).toBe(201);
    return (result.json() as { item: DomainItem }).item;
  }

  async function audits(organizationId: string): Promise<string[]> {
    const rows = await owner.query<{ action: string }>(
      `SELECT action FROM owner_actions WHERE organization_id = $1 AND action LIKE 'domain.%' ORDER BY created_at, id`,
      [organizationId],
    );
    return rows.rows.map((row) => row.action);
  }

  it('① member 는 목록 · 한 개만 — 추가 · 지금 확인 · 제거는 403 forbidden_role(대상을 보기 전에)', async () => {
    const a = await org();
    const item = await added(a.session);
    const member = await roleSession(a.id, 'member');
    expect((await call(deps, 'GET', '/api/domains', authed(member))).statusCode).toBe(200);
    expect((await call(deps, 'GET', `/api/domains/${item.id}`, authed(member))).statusCode).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/api/domains', { domain: `agents.${newRegistrable()}` }],
      ['POST', `/api/domains/${item.id}/check`, {}],
      ['DELETE', `/api/domains/${item.id}`, {}],
    ] as const) {
      const denied = await call(deps, method, path, authed(member, { body }));
      expect([denied.statusCode, errorOf(denied)], `${method} ${path}`).toEqual([403, 'forbidden_role']);
    }
    const adminSession = await roleSession(a.id, 'admin');
    expect((await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(adminSession, { body: {} }))).statusCode).toBe(202);
  });

  it('② 기능 꺼짐: 추가 · 지금 확인 403 feature_not_enabled · 목록은 enabled:false · DB 가드(P0A07)도 같은 코드', async () => {
    const off = await org('team', false);
    const list = await call(deps, 'GET', '/api/domains', authed(off.session));
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ enabled: false, limit: 3, pendingMax: 2, live: 0, items: [] });
    const denied = await add(off.session, `agents.${newRegistrable()}`);
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, 'feature_not_enabled']);
    // 허용 목록에서 빠진 조직도 이미 만든 도메인은 보고 지운다.
    const was = await org('team');
    const item = await added(was.session);
    await owner.query(`DELETE FROM org_features WHERE organization_id = $1`, [was.id]);
    const check = await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(was.session, { body: {} }));
    expect([check.statusCode, errorOf(check)]).toEqual([403, 'feature_not_enabled']);
    expect((await call(deps, 'GET', `/api/domains/${item.id}`, authed(was.session))).statusCode).toBe(200);
    // 콘솔 메뉴(`GET /api/plan` features.customDomains — M4): 허용 목록 · 남은 도메인이 있으면 보이고, 둘 다 없으면 숨는다. 멤버도 읽는다.
    const menu = async (session: Session): Promise<unknown> =>
      ((await call(deps, 'GET', '/api/plan', authed(session))).json() as { features: { customDomains: unknown } }).features.customDomains;
    expect(await menu(off.session)).toBe(false);
    expect(await menu(was.session)).toBe(true);
    expect(await menu(await roleSession(was.id, 'member'))).toBe(true);
    expect((await call(deps, 'DELETE', `/api/domains/${item.id}`, authed(was.session, { body: {} }))).statusCode).toBe(200);
    expect(await menu(was.session)).toBe(false);
    await enableCustomDomains(was.id);
    expect(await menu(was.session)).toBe(true);
  });

  it('③ 이름 거부는 판정 사유 코드(400) — apex · IDN · 공용 메일 · atmark.ai · 길이 · 모양 · 같은 조직의 같은 도메인 409', async () => {
    const a = await org();
    const cases: [string, string][] = [
      [newRegistrable(), 'registrable_apex'],
      [`xn--bcher-kva.${newRegistrable()}`, 'idn_label'],
      ['agents.gmail.com', 'shared_mailbox_domain'],
      ['agents.atmark.ai', 'platform_domain'],
      [`${'a'.repeat(60)}.${'b'.repeat(40)}.${newRegistrable()}`, 'too_long'],
      ['agents..example.com', 'invalid_label'],
    ];
    for (const [domain, code] of cases) {
      const denied = await add(a.session, domain);
      expect([denied.statusCode, errorOf(denied)], domain).toEqual([400, code]);
    }
    const domain = `agents.${newRegistrable()}`;
    await added(a.session, domain);
    const again = await add(a.session, domain.toUpperCase());
    expect([again.statusCode, errorOf(again)]).toEqual([409, 'domain_exists']);
    expect(await audits(a.id)).toEqual(['domain.add']);
  });

  it('④ 한도 — 요금제(pending 포함) 409 plan_custom_domains_exceeded · pending 셋째 409 custom_domains_pending_exceeded', async () => {
    const beta = await org('beta');
    await added(beta.session);
    const over = await add(beta.session, `agents.${newRegistrable()}`);
    expect([over.statusCode, errorOf(over)]).toEqual([409, 'plan_custom_domains_exceeded']);

    const team = await org('team');
    await added(team.session);
    await added(team.session);
    const third = await add(team.session, `agents.${newRegistrable()}`);
    expect([third.statusCode, errorOf(third)]).toEqual([409, 'custom_domains_pending_exceeded']);
    const view = (await call(deps, 'GET', '/api/domains', authed(team.session))).json() as { live: number; limit: number };
    expect(view).toMatchObject({ live: 2, limit: 3 });
  });

  it('⑤ 다른 조직의 id 는 없는 id 와 같다 — 한 개 · 지금 확인 · 제거(같은 상태 · 같은 몸통)', async () => {
    const a = await org();
    const theirs = await added(a.session);
    const b = await org();
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const [method, suffixPath] of [
      ['GET', ''],
      ['POST', '/check'],
      ['DELETE', ''],
    ] as const) {
      const foreign = await call(deps, method, `/api/domains/${theirs.id}${suffixPath}`, authed(b.session, { body: method === 'GET' ? undefined : {} }));
      const none = await call(deps, method, `/api/domains/${missing}${suffixPath}`, authed(b.session, { body: method === 'GET' ? undefined : {} }));
      expect([foreign.statusCode, foreign.json()], `${method} ${suffixPath}`).toEqual([none.statusCode, none.json()]);
      expect(foreign.statusCode).toBe(404);
    }
    // 모양 아닌 id 도 같은 404.
    const garbage = await call(deps, 'GET', '/api/domains/not-a-uuid', authed(b.session));
    expect([garbage.statusCode, errorOf(garbage)]).toEqual([404, 'domain_not_found']);
    // 기능이 꺼진 조직에서는 남의 id 도 없는 id 도 같은 403(지금 확인).
    const off = await org('team', false);
    const offForeign = await call(deps, 'POST', `/api/domains/${theirs.id}/check`, authed(off.session, { body: {} }));
    const offNone = await call(deps, 'POST', `/api/domains/${missing}/check`, authed(off.session, { body: {} }));
    expect([offForeign.statusCode, offForeign.json()]).toEqual([offNone.statusCode, offNone.json()]);
    expect((await owner.query(`SELECT status FROM custom_domains WHERE id = $1`, [theirs.id])).rows[0]).toEqual({ status: 'pending' });
  });

  it('⑥ 지금 확인 — 202 · 60초에 한 번 429 · 조직 시간당 20번 429 domain_check_rate_limited · 감사 domain.check', async () => {
    const a = await org();
    const item = await added(a.session);
    const first = await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(a.session, { body: {} }));
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ id: item.id });
    const soon = await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(a.session, { body: {} }));
    expect([soon.statusCode, errorOf(soon)]).toEqual([429, 'domain_check_rate_limited']);
    for (let i = 1; i < MANUAL_CHECKS_PER_ORG_PER_HOUR; i += 1) {
      await owner.query(`UPDATE custom_domains SET last_manual_check_at = now() - interval '2 minutes' WHERE id = $1`, [item.id]);
      const again = await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(a.session, { body: {} }));
      expect(again.statusCode, `check ${String(i + 1)}`).toBe(202);
    }
    await owner.query(`UPDATE custom_domains SET last_manual_check_at = now() - interval '2 minutes' WHERE id = $1`, [item.id]);
    const hourly = await call(deps, 'POST', `/api/domains/${item.id}/check`, authed(a.session, { body: {} }));
    expect([hourly.statusCode, errorOf(hourly)]).toEqual([429, 'domain_check_rate_limited']);
    expect((await audits(a.id)).filter((action) => action === 'domain.check')).toHaveLength(MANUAL_CHECKS_PER_ORG_PER_HOUR);
  });

  it('⑦ 제거 — 기본은 주소를 남긴다 · releaseAddresses 는 폐기 · 대표로 쓰던 에이전트 수 · 재생은 감사 없음', async () => {
    const a = await org('scale');
    // 도메인 둘을 verified 로(소유자 롤 — 틱 대신).
    const keep = await added(a.session);
    const release = await added(a.session);
    for (const id of [keep.id, release.id]) {
      await owner.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
      await owner.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
    }
    // 에이전트 둘 — 하나는 keep 도메인을 대표로, 하나는 release 도메인에 별칭만.
    const primaryAgent = await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'on-keep', localPart: `k-${suffix()}`, domain: keep.domain } }));
    expect(primaryAgent.statusCode, primaryAgent.body).toBe(201);
    const plain = await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'plain', localPart: `p-${suffix()}` } }));
    const plainId = (plain.json() as { agent: { id: string } }).agent.id;
    const alias = await call(deps, 'POST', `/api/agents/${plainId}/aliases`, authed(a.session, { body: { localPart: `r-${suffix()}`, domain: release.domain } }));
    expect(alias.statusCode, alias.body).toBe(201);

    const removedKeep = await call(deps, 'DELETE', `/api/domains/${keep.id}`, authed(a.session));
    expect(removedKeep.statusCode, removedKeep.body).toBe(200);
    expect(removedKeep.json()).toMatchObject({ replayed: false, primaryAgents: 1, releasedAddresses: 0, item: { status: 'removed' } });
    const kept = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_addresses WHERE domain = $1 AND retired_at IS NULL`, [keep.domain]);
    expect(kept.rows[0]?.n).toBe(1);
    // 대표 주소를 잃은 에이전트는 "주소 없음"(자동으로 @atmark.ai 로 옮기지 않는다).
    const agentId = (primaryAgent.json() as { agent: { id: string } }).agent.id;
    expect(((await call(deps, 'GET', `/api/agents/${agentId}`, authed(a.session))).json() as { address: string | null }).address).toBeNull();

    const removedRelease = await call(deps, 'DELETE', `/api/domains/${release.id}`, authed(a.session, { body: { releaseAddresses: true } }));
    expect(removedRelease.json()).toMatchObject({ replayed: false, primaryAgents: 0, releasedAddresses: 1 });
    const released = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_addresses WHERE domain = $1 AND retired_at IS NULL`, [release.domain]);
    expect(released.rows[0]?.n).toBe(0);

    const replay = await call(deps, 'DELETE', `/api/domains/${keep.id}`, authed(a.session));
    expect(replay.json()).toMatchObject({ replayed: true });
    expect((await audits(a.id)).filter((action) => action === 'domain.remove')).toHaveLength(2);
    const badBody = await call(deps, 'DELETE', `/api/domains/${keep.id}`, authed(a.session, { body: { releaseAddresses: 'yes' } }));
    expect([badBody.statusCode, errorOf(badBody)]).toEqual([400, 'invalid_body']);
  });

  it('⑧ 조직 API — domains:manage 가 없으면 403 · 있으면 같은 연산(키 행위자 감사) · 다른 조직 id 는 404', async () => {
    const a = await org('scale');
    const issue = async (capabilities: string[]): Promise<string> => {
      const issued = await call(deps, 'POST', '/api/org-keys', authed(a.session, { body: { label: `k-${suffix()}`, capabilities } }));
      expect(issued.statusCode, issued.body).toBe(201);
      return (issued.json() as { key: string }).key;
    };
    const agentsOnly = await issue(['agents:read', 'agents:create']);
    const domains = await issue(['domains:manage']);
    const api = (key: string, method: string, path: string, body?: unknown) =>
      call(deps, method, `/org-api/v1${path}`, { headers: { authorization: `Bearer ${key}` }, ...(body === undefined ? {} : { body }) });

    const forbidden = await api(agentsOnly, 'GET', '/domains');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: 'forbidden_capability', required: 'domains:manage' });

    const created = await api(domains, 'POST', '/domains', { domain: `agents.${newRegistrable()}` });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { item: DomainItem }).item.id;
    expect((await api(domains, 'GET', '/domains')).json()).toMatchObject({ enabled: true, live: 1 });
    expect((await api(domains, 'GET', `/domains/${id}`)).statusCode).toBe(200);
    expect((await api(domains, 'POST', `/domains/${id}/check`, {})).statusCode).toBe(202);
    const limited = await api(domains, 'POST', `/domains/${id}/check`, {});
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'domain_check_rate_limited']);
    expect((await api(domains, 'DELETE', `/domains/${id}`)).json()).toMatchObject({ replayed: false, item: { status: 'removed' } });
    const keyAudit = await owner.query<{ action: string }>(
      `SELECT action FROM owner_actions WHERE organization_id = $1 AND org_api_key_id IS NOT NULL ORDER BY created_at, id`,
      [a.id],
    );
    expect(keyAudit.rows.map((row) => row.action)).toEqual(['domain.add', 'domain.check', 'domain.remove']);

    const b = await org('team');
    const theirs = await added(b.session);
    const foreign = await api(domains, 'GET', `/domains/${theirs.id}`);
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, 'domain_not_found']);
    // DB CHECK(202610021200 · 1201) — 권한 셋의 상위 집합 · 검증됨.
    const check = await owner.query<{ def: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint WHERE conname = 'org_api_keys_capabilities_check'`,
    );
    expect(check.rows[0]?.validated).toBe(true);
    expect(check.rows[0]?.def).toMatch(/'agents:read'.*'agents:create'.*'domains:manage'/);
  });

  it('⑨ 한 개 보기 — 레코드(소유 TXT 서브도메인 · 수신 MX · MAIL FROM MX·SPF · DKIM 은 토큰이 행에 있으면) · 72시간 만료 · 토큰은 레코드 값으로만', async () => {
    const a = await org();
    const item = await added(a.session);
    const detail = (await call(deps, 'GET', `/api/domains/${item.id}`, authed(a.session))).json() as { item: DomainItem & { primaryAgents: number; recordsReady: boolean } };
    expect(detail.item.records?.map((record) => record.purpose)).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dmarc']);
    expect(detail.item.recordsReady).toBe(false);
    expect(detail.item.records?.[0]?.name).toBe(`_atmark-challenge.${item.domain}`);
    expect(Date.parse(detail.item.expiresAt ?? '') - Date.parse(detail.item.createdAt)).toBe(PENDING_EXPIRY_MS);
    expect(JSON.stringify(detail)).not.toContain('challengeToken');
    await owner.query(`UPDATE custom_domains SET dkim_tokens = ARRAY['aaa', 'bbb', 'ccc'] WHERE id = $1`, [item.id]);
    const withDkim = (await call(deps, 'GET', `/api/domains/${item.id}`, authed(a.session))).json() as { item: DomainItem };
    expect(withDkim.item.records?.filter((record) => record.purpose === 'dkim').map((record) => record.name)).toEqual([
      `aaa._domainkey.${item.domain}`,
      `bbb._domainkey.${item.domain}`,
      `ccc._domainkey.${item.domain}`,
    ]);
    expect((withDkim.item as DomainItem & { recordsReady?: boolean }).recordsReady).toBe(true);
  });
  it('⑩ #15 L3 — 조직 24시간 도메인 추가 10번 · 11번째 429 domain_add_rate_limited(추가 · 제거를 되풀이해도)', async () => {
    const a = await org('scale');
    for (let i = 0; i < 10; i += 1) {
      const item = await added(a.session);
      expect((await call(deps, 'DELETE', `/api/domains/${item.id}`, authed(a.session))).statusCode).toBe(200);
    }
    const limited = await add(a.session, `agents.${newRegistrable()}`);
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'domain_add_rate_limited']);
    expect((await audits(a.id)).filter((action) => action === 'domain.add')).toHaveLength(10);
  });
});
