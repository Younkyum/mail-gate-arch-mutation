/**
 * 라우트 표의 **역할 칸** (확장성 P0 R-1 · 창업자 결정 F-1 · 계획 pre-mortem S3 "역할 누락 라우트"). DB 없음.
 *
 *   ① 표 스냅샷 — 세션 라우트는 전부 역할이 있고, 세션 없는 라우트는 역할이 없다.
 *   ② member 가 부를 수 있는 **변경** 라우트는 이름 붙은 허용 목록과 정확히 같다(새 변경 라우트가 member 에게 열리면 빨강) ·
 *      GET 은 사유 붙은 특권 목록(`PRIVILEGED_GETS` — 지금은 조직 키 목록 하나) 밖은 전부 member.
 *   ③ owner 전용 라우트 목록(멤버·초대 관리)이 정확히 같다.
 *   ④ 라우터가 실제로 막는다 — member 세션의 변경 요청은 핸들러에 닿기 전에 403 `forbidden_role {required}`(가짜 풀: 세션 조회만 답한다).
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AdminDependencies, MemberRole } from '../../../src/admin/context';
import { SESSION_COOKIE } from '../../../src/admin/http';
import { ADMIN_ROUTES, routeAdminEvent } from '../../../src/admin/router';
import { csrfTokenOf } from '../../../src/admin/session';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

const MEMBER_MUTATIONS = [
  // 개인 설정(202610101000) — 본인 행의 메일 언어 한 칸(조직 · 권한과 무관).
  'PATCH /api/me/preferences',
  'POST /api/logout',
  'POST /api/logout-all',
  'POST /api/members/leave',
  'POST /api/organizations',
  'POST /api/session/org',
].sort();

/**
 * member 보다 높은 역할이 필요한 **읽기** — 이름과 사유로만 늘린다. 새 특권 GET 이 조용히 생기지도, member GET 이 조용히 특권이 되지도 않게
 * 이 목록과 표가 정확히 같아야 한다.
 */
const PRIVILEGED_GETS: Readonly<Record<string, { readonly role: MemberRole; readonly reason: string }>> = {
  // WP-B 계약 B4 — 조직 API 키 목록은 키 끝 4자·권한·발급자를 드러낸다(리드 결정 2026-09-25).
  'GET /api/org-keys': { role: 'owner', reason: '조직 API 키 hint·capabilities 노출' },
  'GET /api/domains/{domainId}/connect': { role: 'admin', reason: 'DNS 업체에 바로 적용되는 서명된 URL(소유 증명 토큰 · DKIM) — 적용은 쓰기 동작(지금 확인과 같은 admin)' },
};

const OWNER_ONLY = [
  'DELETE /api/members/{userId}',
  'PATCH /api/members/{userId}',
  'POST /api/members/invites',
  'POST /api/members/invites/{inviteId}/revoke',
];

const key = (route: { method: string; path: string }): string => `${route.method} ${route.path}`;

describe('라우트 표 — 역할 칸', () => {
  it('① 세션 라우트는 전부 역할이 있고, 세션 없는 라우트는 역할이 없다', () => {
    for (const route of ADMIN_ROUTES) {
      if (route.auth === 'session') expect(route.role, key(route)).not.toBeNull();
      else expect(route.role, key(route)).toBeNull();
    }
  });

  it('② member 에게 열린 변경 라우트는 이름 붙은 허용 목록뿐이다 · GET 은 사유 붙은 특권 목록 밖은 전부 member', () => {
    const session = ADMIN_ROUTES.filter((route) => route.auth === 'session');
    const memberMutations = session.filter((route) => route.method !== 'GET' && route.role === 'member').map(key).sort();
    // 다른 패키지(WP-B)가 member 변경 라우트를 더하면 여기서 이름으로 드러난다 — 의도라면 목록에 올리고 리뷰에 건다.
    expect(memberMutations.filter((route) => !MEMBER_MUTATIONS.includes(route))).toEqual([]);
    for (const route of MEMBER_MUTATIONS) expect(memberMutations, route).toContain(route);
    const gets = session.filter((entry) => entry.method === 'GET');
    for (const route of gets) expect(route.role, key(route)).toBe(PRIVILEGED_GETS[key(route)]?.role ?? 'member');
    // 특권 GET 목록은 표와 정확히 같다(목록에만 있고 표에 없는 경로도 빨강 — 죽은 예외를 남기지 않는다).
    expect(gets.filter((route) => route.role !== 'member').map(key).sort()).toEqual(Object.keys(PRIVILEGED_GETS).sort());
    for (const [route, entry] of Object.entries(PRIVILEGED_GETS)) expect(entry.reason.length, route).toBeGreaterThan(0);
  });

  it('③ 멤버·초대 관리는 owner 전용 · kill-switch 는 admin(조직 해제는 핸들러가 owner 를 한 번 더)', () => {
    const byKey = new Map(ADMIN_ROUTES.map((route) => [key(route), route.role]));
    for (const route of OWNER_ONLY) expect(byKey.get(route), route).toBe('owner');
    expect(byKey.get('POST /api/kill-switch')).toBe('admin');
    expect(byKey.get('POST /api/agents')).toBe('admin');
  });

  it('③-3 AI 의심 메일 감시(ADR-0017) — 보기 member · 바꾸기 admin(켜기는 핸들러가 owner 를 한 번 더)', () => {
    const byKey = new Map(ADMIN_ROUTES.map((route) => [key(route), route.role]));
    expect(byKey.get('GET /api/settings/ai-watch')).toBe('member');
    expect(byKey.get('PATCH /api/settings/ai-watch')).toBe('admin');
  });

  it('③-2 웹훅 관리(2026-09-30) — 보기 둘은 member · 쓰기 넷(등록·삭제·시크릿 회전·재전송)은 admin 이상', () => {
    const byKey = new Map(ADMIN_ROUTES.map((route) => [key(route), route.role]));
    expect(byKey.get('GET /api/agents/{agentId}/webhooks')).toBe('member');
    expect(byKey.get('GET /api/agents/{agentId}/webhooks/deliveries')).toBe('member');
    for (const route of [
      'POST /api/agents/{agentId}/webhooks',
      'DELETE /api/agents/{agentId}/webhooks/{webhookId}',
      'POST /api/agents/{agentId}/webhooks/{webhookId}/rotate',
      'POST /api/agents/{agentId}/webhooks/deliveries/{deliveryId}/redeliver',
    ]) {
      expect(byKey.get(route), route).toBe('admin');
    }
  });
});

describe('라우터 — 역할 집행 (가짜 풀)', () => {
  function fakePool(role: MemberRole, calls: string[]): Pool {
    return {
      query: (sql: string) => {
        calls.push(sql);
        if (/FROM owner_sessions s\s+JOIN memberships m/.test(sql)) {
          return Promise.resolve({ rows: [{ id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333', role }], rowCount: 1 });
        }
        return Promise.reject(new Error(`예상 밖 SQL: ${sql.slice(0, 60)}`));
      },
    } as unknown as Pool;
  }

  function deps(pool: Pool): AdminDependencies {
    return {
      pool,
      loginKeys: parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST'),
      custody: () => {
        throw new Error('custody 를 부르면 안 된다');
      },
      outboundContent: createInMemoryContentStore(),
      now: () => new Date(),
    };
  }

  async function post(role: MemberRole, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; calls: string[] }> {
    const calls: string[] = [];
    const token = `atk_admin_${randomBytes(32).toString('base64url')}`;
    const result = await routeAdminEvent(deps(fakePool(role, calls)), {
      rawPath: path,
      headers: { 'content-type': 'application/json', 'x-atmark-csrf': csrfTokenOf(token) },
      cookies: [`${SESSION_COOKIE}=${token}`],
      body: JSON.stringify(body),
      requestContext: { requestId: 'req-roles', stage: '$default', http: { method: 'POST', sourceIp: '198.51.100.7' } },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown>, calls };
  }

  it('④ member 세션의 에이전트 생성 → 403 forbidden_role{required:admin} · 세션 조회 밖의 SQL 0', async () => {
    const result = await post('member', '/api/agents', { name: 'x', localPart: 'x' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'forbidden_role', required: 'admin' });
    expect(result.calls).toHaveLength(1);
  });

  it('④ admin 세션의 초대 → 403 forbidden_role{required:owner} · 대상 조회 전에 막힌다', async () => {
    const result = await post('admin', '/api/members/invites', { email: 'someone@example.com', role: 'member' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'forbidden_role', required: 'owner' });
    expect(result.calls).toHaveLength(1);
  });

  it('④ member 세션의 웹훅 등록·시크릿 회전 → 403 forbidden_role{required:admin} · 세션 조회 밖의 SQL 0(시크릿 파생 전)', async () => {
    for (const path of ['/api/agents/aaaa/webhooks', '/api/agents/aaaa/webhooks/0f3c9a52-6b1e-4d7a-9c2f-5e8b1a4d7c01/rotate']) {
      const result = await post('member', path, path.endsWith('/rotate') ? {} : { url: 'https://hooks.example.com/x' });
      expect(result.status, path).toBe(403);
      expect(result.body, path).toMatchObject({ error: 'forbidden_role', required: 'admin' });
      expect(result.calls, path).toHaveLength(1);
    }
  });

  it('④ 대조군: owner 세션은 역할 검사를 지나 핸들러로 간다(가짜 풀에 트랜잭션이 없어 500 — 403 이 아니다)', async () => {
    const result = await post('owner', '/api/members/invites', { email: 'someone@example.com', role: 'member' });
    expect(result.status).toBe(500);
    expect(result.body['error']).toBe('internal_error');
  });
});
