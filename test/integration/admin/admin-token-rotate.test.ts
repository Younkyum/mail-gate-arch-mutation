/**
 * **토큰 한 개 교체** — `POST /api/agents/{agentId}/tokens/{tokenId}/rotate`(2026-09-27 진윤겸: "처음 못 하면 다시 못 보니까",
 * 마이그레이션 202609270140·0141).
 *
 * 라우터는 **`atmark_admin` 롤 풀**로 돈다(운영 admin Lambda 와 같은 롤) — 새 칸(`new_key_id`) INSERT 가 표 단위 GRANT 로 덮이는지 여기서 본다.
 * 행 심기·DB 가드 검사는 소유자 롤, 토큰 인증은 앱 롤. 실메일 0 · AWS 호출 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 한 트랜잭션: 옛 토큰은 폐기(인증 `token_revoked`) · 새 토큰은 같은 이름·권한 · 같은 수명(만든 때 → 만료) · 다른 토큰은 그대로 · 활성 수 불변.
 *   - 평문 1회: 새 평문은 응답에만(목록·DB 에 없다) · 끝 4자 = 새 평문의 끝 4자.
 *   - 감사: `agent.token.rotate_one`(대상 = 에이전트 id) 1행 + 상세 1행(key_id = 옛 토큰 · new_key_id = 새 토큰 · 이름 칸 NULL).
 *   - 끝난 토큰(폐기·만료) → 409 `token_not_active`, 아무것도 바뀌지 않는다(감사 없음).
 *   - 범위: 다른 조직 → 404 `agent_not_found` · 같은 조직 다른 에이전트의 토큰 · 없는 id · 모양 아닌 id → 404 `token_not_found`.
 *   - 속도: 교체도 조직당 분당 토큰 변경에 세고, 상한이면 429 `rate_limited`(옛 토큰 그대로 · 새 토큰 없음).
 *   - 상한: 활성이 요금제 한도에 닿아도 교체는 된다(활성 수를 늘리지 않는다).
 *   - DB: 상세의 새 토큰은 옛 토큰과 달라야 하고 이름 전·후를 싣지 않는다(CHECK) · 있는 토큰이어야 한다(FK).
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { supersedeAgentTokenOp } from '../../../src/admin/ops/agents';
import { MAX_ACTIVE_TOKENS_PER_AGENT, TOKEN_CHANGES_PER_MINUTE } from '../../../src/admin/ops/tokens';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { toAgentId } from '../../../src/db/schema';
import { authenticateAgentToken } from '../../../src/identity/agent-token';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

interface TokenItem {
  id: string;
  label: string | null;
  hint: string | null;
  capabilities: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

interface Rotated {
  token: string;
  item: TokenItem;
  revoked: TokenItem;
}

interface Fixture {
  readonly org: { id: string; ownerEmail: string };
  readonly session: Session;
  readonly agentId: string;
  /** 프로비저닝 토큰 평문(이름 없음 · 무기한). */
  readonly token: string;
}

const DAY_MS = 86_400_000;

describe.skipIf(!AVAILABLE)('토큰 한 개 교체 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await app.end();
    await mailer.end();
  });

  async function fixture(existing?: { org: { id: string; ownerEmail: string }; session: Session }): Promise<Fixture> {
    const org = existing?.org ?? (await newOrganization(owner));
    const session = existing?.session ?? (await login(deps, mailer, org));
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'rotate', localPart: `rot-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const payload = created.json() as { agent: { id: string }; token: string };
    return { org, session, agentId: payload.agent.id, token: payload.token };
  }

  async function ok(session: Session, method: string, path: string, options: Parameters<typeof authed>[1] = {}, expected = 200): Promise<unknown> {
    const result = await call(deps, method, path, authed(session, options));
    expect(result.statusCode, `${method} ${path} → ${result.body}`).toBe(expected);
    return result.json();
  }

  async function authenticates(token: string): Promise<string> {
    const result = await authenticateAgentToken(createPostgresAgentTokenStore(app), token, new Date());
    return result.kind === 'authenticated' ? 'ok' : result.reason;
  }

  async function tokenAudit(orgId: string): Promise<Array<{ action: string; target: string | null; key: string | null; next: string | null; old: string | null; new: string | null }>> {
    const rows = await owner.query<{ action: string; target_id: string | null; key_id: string | null; new_key_id: string | null; old_label: string | null; new_label: string | null }>(
      `SELECT o.action, o.target_id, e.key_id::text AS key_id, e.new_key_id::text AS new_key_id, e.old_label, e.new_label
         FROM owner_actions o LEFT JOIN agent_api_key_events e ON e.owner_action_id = o.id
        WHERE o.organization_id = $1 AND o.action LIKE 'agent.token.%' ORDER BY o.created_at, o.id`,
      [orgId],
    );
    return rows.rows.map((row) => ({ action: row.action, target: row.target_id, key: row.key_id, next: row.new_key_id, old: row.old_label, new: row.new_label }));
  }

  it('교체 — 옛 토큰 폐기 + 같은 이름·권한·수명의 새 토큰(한 번에) · 다른 토큰은 그대로 · 평문은 응답 한 번 · 감사 1행 + 상세(옛 → 새)', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const ci = (await ok(f.session, 'POST', base, { body: { label: 'ci', expiresDays: 90, capabilities: ['messages:read', 'audit:read'] } }, 201)) as { token: string; item: TokenItem };

    const rotated = (await ok(f.session, 'POST', `${base}/${ci.item.id}/rotate`, {}, 201)) as Rotated;
    expect(rotated.token).toMatch(/^atk_agent_[A-Za-z0-9_-]{43}$/);
    expect(rotated.token).not.toBe(ci.token);
    expect(rotated.item.id).not.toBe(ci.item.id);
    expect(rotated.item).toMatchObject({ label: 'ci', hint: rotated.token.slice(-4), status: 'active', revokedAt: null, lastUsedAt: null });
    expect([...rotated.item.capabilities].sort()).toEqual(['audit:read', 'messages:read']);
    // 같은 수명(90일) — 남은 기간이 아니라 만든 때 → 만료.
    const lifetime = (item: TokenItem): number => new Date(item.expiresAt ?? 0).getTime() - new Date(item.createdAt).getTime();
    expect(Math.abs(lifetime(rotated.item) - 90 * DAY_MS)).toBeLessThan(2000);
    // DB 는 µs, 응답 ISO 는 ms — 두 시각을 각각 자르므로 1ms 까지 어긋날 수 있다.
    expect(Math.abs(lifetime(rotated.item) - lifetime(ci.item))).toBeLessThanOrEqual(1);
    expect(rotated.revoked).toMatchObject({ id: ci.item.id, label: 'ci', status: 'revoked' });
    expect(rotated.revoked.revokedAt).not.toBeNull();

    // 인증: 옛 것은 거부 · 새 것과 다른 토큰(프로비저닝)은 통과.
    expect(await authenticates(ci.token)).toBe('token_revoked');
    expect(await authenticates(rotated.token)).toBe('ok');
    expect(await authenticates(f.token)).toBe('ok');

    // 평문은 목록·DB 어디에도 없다 · 활성 수 불변.
    const listed = await call(deps, 'GET', base, authed(f.session, { query: 'status=all' }));
    expect(listed.body).not.toContain(rotated.token.slice('atk_agent_'.length, -4));
    expect(listed.body).not.toMatch(/token_hash|tokenHash/);
    const rows = await owner.query<Record<string, unknown>>('SELECT * FROM agent_api_keys WHERE agent_id = $1', [f.agentId]);
    expect(JSON.stringify(rows.rows)).not.toContain(rotated.token.slice('atk_agent_'.length));
    const view = listed.json() as { tokens: TokenItem[]; activeCount: number };
    expect(view.activeCount).toBe(2);
    expect(view.tokens.map((item) => [item.id, item.status])).toEqual([
      [rotated.item.id, 'active'],
      [expect.any(String), 'active'],
      [ci.item.id, 'revoked'],
    ]);

    // 감사: 발급 1 · 교체 1(대상 = 에이전트 id) — 교체 상세는 옛 → 새 토큰, 이름 칸 없음.
    expect(await tokenAudit(f.org.id)).toEqual([
      { action: 'agent.token.issue', target: f.agentId, key: null, next: null, old: null, new: null },
      { action: 'agent.token.rotate_one', target: f.agentId, key: ci.item.id, next: rotated.item.id, old: null, new: null },
    ]);
    const consoleLog = (await ok(f.session, 'GET', '/api/logs', { query: `type=console&agent=${f.agentId}` })) as { items: Array<{ action: string }> };
    expect(consoleLog.items.map((item) => item.action)).toContain('agent.token.rotate_one');

    // 이미 교체된(폐기된) 토큰을 다시 교체 → 409, 아무것도 바뀌지 않는다.
    const again = await call(deps, 'POST', `${base}/${ci.item.id}/rotate`, authed(f.session));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: 'token_not_active' });
    expect(await tokenAudit(f.org.id)).toHaveLength(2);
    expect(((await ok(f.session, 'GET', base)) as { activeCount: number }).activeCount).toBe(2);
  });

  it('동시 교체: 같은 토큰을 두 번 동시에 교체 → 201 하나 · 409 token_not_active 하나 · 새 활성 행 하나 · 활성 수 불변 · 감사 1행', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const target = (await ok(f.session, 'POST', base, { body: { label: 'race' } }, 201)) as { token: string; item: TokenItem };
    const before = (await ok(f.session, 'GET', base)) as { activeCount: number };
    const results = await Promise.all([0, 1].map(() => call(deps, 'POST', `${base}/${target.item.id}/rotate`, authed(f.session))));
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const lost = results.find((result) => result.statusCode === 409);
    expect(lost?.json()).toMatchObject({ error: 'token_not_active' });
    const won = results.find((result) => result.statusCode === 201)?.json() as Rotated;
    const all = (await ok(f.session, 'GET', base, { query: 'status=all' })) as { tokens: TokenItem[]; activeCount: number };
    expect(all.activeCount).toBe(before.activeCount);
    // 'race' 이름의 행은 옛(폐기) 하나 + 새(활성) 하나뿐이다.
    const race = all.tokens.filter((item) => item.label === 'race');
    expect(race.map((item) => [item.id, item.status]).sort()).toEqual([[target.item.id, 'revoked'], [won.item.id, 'active']].sort());
    expect(await authenticates(target.token)).toBe('token_revoked');
    expect(await authenticates(won.token)).toBe('ok');
    expect((await tokenAudit(f.org.id)).filter((row) => row.action === 'agent.token.rotate_one')).toEqual([
      { action: 'agent.token.rotate_one', target: f.agentId, key: target.item.id, next: won.item.id, old: null, new: null },
    ]);
  });

  it('만료: 무기한 토큰(이름 없는 프로비저닝 토큰)은 무기한 · 이름 없음 그대로 · expiresDays 를 주면 그 값 · 모양 검사 · 만료된 토큰은 409', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const first = ((await ok(f.session, 'GET', base)) as { tokens: TokenItem[] }).tokens[0];
    if (first === undefined) throw new Error('fixture');
    const forever = (await ok(f.session, 'POST', `${base}/${first.id}/rotate`, { body: {} }, 201)) as Rotated;
    expect(forever.item).toMatchObject({ label: null, expiresAt: null, status: 'active' });
    expect([...forever.item.capabilities].sort()).toEqual([...first.capabilities].sort());
    expect(await authenticates(f.token)).toBe('token_revoked');
    expect(await authenticates(forever.token)).toBe('ok');

    // null 은 생략과 같다(옛 수명 — 여기서는 무기한). 숫자면 그 날수.
    const same = (await ok(f.session, 'POST', `${base}/${forever.item.id}/rotate`, { body: { expiresDays: null } }, 201)) as Rotated;
    expect(same.item.expiresAt).toBeNull();
    const thirty = (await ok(f.session, 'POST', `${base}/${same.item.id}/rotate`, { body: { expiresDays: 30 } }, 201)) as Rotated;
    expect(Math.abs(new Date(thirty.item.expiresAt ?? 0).getTime() - Date.now() - 30 * DAY_MS)).toBeLessThan(60_000);

    for (const [body, code] of [
      [{ expiresDays: 0 }, 'invalid_expiry'],
      [{ expiresDays: '30' }, 'invalid_expiry'],
      [{ label: 'renamed' }, 'invalid_body'],
      [{ capabilities: ['messages:read'] }, 'invalid_body'],
      [[], 'invalid_body'],
    ] as const) {
      const result = await call(deps, 'POST', `${base}/${thirty.item.id}/rotate`, authed(f.session, { body }));
      expect(result.statusCode, JSON.stringify(body)).toBe(400);
      expect(result.json(), JSON.stringify(body)).toMatchObject({ error: code });
    }
    expect(await authenticates(thirty.token)).toBe('ok');

    // 만료된 토큰 — 활성이 아니다.
    const expired = await owner.query<{ id: string }>(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, expires_at, hint, label)
       VALUES ($1, $2, '{messages:read}'::agent_token_capability[], now() + interval '1 millisecond', 'zzzz', 'short') RETURNING id::text AS id`,
      [f.agentId, createHash('sha256').update(randomUUID()).digest('hex')],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expiredId = expired.rows[0]?.id ?? '';
    const onExpired = await call(deps, 'POST', `${base}/${expiredId}/rotate`, authed(f.session));
    expect(onExpired.statusCode, onExpired.body).toBe(409);
    expect(onExpired.json()).toMatchObject({ error: 'token_not_active' });
  });

  it('범위: 다른 조직 → 404 agent_not_found · 같은 조직 다른 에이전트의 토큰 · 없는 id · 모양 아닌 id → 404 token_not_found · CSRF 403', async () => {
    const a = await fixture();
    const sibling = await fixture({ org: a.org, session: a.session });
    const b = await fixture();
    const siblingTokenId = ((await ok(a.session, 'GET', `/api/agents/${sibling.agentId}/tokens`)) as { tokens: TokenItem[] }).tokens[0]?.id ?? '';
    const bTokenId = ((await ok(b.session, 'GET', `/api/agents/${b.agentId}/tokens`)) as { tokens: TokenItem[] }).tokens[0]?.id ?? '';

    const cross = await call(deps, 'POST', `/api/agents/${b.agentId}/tokens/${bTokenId}/rotate`, authed(a.session));
    expect(cross.statusCode, cross.body).toBe(404);
    expect(cross.json()).toMatchObject({ error: 'agent_not_found' });
    for (const tokenId of [siblingTokenId, bTokenId, randomUUID(), 'not-a-uuid']) {
      const result = await call(deps, 'POST', `/api/agents/${a.agentId}/tokens/${tokenId}/rotate`, authed(a.session));
      expect(result.statusCode, tokenId).toBe(404);
      expect(result.json(), tokenId).toMatchObject({ error: 'token_not_found' });
    }
    // 연산 자체도 에이전트 범위다 — 자동 커밋 풀에서 불러도 남의 토큰을 건드리지 않는다.
    await expect(supersedeAgentTokenOp(owner, toAgentId(a.agentId), siblingTokenId, undefined)).rejects.toMatchObject({ code: 'token_not_found' });
    expect(await authenticates(sibling.token)).toBe('ok');
    expect(await authenticates(b.token)).toBe('ok');
    expect(await tokenAudit(a.org.id)).toEqual([]);
    expect(await tokenAudit(b.org.id)).toEqual([]);

    const own = ((await ok(a.session, 'GET', `/api/agents/${a.agentId}/tokens`)) as { tokens: TokenItem[] }).tokens[0]?.id ?? '';
    const noCsrf = await call(deps, 'POST', `/api/agents/${a.agentId}/tokens/${own}/rotate`, { cookies: a.session.cookies });
    expect(noCsrf.statusCode).toBe(403);
    expect(await authenticates(a.token)).toBe('ok');
  });

  it('상한: 활성이 한도(5)에 닿아도 교체는 된다 — 활성 수를 늘리지 않는다', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    for (let index = 1; index < MAX_ACTIVE_TOKENS_PER_AGENT; index += 1) await ok(f.session, 'POST', base, { body: { label: `t${String(index)}` } }, 201);
    const full = (await ok(f.session, 'GET', base)) as { tokens: TokenItem[]; activeCount: number; maxActive: number };
    expect(full.activeCount).toBe(full.maxActive);
    const target = full.tokens[0];
    if (target === undefined) throw new Error('fixture');
    const rotated = (await ok(f.session, 'POST', `${base}/${target.id}/rotate`, {}, 201)) as Rotated;
    expect(rotated.item.label).toBe(target.label);
    expect(((await ok(f.session, 'GET', base)) as { activeCount: number }).activeCount).toBe(full.maxActive);
  });

  it('속도: 교체도 조직당 분당 토큰 변경에 센다 → 상한이면 429 rate_limited(옛 토큰 그대로 · 새 토큰 없음 · 감사 없음)', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const created = (await ok(f.session, 'POST', base, { body: { label: 'r-0' } }, 201)) as { token: string; item: TokenItem };
    const rotated = (await ok(f.session, 'POST', `${base}/${created.item.id}/rotate`, {}, 201)) as Rotated;
    for (let index = 2; index < TOKEN_CHANGES_PER_MINUTE; index += 1) {
      await ok(f.session, 'PATCH', `${base}/${rotated.item.id}`, { body: { label: `r-${String(index)}` } });
    }
    expect(await tokenAudit(f.org.id)).toHaveLength(TOKEN_CHANGES_PER_MINUTE);
    const limited = await call(deps, 'POST', `${base}/${rotated.item.id}/rotate`, authed(f.session));
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(await authenticates(rotated.token)).toBe('ok');
    expect(((await ok(f.session, 'GET', base, { query: 'status=all' })) as { tokens: TokenItem[] }).tokens).toHaveLength(3);
    expect(await tokenAudit(f.org.id)).toHaveLength(TOKEN_CHANGES_PER_MINUTE);
    // 교체가 센 한 번 — 발급 1 + 교체 1 + 이름 18 = 20 이라 이름 바꾸기도 막힌다.
    const rename = await call(deps, 'PATCH', `${base}/${rotated.item.id}`, authed(f.session, { body: { label: 'late' } }));
    expect(rename.statusCode).toBe(429);
  });

  it('DB 가드: 상세의 새 토큰은 옛 토큰과 달라야 하고 이름 전·후를 싣지 않는다(CHECK) · 있는 토큰이어야 한다(FK) · admin 롤은 적기만 한다', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const tokenId = ((await ok(f.session, 'GET', base)) as { tokens: TokenItem[] }).tokens[0]?.id ?? '';
    const rotated = (await ok(f.session, 'POST', `${base}/${tokenId}/rotate`, {}, 201)) as Rotated;
    // 상세가 없는 감사 행(에이전트 만들기)에 붙여 본다 — 감사 행 FK 는 맞고, 새 칸의 가드만 걸린다.
    const bare = await owner.query<{ id: string }>("SELECT id::text AS id FROM owner_actions WHERE organization_id = $1 AND action = 'agent.create' LIMIT 1", [f.org.id]);
    const ownerActionId = bare.rows[0]?.id ?? '';
    expect(ownerActionId).not.toBe('');
    const insert = (keyId: string, newKeyId: string, oldLabel: string | null): Promise<unknown> =>
      owner.query('INSERT INTO agent_api_key_events (owner_action_id, key_id, old_label, new_label, new_key_id) VALUES ($1::uuid, $2::uuid, $3, NULL, $4::uuid)', [
        ownerActionId,
        keyId,
        oldLabel,
        newKeyId,
      ]);
    await expect(insert(tokenId, tokenId, null)).rejects.toThrow(/agent_api_key_events_new_key_check/);
    await expect(insert(tokenId, rotated.item.id, 'x')).rejects.toThrow(/agent_api_key_events_new_key_check/);
    await expect(insert(tokenId, randomUUID(), null)).rejects.toThrow(/agent_api_key_events_new_key_fkey/);
    await expect(admin.query('SELECT new_key_id FROM agent_api_key_events LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(owner.query('UPDATE agent_api_key_events SET new_key_id = NULL WHERE key_id = $1', [tokenId])).rejects.toThrow();
  });
});
