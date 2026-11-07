/**
 * **콘솔 v4 — 토큰 목록 · 신원 지문 · 개요 통계**(계약 `.omc/handoffs/console-v4-api.md`, 마이그레이션 202609250010).
 *
 * 라우터는 전부 **`atmark_admin` 롤 풀**로 돈다(운영 admin Lambda 와 같은 롤) — `label` UPDATE 한 칸 GRANT 가 모자라면 빨개진다.
 * 행 심기·DB 가드 검사는 소유자 롤, 토큰 인증은 앱 롤(api Lambda 와 같은 롤). 실메일 0 · AWS 호출 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 활성 상한 5: 6번째 새 토큰 409 `token_limit`(콘솔) · CLI 발급 함수도 같은 상한 · DB 트리거가 직접 INSERT 도 막는다 · 폐기하면 다시 된다.
 *   - 한 개 폐기: 그 토큰만 인증 거부(`token_revoked`), 나머지는 계속 인증된다 · 두 번째 폐기는 같은 응답(폐기 시각 불변) · 감사 1행.
 *   - 평문 1회: 목록·DB 어디에도 평문이 없다 · 끝 4자(`hint`)는 평문의 끝 4자다(프로비저닝·새 토큰·교체 모두).
 *   - 범위: 다른 조직 → 404 `agent_not_found` · 같은 조직 다른 에이전트의 토큰 · 없는 id · 모양 아닌 id → 404 `token_not_found`.
 *   - 가드: `hint`·`capabilities` 불변(모든 롤) · admin 은 `label` 만 바꾼다 · 이름 CHECK(보이지 않는 문자 거부).
 *   - 목록 상한이 활성 토큰을 숨기지 않는다(M1): 끝난 토큰 60개 + 가장 오래된 활성 토큰 → 활성이 먼저 실린다.
 *   - 감사 상세(L1): 한 개 폐기·이름 바꾸기 감사 행마다 `agent_api_key_events` 한 행(토큰 id · 이름 전·후) · 폐기·만료 토큰 이름 바꾸기 409.
 *   - 속도(L2): 조직당 분당 토큰 변경 `TOKEN_CHANGES_PER_MINUTE` → 429 `rate_limited`(다른 조직은 무관) · 통계는 조직당 한 번에 하나 → 429.
 *   - 신원: 목록·신원 응답의 `keyFingerprint` = `publicKeyFingerprint(agent_keypairs.public_key)` · draft 는 DID·URL 없음(B5).
 *   - 통계: 로그 API 와 같은 판정 · 창 밖 행 제외 · 다른 조직 행 제외 · `agent` 필터 · 잘못된 `days` 400.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { issueAgentTokenOp, resolveCapabilities } from '../../../src/admin/ops/agents';
import {
  isValidTokenLabel,
  MAX_ACTIVE_TOKENS_PER_AGENT,
  renameAgentTokenOp,
  revokeAgentTokenOp,
  TOKEN_CHANGES_PER_MINUTE,
  TOKEN_LIST_MAX_ROWS,
} from '../../../src/admin/ops/tokens';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { toAgentId } from '../../../src/db/schema';
import { authenticateAgentToken } from '../../../src/identity/agent-token';
import { publicKeyFingerprint } from '../../../src/tlog/leaf';
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

interface Fixture {
  readonly org: { id: string; ownerEmail: string };
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
  /** 프로비저닝 토큰 평문. */
  readonly token: string;
}

describe.skipIf(!AVAILABLE)('콘솔 v4 토큰·신원·통계 — atmark_admin 롤', () => {
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
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'tokens', localPart: `tok-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const payload = created.json() as { agent: { id: string; address: string }; token: string };
    return { org, session, agentId: payload.agent.id, address: payload.agent.address, token: payload.token };
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

  async function auditActions(orgId: string): Promise<Array<[string, string | null]>> {
    const rows = await owner.query<{ action: string; target_id: string | null }>(
      "SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.token.%' ORDER BY created_at, id",
      [orgId],
    );
    return rows.rows.map((row) => [row.action, row.target_id]);
  }

  /** 토큰 감사 행 + 그 감사 상세(`agent_api_key_events`) — 감사 순서대로. 상세가 없으면 key 는 `null`. */
  async function auditDetails(orgId: string): Promise<Array<{ action: string; key: string | null; old: string | null; new: string | null }>> {
    const rows = await owner.query<{ action: string; key_id: string | null; old_label: string | null; new_label: string | null }>(
      `SELECT o.action, e.key_id::text AS key_id, e.old_label, e.new_label
         FROM owner_actions o LEFT JOIN agent_api_key_events e ON e.owner_action_id = o.id
        WHERE o.organization_id = $1 AND o.action LIKE 'agent.token.%' ORDER BY o.created_at, o.id`,
      [orgId],
    );
    return rows.rows.map((row) => ({ action: row.action, key: row.key_id, old: row.old_label, new: row.new_label }));
  }

  it('풀은 정말 atmark_admin 이다 — 이 파일의 GRANT 단언이 공허하지 않다', async () => {
    const who = await admin.query<{ user: string }>('SELECT current_user AS user');
    expect(who.rows[0]?.user).toBe('atmark_admin');
  });

  it('수명: 목록(프로비저닝 토큰 · 끝 4자) → 새 토큰 4개 → 6번째 409 → 한 개 폐기(나머지 유효) → 멱등 → 다시 발급 → 전체 보기 → 이름 바꾸기', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;

    // 프로비저닝 토큰도 끝 4자를 가진다(이름은 없다).
    const first = (await ok(f.session, 'GET', base)) as { tokens: TokenItem[]; activeCount: number; maxActive: number };
    expect(first.activeCount).toBe(1);
    expect(first.maxActive).toBe(MAX_ACTIVE_TOKENS_PER_AGENT);
    expect(first.tokens).toHaveLength(1);
    expect(first.tokens[0]).toMatchObject({ label: null, hint: f.token.slice(-4), status: 'active', revokedAt: null, lastUsedAt: null });
    expect(first.tokens[0]?.capabilities.sort()).toEqual(['agent:read_self', 'audit:read', 'messages:read', 'messages:send', 'policy:request']);

    // 새 토큰 4개(이름 · 만료 선택) — 평문은 응답 한 번.
    const issued: Array<{ token: string; item: TokenItem }> = [];
    for (const [index, expiresDays] of [30, 90, 365, null].entries()) {
      const body = expiresDays === null ? { label: `tok-${String(index)}` } : { label: `  tok-${String(index)}  `, expiresDays };
      const created = (await ok(f.session, 'POST', base, { body }, 201)) as { token: string; item: TokenItem };
      expect(created.token).toMatch(/^atk_agent_[A-Za-z0-9_-]{43}$/);
      expect(created.item).toMatchObject({ label: `tok-${String(index)}`, hint: created.token.slice(-4), status: 'active' });
      expect(created.item.expiresAt === null).toBe(expiresDays === null);
      issued.push(created);
    }

    // 6번째 — 상한.
    const sixth = await call(deps, 'POST', base, authed(f.session, { body: { label: 'one-too-many' } }));
    expect(sixth.statusCode, sixth.body).toBe(409);
    expect(sixth.json()).toMatchObject({ error: 'token_limit' });
    // CLI 발급 함수도 같은 상한(같은 함수 — 표면 동일).
    await expect(issueAgentTokenOp(owner, toAgentId(f.agentId), { capabilities: resolveCapabilities(undefined), expiresAt: null })).rejects.toMatchObject({ code: 'token_limit' });

    // 평문은 목록·DB 어디에도 없다.
    const listed = await call(deps, 'GET', base, authed(f.session));
    const rows = await owner.query<Record<string, unknown>>('SELECT * FROM agent_api_keys WHERE agent_id = $1', [f.agentId]);
    for (const { token } of [...issued, { token: f.token }]) {
      expect(listed.body).not.toContain(token.slice('atk_agent_'.length, -4));
      expect(JSON.stringify(rows.rows)).not.toContain(token.slice('atk_agent_'.length));
    }
    expect(listed.body).not.toMatch(/token_hash|tokenHash/);
    expect((listed.json() as { activeCount: number }).activeCount).toBe(5);

    // 모두 인증된다.
    for (const { token } of [...issued, { token: f.token }]) expect(await authenticates(token)).toBe('ok');

    // 한 개 폐기 → 그것만 거부, 나머지 유효.
    const target = issued[1];
    if (target === undefined) throw new Error('fixture');
    const revoked = (await ok(f.session, 'POST', `${base}/${target.item.id}/revoke`)) as { item: TokenItem };
    expect(revoked.item).toMatchObject({ id: target.item.id, status: 'revoked', label: 'tok-1' });
    expect(revoked.item.revokedAt).not.toBeNull();
    expect(await authenticates(target.token)).toBe('token_revoked');
    for (const { token } of [...issued.filter((entry) => entry !== target), { token: f.token }]) expect(await authenticates(token)).toBe('ok');

    // 두 번째 폐기 — 같은 응답(폐기 시각 불변) · 감사 추가 없음.
    const again = (await ok(f.session, 'POST', `${base}/${target.item.id}/revoke`, { body: {} })) as { item: TokenItem };
    expect(again.item).toEqual(revoked.item);

    // 폐기로 자리가 났다 — 다시 발급된다.
    await ok(f.session, 'POST', base, { body: { label: 'replacement' } }, 201);

    // 활성 보기 vs 전체 보기.
    const active = (await ok(f.session, 'GET', base, { query: 'status=active' })) as { tokens: TokenItem[] };
    expect(active.tokens.map((item) => item.status)).toEqual(Array(5).fill('active'));
    expect(active.tokens.map((item) => item.id)).not.toContain(target.item.id);
    const all = (await ok(f.session, 'GET', base, { query: 'status=all' })) as { tokens: TokenItem[]; activeCount: number };
    expect(all.tokens).toHaveLength(6);
    expect(all.tokens.find((item) => item.id === target.item.id)?.status).toBe('revoked');
    // 활성이 먼저, 그 안에서 최신순.
    expect(all.tokens.map((item) => item.status)).toEqual([...Array(5).fill('active'), 'revoked']);
    const created = all.tokens.slice(0, 5).map((item) => item.createdAt);
    expect(created).toEqual([...created].sort().reverse());

    // 이름 바꾸기 — 활성 토큰만(폐기된 토큰은 409 token_not_active, 이름 그대로 · 감사 없음) · 같은 이름은 감사 없음.
    const onRevoked = await call(deps, 'PATCH', `${base}/${target.item.id}`, authed(f.session, { body: { label: 'old laptop' } }));
    expect(onRevoked.statusCode, onRevoked.body).toBe(409);
    expect(onRevoked.json()).toMatchObject({ error: 'token_not_active' });
    expect((await owner.query('SELECT label FROM agent_api_keys WHERE id = $1', [target.item.id])).rows[0]?.label).toBe('tok-1');
    const keep = issued[0];
    if (keep === undefined) throw new Error('fixture');
    const renamed = (await ok(f.session, 'PATCH', `${base}/${keep.item.id}`, { body: { label: 'home laptop' } })) as { item: TokenItem };
    expect(renamed.item).toMatchObject({ id: keep.item.id, label: 'home laptop', status: 'active', hint: keep.item.hint });
    await ok(f.session, 'PATCH', `${base}/${keep.item.id}`, { body: { label: 'home laptop' } });

    // 감사: 발급 5(4 + 교체분 1) · 폐기 1 · 이름 1 — 대상은 에이전트 id(에이전트 로그 필터에 걸린다), 토큰 평문 없음.
    expect(await auditActions(f.org.id)).toEqual([
      ...Array(4).fill(['agent.token.issue', f.agentId]),
      ['agent.token.revoke', f.agentId],
      ['agent.token.issue', f.agentId],
      ['agent.token.rename', f.agentId],
    ]);
    // 감사 상세(L1): 폐기 · 이름 바꾸기 행은 어느 토큰인지(+ 이름 전·후)를 가리킨다. 발급은 상세 없음.
    expect(await auditDetails(f.org.id)).toEqual([
      ...Array(4).fill({ action: 'agent.token.issue', key: null, old: null, new: null }),
      { action: 'agent.token.revoke', key: target.item.id, old: null, new: null },
      { action: 'agent.token.issue', key: null, old: null, new: null },
      { action: 'agent.token.rename', key: keep.item.id, old: 'tok-0', new: 'home laptop' },
    ]);
    // admin 롤은 상세를 적기만 한다(읽기·고치기·지우기 없음).
    await expect(admin.query('SELECT 1 FROM agent_api_key_events LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(owner.query('UPDATE agent_api_key_events SET new_label = $1 WHERE key_id = $2', ['x', keep.item.id])).rejects.toThrow();
    await expect(owner.query('DELETE FROM agent_api_key_events WHERE key_id = $1', [keep.item.id])).rejects.toThrow();
    const consoleLog = (await ok(f.session, 'GET', '/api/logs', { query: `type=console&agent=${f.agentId}` })) as { items: Array<{ action: string }> };
    expect(consoleLog.items.map((item) => item.action)).toContain('agent.token.revoke');
  });

  it('교체(rotate): 이름·끝 4자를 가진 새 토큰 1개 + item · 전부 폐기 · 활성 5개여도 교체는 된다', async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index += 1) await ok(f.session, 'POST', `/api/agents/${f.agentId}/tokens`, { body: { label: `t${String(index)}` } }, 201);
    const rotated = (await ok(f.session, 'POST', `/api/agents/${f.agentId}/token`, { body: { action: 'rotate', label: 'rotated' } })) as {
      revoked: number;
      token: string;
      item: TokenItem;
    };
    expect(rotated.revoked).toBe(5);
    expect(rotated.item).toMatchObject({ label: 'rotated', hint: rotated.token.slice(-4), status: 'active' });
    // 생략 → 기본 권한(전부).
    expect([...rotated.item.capabilities].sort()).toEqual(['agent:read_self', 'audit:read', 'messages:read', 'messages:send', 'policy:request']);
    expect(await authenticates(rotated.token)).toBe('ok');
    expect(await authenticates(f.token)).toBe('token_revoked');
    const bad = await call(deps, 'POST', `/api/agents/${f.agentId}/token`, authed(f.session, { body: { action: 'revoke-all', label: 'x' } }));
    expect(bad.statusCode).toBe(400);
    const badCaps = await call(deps, 'POST', `/api/agents/${f.agentId}/token`, authed(f.session, { body: { action: 'revoke-all', capabilities: ['messages:read'] } }));
    expect(badCaps.statusCode).toBe(400);
    expect(badCaps.json()).toMatchObject({ error: 'invalid_body' });
    expect(await ok(f.session, 'POST', `/api/agents/${f.agentId}/token`, { body: { action: 'revoke-all' } })).toEqual({ revoked: 1 });
    expect(((await ok(f.session, 'GET', `/api/agents/${f.agentId}/tokens`)) as { activeCount: number }).activeCount).toBe(0);
  });

  it('교체(rotate) 권한: 명시한 빈 목록·모양 아닌 값은 400 invalid_capability 이고 아무것도 폐기·발급하지 않는다 · 좁힌 목록은 그대로 쓴다', async () => {
    const f = await fixture();
    const path = `/api/agents/${f.agentId}/token`;
    for (const capabilities of [[], [''], 'messages:send', [7], ['policy:write']]) {
      const result = await call(deps, 'POST', path, authed(f.session, { body: { action: 'rotate', capabilities } }));
      expect(result.statusCode, JSON.stringify(capabilities)).toBe(400);
      expect(result.json(), JSON.stringify(capabilities)).toMatchObject({ error: 'invalid_capability' });
    }
    expect(await authenticates(f.token)).toBe('ok');
    const listed = (await ok(f.session, 'GET', `/api/agents/${f.agentId}/tokens`)) as { activeCount: number; tokens: TokenItem[] };
    expect(listed.activeCount).toBe(1);
    expect(listed.tokens).toHaveLength(1);
    const narrow = (await ok(f.session, 'POST', path, { body: { action: 'rotate', capabilities: ['messages:read'] } })) as { revoked: number; token: string; item: TokenItem };
    expect(narrow.revoked).toBe(1);
    expect(narrow.item.capabilities).toEqual(['messages:read']);
    expect(await authenticates(f.token)).toBe('token_revoked');
  });

  it('범위: 다른 조직 → 404 agent_not_found · 같은 조직 다른 에이전트의 토큰 · 없는 id · 모양 아닌 id → 404 token_not_found', async () => {
    const a = await fixture();
    const sibling = await fixture({ org: a.org, session: a.session });
    const b = await fixture();
    const siblingTokens = (await ok(a.session, 'GET', `/api/agents/${sibling.agentId}/tokens`)) as { tokens: TokenItem[] };
    const siblingTokenId = siblingTokens.tokens[0]?.id ?? '';

    for (const [method, path] of [
      ['GET', `/api/agents/${b.agentId}/tokens`],
      ['POST', `/api/agents/${b.agentId}/tokens`],
      ['POST', `/api/agents/${b.agentId}/tokens/${siblingTokenId}/revoke`],
      ['PATCH', `/api/agents/${b.agentId}/tokens/${siblingTokenId}`],
    ] as const) {
      const result = await call(deps, method, path, authed(a.session, method === 'GET' ? {} : { body: { label: 'x' } }));
      expect(result.statusCode, `${method} ${path}`).toBe(404);
      expect(result.json()).toMatchObject({ error: 'agent_not_found' });
    }
    for (const tokenId of [siblingTokenId, randomUUID(), 'not-a-uuid']) {
      const revoke = await call(deps, 'POST', `/api/agents/${a.agentId}/tokens/${tokenId}/revoke`, authed(a.session));
      expect(revoke.statusCode, tokenId).toBe(404);
      expect(revoke.json()).toMatchObject({ error: 'token_not_found' });
      const rename = await call(deps, 'PATCH', `/api/agents/${a.agentId}/tokens/${tokenId}`, authed(a.session, { body: { label: 'x' } }));
      expect(rename.statusCode, tokenId).toBe(404);
    }
    // 연산 자체도 에이전트 범위다 — 트랜잭션 롤백(라우트의 `audited`)에 기대지 않고, 자동 커밋 풀에서 불러도 남의 토큰을 건드리지 않는다.
    await expect(revokeAgentTokenOp(owner, toAgentId(a.agentId), siblingTokenId)).rejects.toMatchObject({ code: 'token_not_found' });
    await expect(renameAgentTokenOp(owner, toAgentId(a.agentId), siblingTokenId, 'hijack')).rejects.toMatchObject({ code: 'token_not_found' });
    // 형제 에이전트의 토큰은 그대로 살아 있다(이름도 그대로).
    expect(await authenticates(sibling.token)).toBe('ok');
    const siblingRow = await owner.query<{ label: string | null }>('SELECT label FROM agent_api_keys WHERE id = $1', [siblingTokenId]);
    expect(siblingRow.rows[0]?.label).toBeNull();
    // CSRF — 새 경로도 변경 요청이면 헤더가 필요하다.
    const noCsrf = await call(deps, 'POST', `/api/agents/${a.agentId}/tokens`, { cookies: a.session.cookies, body: { label: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('입력 검사: 이름 없음·빈 값·61자·보이지 않는 문자·제어 문자 · 모르는 키 · 권한 값 · 만료 · status 값', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const cases: Array<[unknown, string]> = [
      [{}, 'invalid_label'],
      [{ label: '   ' }, 'invalid_label'],
      [{ label: 'x'.repeat(61) }, 'invalid_label'],
      [{ label: 'a​b' }, 'invalid_label'],
      [{ label: 'a‮b' }, 'invalid_label'],
      [{ label: 'a\nb' }, 'invalid_label'],
      [{ label: 7 }, 'invalid_label'],
      [{ label: 'ok', scope: 'all' }, 'invalid_body'],
      [{ label: 'ok', capabilities: ['policy:write'] }, 'invalid_capability'],
      [{ label: 'ok', capabilities: 'messages:send' }, 'invalid_capability'],
      // 2026-09-25 핫픽스(fail-open): 명시한 빈 목록은 "권한 없음" 이지 "기본(전권)" 이 아니다 — 거부한다.
      [{ label: 'ok', capabilities: [] }, 'invalid_capability'],
      [{ label: 'ok', capabilities: [''] }, 'invalid_capability'],
      [{ label: 'ok', expiresDays: 0 }, 'invalid_expiry'],
    ];
    for (const [body, code] of cases) {
      const result = await call(deps, 'POST', base, authed(f.session, { body }));
      expect(result.statusCode, JSON.stringify(body)).toBe(400);
      expect(result.json(), JSON.stringify(body)).toMatchObject({ error: code });
    }
    // 거부된 요청은 토큰을 만들지 않았다(프로비저닝 토큰 1개 그대로).
    expect(((await ok(f.session, 'GET', base)) as { activeCount: number }).activeCount).toBe(1);
    // 60자 한글 이름 · 좁힌 권한은 된다.
    const narrow = (await ok(f.session, 'POST', base, { body: { label: '가'.repeat(60), capabilities: ['messages:read'] } }, 201)) as { item: TokenItem };
    expect(narrow.item.capabilities).toEqual(['messages:read']);
    const status = await call(deps, 'GET', base, authed(f.session, { query: 'status=revoked' }));
    expect(status.statusCode).toBe(400);
    expect(status.json()).toMatchObject({ error: 'invalid_status' });
  });

  it('DB 가드: hint·권한 불변(모든 롤) · admin 은 label 만 · 이름 CHECK · 활성 5 트리거(직접 INSERT)', async () => {
    const f = await fixture();
    const key = (await owner.query<{ id: string }>('SELECT id FROM agent_api_keys WHERE agent_id = $1', [f.agentId])).rows[0]?.id ?? '';
    await expect(owner.query("UPDATE agent_api_keys SET hint = 'AAAA' WHERE id = $1", [key])).rejects.toThrow(/immutable column agent_api_keys\.hint/);
    await expect(owner.query("UPDATE agent_api_keys SET capabilities = '{messages:send}' WHERE id = $1", [key])).rejects.toThrow(/immutable/);
    await expect(admin.query("UPDATE agent_api_keys SET hint = 'AAAA' WHERE id = $1", [key])).rejects.toThrow(/permission denied/);
    await expect(admin.query('UPDATE agent_api_keys SET expires_at = now() WHERE id = $1', [key])).rejects.toThrow(/permission denied/);
    await admin.query("UPDATE agent_api_keys SET label = 'admin-can' WHERE id = $1", [key]);
    await expect(app.query("UPDATE agent_api_keys SET label = 'app-cannot' WHERE id = $1", [key])).rejects.toThrow(/permission denied/);
    await expect(owner.query("UPDATE agent_api_keys SET label = E'a\\u200Bb' WHERE id = $1", [key])).rejects.toThrow(/agent_api_keys_label_check/);
    await expect(owner.query("UPDATE agent_api_keys SET label = ' padded' WHERE id = $1", [key])).rejects.toThrow(/agent_api_keys_label_check/);

    const insert = (hint: string | null, expired = false): Promise<unknown> =>
      owner.query(
        `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, hint, expires_at, created_at)
         VALUES ($1, $2, '{messages:send}', $3, CASE WHEN $4 THEN now() - interval '1 day' END, CASE WHEN $4 THEN now() - interval '2 days' ELSE now() END)`,
        [f.agentId, createHash('sha256').update(randomUUID()).digest('hex'), hint, expired],
      );
    await expect(insert('abc')).rejects.toThrow(/agent_api_keys_hint_check/);
    // 만료된 토큰은 세지 않는다 — 활성 1개(프로비저닝) 옆에 만료 5개가 있어도 활성 4개를 더 넣을 수 있다.
    for (let index = 0; index < 5; index += 1) await insert(null, true);
    for (let index = 0; index < 4; index += 1) await insert(null);
    // 소유자 롤도 여섯 번째 활성은 못 넣는다(트리거 — 코드 밖 경로).
    await expect(insert(null)).rejects.toThrow(/max 5/);
    const list = (await ok(f.session, 'GET', `/api/agents/${f.agentId}/tokens`, { query: 'status=all' })) as { tokens: TokenItem[]; activeCount: number };
    expect(list.activeCount).toBe(5);
    expect(list.tokens.filter((item) => item.status === 'expired')).toHaveLength(5);
  });

  it('이름 문자 집합: 실제 CHECK(agent_api_keys_label_check)가 거부하는 글자는 앱(isValidTokenLabel)도 전부 거부한다(→ SQL 전에 400, 500 아님)', async () => {
    // 식을 카탈로그에서 그대로 가져와 평가한다(문자 집합을 테스트에 다시 적지 않는다). 앞뒤를 보통 글자로 감싸 문자 집합만 본다.
    const def = await owner.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'agent_api_keys'::regclass AND conname = 'agent_api_keys_label_check'",
    );
    const expression = /^CHECK \((.*)\)$/s.exec(def.rows[0]?.def ?? '')?.[1];
    expect(expression, 'agent_api_keys_label_check 가 없다').toBeDefined();
    const rejected = await owner.query<{ cp: number }>(
      `SELECT cp FROM (SELECT cp, 'a' || chr(cp) || 'b' AS label FROM generate_series(1, 1114111) AS cp WHERE cp NOT BETWEEN 55296 AND 57343) v
        WHERE NOT (${expression ?? 'true'})`,
    );
    const dbRejected = rejected.rows.map((row) => row.cp);
    expect(dbRejected).toContain(0x200b);
    expect(dbRejected.length).toBeGreaterThan(50);
    const leaked = dbRejected.filter((cp) => isValidTokenLabel(`a${String.fromCodePoint(cp)}b`));
    expect(leaked.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)).toEqual([]);
    // 길이: DB 가 거부하는 61자를 앱도 거부한다.
    expect(isValidTokenLabel('가'.repeat(61))).toBe(false);
    const long = await owner.query<{ ok: boolean }>(`SELECT (${expression ?? 'true'}) AS ok FROM (SELECT repeat('가', 61) AS label) v`);
    expect(long.rows[0]?.ok).toBe(false);
  }, 60_000);

  it('신원: 목록·신원 응답의 keyFingerprint = sha256(원시 공개키) · identityStatus draft · DID·URL 없음(B5)', async () => {
    const f = await fixture();
    const keypair = await owner.query<{ public_key: string; algorithm: string }>('SELECT public_key, algorithm::text AS algorithm FROM agent_keypairs WHERE agent_id = $1', [
      f.agentId,
    ]);
    const expected = publicKeyFingerprint(keypair.rows[0]?.public_key ?? '');
    expect(expected).toMatch(/^[0-9a-f]{64}$/);

    const list = await call(deps, 'GET', '/api/agents', authed(f.session));
    const agents = list.json() as Array<{ id: string; identityStatus: string | null; keyFingerprint: string | null }>;
    expect(agents.find((agent) => agent.id === f.agentId)).toMatchObject({ identityStatus: 'draft', keyFingerprint: expected });
    expect(list.body).not.toMatch(/did:|identity\.atmark|\.well-known/);

    const identity = (await ok(f.session, 'GET', `/api/agents/${f.agentId}/identity`)) as Record<string, unknown>;
    expect(identity).toMatchObject({ status: 'draft', did: null, didDocumentUrl: null, keyFingerprint: expected, keyAlgorithm: keypair.rows[0]?.algorithm });

    // 신원 블록 API 의 card 와 같은 값.
    const blocks = (await ok(f.session, 'GET', `/api/agents/${f.agentId}/identity-blocks`)) as { card: { keyFingerprint: string } };
    expect(blocks.card.keyFingerprint).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // 통계
  // -------------------------------------------------------------------------

  async function policyVersionId(agentId: string): Promise<string> {
    const row = await owner.query<{ id: string }>('SELECT id FROM policy_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1', [agentId]);
    return row.rows[0]?.id ?? '';
  }

  async function outbound(f: Fixture, state: 'sent' | 'failed' | 'denied' | 'queued', at: Date = new Date()): Promise<void> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [f.agentId]);
    const status = state === 'queued' ? 'pending' : state;
    const message = await owner.query<{ id: string }>(
      `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, subject, status, message_id_header,
                             idempotency_key, request_hash, recipient_count, created_at, ses_message_id, sent_at, failure_reason, failed_at)
       VALUES ($1, $2, 'outbound', $3, split_part($4, '@', 2), 'stats', $5::message_status, $6, $7, $8, 1, $9,
               CASE WHEN $5 = 'sent' THEN $10 END, CASE WHEN $5 = 'sent' THEN now() END,
               CASE WHEN $5 = 'failed' THEN 'ses_rejected' END, CASE WHEN $5 = 'failed' THEN now() END)
       RETURNING id`,
      [
        f.agentId,
        thread.rows[0]?.id,
        createHash('sha256').update(f.address, 'utf8').digest('hex'),
        f.address,
        status,
        `<${randomUUID()}@atmark.test>`,
        `idem-${randomUUID()}`,
        createHash('sha256').update(randomUUID()).digest('hex'),
        at,
        `ses-${randomUUID()}`,
      ],
    );
    const messageId = message.rows[0]?.id ?? '';
    await owner.query('INSERT INTO outbound_recipients (message_id, address) VALUES ($1, $2)', [messageId, 'to@example.com']);
    await owner.query(
      `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version)
       VALUES ($1, $2, $3::audit_decision, $4::text[], $5, 1)`,
      [f.agentId, messageId, state === 'denied' ? 'denied' : 'allowed', state === 'denied' ? ['recipient_not_allowlisted'] : [], await policyVersionId(f.agentId)],
    );
  }

  async function inbound(f: Fixture, quarantined: boolean, at: Date = new Date()): Promise<void> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    await owner.query(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, $2, $3, $4, 'no_header_ids', 'sender@partner.example', 'partner.example', false, 'hello', false, 'pass', 'pass', 'fail', 'pass',
               'pass', false, 'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, $5,
               'test-v0', $6::injection_risk, $7, 'unknown')`,
      [f.agentId, f.address, ses, thread.rows[0]?.id, at, quarantined ? 'high' : 'none', quarantined],
    );
  }

  async function rejection(recipients: string[]): Promise<void> {
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    await owner.query(
      `INSERT INTO inbound_rejections (ses_message_id, reason, detail, envelope_recipients, virus_verdict, spam_verdict, raw_storage_key, received_at)
       VALUES ($1, 'virus', 'detail', $2::text[], 'fail', 'pass', 'inbound/raw/' || $1, now())`,
      [ses, recipients],
    );
  }

  it('통계: 판정별 발신 · 전달/격리/거부 수신 · 창 밖 제외 · 다른 조직 제외 · agent 필터 · byAgent · days 검사', async () => {
    const a = await fixture();
    const a2 = await fixture({ org: a.org, session: a.session });
    const b = await fixture();
    const old = new Date(Date.now() - 8 * 86_400_000);

    await outbound(a, 'sent');
    await outbound(a, 'sent');
    await outbound(a, 'denied');
    await outbound(a, 'failed');
    await outbound(a2, 'queued');
    await outbound(a2, 'sent');
    await outbound(a, 'sent', old); // 7일 창 밖
    await outbound(b, 'sent'); // 다른 조직
    await inbound(a, false);
    await inbound(a, true);
    await inbound(a2, false);
    await inbound(a, false, old); // 창 밖
    await inbound(b, false); // 다른 조직
    await rejection([a.address]);
    await rejection([b.address]); // 다른 조직

    const org = (await ok(a.session, 'GET', '/api/stats')) as Record<string, unknown>;
    expect(org).toMatchObject({
      days: 7,
      agentId: null,
      outbound: { total: 6, sent: 3, denied: 1, pending: 0, failed: 1, sending: 0, queued: 1 },
      inbound: { total: 4, delivered: 2, quarantined: 1, rejected: 1 },
      byAgent: [
        { agentId: a.agentId, sent: 2, received: 2 },
        { agentId: a2.agentId, sent: 1, received: 1 },
      ],
    });
    expect(Date.parse(String(org['since']))).toBeLessThan(Date.now() - 7 * 86_400_000 + 60_000);

    // 30일 창은 옛 행까지.
    expect(await ok(a.session, 'GET', '/api/stats', { query: 'days=30' })).toMatchObject({ outbound: { total: 7, sent: 4 }, inbound: { delivered: 3 } });

    // 에이전트 필터 — byAgent 없음 · 거부는 그 에이전트 주소만.
    const one = (await ok(a.session, 'GET', '/api/stats', { query: `agent=${a2.agentId}` })) as Record<string, unknown>;
    expect(one).toMatchObject({ agentId: a2.agentId, outbound: { total: 2, sent: 1, queued: 1 }, inbound: { total: 1, delivered: 1, rejected: 0 } });
    expect(one).not.toHaveProperty('byAgent');

    // 다른 조직의 에이전트 → 404 · days 값 밖 → 400.
    const cross = await call(deps, 'GET', '/api/stats', authed(a.session, { query: `agent=${b.agentId}` }));
    expect(cross.statusCode).toBe(404);
    for (const days of ['0', '14', 'x', '7.0', '']) {
      const bad = await call(deps, 'GET', '/api/stats', authed(a.session, { query: `days=${days}` }));
      expect(bad.statusCode, days).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid_days' });
    }
  });

  it('/api/me memberships — 현재 조직 한 행(owner)', async () => {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    expect(await ok(session, 'GET', '/api/me')).toMatchObject({ memberships: [{ organizationId: org.id, role: 'owner' }] });
  });

  it('M1 — 목록 상한이 활성 토큰을 숨기지 않는다: 끝난 토큰 60개(더 새것) + 가장 오래된 활성 토큰 → 활성이 먼저 · 상한 = 끝난 토큰 상한 + 활성 상한', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    // 프로비저닝 토큰(가장 오래됨, 활성) 뒤에 폐기 30 · 만료 30 — 모두 더 새것.
    await owner.query(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, created_at, revoked_at, expires_at)
       SELECT $1, encode(sha256(convert_to($2 || g::text, 'UTF8')), 'hex'), ARRAY['messages:send']::agent_token_capability[],
              now() + make_interval(secs => g), CASE WHEN g % 2 = 0 THEN now() END, CASE WHEN g % 2 = 1 THEN now() - interval '1 second' END
         FROM generate_series(1, 60) g`,
      [f.agentId, randomUUID()],
    );
    const all = (await ok(f.session, 'GET', base, { query: 'status=all' })) as { tokens: TokenItem[]; activeCount: number };
    expect(all.activeCount).toBe(1);
    expect(all.tokens).toHaveLength(TOKEN_LIST_MAX_ROWS + MAX_ACTIVE_TOKENS_PER_AGENT);
    expect(all.tokens[0]).toMatchObject({ hint: f.token.slice(-4), status: 'active' });
    expect(all.tokens.filter((item) => item.status === 'active')).toHaveLength(all.activeCount);
    // 끝난 토큰은 그 뒤 최신순.
    const ended = all.tokens.slice(1).map((item) => item.createdAt);
    expect(ended).toEqual([...ended].sort().reverse());
    const active = (await ok(f.session, 'GET', base, { query: 'status=active' })) as { tokens: TokenItem[] };
    expect(active.tokens.map((item) => item.hint)).toEqual([f.token.slice(-4)]);
  });

  it('L1 — 만료된 토큰도 이름 바꾸기 409 token_not_active · ops 함수도 같은 거부(표면 동일)', async () => {
    const f = await fixture();
    const expired = await owner.query<{ id: string }>(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, created_at, expires_at, label)
       VALUES ($1, $2, ARRAY['messages:send']::agent_token_capability[], now() - interval '2 days', now() - interval '1 day', 'stale') RETURNING id::text AS id`,
      [f.agentId, createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const id = expired.rows[0]?.id ?? '';
    const result = await call(deps, 'PATCH', `/api/agents/${f.agentId}/tokens/${id}`, authed(f.session, { body: { label: 'fresh' } }));
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ error: 'token_not_active' });
    await expect(renameAgentTokenOp(admin, toAgentId(f.agentId), id, 'fresh')).rejects.toMatchObject({ code: 'token_not_active', status: 409 });
    expect((await owner.query('SELECT label FROM agent_api_keys WHERE id = $1', [id])).rows[0]?.label).toBe('stale');
    expect(await auditActions(f.org.id)).toEqual([]);
  });

  it('L2 — 조직당 분당 토큰 변경 상한 → 429 rate_limited(발급 · 폐기 · 이름 바꾸기 모두, 아무것도 바뀌지 않는다) · 다른 조직은 무관', async () => {
    const f = await fixture();
    const base = `/api/agents/${f.agentId}/tokens`;
    const created = (await ok(f.session, 'POST', base, { body: { label: 'r-0' } }, 201)) as { item: TokenItem };
    for (let index = 1; index < TOKEN_CHANGES_PER_MINUTE; index += 1) {
      await ok(f.session, 'PATCH', `${base}/${created.item.id}`, { body: { label: `r-${String(index)}` } });
    }
    expect(await auditActions(f.org.id)).toHaveLength(TOKEN_CHANGES_PER_MINUTE);
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['POST', base, { label: 'one-more' }],
      ['POST', `${base}/${created.item.id}/revoke`, {}],
      ['PATCH', `${base}/${created.item.id}`, { label: 'late' }],
    ];
    for (const [method, path, body] of attempts) {
      const limited = await call(deps, method, path, authed(f.session, { body }));
      expect(limited.statusCode, `${method} ${path} → ${limited.body}`).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    }
    const row = await owner.query<{ label: string; revoked: boolean }>('SELECT label, revoked_at IS NOT NULL AS revoked FROM agent_api_keys WHERE id = $1', [created.item.id]);
    expect(row.rows[0]).toEqual({ label: `r-${String(TOKEN_CHANGES_PER_MINUTE - 1)}`, revoked: false });
    expect(await auditActions(f.org.id)).toHaveLength(TOKEN_CHANGES_PER_MINUTE);
    // 조회는 상한 밖 · 다른 조직은 따로 센다.
    await ok(f.session, 'GET', base);
    const other = await fixture();
    await ok(other.session, 'POST', `/api/agents/${other.agentId}/tokens`, { body: { label: 'elsewhere' } }, 201);
  });

  it('L2 — 통계는 조직당 한 번에 하나: 같은 조직 계산이 돌고 있으면 429 rate_limited · 풀리면 200 · 다른 조직은 무관', async () => {
    const f = await fixture();
    const other = await fixture();
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin_stats:' || $1::text, 0))`, [f.org.id]);
      const busy = await call(deps, 'GET', '/api/stats', authed(f.session));
      expect(busy.statusCode, busy.body).toBe(429);
      expect(busy.json()).toMatchObject({ error: 'rate_limited' });
      const elsewhere = await call(deps, 'GET', '/api/stats', authed(other.session));
      expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await ok(f.session, 'GET', '/api/stats');
  });
});
