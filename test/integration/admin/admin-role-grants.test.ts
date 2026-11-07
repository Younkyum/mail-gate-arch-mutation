/**
 * **관리 API 전 경로가 `atmark_admin` 롤의 GRANT 안에서 돈다** (ADR-0006 · 검증 H2) — 운영 admin Lambda 의 롤과 같은 롤로
 * 라우터를 부른다. 소유자 롤로만 돌리면 202609230720 의 GRANT 가 모자라도 전부 초록이다 — 여기서 빨개져야 배포 전에 안다.
 *
 * 덮는 경로: 로그인 요청·verify · me · 에이전트 목록·생성 · 토큰 교체·전부 폐기 · 정책 조회·변경 · 목록 더하기·지우기(정책 v2) · 발신자 분류
 * 기록·조회 · 승인 대기 조회 · 게이트 시작·조회·전달·개입 · 에이전트·조직 정지 · 로그아웃. 실메일 0 · AWS 호출 0.
 * (조직 생성은 CLI 전용 — 소유자 롤. 여기서는 테스트 지반으로만 쓴다.)
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix } from './support';

describe.skipIf(!AVAILABLE)('관리 API — atmark_admin 롤의 GRANT 안에서 (ADR-0006)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
  });

  it('풀은 정말 atmark_admin 이다(소유자·슈퍼유저 아님) — 이 파일의 단언이 공허하지 않다', async () => {
    const who = await admin.query<{ user: string; superuser: string }>(`SELECT current_user AS user, current_setting('is_superuser') AS superuser`);
    expect(who.rows[0]).toEqual({ user: 'atmark_admin', superuser: 'off' });
  });

  it('전 경로: 로그인 → me → 에이전트·토큰·정책·목록 → 발신자 분류 → 승인 대기 → 게이트 → 정지 → 로그아웃', async () => {
    const deps = adminDeps(admin);
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const ok = async (method: string, path: string, options: Parameters<typeof authed>[1] = {}, expected = 200): Promise<unknown> => {
      const result = await call(deps, method, path, authed(session, options));
      expect(result.statusCode, `${method} ${path} → ${result.body}`).toBe(expected);
      return result.json();
    };

    expect(await ok('GET', '/api/me')).toMatchObject({ organization: { id: org.id } });
    const created = (await ok('POST', '/api/agents', { body: { name: 'grants', localPart: `grants-${suffix()}` } }, 201)) as {
      agent: { id: string };
    };
    const agentId = created.agent.id;
    expect(await ok('GET', '/api/agents')).toHaveLength(1);

    expect(await ok('POST', `/api/agents/${agentId}/token`, { body: { action: 'rotate', expiresDays: 30 } })).toMatchObject({ revoked: 1 });
    expect(await ok('POST', `/api/agents/${agentId}/token`, { body: { action: 'revoke-all' } })).toMatchObject({ revoked: 1 });

    expect(await ok('GET', `/api/agents/${agentId}/policy`)).toMatchObject({ outbound: { mode: 'all', allow: [] }, inbound: { mode: 'all' } });
    expect(
      await ok('PATCH', `/api/agents/${agentId}/policy`, { body: { outbound: { mode: 'blocklist' }, inbound: { mode: 'allowlist' }, limits: { perMinute: 2 } } }),
    ).toMatchObject({ outbound: { mode: 'blocklist' }, inbound: { mode: 'allowlist' }, limits: { per_minute: 2 } });
    // 정책 v2 목록 — 더하기(INSERT 칸 단위) · 지우기(removed_at 표시 — DELETE 권한 없음, 202609241020).
    const added = (await ok('POST', `/api/agents/${agentId}/rules`, { body: { direction: 'outbound', list: 'allow', value: 'friend@example.com' } }, 201)) as {
      rule: { id: string };
    };
    await ok('POST', `/api/agents/${agentId}/rules`, { body: { direction: 'inbound', list: 'block', value: '*.spam.example' } }, 201);
    expect(await ok('DELETE', `/api/agents/${agentId}/rules/${added.rule.id}`)).toMatchObject({
      policy: { outbound: { allow: [] }, inbound: { block: [{ value: '*.spam.example' }] } },
    });

    await ok('POST', '/api/senders', { body: { agentId, address: 'newsletter@service.example', mark: 'seen' } }, 201);
    expect(await ok('GET', '/api/senders', { query: `agent=${agentId}` })).toHaveLength(1);

    expect(await ok('GET', '/api/approvals', { query: 'status=pending' })).toEqual([]);

    const gate = (await ok('POST', '/api/gate/start', { body: { agentId, humanMailboxes: ['founder@example.com'] } }, 201)) as { gateId: string };
    await ok('POST', '/api/gate/forwarding', { body: { gateId: gate.gateId, state: 'on' } }, 201);
    await ok('POST', '/api/gate/intervention', { body: { gateId: gate.gateId, category: 'agent_gap', reason: 'grants probe' } }, 201);
    expect(await ok('GET', '/api/gate', { query: `agent=${agentId}` })).toMatchObject({ ambiguous: false });

    await ok('POST', '/api/kill-switch', { body: { scope: 'agent', id: agentId, on: true } });
    await ok('POST', '/api/kill-switch', { body: { scope: 'org', id: org.id, on: true } });

    const out = await call(deps, 'POST', '/api/logout', authed(session));
    expect(out.statusCode).toBe(204);

    // 감사는 전부 atmark_admin 이 적었다(INSERT 만 있는 테이블) — 읽기는 소유자 셸.
    const actions = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1', [org.id]);
    expect(actions.rows[0]?.n).toBeGreaterThan(10);
  });
});
