/**
 * **확장성 P1 WP-B — 조직 API 키 · `/org-api/v1` · 에이전트 목록 쪽 나누기 · 채널 별칭 · 토큰 권한 선택**
 * (계약 `.omc/handoffs/p0p1-api.md` B1–B6, 마이그레이션 202609250150·0160).
 *
 * 라우터는 전부 **`atmark_admin` 롤 풀**로 돈다(운영 admin Lambda 와 같은 롤 — GRANT 가 모자라면 빨개진다). 행 심기·DB 가드 검사는 소유자 롤.
 * 실메일 0 · AWS 호출 0(custody 는 테스트 보관소).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 키 관리: 평문 1회(목록·DB 어디에도 평문·해시 없음 · 해시 = sha256) · 활성 5 → 6번째 409 `org_key_limit` · 이름 · 멱등 폐기 ·
 *     교체(같은 이름·권한 · 옛 키 폐기 · 계보 · 끝난 키 교체 409) · 권한 필수 · 감사 `org_key.*`(대상 = 키 id).
 *   - `/org-api`: 목록(늘 봉투)·한 개·생성(첫 토큰 1회, 콘솔과 같은 프로비저닝) · 감사 행위자 = 키(session_id NULL) → 투명성 outbox ·
 *     `last_used_at` · 폐기·만료 키 401 · 읽기 전용 키로 생성 403 · 다른 조직 에이전트 404 · 주소 중복 409 · 조직 키로 콘솔 `/api` 401.
 *   - 콘솔 로그 행위자: 세션 행위 = 사용자 주소, 키 행위 = 키 이름·끝 4자.
 *   - 쪽 나누기: 쿼리 없으면 옛 배열 · 정확히 limit 개면 nextCursor null · 다음 쪽 · q(이름·local part, `%` 는 글자) · 남의 커서는 자기 조직만.
 *   - 채널 별칭: email 별칭 = 옛 경로 응답 · sms 404 `channel_not_found` · 다른 조직 에이전트는 채널보다 먼저 `agent_not_found`.
 *   - 토큰 권한 선택: 부분집합 저장 · `[]` 400.
 *   - DB 가드: 해시·권한 UPDATE 거부 · 폐기 1회 · 삭제 거부 · 권한 CHECK · 행위자 정확히 하나 · 다른 조직 키로 감사 불가.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { authenticateOrgKey, MAX_ACTIVE_ORG_KEYS } from '../../../src/admin/ops/org-keys';
import { createPool } from '../../../src/db/client';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

interface KeyItem {
  id: string;
  label: string;
  hint: string;
  capabilities: string[];
  status: 'active' | 'expired' | 'revoked';
  revokedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdBy: { email: string } | null;
  previousKeyId: string | null;
}

interface AgentItem {
  id: string;
  name: string;
  address: string | null;
}

describe.skipIf(!AVAILABLE)('WP-B — 조직 키 · /org-api · 목록 쪽 · 채널 별칭 — atmark_admin 롤', () => {
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

  async function ok(session: Session, method: string, path: string, options: Parameters<typeof authed>[1] = {}, expected = 200): Promise<unknown> {
    const result = await call(deps, method, path, authed(session, options));
    expect(result.statusCode, `${method} ${path} → ${result.body}`).toBe(expected);
    return result.json();
  }

  async function org(): Promise<{ org: { id: string; ownerEmail: string }; session: Session }> {
    const organization = await newOrganization(owner);
    return { org: organization, session: await login(deps, mailer, organization) };
  }

  async function issue(session: Session, body: Record<string, unknown>): Promise<{ key: string; item: KeyItem }> {
    return (await ok(session, 'POST', '/api/org-keys', { body }, 201)) as { key: string; item: KeyItem };
  }

  function bearer(key: string, extra: Record<string, string> = {}): { headers: Record<string, string> } {
    return { headers: { authorization: `Bearer ${key}`, ...extra } };
  }

  async function createAgent(session: Session, name: string, localPart: string): Promise<AgentItem> {
    return ((await ok(session, 'POST', '/api/agents', { body: { name, localPart } }, 201)) as { agent: AgentItem }).agent;
  }

  it('풀은 정말 atmark_admin 이다', async () => {
    const who = await admin.query<{ user: string }>('SELECT current_user AS user');
    expect(who.rows[0]?.user).toBe('atmark_admin');
  });

  it('키 관리 수명 — 발급(평문 1회) → 상한 → 이름 → 폐기(멱등) → 교체 → 감사', async () => {
    const { org: o, session } = await org();
    const first = await issue(session, { label: 'CI deploy', capabilities: ['agents:create', 'agents:read'], expiresDays: 30 });
    expect(first.key).toMatch(/^atk_org_[A-Za-z0-9_-]{43}$/);
    expect(first.item).toMatchObject({ label: 'CI deploy', hint: first.key.slice(-4), capabilities: ['agents:read', 'agents:create'], status: 'active' });
    expect(first.item.createdBy?.email).toBe(o.ownerEmail);
    expect(first.item.expiresAt).not.toBeNull();

    // 평문·해시는 목록에도 DB 에도 없다(해시만 = sha256).
    const listed = (await ok(session, 'GET', '/api/org-keys')) as { keys: KeyItem[]; activeCount: number; maxActive: number };
    expect(listed).toMatchObject({ activeCount: 1, maxActive: MAX_ACTIVE_ORG_KEYS });
    expect(JSON.stringify(listed)).not.toContain(first.key);
    const stored = await owner.query<{ token_hash: string }>('SELECT token_hash FROM org_api_keys WHERE id = $1', [first.item.id]);
    expect(stored.rows[0]?.token_hash).toBe(createHash('sha256').update(first.key, 'utf8').digest('hex'));
    expect(JSON.stringify(listed)).not.toContain(stored.rows[0]?.token_hash ?? 'x');

    // 권한 필수 · 이름 규칙.
    for (const bad of [{ label: 'x' }, { label: 'x', capabilities: [] }, { label: 'x', capabilities: ['messages:send'] }]) {
      const rejected = await call(deps, 'POST', '/api/org-keys', authed(session, { body: bad }));
      expect(rejected.statusCode).toBe(400);
      expect((rejected.json() as { error: string }).error).toBe('invalid_capability');
    }
    const badLabel = await call(deps, 'POST', '/api/org-keys', authed(session, { body: { label: 'a​b', capabilities: ['agents:read'] } }));
    expect((badLabel.json() as { error: string }).error).toBe('invalid_label');

    // 활성 5 → 6번째 409.
    for (let index = 2; index <= MAX_ACTIVE_ORG_KEYS; index += 1) await issue(session, { label: `k${String(index)}`, capabilities: ['agents:read'] });
    const sixth = await call(deps, 'POST', '/api/org-keys', authed(session, { body: { label: 'k6', capabilities: ['agents:read'] } }));
    expect(sixth.statusCode).toBe(409);
    expect((sixth.json() as { error: string }).error).toBe('org_key_limit');

    // 이름 바꾸기 · 같은 이름이면 감사 없음.
    await ok(session, 'PATCH', `/api/org-keys/${first.item.id}`, { body: { label: 'CI prod' } });
    await ok(session, 'PATCH', `/api/org-keys/${first.item.id}`, { body: { label: 'CI prod' } });

    // 교체 — 같은 이름·권한 · 옛 키 폐기 · 계보 · 수명 유지(30일).
    const rotated = (await ok(session, 'POST', `/api/org-keys/${first.item.id}/rotate`, {}, 201)) as { key: string; item: KeyItem; revoked: KeyItem };
    expect(rotated.item).toMatchObject({ label: 'CI prod', capabilities: ['agents:read', 'agents:create'], status: 'active', previousKeyId: first.item.id });
    expect(rotated.revoked).toMatchObject({ id: first.item.id, status: 'revoked' });
    const lifetime = Date.parse(rotated.item.expiresAt ?? '') - Date.now();
    expect(lifetime).toBeGreaterThan(29 * 86_400_000);
    expect(lifetime).toBeLessThan(31 * 86_400_000);
    // 끝난 키: 교체·이름 409 · 폐기는 멱등.
    const again = await call(deps, 'POST', `/api/org-keys/${first.item.id}/rotate`, authed(session));
    expect((again.json() as { error: string }).error).toBe('org_key_not_active');
    const renameRevoked = await call(deps, 'PATCH', `/api/org-keys/${first.item.id}`, authed(session, { body: { label: 'zzz' } }));
    expect(renameRevoked.statusCode).toBe(409);
    await ok(session, 'POST', `/api/org-keys/${rotated.item.id}/revoke`);
    const twice = (await ok(session, 'POST', `/api/org-keys/${rotated.item.id}/revoke`)) as { item: KeyItem };
    expect(twice.item.status).toBe('revoked');

    // 없는 키·모양 아닌 id · 다른 조직의 키 → 404.
    const other = await org();
    const foreign = await issue(other.session, { label: 'other', capabilities: ['agents:read'] });
    for (const id of [randomUUID(), 'not-a-uuid', foreign.item.id]) {
      const missing = await call(deps, 'POST', `/api/org-keys/${id}/revoke`, authed(session));
      expect(missing.statusCode, id).toBe(404);
      expect((missing.json() as { error: string }).error).toBe('org_key_not_found');
    }

    // 감사 — 대상 = 키 id. 같은 이름 바꾸기 · 두 번째 폐기는 행이 없다.
    const audit = await owner.query<{ action: string; target_id: string | null }>(
      "SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action LIKE 'org_key.%' ORDER BY created_at, id",
      [o.id],
    );
    const actions = audit.rows.map((row) => row.action);
    expect(actions.filter((action) => action === 'org_key.issue')).toHaveLength(MAX_ACTIVE_ORG_KEYS);
    expect(actions.filter((action) => action === 'org_key.rename')).toHaveLength(1);
    expect(actions.filter((action) => action === 'org_key.rotate')).toHaveLength(1);
    expect(actions.filter((action) => action === 'org_key.revoke')).toHaveLength(1);
    expect(audit.rows.find((row) => row.action === 'org_key.rotate')?.target_id).toBe(rotated.item.id);
  });

  it('/org-api — 목록·한 개·생성 · 키 행위자 감사 · 로그 행위자 · 거부들', async () => {
    const { org: o, session } = await org();
    const writer = await issue(session, { label: 'CI writer', capabilities: ['agents:read', 'agents:create'] });
    const reader = await issue(session, { label: 'CI reader', capabilities: ['agents:read'] });

    const localPart = `ci-${suffix()}`;
    const created = await call(deps, 'POST', '/org-api/v1/agents', { body: { name: 'from ci', localPart }, ...bearer(writer.key) });
    expect(created.statusCode, created.body).toBe(201);
    const payload = created.json() as { agent: AgentItem; token: string };
    expect(payload.token).toMatch(/^atk_agent_/);
    expect(payload.agent.address?.startsWith(`${localPart}@`)).toBe(true);

    // 감사: 행위자 = 키(세션 없음) · 투명성 outbox 행.
    const audit = await owner.query<{ id: string; session_id: string | null; org_api_key_id: string | null; target_id: string }>(
      "SELECT id, session_id, org_api_key_id::text AS org_api_key_id, target_id FROM owner_actions WHERE organization_id = $1 AND action = 'agent.create'",
      [o.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ session_id: null, org_api_key_id: writer.item.id, target_id: payload.agent.id });
    const outbox = await owner.query("SELECT 1 FROM tlog_outbox WHERE source_table = 'owner_actions' AND source_id = $1", [audit.rows[0]?.id]);
    expect(outbox.rowCount).toBe(1);
    // 서열기(atmark_tlog 롤)가 행위자 칸을 읽을 수 있다(202609250160 GRANT) — 읽지 못하면 키 행위 잎이 서지 않는다.
    const tlogUrl = new URL(APP_URL);
    tlogUrl.username = 'atmark_tlog';
    tlogUrl.password = '';
    const tlog = createPool(tlogUrl.toString(), { max: 1 });
    try {
      const seen = await tlog.query<{ session_id: string | null; org_api_key_id: string | null }>(
        'SELECT session_id, org_api_key_id::text AS org_api_key_id FROM owner_actions WHERE id = $1::uuid',
        [audit.rows[0]?.id],
      );
      expect(seen.rows[0]).toEqual({ session_id: null, org_api_key_id: writer.item.id });
    } finally {
      await tlog.end();
    }

    // 콘솔 로그의 행위자.
    const logs = (await ok(session, 'GET', '/api/logs', { query: 'type=console' })) as { items: { action: string; actor: unknown }[] };
    expect(logs.items.find((item) => item.action === 'agent.create')?.actor).toEqual({ kind: 'org_key', label: 'CI writer', hint: writer.key.slice(-4) });
    expect(logs.items.find((item) => item.action === 'org_key.issue')?.actor).toEqual({ kind: 'user', email: o.ownerEmail });

    // 목록(늘 봉투)·한 개 — 읽기 전용 키.
    const list = await call(deps, 'GET', '/org-api/v1/agents', bearer(reader.key));
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ id: payload.agent.id }], nextCursor: null });
    const one = await call(deps, 'GET', `/org-api/v1/agents/${payload.agent.id}`, bearer(reader.key));
    expect((one.json() as AgentItem).id).toBe(payload.agent.id);
    const used = await owner.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM org_api_keys WHERE id = $1', [reader.item.id]);
    expect(used.rows[0]?.last_used_at).not.toBeNull();

    // 읽기 전용 키로 생성 → 403 · 주소 중복 → 409.
    const forbidden = await call(deps, 'POST', '/org-api/v1/agents', { body: { name: 'x', localPart: `ro-${suffix()}` }, ...bearer(reader.key) });
    expect(forbidden.statusCode).toBe(403);
    expect((forbidden.json() as { error: string }).error).toBe('forbidden_capability');
    const duplicate = await call(deps, 'POST', '/org-api/v1/agents', { body: { name: 'dup', localPart }, ...bearer(writer.key) });
    expect(duplicate.statusCode).toBe(409);

    // 다른 조직의 에이전트 → 404.
    const other = await org();
    const foreignAgent = await createAgent(other.session, 'foreign', `fx-${suffix()}`);
    const cross = await call(deps, 'GET', `/org-api/v1/agents/${foreignAgent.id}`, bearer(reader.key));
    expect(cross.statusCode).toBe(404);
    const otherList = (await call(deps, 'GET', '/org-api/v1/agents', bearer(reader.key))).json() as { items: AgentItem[] };
    expect(otherList.items.map((item) => item.id)).not.toContain(foreignAgent.id);

    // Origin(브라우저) 403 · 조직 키로 콘솔 /api 401.
    const browser = await call(deps, 'GET', '/org-api/v1/agents', bearer(reader.key, { origin: 'https://console.atmark.ai' }));
    expect(browser.statusCode).toBe(403);
    const consoleWithKey = await call(deps, 'GET', '/api/agents', bearer(reader.key));
    expect(consoleWithKey.statusCode).toBe(401);

    // 폐기 → 401 · 만료 → 401.
    await ok(session, 'POST', `/api/org-keys/${reader.item.id}/revoke`);
    expect((await call(deps, 'GET', '/org-api/v1/agents', bearer(reader.key))).statusCode).toBe(401);
    const expired = await issue(session, { label: 'soon', capabilities: ['agents:read'], expiresDays: 1 });
    // 만료는 불변 칸이라 UPDATE 로 당길 수 없다 — 소유자 롤 **한 트랜잭션** 안에서 불변 가드(`org_api_keys_immutable_core`) 하나만 끄고
    //   이미 끝난 키로 만든 뒤 같은 트랜잭션에서 인증을 판정하고 되돌린다(적대적 검토 L5 — `session_replication_role`(슈퍼유저) 없이 ·
    //   잘못된 상태를 커밋하지 않는다). 라우터의 "인증 null → 401" 은 위 폐기 경로가 이미 본다.
    expect(await authenticateOrgKey(owner, expired.key)).not.toBeNull();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE org_api_keys DISABLE TRIGGER org_api_keys_immutable_core');
      await client.query("UPDATE org_api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1", [expired.item.id]);
      expect(await authenticateOrgKey(client, expired.key)).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // 되돌렸으므로 키는 다시 살아 있다(커밋된 잘못된 상태 없음).
    expect((await call(deps, 'GET', '/org-api/v1/agents', bearer(expired.key))).statusCode).toBe(200);
  });

  it('에이전트 목록 쪽 나누기 — 옛 배열 · 경계 · q · 남의 커서', async () => {
    const { session } = await org();
    const tag = suffix();
    const names = [`alpha-${tag}`, `beta-${tag}`, `gamma_${tag}`];
    const agents: AgentItem[] = [];
    for (const [index, name] of names.entries()) agents.push(await createAgent(session, name, `pg${String(index)}-${tag}`));

    // 쿼리 없음 = 옛 배열.
    const legacy = await ok(session, 'GET', '/api/agents');
    expect(Array.isArray(legacy)).toBe(true);
    expect((legacy as AgentItem[]).map((agent) => agent.id)).toEqual(agents.map((agent) => agent.id));

    // limit 2 → 다음 쪽 1 → 끝.
    const page1 = (await ok(session, 'GET', '/api/agents', { query: 'limit=2' })) as { items: AgentItem[]; nextCursor: string | null };
    expect(page1.items.map((agent) => agent.id)).toEqual(agents.slice(0, 2).map((agent) => agent.id));
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await ok(session, 'GET', '/api/agents', { query: `limit=2&cursor=${page1.nextCursor ?? ''}` })) as {
      items: AgentItem[];
      nextCursor: string | null;
    };
    expect(page2.items.map((agent) => agent.id)).toEqual([agents[2]?.id]);
    expect(page2.nextCursor).toBeNull();
    // 정확히 limit 개로 끝나면 nextCursor null.
    const exact = (await ok(session, 'GET', '/api/agents', { query: 'limit=3' })) as { items: AgentItem[]; nextCursor: string | null };
    expect(exact.items).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();

    // q — 이름·local part · `_` 는 글자 그대로(와일드카드 아님).
    const byName = (await ok(session, 'GET', '/api/agents', { query: `q=BETA-${tag}` })) as { items: AgentItem[] };
    expect(byName.items.map((agent) => agent.id)).toEqual([agents[1]?.id]);
    const byLocal = (await ok(session, 'GET', '/api/agents', { query: `q=pg2-${tag}` })) as { items: AgentItem[] };
    expect(byLocal.items.map((agent) => agent.id)).toEqual([agents[2]?.id]);
    const literal = (await ok(session, 'GET', '/api/agents', { query: `q=a_${tag}` })) as { items: AgentItem[] };
    expect(literal.items.map((agent) => agent.id)).toEqual([agents[2]?.id]);
    const wildcard = (await ok(session, 'GET', '/api/agents', { query: 'q=%25' })) as { items: AgentItem[] };
    expect(wildcard.items).toHaveLength(0);

    // 오류.
    for (const [query, code] of [
      ['limit=0', 'invalid_limit'],
      ['cursor=zzz', 'invalid_cursor'],
      ['q=', 'invalid_query'],
    ] as const) {
      const rejected = await call(deps, 'GET', '/api/agents', authed(session, { query }));
      expect(rejected.statusCode, query).toBe(400);
      expect((rejected.json() as { error: string }).error).toBe(code);
    }

    // 남의 커서(다른 조직에서 받은 값)로도 자기 조직만.
    const other = await org();
    await createAgent(other.session, 'other', `po-${suffix()}`);
    const foreignPage = (await ok(other.session, 'GET', '/api/agents', { query: `cursor=${page1.nextCursor ?? ''}` })) as { items: AgentItem[] };
    expect(foreignPage.items.every((agent) => !agents.some((mine) => mine.id === agent.id))).toBe(true);

    // 한 개.
    const single = (await ok(session, 'GET', `/api/agents/${agents[0]?.id ?? ''}`)) as AgentItem;
    expect(single.id).toBe(agents[0]?.id);
    const crossSingle = await call(deps, 'GET', `/api/agents/${agents[0]?.id ?? ''}`, authed(other.session));
    expect(crossSingle.statusCode).toBe(404);
    expect((crossSingle.json() as { error: string }).error).toBe('agent_not_found');
  });

  it('채널 별칭 — email = 옛 경로 · sms 404 · 교차 조직은 agent_not_found 먼저', async () => {
    const { session } = await org();
    const agent = await createAgent(session, 'channels', `ch-${suffix()}`);
    const legacy = await ok(session, 'GET', `/api/agents/${agent.id}/policy`);
    const alias = await ok(session, 'GET', `/api/agents/${agent.id}/channels/email/policy`);
    expect(alias).toEqual(legacy);

    const patched = (await ok(session, 'PATCH', `/api/agents/${agent.id}/channels/email/policy`, { body: { inbound: { mode: 'allowlist' } } })) as {
      inbound: { mode: string };
    };
    expect(patched.inbound.mode).toBe('allowlist');
    const added = (await ok(session, 'POST', `/api/agents/${agent.id}/channels/email/rules`, { body: { direction: 'inbound', list: 'allow', value: 'partner.example' } }, 201)) as {
      rule: { id: string };
    };
    await ok(session, 'DELETE', `/api/agents/${agent.id}/channels/email/rules/${added.rule.id}`);

    const sms = await call(deps, 'GET', `/api/agents/${agent.id}/channels/sms/policy`, authed(session));
    expect(sms.statusCode).toBe(404);
    expect((sms.json() as { error: string }).error).toBe('channel_not_found');

    const other = await org();
    const cross = await call(deps, 'GET', `/api/agents/${agent.id}/channels/sms/policy`, authed(other.session));
    expect(cross.statusCode).toBe(404);
    expect((cross.json() as { error: string }).error).toBe('agent_not_found');
  });

  it('토큰 권한 선택 — 부분집합 저장 · [] 400', async () => {
    const { session } = await org();
    const agent = await createAgent(session, 'caps', `cp-${suffix()}`);
    const issued = (await ok(session, 'POST', `/api/agents/${agent.id}/tokens`, { body: { label: 'read only', capabilities: ['messages:read', 'audit:read'] } }, 201)) as {
      item: { capabilities: string[] };
    };
    expect([...issued.item.capabilities].sort()).toEqual(['audit:read', 'messages:read']);
    const empty = await call(deps, 'POST', `/api/agents/${agent.id}/tokens`, authed(session, { body: { label: 'none', capabilities: [] } }));
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: string }).error).toBe('invalid_capability');
    const rotated = (await ok(session, 'POST', `/api/agents/${agent.id}/token`, { body: { action: 'rotate', capabilities: ['messages:send'] } })) as {
      item: { capabilities: string[] };
    };
    expect(rotated.item.capabilities).toEqual(['messages:send']);
  });

  it('DB 가드 — 불변 칸 · 폐기 1회 · 삭제 · 권한 CHECK · 행위자 정확히 하나 · 다른 조직 키', async () => {
    const { org: o, session } = await org();
    const key = await issue(session, { label: 'guard', capabilities: ['agents:read'] });
    const rejects = async (pool: Pool, sql: string, params: unknown[]): Promise<void> => {
      await expect(pool.query(sql, params), sql).rejects.toThrow();
    };
    await rejects(owner, "UPDATE org_api_keys SET token_hash = repeat('0', 64) WHERE id = $1", [key.item.id]);
    await rejects(owner, "UPDATE org_api_keys SET capabilities = ARRAY['agents:read','agents:create'] WHERE id = $1", [key.item.id]);
    await rejects(admin, "UPDATE org_api_keys SET capabilities = ARRAY['agents:create'] WHERE id = $1", [key.item.id]);
    await rejects(owner, 'DELETE FROM org_api_keys WHERE id = $1', [key.item.id]);
    await owner.query('UPDATE org_api_keys SET revoked_at = now() WHERE id = $1', [key.item.id]);
    await rejects(owner, "UPDATE org_api_keys SET revoked_at = now() + interval '1 hour' WHERE id = $1", [key.item.id]);
    await rejects(owner, 'UPDATE org_api_keys SET revoked_at = NULL WHERE id = $1', [key.item.id]);
    const user = await owner.query<{ id: string }>('SELECT created_by_user_id::text AS id FROM org_api_keys WHERE id = $1', [key.item.id]);
    const userId = user.rows[0]?.id;
    await rejects(
      owner,
      "INSERT INTO org_api_keys (organization_id, label, hint, token_hash, capabilities, created_by_user_id) VALUES ($1, 'x', 'abcd', repeat('1', 64), ARRAY['messages:send'], $2)",
      [o.id, userId],
    );
    await rejects(
      owner,
      "INSERT INTO org_api_keys (organization_id, label, hint, token_hash, capabilities, created_by_user_id) VALUES ($1, 'x', 'abcd', repeat('2', 64), ARRAY[]::text[], $2)",
      [o.id, userId],
    );
    // 행위자: 둘 다 없음 · 다른 조직의 키.
    await rejects(owner, "INSERT INTO owner_actions (organization_id, action) VALUES ($1, 'probe.none')", [o.id]);
    const other = await org();
    await rejects(owner, "INSERT INTO owner_actions (org_api_key_id, organization_id, action) VALUES ($1, $2, 'probe.cross')", [key.item.id, other.org.id]);
    // 앱 롤 권한 0.
    const app = await owner.query<{ allowed: boolean }>("SELECT has_table_privilege('atmark_app', 'public.org_api_keys', 'SELECT') AS allowed");
    expect(app.rows[0]?.allowed).toBe(false);
  });
});
