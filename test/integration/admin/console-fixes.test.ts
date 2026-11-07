/**
 * **관리 콘솔 검증 결함의 회귀 — 실제 Postgres 위에서** (H3 · M1 · M2 · M4 · L1 · L3 · L4 · L5 · U1 · U3 백엔드). 실메일 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - H3  콘솔은 플랫폼 동결(`abuse_freeze`)·운영자 정지를 풀 수 없다 · 콘솔 조직 정지는 `owner_paused` · Stage 0 이 읽는다
 *   - M1  감사 INSERT 가 실패하면 행위도 롤백된다(토큰 교체·에이전트 생성·조직 정지·전체 로그아웃)
 *   - M2  한 요청자는 (조직, 요청자) 몫 3개만 태운다 — 소유자의 요청은 링크를 받는다 · 조직 상한은 20
 *   - L1  같은 요청자의 동시 30건 → 정확히 10건만 받는다 · 신뢰 밖 다른 요청자 동시 25건 → 링크 정확히 2개(15분 창)
 *   - M4  조직당 에이전트 10개(동시 요청 포함) · CLI 도 같은 코드 · 서비스 예약 로컬파트
 *   - L3  HSTS · L4 보안 사건 로그(값 없음) · L5 모든 세션 로그아웃 · owner_email 변경 시 세션 폐기
 *   - U3  논스 쿠키가 **없는** 브라우저는 `login_browser_missing`(토큰과 무관하게 같은 응답 · 링크를 태우지 않는다)
 *   - U1  게이트가 있는데 새로 열면 409 `gate_exists`(CLI 문구 없음) · `newGate` 로 따로 연다 · 둘이면 ambiguous ·
 *         `GET /api/gate` 판정에 `nextSteps` 코드(`next` 와 같은 줄)가 실린다
 *   - 관리 롤(`atmark_admin`)의 GRANT 안에서 새 SQL 이 돈다
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { agentProvision } from '../../../scripts/admin/agent-provision';
import type { AdminIo } from '../../../scripts/admin/common';
import { killSwitch } from '../../../scripts/admin/kill-switch';
import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE } from '../../../src/admin/http';
import { PLAN_CATALOG } from '../../../src/billing/plans';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { browserBindingOf } from '../../../src/admin/session';
import {
  LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR,
  LOGIN_REQUESTS_PER_CLIENT,
  LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW,
} from '../../../src/security/login-limits';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { toAgentId } from '../../../src/db/schema';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  adminDeps,
  adminRolePool,
  appPool,
  authed,
  AVAILABLE,
  call,
  cookieValue,
  drainLoginMail,
  login,
  loginMailerPool,
  newOrganization,
  OWNER_URL,
  ownerPool,
  suffix,
  codeFromMail,
  uniqueCodeIp,
  type Session,
} from './support';
import { recordTlogCapabilities } from '../db/support/harness';

/** beta 요금제의 에이전트 한도(비활성 제외) — ADR-0011 전의 조직 상한 10 과 같다. */
const BETA_AGENTS = PLAN_CATALOG.beta.maxAgents;

const keyDir = mkdtempSync(resolve(tmpdir(), 'atmark-console-fix-keys-'));
const cliEnv = (): NodeJS.ProcessEnv => ({ DATABASE_MIGRATION_URL: OWNER_URL, ATMARK_DEV_KEY_DIR: keyDir, USER: 'console-fix-test' });
function cliIo(): AdminIo {
  return { out: () => undefined, err: () => undefined, interactive: false, ask: async () => '' };
}
async function cliCode(run: Promise<number>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AdminInputError) return error.code;
    throw error;
  }
  return 'ok';
}

/** 감사 INSERT 만 실패시키는 풀 — 풀 직접 문장과 트랜잭션 커넥션 문장 **둘 다** 본다(고치기 전 코드는 풀로 감사를 적었다). */
function failingAudit(pool: Pool): Pool {
  const isAudit = (text: unknown): boolean => typeof text === 'string' && text.includes('INSERT INTO owner_actions');
  const failure = (): Promise<never> => Promise.reject(new Error('모의 감사 실패(Lambda 시간 초과 등)'));
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') return (text: string, values?: unknown[]) => (isAudit(text) ? failure() : target.query(text, values));
      if (property === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
          return Object.assign(Object.create(client) as PoolClient, {
            query: (text: string, values?: unknown[]) => (isAudit(text) ? failure() : query(text, values)),
            release: () => client.release(),
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const randomIp = (): string => `198.18.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}-${suffix()}`;

describe.skipIf(!AVAILABLE)('관리 콘솔 검증 결함 — 회귀', () => {
  let owner: Pool;
  let mailer: Pool;
  beforeAll(async () => {
    await recordTlogCapabilities();
    owner = ownerPool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.end();
    await mailer.end();
  });
  afterEach(() => {
    resetLogSink();
  });

  async function orgWithSession(): Promise<{ org: { id: string; ownerEmail: string }; session: Session }> {
    const org = await newOrganization(owner);
    return { org, session: await login(adminDeps(owner), mailer, org) };
  }

  async function createAgent(session: Session, prefix = 'fix'): Promise<string> {
    const created = await call(adminDeps(owner), 'POST', '/api/agents', authed(session, { body: { name: prefix, localPart: `${prefix}-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { agent: { id: string } }).agent.id;
  }

  // -------------------------------------------------------------------------
  // H3 — 소유자 정지 ≠ 플랫폼 동결
  // -------------------------------------------------------------------------

  it('H3 조직: 운영자 동결(abuse_freeze)은 콘솔로 풀리지 않는다 · 콘솔 정지는 owner_paused · Stage 0 소스가 둘을 따로 읽는다', async () => {
    const { org, session } = await orgWithSession();
    const agentId = await createAgent(session);
    // 운영자 CLI 가 동결한다.
    expect(await killSwitch(['--org', org.id, 'on', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    const me1 = await call(adminDeps(owner), 'GET', '/api/me', authed(session));
    expect((me1.json() as { orgKillSwitch: unknown }).orgKillSwitch).toEqual({ ownerPaused: false, platformFrozen: true, active: true });

    // 콘솔의 "해제" — 소유자 정지가 없으니 아무것도 바꾸지 않는다. 동결은 그대로.
    const off = await call(adminDeps(owner), 'POST', '/api/kill-switch', authed(session, { body: { scope: 'org', id: org.id, on: false } }));
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ changed: false });
    const frozen = await owner.query<{ abuse_freeze: boolean; owner_paused: boolean }>('SELECT abuse_freeze, owner_paused FROM organizations WHERE id = $1', [org.id]);
    expect(frozen.rows[0]).toEqual({ abuse_freeze: true, owner_paused: false });

    // 콘솔 정지 → owner_paused 만. 운영자가 동결을 풀어도 소유자 정지는 남는다.
    const on = await call(adminDeps(owner), 'POST', '/api/kill-switch', authed(session, { body: { scope: 'org', id: org.id, on: true } }));
    expect(on.json()).toMatchObject({ changed: true });
    expect(await killSwitch(['--org', org.id, 'off', '--reason', 'test unfreeze', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    const after = await owner.query<{ abuse_freeze: boolean; owner_paused: boolean }>('SELECT abuse_freeze, owner_paused FROM organizations WHERE id = $1', [org.id]);
    expect(after.rows[0]).toEqual({ abuse_freeze: false, owner_paused: true });

    // 관문의 실제 소스가 owner_paused 를 싣는다(Stage 0 `org_owner_paused` 는 단위 테스트 — stages.test.ts).
    const loaded = await createPostgresPolicySource(owner).load({ agentId: toAgentId(agentId), recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    expect(loaded.organization).toMatchObject({ owner_paused: true, abuse_freeze: false });

    // 감사: 바꾼 것만(changed:false 는 행이 없다).
    const audit = await owner.query<{ action: string }>(`SELECT action FROM owner_actions WHERE organization_id = $1 AND action LIKE 'kill_switch.%'`, [org.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['kill_switch.org.on']);
  });

  it('H3 에이전트: 운영자 정지는 콘솔로 풀리지 않는다(409 operator_suspension) · 소유자 정지는 CLI 가 풀지 않는다 · CLI 는 넘겨받는다', async () => {
    const { session } = await orgWithSession();
    const agentId = await createAgent(session);
    const deps = adminDeps(owner);
    const statusOf = async (): Promise<unknown> =>
      (await owner.query<{ status: string; suspended_by: string | null }>('SELECT status, suspended_by FROM agents WHERE id = $1', [agentId])).rows[0];

    // 운영자 정지 → 콘솔 해제 거부.
    expect(await killSwitch(['--agent', agentId, 'on', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    expect(await statusOf()).toEqual({ status: 'suspended', suspended_by: 'operator' });
    const lift = await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: false } }));
    expect(lift.statusCode).toBe(409);
    expect(lift.json()).toMatchObject({ error: 'operator_suspension' });
    expect(await statusOf()).toEqual({ status: 'suspended', suspended_by: 'operator' });
    // 콘솔 "정지" 는 운영자 정지를 넘겨받지 않는다.
    const again = await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: true } }));
    expect(again.json()).toMatchObject({ changed: false, suspendedBy: 'operator' });
    const listed = await call(deps, 'GET', '/api/agents', authed(session));
    expect((listed.json() as { id: string; suspendedBy: unknown }[]).find((a) => a.id === agentId)?.suspendedBy).toBe('operator');

    // 운영자가 풀고, 소유자가 정지 → CLI 해제는 거부(owner_suspension) · CLI 정지는 넘겨받는다.
    expect(await killSwitch(['--agent', agentId, 'off', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    const ownerOn = await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: true } }));
    expect(ownerOn.json()).toMatchObject({ changed: true, suspendedBy: 'owner' });
    expect(await cliCode(killSwitch(['--agent', agentId, 'off', '--yes'], { env: cliEnv(), io: cliIo() }))).toBe('owner_suspension');
    expect(await statusOf()).toEqual({ status: 'suspended', suspended_by: 'owner' });
    expect(await killSwitch(['--agent', agentId, 'on', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    expect(await statusOf()).toEqual({ status: 'suspended', suspended_by: 'operator' });
    expect((await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: false } }))).statusCode).toBe(409);

    // 소유자 자기 정지는 소유자가 푼다.
    expect(await killSwitch(['--agent', agentId, 'off', '--yes'], { env: cliEnv(), io: cliIo() })).toBe(0);
    await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: true } }));
    const ownerOff = await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: false } }));
    expect(ownerOff.json()).toMatchObject({ changed: true, status: 'active', suspendedBy: null });

    // DB 바닥: 정지 주체 없는 정지·주체 있는 활성은 CHECK 가 거부한다.
    await expect(owner.query(`UPDATE agents SET status = 'suspended' WHERE id = $1`, [agentId])).rejects.toThrow(/agents_suspended_by_matches_status/);
    await expect(owner.query(`UPDATE agents SET suspended_by = 'owner' WHERE id = $1`, [agentId])).rejects.toThrow(/agents_suspended_by_matches_status/);
  });

  // -------------------------------------------------------------------------
  // M1 — 행위와 감사는 한 트랜잭션
  // -------------------------------------------------------------------------

  it('M1 토큰 교체: 감사 INSERT 가 실패하면 500 이고 토큰 집합은 요청 전 그대로다(옛 토큰 살아 있음 · 새 토큰 없음)', async () => {
    const { session } = await orgWithSession();
    const agentId = await createAgent(session);
    const keys = async (): Promise<unknown[]> =>
      (await owner.query('SELECT token_hash, revoked_at FROM agent_api_keys WHERE agent_id = $1 ORDER BY token_hash', [agentId])).rows;
    const before = await keys();
    const result = await call(adminDeps(failingAudit(owner)), 'POST', `/api/agents/${agentId}/token`, authed(session, { body: { action: 'rotate' } }));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toMatch(/atk_agent_/);
    expect(await keys()).toEqual(before);
    const audit = await owner.query(`SELECT 1 FROM owner_actions WHERE target_id = $1 AND action LIKE 'agent.token%'`, [agentId]);
    expect(audit.rowCount).toBe(0);
  });

  it('M1 생성·조직 정지·에이전트 정지·전체 로그아웃: 감사가 실패하면 흔적이 없다', async () => {
    const { org, session } = await orgWithSession();
    const agentId = await createAgent(session);
    const faulty = adminDeps(failingAudit(owner));
    const agentsBefore = await owner.query('SELECT 1 FROM agents WHERE organization_id = $1', [org.id]);

    const created = await call(faulty, 'POST', '/api/agents', authed(session, { body: { name: 'lost', localPart: `lost-${suffix()}` } }));
    expect(created.statusCode).toBe(500);
    expect(created.body).not.toMatch(/atk_agent_/);
    expect((await owner.query('SELECT 1 FROM agents WHERE organization_id = $1', [org.id])).rowCount).toBe(agentsBefore.rowCount);

    expect((await call(faulty, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'org', id: org.id, on: true } }))).statusCode).toBe(500);
    expect((await owner.query<{ p: boolean }>('SELECT owner_paused AS p FROM organizations WHERE id = $1', [org.id])).rows[0]?.p).toBe(false);

    expect((await call(faulty, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: true } }))).statusCode).toBe(500);
    expect((await owner.query<{ s: string }>('SELECT status AS s FROM agents WHERE id = $1', [agentId])).rows[0]?.s).toBe('active');

    expect((await call(faulty, 'POST', '/api/logout-all', authed(session))).statusCode).toBe(500);
    expect((await call(adminDeps(owner), 'GET', '/api/me', authed(session))).statusCode).toBe(200);

    const audit = await owner.query<{ action: string }>('SELECT action FROM owner_actions WHERE organization_id = $1 ORDER BY created_at', [org.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['session.login', 'agent.create']);
  });

  // -------------------------------------------------------------------------
  // M2 · L1 — 로그인 링크 상한
  // -------------------------------------------------------------------------

  it('M2 한 요청자가 10번 요청해도 링크는 2개(신뢰 밖 15분 몫) — 소유자(이 주소로 로그인한 적 있는 요청자)의 요청은 링크를 받고 메일이 나간다', async () => {
    const org = await newOrganization(owner);
    const deps = adminDeps(owner);
    const ownerIp = randomIp();
    // 소유자가 평소 IP 에서 한 번 로그인했다 — 그 IP 는 신뢰 IP 다.
    const first = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: ownerIp });
    const firstNonce = cookieValue(first, LOGIN_BROWSER_COOKIE) ?? '';
    const [firstMail] = await drainLoginMail(mailer, org.id);
    expect(
      (await call(deps, 'POST', '/api/login/verify', { body: { code: firstMail === undefined ? '' : codeFromMail(firstMail) }, cookies: { [LOGIN_BROWSER_COOKIE]: firstNonce }, ip: uniqueCodeIp() }))
        .statusCode,
    ).toBe(200);
    const attacker = randomIp();
    for (let i = 0; i < LOGIN_REQUESTS_PER_CLIENT; i += 1) {
      expect((await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: attacker })).statusCode).toBe(202);
    }
    await drainLoginMail(mailer, org.id);
    const attackerLinks = (await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1 AND used_at IS NULL', [org.id])).rowCount;

    // 소유자의 요청(신뢰 IP)은 링크를 받는다 — 공격자가 신뢰 밖 몫을 다 써도.
    const mine = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: ownerIp });
    const nonce = cookieValue(mine, LOGIN_BROWSER_COOKIE) ?? '';
    const link = await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1 AND browser_binding = $2', [org.id, browserBindingOf(nonce)]);
    expect(link.rowCount).toBe(1);
    expect(attackerLinks).toBe(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW);
    const mails = await drainLoginMail(mailer, org.id);
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    const verified = await call(deps, 'POST', '/api/login/verify', {
      body: { code: mail === undefined ? '' : codeFromMail(mail) },
      cookies: { [LOGIN_BROWSER_COOKIE]: nonce },
      ip: uniqueCodeIp(),
    });
    expect(verified.statusCode).toBe(200);
  });

  it('L1 같은 요청자의 동시 30건 → 정확히 10건 202 · 20건 429 · 링크 2개(신뢰 밖 15분 몫)', async () => {
    const org = await newOrganization(owner);
    const deps = adminDeps(owner);
    const ip = randomIp();
    const results = await Promise.all(Array.from({ length: 30 }, () => call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip })));
    const statuses = results.map((result) => result.statusCode);
    expect(statuses.filter((status) => status === 202)).toHaveLength(LOGIN_REQUESTS_PER_CLIENT);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30 - LOGIN_REQUESTS_PER_CLIENT);
    const links = await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [org.id]);
    expect(links.rowCount).toBe(Math.min(LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR, LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW));
  });

  it('L1·M2 주소 상한: 신뢰 밖 서로 다른 요청자 동시 25건 → 링크 정확히 2개(15분 창 · 응답은 전부 같은 202)', async () => {
    const org = await newOrganization(owner);
    const deps = adminDeps(owner);
    const results = await Promise.all(Array.from({ length: 25 }, () => call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail }, ip: randomIp() })));
    expect(results.every((result) => result.statusCode === 202)).toBe(true);
    const links = await owner.query('SELECT 1 FROM owner_login_links WHERE organization_id = $1', [org.id]);
    expect(links.rowCount).toBe(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW);
  });

  // -------------------------------------------------------------------------
  // M4 — 조직당 에이전트 상한 · 예약 로컬파트
  // -------------------------------------------------------------------------

  it('M4 조직당 에이전트 = 요금제 한도(beta 10) — 동시 12건이면 정확히 10건 · 11번째는 409 agent_limit · CLI 도 같은 코드', async () => {
    const { org, session } = await orgWithSession();
    const deps = adminDeps(owner);
    const results = await Promise.all(
      Array.from({ length: BETA_AGENTS + 2 }, (_, i) =>
        call(deps, 'POST', '/api/agents', authed(session, { body: { name: `cap-${String(i)}`, localPart: `cap-${suffix()}` } })),
      ),
    );
    const statuses = results.map((result) => result.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(BETA_AGENTS);
    expect(statuses.filter((status) => status === 409)).toHaveLength(2);
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({ error: 'agent_limit' });
    expect((await owner.query('SELECT 1 FROM agents WHERE organization_id = $1', [org.id])).rowCount).toBe(BETA_AGENTS);
    const local = `cli-cap-${suffix()}`;
    expect(await cliCode(agentProvision(['--org', org.id, '--name', local, '--local-part', local], { env: cliEnv(), io: cliIo() }))).toBe('agent_limit');
  });

  it('M4 서비스 예약 로컬파트(support·login·billing·admin·console…)는 콘솔에서 만들 수 없다', async () => {
    const { session } = await orgWithSession();
    for (const localPart of ['support', 'login', 'billing', 'admin', 'console', 'security', 'notify', 'Atmark']) {
      const result = await call(adminDeps(owner), 'POST', '/api/agents', authed(session, { body: { name: 'squat', localPart } }));
      expect(result.statusCode, localPart).toBe(400);
      expect(result.json(), localPart).toMatchObject({ error: 'invalid_local_part' });
    }
  });

  it('AI 에이전트 이름 예약(claude-code·codex·hermes·openclaw…)도 콘솔에서 만들 수 없다 — 홈 예시 주소 사칭 방지', async () => {
    const { session } = await orgWithSession();
    for (const localPart of ['claude-code', 'codex', 'hermes', 'OpenClaw', 'anthropic']) {
      const result = await call(adminDeps(owner), 'POST', '/api/agents', authed(session, { body: { name: 'squat', localPart } }));
      expect(result.statusCode, localPart).toBe(400);
      expect(result.json(), localPart).toMatchObject({ error: 'invalid_local_part' });
    }
  });

  // -------------------------------------------------------------------------
  // L3 · L4 · L5
  // -------------------------------------------------------------------------

  it('L3 모든 관리 응답에 HSTS(2년 · 하위 도메인)', async () => {
    const { session } = await orgWithSession();
    const deps = adminDeps(owner);
    for (const result of [
      await call(deps, 'GET', '/'),
      await call(deps, 'GET', '/login'),
      await call(deps, 'GET', '/api/me', authed(session)),
      await call(deps, 'GET', '/api/nope'),
      await call(deps, 'POST', '/api/login', { body: { email: 'x@example.com' } }),
    ]) {
      expect(result.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    }
  });

  it('L4 보안 사건은 값 없이 한 줄 — CSRF·출처 불일치·교차 조직 탐침·링크 거부 · 이메일·id·토큰 원문 없음', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const { session } = await orgWithSession();
    const other = await orgWithSession();
    const otherAgent = await createAgent(other.session, 'victim');
    const deps = adminDeps(owner);
    await call(deps, 'POST', '/api/kill-switch', { body: { scope: 'org', id: 'x', on: true }, cookies: session.cookies });
    await call(deps, 'POST', '/api/kill-switch', authed(session, { body: {}, headers: { origin: 'https://evil.example' } }));
    await call(deps, 'GET', '/api/agents/' + otherAgent + '/policy', authed(session));
    await call(deps, 'GET', '/api/gate', authed(session, { query: 'gate=00000000-0000-0000-0000-000000000000' }));
    await call(deps, 'POST', '/api/login/verify', { body: { code: '000000' }, cookies: { [LOGIN_BROWSER_COOKIE]: 'Q'.repeat(43) }, ip: uniqueCodeIp() });
    await call(deps, 'POST', '/api/login/verify', { body: { token: 'atk_login_garbage' }, cookies: { [LOGIN_BROWSER_COOKIE]: 'Q'.repeat(43) } });
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['event'] === 'admin.security');
    expect(events.map((entry) => entry['error_code'])).toEqual(['csrf_mismatch', 'origin_mismatch', 'agent_not_found', 'gate_not_found', 'login_code_invalid', 'login_link_retired']);
    expect(events[0]).toMatchObject({ route_id: 'admin:/api/kill-switch', level: 'warn' });
    expect(String(events[0]?.['detail'])).toMatch(/^session:[0-9a-f]{16}$/);
    const joined = events.map((entry) => JSON.stringify(entry)).join('\n');
    for (const secret of [otherAgent, session.token, other.org.ownerEmail, session.csrf]) expect(joined).not.toContain(secret);
  });

  it('L5 모든 세션 로그아웃: CSRF 필요 · 두 세션 모두 폐기 · 감사 1행 · 쿠키 삭제', async () => {
    const org = await newOrganization(owner);
    const deps = adminDeps(owner);
    const first = await login(deps, mailer, org);
    const second = await login(deps, mailer, org);
    expect((await call(deps, 'POST', '/api/logout-all', { cookies: first.cookies })).statusCode).toBe(403);
    const out = await call(deps, 'POST', '/api/logout-all', authed(first));
    expect(out.statusCode).toBe(204);
    expect((out.cookies ?? [])[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=; Path=/; .*Max-Age=0$`));
    expect((await call(deps, 'GET', '/api/me', authed(first))).statusCode).toBe(401);
    expect((await call(deps, 'GET', '/api/me', authed(second))).statusCode).toBe(401);
    const live = await owner.query('SELECT 1 FROM owner_sessions WHERE organization_id = $1 AND revoked_at IS NULL', [org.id]);
    expect(live.rowCount).toBe(0);
    const audit = await owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'session.logout_all'`, [org.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('L5 owner_email 이 바뀌면 그 조직의 살아 있는 세션이 전부 폐기된다(DB 트리거 — 다른 조직은 그대로)', async () => {
    const { org, session } = await orgWithSession();
    const bystander = await orgWithSession();
    await owner.query('UPDATE organizations SET name = name WHERE id = $1', [org.id]);
    expect((await call(adminDeps(owner), 'GET', '/api/me', authed(session))).statusCode).toBe(200);
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [org.id, `new-owner-${suffix()}@example.com`]);
    expect((await call(adminDeps(owner), 'GET', '/api/me', authed(session))).statusCode).toBe(401);
    expect((await call(adminDeps(owner), 'GET', '/api/me', authed(bystander.session))).statusCode).toBe(200);
    // 앱 롤은 owner_email 을 아예 바꿀 수 없다(202609230730 — api 탈취가 로그인 링크를 자기 메일함으로 돌리는 길). 세션도 그대로.
    const app = appPool();
    try {
      await expect(
        app.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [bystander.org.id, `moved-${suffix()}@example.com`]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    expect((await call(adminDeps(owner), 'GET', '/api/me', authed(bystander.session))).statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // U3 — 다른 브라우저
  // -------------------------------------------------------------------------

  it('U3 논스 쿠키가 없는 브라우저: 401 login_browser_missing — 맞는·틀린 코드가 같은 응답 · 시도를 태우지 않는다 · 다른 논스는 login_code_invalid', async () => {
    const org = await newOrganization(owner);
    const deps = adminDeps(owner);
    const requested = await call(deps, 'POST', '/api/login', { body: { email: org.ownerEmail } });
    const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE) ?? '';
    const [mail] = await drainLoginMail(mailer, org.id);
    const code = mail === undefined ? '' : codeFromMail(mail);
    const valid = await call(deps, 'POST', '/api/login/verify', { body: { code }, ip: uniqueCodeIp() });
    const garbage = await call(deps, 'POST', '/api/login/verify', { body: { code: code === '000000' ? '111111' : '000000' }, ip: uniqueCodeIp() });
    expect([valid.statusCode, garbage.statusCode]).toEqual([401, 401]);
    expect(valid.body).toBe(garbage.body);
    expect(valid.json()).toMatchObject({ error: 'login_browser_missing' });
    const wrong = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: 'Z'.repeat(43) }, ip: uniqueCodeIp() });
    expect(wrong.json()).toMatchObject({ error: 'login_code_invalid' });
    const ok = await call(deps, 'POST', '/api/login/verify', { body: { code }, cookies: { [LOGIN_BROWSER_COOKIE]: nonce }, ip: uniqueCodeIp() });
    expect(ok.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // U1 — 게이트
  // -------------------------------------------------------------------------

  it('U1 게이트가 있는데 새로 열면 409 gate_exists(CLI 문구 없음) · newGate 로 따로 연다 · 둘이면 ambiguous', async () => {
    const { session } = await orgWithSession();
    const agentId = await createAgent(session);
    const deps = adminDeps(owner);
    const start = (extra: Record<string, unknown> = {}) =>
      call(deps, 'POST', '/api/gate/start', authed(session, { body: { agentId, humanMailboxes: ['founder@example.com'], ...extra } }));
    expect((await start()).statusCode).toBe(201);
    const single = await call(deps, 'GET', '/api/gate', authed(session, { query: `agent=${agentId}` }));
    expect(single.json()).toMatchObject({ ambiguous: false });
    // 다음 할 일은 CLI 문장(next)과 같은 줄의 코드(nextSteps)로도 내려간다 — 콘솔이 두 언어로 그린다.
    const verdict = (single.json() as { report: { verdict: { next: string[]; nextSteps: unknown[] } } }).report.verdict;
    expect(verdict.nextSteps).toEqual([{ code: 'forwarding_on_before_day1' }]);
    expect(verdict.next).toHaveLength(1);
    expect(verdict.next[0]).toContain('pnpm ac0:forwarding on');
    const dup = await start();
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'gate_exists' });
    expect(dup.body).not.toMatch(/pnpm|--new-gate|ac0:restart/);
    expect((await start({ newGate: true })).statusCode).toBe(201);
    const report = await call(deps, 'GET', '/api/gate', authed(session, { query: `agent=${agentId}` }));
    expect(report.json()).toMatchObject({ report: null, ambiguous: true });
    expect((report.json() as { gates: unknown[] }).gates).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 관리 롤 — 새 SQL 이 atmark_admin 의 GRANT 안에서 돈다
  // -------------------------------------------------------------------------

  it('atmark_admin 롤: 로그인 요청(잠금·client_key)·verify·조직 정지·에이전트 생성(상한 잠금)·정지·전체 로그아웃이 권한 안에서 돈다', async () => {
    const admin = adminRolePool();
    try {
      const deps = adminDeps(admin);
      const org = await newOrganization(owner);
      const session = await login(deps, mailer, org);
      const paused = await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'org', id: org.id, on: true } }));
      expect(paused.statusCode, paused.body).toBe(200);
      expect((await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'org', id: org.id, on: false } }))).statusCode).toBe(200);
      const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'role', localPart: `role-${suffix()}` } }));
      expect(created.statusCode, created.body).toBe(201);
      const agentId = (created.json() as { agent: { id: string } }).agent.id;
      expect((await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: true } }))).statusCode).toBe(200);
      expect((await call(deps, 'POST', '/api/kill-switch', authed(session, { body: { scope: 'agent', id: agentId, on: false } }))).statusCode).toBe(200);
      expect((await call(deps, 'POST', '/api/logout-all', authed(session))).statusCode).toBe(204);
      // 그리고 이 롤은 플랫폼 동결을 바꿀 수 없다(DB 가 한 번 더 막는다).
      await expect(admin.query('UPDATE organizations SET abuse_freeze = false WHERE id = $1', [org.id])).rejects.toThrow(/permission denied/);
    } finally {
      await admin.end();
    }
  });
});
