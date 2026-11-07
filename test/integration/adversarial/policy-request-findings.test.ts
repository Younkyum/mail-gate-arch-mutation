/**
 * 에이전트 정책 변경 요청(PR #90 — ADR-0007 2026-10-13) **적대 검증** — 실제 Postgres · 운영과 같은 롤 · 실제 라우트(REST `routeHttpApiEvent` · MCP · 콘솔 `routeAdminEvent`).
 *
 * 공격 하나 = 테스트 하나. 각 공격은 `attack(id, 벡터, 기대, 실행)` 으로 등록되고 결과(id · 기대 · 실제 · PASS/FAIL)가 `ATTACK_REPORT` 파일(JSON)에 남는다.
 * 모든 공격은 "정책이 바뀌지 않았다 · 요청 행이 생기지 않았다 · 새는 것이 없다" 를 DB 에서 다시 확인한다. 실메일 0 · AWS 0.
 *
 * 묶음: A 자가 승인 · 인증 경계 · DB 롤 · B 재생/위조 id · C 칸 밀수(닫힌 어휘) · D 주입(이유 · 값) · E 정보 누출 · F 경합 · G 위험 경고 · H 토큰 범위 · I 기본값 · J 알림 메일.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runReservedAddress, parseReservedAddressArgs } from '../../../scripts/admin/reserved-address';
import { classifyTarget, type AdminIo } from '../../../scripts/admin/common';
import { setAgentSuspendedOp } from '../../../src/admin/ops/agents';
import { transactionPool } from '../../../src/admin/ops/transaction';
import type { ApiRequest } from '../../../src/api/http';
import { handleCreatePolicyRequest, handleGetPolicyRequest, type PolicyRequestRouteDependencies } from '../../../src/api/routes/policy-requests';
import { createPool } from '../../../src/db/client';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories';
import { createPostgresPolicyRequestStore } from '../../../src/db/repositories/policy-request-store';
import { hashAgentToken, issueAgentToken, ENROLLED_AGENT_TOKEN_CAPABILITIES } from '../../../src/identity/agent-token';
import { createQuarantineNotifier } from '../../../src/notify/quarantine-notifier';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { runQuarantineNotifier } from '../../../src/workers/quarantine-notifier';
import { adminDeps, ADMIN_ROLE_URL, adminRolePool, APP_URL, appPool, authed, AVAILABLE, call, fakeSes, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, rolledBack, seedFixture, testPool } from '../db/support/harness';
import { closeConsoleKit, sessionFor } from './watch-d-support';
import { enrollCall, enrollWorld } from './watch-d-enroll-support';

interface Row {
  id: string;
  vector: string;
  expected: string;
  actual: string;
  verdict: 'PASS' | 'FAIL';
}
const rows: Row[] = [];

function attack(id: string, vector: string, expected: string, run: () => Promise<string | void>): void {
  it(`${id} ${vector}`, async () => {
    try {
      const actual = (await run()) ?? expected;
      rows.push({ id, vector, expected, actual, verdict: 'PASS' });
    } catch (error) {
      rows.push({ id, vector, expected, actual: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 260), verdict: 'FAIL' });
      throw error;
    }
  });
}

describe.skipIf(!AVAILABLE || !DATABASE_AVAILABLE)('PR #90 적대 검증 — 발견 사항(현재 실패 = 취약, 수정되면 통과)', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let wideAdmin: Pool;
  let wideApp: Pool;
  let mailer: Pool;
  let app: Pool;
  let api: PolicyRequestRouteDependencies;
  let wideApi: PolicyRequestRouteDependencies;
  const deps = () => adminDeps(admin);
  const wideDeps = () => adminDeps(wideAdmin);

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    wideAdmin = createPool(ADMIN_ROLE_URL, { max: 14 });
    wideApp = createPool(APP_URL, { max: 24 });
    mailer = loginMailerPool();
    app = appPool();
    api = { tokens: createPostgresAgentTokenStore(app), policyRequests: createPostgresPolicyRequestStore(app), now: () => new Date() };
    wideApi = { tokens: createPostgresAgentTokenStore(wideApp), policyRequests: createPostgresPolicyRequestStore(wideApp), now: () => new Date() };
  });
  afterAll(async () => {
    const path = process.env['ATTACK_REPORT'];
    if (path !== undefined && path !== '') writeFileSync(path, JSON.stringify(rows, null, 1));
    await Promise.all([owner.end(), admin.end(), wideAdmin.end(), wideApp.end(), mailer.end(), app.end()]);
    await closeConsoleKit();
    await closeTestPool();
  });

  // ---------------------------------------------------------------------------------------------------- 도구
  interface Fixture {
    readonly orgId: string;
    readonly session: Session;
    readonly agentId: string;
    readonly address: string;
    readonly token: string;
  }
  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    const session = await login(deps(), mailer, org);
    const created = await call(deps(), 'POST', '/api/agents', authed(session, { body: { name: 'requester', localPart: `pa-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { agent: { id: string; address: string }; token: string };
    return { orgId: org.id, session, agentId: body.agent.id, address: body.agent.address, token: body.token };
  }
  /** 같은 조직에 에이전트 하나 더(조직 안의 다른 에이전트 경계). */
  async function siblingAgent(f: Fixture): Promise<{ agentId: string; token: string }> {
    const created = await call(deps(), 'POST', '/api/agents', authed(f.session, { body: { name: 'sibling', localPart: `sb-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { agent: { id: string }; token: string };
    return { agentId: body.agent.id, token: body.token };
  }
  async function tokenWith(agentId: string, capabilities: Parameters<typeof issueAgentToken>[1], expiresAt: Date | null = null): Promise<string> {
    const issued = issueAgentToken(agentId as never, capabilities);
    await createPostgresAgentTokenStore(owner).insert({ agentId: agentId as never, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt });
    return issued.plaintext;
  }

  const ADD_PARTNER = { action: 'add_rule', direction: 'outbound', list: 'allow', value: 'partner@example.com', reason: 'The owner asked me to email the partner.' };
  type Json = Record<string, unknown>;

  function bearer(token: string, body?: unknown): ApiRequest {
    return { headers: { authorization: `Bearer ${token}` }, query: {}, body };
  }
  async function request(token: string, body: unknown, agentId = 'me', via: PolicyRequestRouteDependencies = api) {
    const response = await handleCreatePolicyRequest(via, bearer(token, body), { agentId });
    return { status: response.status, body: response.body as Json };
  }

  /** 진짜 REST 라우터 — 본문 한도 · JSON 파싱 · 경로 표를 지난다. */
  function untouchable(label: string): never {
    return new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : (() => { throw new Error(`${label}.${String(p)}`); })()) }) as never;
  }
  function apiDeps(via: PolicyRequestRouteDependencies = api): ApiDependencies {
    return new Proxy(
      { inboundRead: { tokens: via.tokens, now: () => new Date() }, policyRequests: via },
      { get: (target, property: string) => (property in target ? (target as Record<string, unknown>)[property] : untouchable(property)) },
    ) as unknown as ApiDependencies;
  }
  async function rest(token: string | null, method: string, path: string, body?: unknown, extra: { raw?: string; headers?: Record<string, string>; b64?: boolean } = {}) {
    const raw = extra.raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const result = await routeHttpApiEvent(apiDeps(), {
      rawPath: path,
      rawQueryString: '',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(extra.headers ?? {}) },
      ...(raw === undefined ? {} : { body: extra.b64 === true ? Buffer.from(raw).toString('base64') : raw }),
      isBase64Encoded: extra.b64 === true,
      requestContext: { requestId: 'req-adv', stage: '$default', http: { method } },
    });
    let json: Json = {};
    try {
      json = JSON.parse(result.body) as Json;
    } catch {
      json = { _raw: result.body };
    }
    return { status: result.statusCode, json, text: result.body };
  }
  async function mcp(token: string, body: unknown) {
    const result = await routeHttpApiEvent(apiDeps(), {
      rawPath: '/mcp',
      rawQueryString: '',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: { requestId: 'req-mcp', stage: '$default', http: { method: 'POST' } },
    });
    return { status: result.statusCode, json: JSON.parse(result.body || '{}') as { result?: { isError?: boolean; content?: { text: string }[]; tools?: { name: string }[] }; error?: { message: string } } };
  }
  const mcpCall = (token: string, name: string, args: Json) => mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  async function list(f: Fixture, status = 'pending') {
    const got = await call(deps(), 'GET', `/api/agents/${f.agentId}/change-requests`, authed(f.session, { query: `status=${status}` }));
    expect(got.statusCode, got.body).toBe(200);
    return got.json() as { items: Json[]; currentVersion: number };
  }
  async function decide(f: Fixture, requestId: string, decision: 'approve' | 'reject', expectedVersion?: number, session: Session = f.session, via = deps()) {
    const body = decision === 'approve' ? { expectedVersion: expectedVersion ?? (await list(f)).currentVersion } : undefined;
    const result = await call(via, 'POST', `/api/agents/${f.agentId}/change-requests/${requestId}/${decision}`, authed(session, body === undefined ? {} : { body }));
    return { status: result.statusCode, body: result.json() as Json };
  }
  async function policyOf(f: Fixture) {
    const got = await call(deps(), 'GET', `/api/agents/${f.agentId}/policy`, authed(f.session));
    return got.json() as { outbound: { mode: string; allow: { value: string }[]; block: { value: string }[] }; inbound: { mode: string; allow: { value: string }[]; block: { value: string }[] }; version: number };
  }
  async function requestRows(agentId: string): Promise<number> {
    return (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM policy_change_requests WHERE agent_id = $1', [agentId])).rows[0]?.n ?? -1;
  }
  async function statusOf(id: string): Promise<string> {
    return (await owner.query<{ status: string }>('SELECT status FROM policy_change_requests WHERE id = $1', [id])).rows[0]?.status ?? 'missing';
  }
  async function addBlock(f: Fixture, direction: 'outbound' | 'inbound', value: string) {
    const r = await call(deps(), 'POST', `/api/agents/${f.agentId}/rules`, authed(f.session, { body: { direction, list: 'block', value } }));
    expect(r.statusCode, r.body).toBe(201);
  }
  async function tokenRowId(token: string): Promise<string> {
    return (await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(token)])).rows[0]?.id ?? '';
  }
  /** 정책이 그대로이고 요청 행이 없다 — 거부된 공격의 공통 사후 조건. */
  async function untouched(f: Fixture, version = 1): Promise<void> {
    expect(await requestRows(f.agentId)).toBe(0);
    expect((await policyOf(f)).version).toBe(version);
  }
  /** 닫힌 행을 소유자 롤로 심는다(상한 · 만료 시나리오). */
  async function seedRequest(f: Fixture, token: string, overrides: { value: string; status?: string; createdAgo?: string; expiresIn?: string; hash?: string; decided?: boolean }) {
    const status = overrides.status ?? 'rejected';
    const r = await owner.query<{ id: string }>(
      `INSERT INTO policy_change_requests (agent_id, organization_id, token_id, action, direction, list, value, reason, request_hash, base_version, tainted,
                                           status, created_at, expires_at, decided_at, decided_by)
       VALUES ($1, $2, $3::uuid, 'add_rule', 'outbound', 'allow', $4, 'seeded', $5, 1, false, $6,
               now() - $7::interval, now() - $7::interval + $8::interval, ${status === 'pending' ? 'NULL' : 'now()'}, ${status === 'pending' ? 'NULL' : "'admin:session:x'"})
       RETURNING id::text AS id`,
      [f.agentId, f.orgId, await tokenRowId(token), overrides.value, overrides.hash ?? randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), status, overrides.createdAgo ?? '0 seconds', overrides.expiresIn ?? '7 days'],
    );
    return r.rows[0]?.id ?? '';
  }
  async function exposure(f: Fixture, level: 0 | 1 | 2, ageHours: number): Promise<void> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const message = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, $2, $3, $4, 'no_header_ids', 'mallory@evil.example', 'evil.example', false, 'invoice', false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(), 'test-v0', 'none', false, 'unknown')
       RETURNING id::text AS id`,
      [f.agentId, f.address, ses, thread.rows[0]?.id],
    );
    await owner.query(
      `INSERT INTO agent_exposures (agent_id, inbound_message_id, part, surface, level, thread_id, sender, first_at, last_at)
       VALUES ($1, $2::uuid, 'body', 'message_detail', $3, $4::uuid, 'mallory@evil.example', now() - ($5 || ' hours')::interval, now() - ($5 || ' hours')::interval)`,
      [f.agentId, message.rows[0]?.id, level, thread.rows[0]?.id, String(ageHours)],
    );
  }

  describe('FINDINGS — 안전한 기대값을 단언한다(지금은 실패)', () => {
    attack('E05', '[누출 경로] 소유자가 차단 목록 remove_rule 을 승인했는데 값이 없으면 에이전트 GET 이 stale/already_applied 로 "없음"을 알려 준다', '에이전트는 차단 목록 존재 여부를 알 수 없어야 한다', async () => {
      const f = await fixture();
      await addBlock(f, 'outbound', 'secret-block@example.com');
      const probeAbsent = await request(f.token, { action: 'remove_rule', direction: 'outbound', list: 'block', value: 'not-blocked@example.com', reason: 'probe' });
      const probePresent = await request(f.token, { action: 'remove_rule', direction: 'outbound', list: 'block', value: 'secret-block@example.com', reason: 'probe' });
      // 소유자가 두 요청을 모두 "승인" 눌렀다고 가정(콘솔은 이미 그 상태 요청에도 승인 버튼을 둔다)
      const a = await decide(f, String(probeAbsent.body['request_id']), 'approve');
      const p = await decide(f, String(probePresent.body['request_id']), 'approve');
      const seeAbsent = await rest(f.token, 'GET', `/v1/agents/me/policy/requests/${String(probeAbsent.body['request_id'])}`);
      const seePresent = await rest(f.token, 'GET', `/v1/agents/me/policy/requests/${String(probePresent.body['request_id'])}`);
      // 에이전트가 보는 두 상태가 구별 가능하면(= approved vs stale+already_applied) 차단 목록 오라클이다.
      const leaks = seeAbsent.json['status'] !== seePresent.json['status'] || seeAbsent.json['stale_reason'] !== undefined;
      expect(leaks, `absent→${String(seeAbsent.json['status'])}/${String(seeAbsent.json['stale_reason'])} present→${String(seePresent.json['status'])} (owner: ${String(a.status)}/${String(p.status)})`).toBe(false);
    });
    attack('E06', '[누출 경로] 소유자가 차단 목록 add_rule(이미 차단) 승인 → stale 로 "이미 차단돼 있음"이 에이전트에 노출', '구별 불가', async () => {
      const f = await fixture();
      await addBlock(f, 'inbound', 'already@example.com');
      const present = await request(f.token, { action: 'add_rule', direction: 'inbound', list: 'block', value: 'already@example.com', reason: 'probe' });
      await decide(f, String(present.body['request_id']), 'approve');
      const seen = await rest(f.token, 'GET', `/v1/agents/me/policy/requests/${String(present.body['request_id'])}`);
      expect(seen.json['status'], JSON.stringify(seen.json)).toBe('approved');
    });

    attack('G07', '[우회] 깨끗하게 요청한 뒤 위험 메일을 읽는다 — 승인 시점에 경고가 갱신되는가', '요청 뒤 노출도 경고', async () => {
      const f = await fixture();
      await request(f.token, ADD_PARTNER);
      expect((await list(f)).items[0]?.['tainted']).toBe(false);
      await exposure(f, 2, 0); // 요청 "뒤" 에이전트가 위험 표시 메일을 읽었다(인젝션 가능 상태)
      const item = (await list(f)).items[0]!;
      // 소유자가 승인하는 시점의 에이전트는 오염 상태 — 콘솔이 이를 알려야 한다.
      expect(item['tainted'] === true || (typeof item['lastRiskExposureAt'] === 'string' && new Date(String(item['lastRiskExposureAt'])).getTime() > new Date(String(item['createdAt'])).getTime()), JSON.stringify({ tainted: item['tainted'], at: item['lastRiskExposureAt'] })).toBe(true);
    });
    attack('G08', '[우회] 깨끗한 요청 이후 오염 → 같은 요청 재전송(replayed)이 오염 맥락을 갱신하는가', 'replay 는 오래된 tainted 를 되돌리지 않거나 갱신', async () => {
      const f = await fixture();
      const first = await request(f.token, ADD_PARTNER);
      await exposure(f, 2, 0);
      const replay = await request(f.token, ADD_PARTNER);
      expect(replay.body['replayed']).toBe(true);
      expect(replay.body['request_id']).toBe(first.body['request_id']);
      const item = (await list(f)).items[0]!;
      expect(item['tainted'], 'replay 로 낡은 clean 요청이 그대로 — 오염 맥락이 갱신되지 않음').toBe(true);
    });

    const modes = async (agentId: string) =>
      (await owner.query<{ outbound_mode: string }>(`SELECT p.outbound_mode::text FROM agent_policies p WHERE p.agent_id = $1`, [agentId])).rows[0];
    attack('I08', '[설계 확인] 조직 API 키(agents:create)로 만든 에이전트의 발신 모드', 'allowlist_only 이어야 안전(키 유출 시 즉시 발신 가능 방지)', async () => {
      const f = await fixture();
      const issued = await call(deps(), 'POST', '/api/org-keys', authed(f.session, { body: { label: 'i08', capabilities: ['agents:create', 'agents:read'] } }));
      const key = (issued.json() as { key: string }).key;
      const created = await call(deps(), 'POST', '/org-api/v1/agents', { body: { name: 'viakey', localPart: `ok-${suffix()}` }, headers: { authorization: `Bearer ${key}` } });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { agent: { id: string } }).agent.id;
      const m = await modes(id);
      expect(m?.outbound_mode, `조직 API 키로 만든 에이전트가 ${String(m?.outbound_mode)} 로 태어남`).toBe('allowlist_only');
    });

  });
});
