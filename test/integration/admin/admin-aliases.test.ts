/**
 * **메일 기본기 2차 A6 — 별칭 주소**(계획 §4 A6 · ADR-0013 2차 · 마이그레이션 202609270110·0115). 라우터는 `atmark_admin` 롤 풀로 돈다.
 *
 *   AC-A6-1 한도 — Free 첫 추가 409 `alias_plan_limit` · Beta 4번째 409 `alias_plan_limit` · 누적 21번째 409 `alias_issued_limit` ·
 *           조직 하루 21번째 409 `alias_org_daily_limit`(세 코드가 다르다) · DB 천장 트리거가 직접 INSERT 도 막는다.
 *   AC-A6-2 폐기 효력 — 수신 라우팅에서 빠지고 · 정책 로더의 발신 주소에서 빠지고 · 목록에 `retired` · 대표 폐기 400 · 재폐기 replayed ·
 *           DB 가드(쓰기 1회 · 대표 불가 · 시각은 DB).
 *   재발급(ADR-0013 2026-09-29 개정 · 202609291000~1002) — 같은 조직은 곧바로(같은 에이전트 · 다른 에이전트) · 다른 조직은 보류 30일 동안 409
 *           `address_taken`(대표 주소로 가져가기도 409) · 보류가 지나면 된다 · 동시 발급은 하나만 이긴다 · 폐기와 발급은 주소 잠금으로 줄 선다 ·
 *           수신 라우팅은 활성 행 · 공개 조회 그대로 · 누적 발급은 폐기를 센다 · 거부 로그는 폐기 전 것만 예전 주인에게 보인다.
 *   AC-A6-3 공개 조회 — 별칭·폐기 주소는 404(대표만).
 *   AC-A6-4 잎 — 추가 1 → `identity.address_assigned`, 폐기 1 → `identity.address_retired` · 평문 `@` 0.
 *   AC-A6-5 강등 뒤 — 기존 별칭은 그대로 받고 추가는 409 · 요금제 화면 `overLimit` 에 `aliases`.
 *   AC-A6-6 스위치 꺼짐: 추가 404 · 목록·폐기는 된다(보안 리뷰 L-4 — 이미 만든 별칭을 끊는 안전 조치) · member 403(추가·폐기) · member 는 목록을 본다 · 다른 조직 404.
 *   단계 공개(`orgs:<uuid>,…`) — 목록의 조직만 추가가 열리고 목록 밖 조직의 추가는 꺼짐과 같은 404(목록·폐기는 자기 조직 것만 된다) ·
 *   `GET /api/plan` 의 `features.addressAliases` 가 조직별.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setOrgPlanOp } from '../../../scripts/admin/plan';
import type { AdminDependencies } from '../../../src/admin/context';
import { AGENT_CREATE_TAKEN_ACTION, ALIAS_REISSUE_HOLD_DAYS, MAX_ALIASES_ISSUED_PER_AGENT, MAX_ALIASES_PER_ORG_PER_DAY } from '../../../src/admin/ops/addresses';
import { ORG_API_AGENT_CREATES_PER_MINUTE } from '../../../src/admin/ops/org-keys';
import { planUsageOp } from '../../../src/admin/ops/plan';
import { createPool } from '../../../src/db/client';
import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import type { KeyCustody } from '../../../src/passport/custody';
import { drainOutboxFully } from '../../support/tlog-drain';
import { testKeyCustody } from '../../unit/identity/fixtures';
import { adminDeps, adminRolePool, APP_URL, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

interface AddressItem {
  id: string;
  address: string;
  primary: boolean;
  status: 'active' | 'retired';
  createdAt: string;
  retiredAt: string | null;
}

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe.skipIf(!AVAILABLE)('별칭 주소(A6) — atmark_admin 롤', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let deps: AdminDependencies;
  let off: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    tlog = createPool(roleUrl('atmark_tlog'), { max: 2 });
    deps = adminDeps(admin, { features: { addressAliases: true } });
    off = adminDeps(admin);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end(), tlog.end()]);
  });

  async function fixture(plan: 'free' | 'beta' | 'scale' | null = 'beta'): Promise<{ orgId: string; session: Session; agentId: string; address: string }> {
    const org = await newOrganization(owner, plan === 'free' ? null : plan);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'aliases', localPart: `al-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { orgId: org.id, session, agentId: agent.id, address: agent.address };
  }

  async function agentIn(session: Session): Promise<string> {
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'aliases-2', localPart: `al2-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { agent: { id: string } }).agent.id;
  }

  const add = (session: Session, agentId: string, localPart: string, d = deps) =>
    call(d, 'POST', `/api/agents/${agentId}/aliases`, authed(session, { body: { localPart } }));
  const retire = (session: Session, agentId: string, addressId: string, d = deps) =>
    call(d, 'POST', `/api/agents/${agentId}/aliases/${addressId}/retire`, authed(session, { body: {} }));
  const list = (session: Session, agentId: string, d = deps) => call(d, 'GET', `/api/agents/${agentId}/aliases`, authed(session));

  async function added(session: Session, agentId: string, localPart = `x-${suffix()}`): Promise<AddressItem> {
    const result = await add(session, agentId, localPart);
    expect(result.statusCode, result.body).toBe(201);
    return (result.json() as { item: AddressItem }).item;
  }

  async function roleSession(organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `alias-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  it('풀은 atmark_admin 이다 — 폐기 칸 GRANT 단언이 공허하지 않다', async () => {
    expect((await admin.query<{ user: string }>('SELECT current_user AS user')).rows[0]?.user).toBe('atmark_admin');
  });

  it('AC-A6-1 — Free 첫 추가 409 alias_plan_limit · Beta 4번째 409 alias_plan_limit', async () => {
    const free = await fixture('free');
    const denied = await add(free.session, free.agentId, `free-${suffix()}`);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: 'alias_plan_limit' });

    const beta = await fixture('beta');
    for (let i = 0; i < 3; i += 1) await added(beta.session, beta.agentId);
    const fourth = await add(beta.session, beta.agentId, `b4-${suffix()}`);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toMatchObject({ error: 'alias_plan_limit' });
    const view = (await list(beta.session, beta.agentId)).json() as { items: AddressItem[]; aliases: Record<string, unknown> };
    expect(view.aliases).toMatchObject({ active: 3, activeMax: 3, issued: 3, overLimit: false });
    expect(view.items[0]).toMatchObject({ address: beta.address, primary: true, status: 'active' });
  });

  it('AC-A6-1 — 누적 21번째 alias_issued_limit · 조직 하루 21번째 alias_org_daily_limit · DB 천장이 직접 INSERT 도 막는다', async () => {
    const f = await fixture('scale');
    const items: AddressItem[] = [];
    for (let i = 0; i < MAX_ALIASES_ISSUED_PER_AGENT; i += 1) items.push(await added(f.session, f.agentId));
    const r = await retire(f.session, f.agentId, items[0]?.id ?? '');
    expect(r.statusCode, r.body).toBe(200);
    const issued = await add(f.session, f.agentId, `i21-${suffix()}`);
    expect(issued.statusCode).toBe(409);
    expect(issued.json()).toMatchObject({ error: 'alias_issued_limit' });
    // 재발급(같은 조직 · 바로)도 새 발급이다 — 누적 발급은 폐기한 것을 센다(교체 남용 상한, ADR-0013 2026-09-29 개정).
    const again = await add(f.session, f.agentId, (items[0]?.address ?? '').split('@')[0] ?? '');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'alias_issued_limit' });

    const other = await agentIn(f.session);
    const daily = await add(f.session, other, `d21-${suffix()}`);
    expect(daily.statusCode).toBe(409);
    expect(daily.json()).toMatchObject({ error: 'alias_org_daily_limit' });
    expect(MAX_ALIASES_PER_ORG_PER_DAY).toBe(20);

    // 앱 검사를 건너뛴 직접 INSERT(소유자 롤)도 DB 천장이 막는다.
    await expect(
      owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [f.agentId, `raw-${suffix()}@atmark.ai`]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('AC-A6-2 · AC-A6-3 · AC-A6-4 — 폐기 효력 · 대표 400 · replayed · 공개 조회 404 · 잎 둘(평문 @ 0)', async () => {
    const f = await fixture('beta');
    const localPart = `ret-${suffix()}`;
    const alias = await added(f.session, f.agentId, localPart);
    const inbound = createPostgresInboundStore(app);
    expect((await inbound.findAgentsByAddresses([alias.address])).map((m) => m.agentId)).toEqual([f.agentId]);
    // 별칭은 비공개(D5) — 활성이어도 공개 조회는 대표만.
    const directory = createPostgresIdentityDirectory(app);
    expect(await directory.findByAddress(alias.address)).toBeNull();

    const retired = await retire(f.session, f.agentId, alias.id);
    expect(retired.statusCode, retired.body).toBe(200);
    const body = retired.json() as { item: AddressItem; replayed: boolean };
    expect(body).toMatchObject({ replayed: false, item: { status: 'retired' } });
    expect(body.item.retiredAt).not.toBeNull();

    expect(await inbound.findAgentsByAddresses([alias.address])).toEqual([]);
    const sending = await app.query<{ address: string }>('SELECT address FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL', [f.agentId]);
    expect(sending.rows.map((row) => row.address)).toEqual([f.address]);
    expect(await directory.findByAddress(alias.address)).toBeNull();

    const again = await retire(f.session, f.agentId, alias.id);
    expect(again.json()).toMatchObject({ replayed: true, item: { retiredAt: body.item.retiredAt } });

    const primary = ((await list(f.session, f.agentId)).json() as { items: AddressItem[] }).items.find((item) => item.primary);
    const primaryRetire = await retire(f.session, f.agentId, primary?.id ?? '');
    expect(primaryRetire.statusCode).toBe(400);
    expect(primaryRetire.json()).toMatchObject({ error: 'address_primary_not_retirable' });

    // DB 가드 — 되돌리기·대표 폐기는 모든 롤에서 거부.
    await expect(owner.query('UPDATE agent_addresses SET retired_at = NULL WHERE id = $1', [alias.id])).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query('UPDATE agent_addresses SET retired_at = now() WHERE id = $1', [primary?.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query('UPDATE agent_addresses SET address = $2 WHERE id = $1', [alias.id, `z-${suffix()}@atmark.ai`])).rejects.toMatchObject({ code: '42501' });

    // 감사 둘(대상 = 에이전트) · 잎 둘.
    const audit = await owner.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.alias.%' ORDER BY created_at, id",
      [f.orgId],
    );
    expect(audit.rows.map((row) => [row.action, row.target_id])).toEqual([
      ['agent.alias.add', f.agentId],
      ['agent.alias.retire', f.agentId],
    ]);
    await drainOutboxFully(tlog);
    const leaves = await owner.query<{ kind: string; event: string; rev: number; leaf_json: string }>(
      `SELECT kind, event, rev, leaf_json FROM tlog_leaves WHERE source_table = 'agent_addresses' AND source_id = $1 ORDER BY seq`,
      [alias.id],
    );
    expect(leaves.rows.map((row) => [row.kind, row.event, row.rev])).toEqual([
      ['identity.address_assigned', 'insert', 0],
      ['identity.address_retired', 'update', 1],
    ]);
    for (const row of leaves.rows) expect(row.leaf_json).not.toContain('@');
    const retiredLeaf = JSON.parse(leaves.rows[1]?.leaf_json ?? '{}') as { at: string; body: Record<string, unknown> };
    expect(retiredLeaf.body).toEqual({ agent_id: f.agentId });
    expect(Date.parse(`${retiredLeaf.at.slice(0, 23)}Z`)).toBe(Date.parse(body.item.retiredAt ?? ''));
  });

  it('보안 리뷰 L4 — 이미 쓰인 주소 시도(address_taken)도 조직 하루 발급 수에 센다 · 감사 agent.alias.taken', async () => {
    const f = await fixture('scale');
    const localPart = `tk-${suffix()}`;
    await added(f.session, f.agentId, localPart);
    const other = await agentIn(f.session);
    for (let i = 1; i < MAX_ALIASES_PER_ORG_PER_DAY; i += 1) {
      const taken = await add(f.session, other, localPart);
      expect(taken.statusCode, `시도 ${String(i)}`).toBe(409);
      expect(taken.json()).toMatchObject({ error: 'address_taken' });
    }
    // 성공 1 + 실패 19 = 20 — 새 주소도 이제 막힌다(주소 추측 탐색이 하루 상한을 넘지 못한다).
    const blocked = await add(f.session, other, `fresh-${suffix()}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'alias_org_daily_limit' });
    const audit = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'agent.alias.taken'",
      [f.orgId],
    );
    expect(audit.rows[0]?.n).toBe(MAX_ALIASES_PER_ORG_PER_DAY - 1);
  });

  it('AC-A6-5 — 강등 뒤 기존 별칭은 그대로 받고 추가는 409 · 요금제 화면 overLimit 에 aliases', async () => {
    const f = await fixture('beta');
    const kept = await added(f.session, f.agentId);
    await setOrgPlanOp(owner, { organizationId: f.orgId, plan: 'free', overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
    expect((await createPostgresInboundStore(app).findAgentsByAddresses([kept.address])).map((m) => m.agentId)).toEqual([f.agentId]);
    const denied = await add(f.session, f.agentId, `dn-${suffix()}`);
    expect(denied.json()).toMatchObject({ error: 'alias_plan_limit' });
    const view = (await list(f.session, f.agentId)).json() as { aliases: Record<string, unknown> };
    expect(view.aliases).toMatchObject({ active: 1, activeMax: 0, overLimit: true });
    const usage = await planUsageOp(admin, f.orgId, new Date());
    expect(usage.overLimit).toContain('aliases');
    expect(usage.limits.aliasesPerAgentMax).toBe(0);
  });

  it('AC-A6-6 — 스위치 꺼짐: 추가 404 · 목록·폐기 200(L-4) · member: 목록 200 · 추가/폐기 403 · 다른 조직 404', async () => {
    const f = await fixture('beta');
    const alias = await added(f.session, f.agentId);
    const spare = await added(f.session, f.agentId);
    const offAdd = await add(f.session, f.agentId, `off-${suffix()}`, off);
    expect(offAdd.statusCode).toBe(404);
    expect(offAdd.json()).toMatchObject({ error: 'not_found' });
    // 꺼져도 이미 만든 별칭은 받고 보낸다 — 보고 끊을 수 있어야 한다(L-4).
    const offList = await list(f.session, f.agentId, off);
    expect(offList.statusCode, offList.body).toBe(200);
    expect((offList.json() as { items: AddressItem[] }).items.map((item) => item.id)).toEqual(expect.arrayContaining([alias.id, spare.id]));
    const offRetire = await retire(f.session, f.agentId, spare.id, off);
    expect(offRetire.statusCode, offRetire.body).toBe(200);
    expect(offRetire.json()).toMatchObject({ item: { id: spare.id, status: 'retired' }, replayed: false });
    const member = await roleSession(f.orgId, 'member');
    expect((await list(member, f.agentId)).statusCode).toBe(200);
    expect((await add(member, f.agentId, `m-${suffix()}`)).json()).toMatchObject({ error: 'forbidden_role' });
    expect((await retire(member, f.agentId, alias.id)).json()).toMatchObject({ error: 'forbidden_role' });
    const stranger = await fixture('beta');
    expect((await list(stranger.session, f.agentId)).statusCode).toBe(404);
    expect((await retire(stranger.session, f.agentId, alias.id)).statusCode).toBe(404);
    // 같은 조직의 다른 에이전트 경로로 남의 주소를 폐기하지 못한다.
    const sibling = await agentIn(f.session);
    const cross = await retire(f.session, sibling, alias.id);
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toMatchObject({ error: 'address_not_found' });
  });

  it('단계 공개 — 목록의 조직: 목록·추가·폐기 · 목록 밖 조직: 꺼짐과 같은 404 · /api/plan features 가 조직별', async () => {
    const f = await fixture('beta');
    const outside = await fixture('beta');
    const staged = adminDeps(admin, { features: { addressAliases: { organizations: new Set([f.orgId]) } } });
    expect((await list(f.session, f.agentId, staged)).statusCode).toBe(200);
    const created = await add(f.session, f.agentId, `st-${suffix()}`, staged);
    expect(created.statusCode, created.body).toBe(201);
    const item = (created.json() as { item: AddressItem }).item;
    expect((await retire(f.session, f.agentId, item.id, staged)).statusCode).toBe(200);
    const closedAdd = await add(outside.session, outside.agentId, `no-${suffix()}`, staged);
    expect(closedAdd.statusCode).toBe(404);
    expect(closedAdd.json()).toMatchObject({ error: 'not_found' });
    // 목록 밖 조직도 자기 에이전트의 목록은 본다(L-4 — 대표뿐) · 남의 조직 에이전트·주소는 여전히 404.
    const closedList = await list(outside.session, outside.agentId, staged);
    expect(closedList.statusCode, closedList.body).toBe(200);
    expect((closedList.json() as { items: AddressItem[] }).items.map((row) => row.primary)).toEqual([true]);
    const crossList = await list(outside.session, f.agentId, staged);
    expect([crossList.statusCode, (crossList.json() as { error: string }).error]).toEqual([404, 'agent_not_found']);
    const crossRetire = await retire(outside.session, outside.agentId, item.id, staged);
    expect([crossRetire.statusCode, (crossRetire.json() as { error: string }).error]).toEqual([404, 'address_not_found']);
    const features = async (session: Session, d: AdminDependencies) =>
      ((await call(d, 'GET', '/api/plan', authed(session))).json() as { features: { addressAliases: boolean } }).features;
    expect(await features(f.session, staged)).toEqual({ addressAliases: true, customDomains: false });
    expect(await features(outside.session, staged)).toEqual({ addressAliases: false, customDomains: false });
    expect(await features(f.session, off)).toEqual({ addressAliases: false, customDomains: false });
    expect(await features(f.session, deps)).toEqual({ addressAliases: true, customDomains: false });
  });

  /** 보류가 지난 것처럼 — 소유자 롤이 트리거를 끈 세션에서 `retired_at` 을 `days` 일 앞당긴다(폐기 가드는 쓰기 1회라 트리거를 거치면 거부된다). */
  async function backdateRetired(addressId: string, days: number): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const moved = await client.query('UPDATE agent_addresses SET retired_at = retired_at - make_interval(days => $2::int) WHERE id = $1 AND retired_at IS NOT NULL', [addressId, days]);
      expect(moved.rowCount).toBe(1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const routed = async (address: string): Promise<string[]> =>
    (await createPostgresInboundStore(app).findAgentsByAddresses([address])).map((match) => match.agentId);

  it('재발급 — 같은 조직은 곧바로: 같은 에이전트 · 다른 에이전트 · 수신은 활성 행 · 공개 조회 그대로 · 누적 발급에 센다 · 잎은 행마다', async () => {
    const f = await fixture('beta');
    const localPart = `re-${suffix()}`;
    const first = await added(f.session, f.agentId, localPart);
    expect((await retire(f.session, f.agentId, first.id)).statusCode).toBe(200);
    expect(await routed(first.address)).toEqual([]);

    // 같은 에이전트 — 바로 된다(보류 없음). 새 행(새 id)이고 수신이 다시 이 에이전트로 온다.
    const same = await added(f.session, f.agentId, localPart);
    expect(same).toMatchObject({ address: first.address, status: 'active', primary: false });
    expect(same.id).not.toBe(first.id);
    expect(await routed(first.address)).toEqual([f.agentId]);
    const view = (await list(f.session, f.agentId)).json() as { items: AddressItem[]; aliases: Record<string, unknown> };
    expect(view.aliases).toMatchObject({ active: 1, issued: 2 });
    expect(view.items.filter((item) => item.address === first.address).map((item) => item.status).sort()).toEqual(['active', 'retired']);

    // 같은 조직의 다른 에이전트 — 폐기 뒤 바로 된다. 수신은 새 활성 행의 에이전트 하나.
    expect((await retire(f.session, f.agentId, same.id)).statusCode).toBe(200);
    const sibling = await agentIn(f.session);
    const moved = await added(f.session, sibling, localPart);
    expect(moved.address).toBe(first.address);
    expect(await routed(first.address)).toEqual([sibling]);

    // 공개 조회 — 별칭은 여전히 404 · 대표 주소는 그대로 보인다(재발급이 대표 조회를 흔들지 않는다).
    const directory = createPostgresIdentityDirectory(app);
    expect(await directory.findByAddress(first.address)).toBeNull();
    const primaryRow = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_addresses WHERE address = $1 AND is_primary AND retired_at IS NULL', [f.address]);
    expect(primaryRow.rows[0]?.n).toBe(1);

    // 잎 — 행마다 연결 잎 하나(재발급은 새 연결 잎) · 폐기한 두 행은 폐기 잎. 평문 @ 0.
    await drainOutboxFully(tlog);
    const leaves = await owner.query<{ source_id: string; kind: string; leaf_json: string }>(
      `SELECT source_id, kind, leaf_json FROM tlog_leaves WHERE source_table = 'agent_addresses' AND source_id = ANY ($1::text[]) ORDER BY seq`,
      [[first.id, same.id, moved.id]],
    );
    const kinds = (id: string): string[] => leaves.rows.filter((row) => row.source_id === id).map((row) => row.kind);
    expect(kinds(first.id)).toEqual(['identity.address_assigned', 'identity.address_retired']);
    expect(kinds(same.id)).toEqual(['identity.address_assigned', 'identity.address_retired']);
    expect(kinds(moved.id)).toEqual(['identity.address_assigned']);
    for (const row of leaves.rows) expect(row.leaf_json).not.toContain('@');
  });

  it('재발급 — 다른 조직은 보류 30일 동안 409 address_taken(대표 주소로도 409) · 보류가 지나면 된다 · 예전 조직도 그때부터는 막힌다', async () => {
    expect(ALIAS_REISSUE_HOLD_DAYS).toBe(30);
    const a = await fixture('beta');
    const b = await fixture('beta');
    const localPart = `hold-${suffix()}`;
    const alias = await added(a.session, a.agentId, localPart);

    // 활성 중 — 다른 조직 409(지금과 같다).
    const busy = await add(b.session, b.agentId, localPart);
    expect([busy.statusCode, (busy.json() as { error: string }).error]).toEqual([409, 'address_taken']);

    expect((await retire(a.session, a.agentId, alias.id)).statusCode).toBe(200);
    // 보류 중 — 같은 409 · 같은 코드(보류인지 사용 중인지 가르지 않는다) · 시도는 감사 행으로 센다.
    const held = await add(b.session, b.agentId, localPart);
    expect([held.statusCode, (held.json() as { error: string }).error]).toEqual([409, 'address_taken']);
    expect(held.body).toBe(busy.body);
    const taken = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'agent.alias.taken'", [b.orgId]);
    expect(taken.rows[0]?.n).toBe(2);
    // 새 에이전트의 대표 주소로 가져가기도 막힌다(같은 탈취) — 에이전트 만들기의 409.
    const asPrimary = await call(deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'hijack', localPart } }));
    expect(asPrimary.statusCode, asPrimary.body).toBe(409);
    expect(await routed(alias.address)).toEqual([]);
    // 29일이 지나도 아직 보류다.
    await backdateRetired(alias.id, ALIAS_REISSUE_HOLD_DAYS - 1);
    expect((await add(b.session, b.agentId, localPart)).statusCode).toBe(409);

    // 보류가 지났다(합 31일) — 다른 조직이 받는다. 수신은 새 주인에게.
    await backdateRetired(alias.id, 2);
    const took = await added(b.session, b.agentId, localPart);
    expect(took.address).toBe(alias.address);
    expect(await routed(alias.address)).toEqual([b.agentId]);
    // 이제 활성 — 예전 조직도 409(쓰는 중).
    const back = await add(a.session, a.agentId, localPart);
    expect([back.statusCode, (back.json() as { error: string }).error]).toEqual([409, 'address_taken']);
    // 새 주인이 지우면 이번엔 예전 조직이 "다른 조직" 이다 — 보류 30일.
    expect((await retire(b.session, b.agentId, took.id)).statusCode).toBe(200);
    expect((await add(a.session, a.agentId, localPart)).statusCode).toBe(409);
    // 새 주인(같은 조직)은 바로 다시 받는다.
    expect((await add(b.session, b.agentId, localPart)).statusCode).toBe(201);
  });

  /** 키 보관소의 메서드 호출을 센다 — 쓸 수 없는 주소의 에이전트 만들기가 키를 만들지 않는지(M2). */
  function countingCustody(): { deps: AdminDependencies; used: () => number } {
    let used = 0;
    const custody = (): KeyCustody => {
      const inner = testKeyCustody();
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]): unknown => {
            used += 1;
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    };
    return { deps: adminDeps(admin, { features: { addressAliases: true }, custody }), used: () => used };
  }

  it('M2 — 쓸 수 없는 주소로 에이전트 만들기: 키 보관 전에 409 conflict(사용 중 · 보류 같은 몸통) · 감사 agent.create.taken(대상 없음) 커밋 · 흔적 0', async () => {
    const a = await fixture('beta');
    const b = await fixture('beta');
    const localPart = `probe-${suffix()}`;
    const alias = await added(a.session, a.agentId, localPart);
    const counting = countingCustody();
    const create = (lp: string) => call(counting.deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'probe', localPart: lp } }));

    const busy = await create(localPart);
    expect([busy.statusCode, (busy.json() as { error: string }).error]).toEqual([409, 'conflict']);
    expect((await retire(a.session, a.agentId, alias.id)).statusCode).toBe(200);
    const held = await create(localPart);
    expect(held.statusCode).toBe(409);
    expect(held.body).toBe(busy.body);
    // 남의 대표 주소도 같은 409 · 같은 몸통.
    const primary = await create(a.address.split('@')[0] ?? '');
    expect(primary.body).toBe(busy.body);
    expect(counting.used()).toBe(0);

    const audit = await owner.query<{ action: string; target_id: string | null; session_id: string | null }>(
      "SELECT action, target_id, session_id::text FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.create%' ORDER BY created_at, id",
      [b.orgId],
    );
    // fixture 의 첫 에이전트 1 + 쓸 수 없는 주소 시도 3.
    expect(audit.rows.map((row) => [row.action, row.target_id])).toEqual([
      ['agent.create', b.agentId],
      [AGENT_CREATE_TAKEN_ACTION, null],
      [AGENT_CREATE_TAKEN_ACTION, null],
      [AGENT_CREATE_TAKEN_ACTION, null],
    ]);
    expect(audit.rows.every((row) => row.session_id !== null)).toBe(true);
    const agents = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM agents WHERE organization_id = $1 AND name = 'probe'", [b.orgId]);
    expect(agents.rows[0]?.n).toBe(0);

    // 비공허성 — 쓸 수 있는 주소면 키 보관소를 쓴다.
    const fresh = await create(`fresh-${suffix()}`);
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect(counting.used()).toBeGreaterThan(0);
  });

  it('M2 — 에이전트 만들기의 시도도 조직 하루 주소 탐침 상한에 센다: 별칭 추가 409 alias_org_daily_limit · 새 주소로도 에이전트 409 address_probe_limit', async () => {
    const a = await fixture('beta');
    const b = await fixture('scale');
    const taken = a.address.split('@')[0] ?? '';
    for (let i = 0; i < MAX_ALIASES_PER_ORG_PER_DAY - 1; i += 1) {
      const probe = await call(deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'probe', localPart: taken } }));
      expect(probe.statusCode, `시도 ${String(i)}`).toBe(409);
    }
    // 19 번의 에이전트 시도 + 별칭 시도 1 = 20 → 별칭은 이제 하루 상한.
    expect((await add(b.session, b.agentId, taken)).json()).toMatchObject({ error: 'address_taken' });
    expect((await add(b.session, b.agentId, `fresh-${suffix()}`)).json()).toMatchObject({ error: 'alias_org_daily_limit' });
    // 에이전트 만들기도 — 새 주소여도(가용성을 답하지 않는다).
    const blocked = await call(deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'probe', localPart: `fresh-${suffix()}` } }));
    expect([blocked.statusCode, (blocked.json() as { error: string }).error]).toEqual([409, 'address_probe_limit']);
  });

  it('M2 — 조직 키 에이전트 만들기: 409 conflict · 키 행위자 감사 agent.create.taken · 분당 생성 상한에 센다', async () => {
    const a = await fixture('beta');
    const b = await fixture('scale');
    const issued = await call(deps, 'POST', '/api/org-keys', authed(b.session, { body: { label: `k-${suffix()}`, capabilities: ['agents:read', 'agents:create'] } }));
    expect(issued.statusCode, issued.body).toBe(201);
    const key = (issued.json() as { key: string }).key;
    const create = (lp: string) => call(deps, 'POST', '/org-api/v1/agents', { headers: { authorization: `Bearer ${key}` }, body: { name: 'ci', localPart: lp } });
    const taken = a.address.split('@')[0] ?? '';
    const first = await create(taken);
    expect([first.statusCode, (first.json() as { error: string }).error]).toEqual([409, 'conflict']);
    const audit = await owner.query<{ action: string; target_id: string | null; org_api_key_id: string | null }>(
      "SELECT action, target_id, org_api_key_id::text FROM owner_actions WHERE organization_id = $1 AND org_api_key_id IS NOT NULL",
      [b.orgId],
    );
    expect(audit.rows.map((row) => [row.action, row.target_id])).toEqual([[AGENT_CREATE_TAKEN_ACTION, null]]);
    // 분당 생성 상한(10) — 쓸 수 없는 주소 시도도 센다: 시도 10 번 뒤에는 새 주소도 429.
    for (let i = 1; i < ORG_API_AGENT_CREATES_PER_MINUTE; i += 1) expect((await create(taken)).statusCode).toBe(409);
    const limited = await create(`fresh-${suffix()}`);
    expect([limited.statusCode, (limited.json() as { error: string }).error]).toEqual([429, 'rate_limited']);
  });

  it('L7 — 발신 allow 의 자기 주소 검사는 활성 주소만: 활성 별칭은 rule_self_address · 폐기한 별칭은 넣을 수 있다', async () => {
    const f = await fixture('beta');
    const alias = await added(f.session, f.agentId);
    const addRule = (value: string) =>
      call(deps, 'POST', `/api/agents/${f.agentId}/rules`, authed(f.session, { body: { direction: 'outbound', list: 'allow', value } }));
    const self = await addRule(alias.address);
    expect([self.statusCode, (self.json() as { error: string }).error]).toEqual([400, 'rule_self_address']);
    expect((await retire(f.session, f.agentId, alias.id)).statusCode).toBe(200);
    const retired = await addRule(alias.address);
    expect(retired.statusCode, retired.body).toBe(201);
  });

  it('재발급 — 같은 조직은 새 에이전트의 대표 주소로도 곧바로 받는다', async () => {
    const f = await fixture('beta');
    const localPart = `own-${suffix()}`;
    const alias = await added(f.session, f.agentId, localPart);
    expect((await retire(f.session, f.agentId, alias.id)).statusCode).toBe(200);
    const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: 'reuse', localPart } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    expect(agent.address).toBe(alias.address);
    expect(await routed(alias.address)).toEqual([agent.id]);
  });

  it('재발급 — 두 조직이 같은 주소를 동시에 청하면 정확히 하나만 이긴다', async () => {
    const a = await fixture('beta');
    const b = await fixture('beta');
    for (let round = 0; round < 3; round += 1) {
      const localPart = `race-${suffix()}`;
      const results = await Promise.all([add(a.session, a.agentId, localPart), add(b.session, b.agentId, localPart)]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
      const loser = results.find((result) => result.statusCode === 409);
      expect(loser?.json()).toMatchObject({ error: 'address_taken' });
      const winner = results[0]?.statusCode === 201 ? a.agentId : b.agentId;
      expect(await routed(`${localPart}@atmark.ai`)).toEqual([winner]);
      const rows = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_addresses WHERE address = $1", [`${localPart}@atmark.ai`]);
      expect(rows.rows[0]?.n).toBe(1);
    }
  });

  it('DB — 폐기와 다른 조직의 발급은 주소 잠금으로 줄 선다(발급은 폐기 커밋을 기다렸다가 보류로 거부) · 폐기 행 INSERT 거부 · 부분 UNIQUE', async () => {
    const a = await fixture('beta');
    const b = await fixture('beta');
    const alias = await added(a.session, a.agentId, `lock-${suffix()}`);
    const retirer = await owner.connect();
    const issuer = await owner.connect();
    try {
      await retirer.query('BEGIN');
      await retirer.query('UPDATE agent_addresses SET retired_at = now() WHERE id = $1', [alias.id]);
      let settled = false;
      const insert = issuer
        .query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [b.agentId, alias.address])
        .finally(() => {
          settled = true;
        });
      insert.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      await retirer.query('COMMIT');
      await expect(insert).rejects.toMatchObject({ code: '23505' });
    } finally {
      await retirer.query('ROLLBACK').catch(() => undefined);
      retirer.release();
      issuer.release();
    }
    expect(await routed(alias.address)).toEqual([]);

    // 새 행은 활성으로만 — retired_at 을 채운 INSERT(먼 미래로 영구 보류를 꾸미기)는 모든 롤에서 23514.
    await expect(
      admin.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary, retired_at) VALUES ($1, $2, 'atmark.ai', false, '9999-01-01')`, [
        a.agentId,
        `squat-${suffix()}@atmark.ai`,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // 옛 전역 UNIQUE 는 없고, 활성 행만의 부분 UNIQUE 와 주소 보통 색인이 있다.
    const indexes = await owner.query<{ name: string; unique: boolean; predicate: string | null }>(
      `SELECT c.relname AS name, i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'agent_addresses'::regclass AND c.relname LIKE 'agent_addresses_%address%' ORDER BY 1`,
    );
    expect(indexes.rows).toEqual([
      { name: 'agent_addresses_active_address_key', unique: true, predicate: '(retired_at IS NULL)' },
      { name: 'agent_addresses_address_idx', unique: false, predicate: null },
    ]);
  });

  it('거부 로그 — 재발급 뒤 받은 거부는 새 주인에게만 보인다(예전 주인에게는 폐기 전 것만)', async () => {
    const a = await fixture('beta');
    const b = await fixture('beta');
    const localPart = `rj-${suffix()}`;
    const alias = await added(a.session, a.agentId, localPart);
    const reject = async (at: Date): Promise<string> => {
      const ses = `0100${randomUUID().replace(/-/g, '')}`;
      const row = await owner.query<{ id: string }>(
        `INSERT INTO inbound_rejections (ses_message_id, reason, detail, envelope_recipients, virus_verdict, spam_verdict, raw_storage_key, received_at)
         VALUES ($1, 'virus', 'x', $2::text[], 'fail', 'pass', 'inbound/raw/' || $1, $3) RETURNING id`,
        [ses, [alias.address], at],
      );
      return row.rows[0]?.id ?? '';
    };
    expect((await retire(a.session, a.agentId, alias.id)).statusCode).toBe(200);
    // 예전 주인의 시간선을 과거로 — 50일 전에 만들고 40일 전에 폐기했다(보류 30일이 지났다). 그 사이에 받은 거부가 하나 있다.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query("UPDATE agent_addresses SET created_at = now() - interval '50 days', retired_at = now() - interval '40 days' WHERE id = $1", [alias.id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const before = await reject(new Date(Date.now() - 45 * 86_400_000));
    await added(b.session, b.agentId, localPart);
    const after = await reject(new Date());
    const rejected = async (session: Session): Promise<string[]> => {
      const result = await call(deps, 'GET', '/api/logs', authed(session, { query: 'type=inbound&verdict=rejected' }));
      expect(result.statusCode, result.body).toBe(200);
      return (result.json() as { items: { id: string }[] }).items.map((item) => item.id);
    };
    expect(await rejected(a.session)).toEqual([before]);
    expect(await rejected(b.session)).toEqual([after]);
  });
});
