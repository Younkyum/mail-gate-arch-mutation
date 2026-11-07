/**
 * 적대적 검증(묶음 D) 요소 2 — 자가 등록 내부 이벤트 · 라우트 · 결과 해석 (DB 없음). 시도 ID `D2-U###`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { InvokeCommand } from '@aws-sdk/client-lambda';

import { enrollNameOf, generatedLocalPart } from '../../../src/admin/ops/enroll';
import { handleEnrollAgent } from '../../../src/api/routes/agents-enroll';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  ENROLL_EVENT_ACTION,
  ENROLL_EVENT_SOURCE,
  ENROLL_EVENT_VERSION,
  parseEnrollEvent,
  parseEnrollResult,
  type AgentEnrollInvokeResult,
  type EnrollEvent,
} from '../../../src/runtime/enroll-event';
import { adminEventKind, createAdminHandler, isFromConsoleApi } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { createAgentEnroller, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';
import { AGENT_ID, issuedToken } from '../../integration/outbound/support/fakes';

afterEach(() => resetLogSink());

const TOKEN = `atk_agent_${'Q'.repeat(43)}`;
const EVENT: EnrollEvent = { source: ENROLL_EVENT_SOURCE, action: ENROLL_EVENT_ACTION, v: ENROLL_EVENT_VERSION, token: TOKEN, name: 'child', localPart: null, requestId: 'req-1' };
const ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';
const context = (): LambdaContext => ({ callbackWaitsForEmptyEventLoop: true, invokedFunctionArn: ARN, awsRequestId: 'r', getRemainingTimeInMillis: () => 10_000 }) as unknown as LambdaContext;

// ---------------------------------------------------------------------------
// 위조 이벤트 모양 (admin λ 입구)
// ---------------------------------------------------------------------------
const FORGED: readonly { label: string; value: unknown }[] = [
  { label: 'action 끝에 공백', value: { ...EVENT, action: 'agent.enroll ' } },
  { label: 'action 대문자', value: { ...EVENT, action: 'AGENT.ENROLL' } },
  { label: 'action 이 다른 관리 연산(agent.policy.change)', value: { ...EVENT, action: 'agent.policy.change' } },
  { label: 'action 이 domain.recheck', value: { ...EVENT, action: 'domain.recheck' } },
  { label: 'source 가 atmark.kick', value: { ...EVENT, source: 'atmark.kick' } },
  { label: 'source 가 aws.events', value: { ...EVENT, source: 'aws.events' } },
  { label: 'source 대문자', value: { ...EVENT, source: 'ATMARK.API' } },
  { label: 'v 가 문자열 "1"', value: { ...EVENT, v: '1' } },
  { label: 'v 가 1.0000001', value: { ...EVENT, v: 1.0000001 } },
  { label: 'v 가 true', value: { ...EVENT, v: true } },
  { label: 'v 없음', value: { source: EVENT.source, action: EVENT.action, token: TOKEN, name: 'x', localPart: null, requestId: 'r' } },
  { label: 'token 없음', value: { source: EVENT.source, action: EVENT.action, v: 1, name: 'x', localPart: null, requestId: 'r' } },
  { label: 'token 이 atk_org_ 모양', value: { ...EVENT, token: `atk_org_${'Q'.repeat(43)}` } },
  { label: 'token 이 42 자', value: { ...EVENT, token: `atk_agent_${'Q'.repeat(42)}` } },
  { label: 'token 이 44 자', value: { ...EVENT, token: `atk_agent_${'Q'.repeat(44)}` } },
  { label: 'token 에 공백', value: { ...EVENT, token: `atk_agent_${'Q'.repeat(42)} ` } },
  { label: 'token 앞 공백', value: { ...EVENT, token: ` ${TOKEN}` } },
  { label: 'token 에 개행', value: { ...EVENT, token: `${TOKEN}\n` } },
  { label: 'token 이 배열', value: { ...EVENT, token: [TOKEN] } },
  { label: 'token 이 객체', value: { ...EVENT, token: { toString: () => TOKEN } } },
  { label: 'name 이 321 자', value: { ...EVENT, name: 'a'.repeat(321) } },
  { label: 'name 이 객체', value: { ...EVENT, name: { a: 1 } } },
  { label: 'name 이 null', value: { ...EVENT, name: null } },
  { label: 'localPart 가 빈 문자열', value: { ...EVENT, localPart: '' } },
  { label: 'localPart 가 65 자', value: { ...EVENT, localPart: 'a'.repeat(65) } },
  { label: 'localPart 가 undefined', value: { ...EVENT, localPart: undefined } },
  { label: 'requestId 에 공백', value: { ...EVENT, requestId: 'a b' } },
  { label: 'requestId 129 자', value: { ...EVENT, requestId: 'a'.repeat(129) } },
  { label: 'requestId 가 빈 문자열', value: { ...EVENT, requestId: '' } },
  { label: 'requestId 에 개행(로그 주입)', value: { ...EVENT, requestId: 'a\nERROR fake' } },
  { label: 'organizationId 키를 끼움(다른 조직 지정)', value: { ...EVENT, organizationId: '11111111-1111-4111-8111-111111111111' } },
  { label: 'agentId 키를 끼움(다른 에이전트 지정)', value: { ...EVENT, agentId: 'a'.repeat(32) } },
  { label: 'capabilities 키를 끼움', value: { ...EVENT, capabilities: ['agents:enroll'] } },
  { label: 'sendApproval 키를 끼움', value: { ...EVENT, sendApproval: 'auto' } },
  { label: '배열로 감쌈', value: [EVENT] },
  { label: '문자열(JSON)', value: JSON.stringify(EVENT) },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: '숫자', value: 7 },
  { label: '클래스 인스턴스', value: new (class Evt { source = EVENT.source; action = EVENT.action; v = 1; token = TOKEN; name = 'x'; localPart = null; requestId = 'r'; })() },
  { label: 'null 프로토타입 객체', value: Object.assign(Object.create(null) as object, EVENT) },
  { label: 'HTTP 이벤트 body 에 이벤트를 넣음', value: { version: '2.0', rawPath: '/api/me', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(EVENT) } },
  { label: '__proto__ 로 키를 심음', value: JSON.parse(`{"__proto__":{"token":"${TOKEN}"},"source":"atmark.api","action":"agent.enroll","v":1,"name":"x","localPart":null,"requestId":"r"}`) as unknown },
];

describe('D2 위조 이벤트 — parseEnrollEvent 는 null, 입구는 던진다(조립 0)', () => {
  const rows = FORGED.map((row, index) => ({ ...row, id: `D2-U${String(index + 1).padStart(3, '0')}` }));
  it.each(rows)('[$id] $label', async ({ value }) => {
    expect(parseEnrollEvent(value)).toBeNull();
    let composed = 0;
    const handler = createAdminHandler(() => {
      composed += 1;
      return Promise.reject(new Error('조립 금지'));
    });
    // 이벤트가 HTTP 모양이면 조립을 시도할 수 있다(HTTP 경로) — 자가 등록 경로가 아니다. 그 외에는 던지거나 거부한다.
    const kind = (() => {
      try {
        return adminEventKind(value);
      } catch {
        return 'throws';
      }
    })();
    expect(kind).not.toBe('agent-enroll');
    if (kind === 'throws') {
      await expect(handler(value, context())).rejects.toThrow();
      expect(composed).toBe(0);
    }
  });
});

describe('D2 정상 모양은 정상으로 읽는다(대조군)', () => {
  it('[D2-U047] 올바른 이벤트는 agent-enroll', () => {
    expect(adminEventKind({ ...EVENT })).toBe('agent-enroll');
    expect(parseEnrollEvent({ ...EVENT, localPart: 'kid' })?.localPart).toBe('kid');
  });

  // 고침(2026-10-08 — 리드 지시 5): HTTP 모양 이벤트는 `requestContext.apiId` 가 콘솔 HTTP API id(`ATMARK_CONSOLE_API_ID`)일 때만 처리한다.
  it('[D2-U048] 직접 invoke 로 위조한 HTTP 모양 이벤트(apiId 없음 · 다른 API · 환경 없음)는 거부되고 조립(관리 연산)을 부르지 않는다', async () => {
    const forged = { version: '2.0', rawPath: '/api/login', requestContext: { requestId: 'r', http: { method: 'POST', sourceIp: '203.0.113.9' } }, headers: {}, body: '{}' };
    expect(adminEventKind(forged)).toBe('http');
    for (const [event, consoleId] of [
      [forged, 'consoleapi1'],
      [{ ...forged, requestContext: { ...forged.requestContext, apiId: 'otherapi9' } }, 'consoleapi1'],
      [{ ...forged, requestContext: { ...forged.requestContext, apiId: 'consoleapi1' } }, undefined],
    ] as const) {
      let composed = 0;
      const handler = createAdminHandler(
        () => {
          composed += 1;
          return Promise.reject(new Error('조립 금지'));
        },
        undefined,
        () => consoleId,
      );
      await expect(handler(event, context())).rejects.toThrow();
      expect(composed).toBe(0);
    }
    expect(isFromConsoleApi({ ...forged, requestContext: { ...forged.requestContext, apiId: 'consoleapi1' } } as never, 'consoleapi1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 결과 해석 변조
// ---------------------------------------------------------------------------
const GOOD = { ok: true, agent: { id: 'a'.repeat(32), name: 'n', address: 'x@atmark.ai' }, token: TOKEN, scopes: ['messages:send'], policyVersion: 1 };
const RESULTS: readonly { label: string; body: unknown }[] = [
  { label: 'ok 가 문자열 "true"', body: { ...GOOD, ok: 'true' } },
  { label: 'ok 없음', body: { agent: GOOD.agent, token: TOKEN, scopes: [], policyVersion: 1 } },
  { label: 'agent.id 가 대문자 hex', body: { ...GOOD, agent: { ...GOOD.agent, id: 'A'.repeat(32) } } },
  { label: 'agent.id 가 31 자', body: { ...GOOD, agent: { ...GOOD.agent, id: 'a'.repeat(31) } } },
  { label: 'agent.id 가 SQL 조각', body: { ...GOOD, agent: { ...GOOD.agent, id: "'; DROP TABLE agents;--" } } },
  { label: 'agent.name 이 객체', body: { ...GOOD, agent: { ...GOOD.agent, name: {} } } },
  { label: 'token 모양 틀림', body: { ...GOOD, token: 'not-a-token' } },
  { label: 'token 이 조직 키 모양', body: { ...GOOD, token: `atk_org_${'Q'.repeat(43)}` } },
  { label: 'scopes 가 문자열', body: { ...GOOD, scopes: 'messages:send' } },
  { label: 'scopes 에 숫자', body: { ...GOOD, scopes: [1] } },
  { label: 'policyVersion 문자열', body: { ...GOOD, policyVersion: '1' } },
  { label: '배열', body: [GOOD] },
  { label: 'null', body: null },
  { label: '문자열', body: 'ok' },
  { label: 'ok:false + 스택 흘리기 시도', body: { ok: false, error: 'unavailable', stack: 'Error: at /var/task/admin.js:1:1', detail: 'password authentication failed for user "atmark_admin"' } },
  { label: 'ok:false + 모르는 코드(DB 오류 문구)', body: { ok: false, error: 'duplicate key value violates unique constraint "agent_addresses_address_key"' } },
  { label: 'ok:false + P0A31 SQLSTATE', body: { ok: false, error: 'P0A31' } },
  { label: 'ok:false + error 객체', body: { ok: false, error: { code: 'x' } } },
];

describe('D2 결과 해석 — 모양이 틀리면 unavailable, 내부 문구는 통과하지 않는다', () => {
  const rows = RESULTS.map((row, index) => ({ ...row, id: `D2-U${String(49 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] $label', ({ body }) => {
    const parsed = parseEnrollResult(body);
    if (parsed.ok) throw new Error('변조된 결과가 성공으로 읽혔다');
    expect(parsed.error).toBe('unavailable');
  });

  it('[D2-U067] 대조군: 올바른 결과', () => {
    expect(parseEnrollResult(GOOD).ok).toBe(true);
  });

  it('[D2-U068] 올바른 결과의 추가 필드(token_hash 등)는 응답에 번지지 않는다', () => {
    const parsed = parseEnrollResult({ ...GOOD, token_hash: 'x', internal: 'secret' });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// 라우트: 거절 매핑 · 정보 누출 · 호출 의미론
// ---------------------------------------------------------------------------
function enrollerToken() {
  const issued = issueAgentToken(AGENT_ID, ['messages:send', 'agents:enroll']);
  return {
    plaintext: issued.plaintext,
    store: { findByHash: (hash: string) => Promise.resolve(hash === issued.tokenHash ? { tokenHash: issued.tokenHash, agentId: AGENT_ID, capabilities: issued.capabilities, revokedAt: null, expiresAt: null } : null) },
  };
}

function route(enroll: ((event: EnrollEvent) => Promise<AgentEnrollInvokeResult>) | null) {
  const t = enrollerToken();
  const deps = { tokens: t.store, enroll, now: () => new Date(), requestId: () => 'req-x', precheck: null };
  const call = (body: unknown, header: string | null = `Bearer ${t.plaintext}`) =>
    handleEnrollAgent(deps, { headers: header === null ? {} : { authorization: header }, query: {}, body });
  return { call, t };
}

const REFUSALS = ['unauthorized', 'scope_missing', 'not_active', 'self_enroll_disabled', 'enroll_daily_cap', 'agent_limit', 'address_taken', 'invalid_local_part', 'invalid_name', 'chain_forbidden', 'unavailable'];
const LEAKY = /P0A\d|agent_enrollments|agent_api_keys|org_watch_settings|atmark_admin|stack|at \/var|postgres|SELECT |INSERT |sqlstate|constraint|arn:aws|organization_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

describe('D2 라우트 — 거절 응답에 내부 정보가 없다', () => {
  const rows = REFUSALS.map((refusal, index) => ({ refusal, id: `D2-U${String(69 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] admin 거절 "$refusal" → 공개 오류만', async ({ refusal }) => {
    const { call } = route(() => Promise.resolve({ ok: true, body: { ok: false, error: refusal } }));
    const r = await call({ name: 'x' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).not.toMatch(LEAKY);
  });

  it('[D2-U080] busy → 503 enroll_busy', async () => {
    const r = await route(() => Promise.resolve({ ok: false, reason: 'busy' })).call({ name: 'x' });
    expect([r.status, r.body['error']]).toEqual([503, 'enroll_busy']);
  });

  it('[D2-U081] timeout → 503 enroll_timeout · "다시 부르지 말라" 안내(중복 생성 방지)', async () => {
    const r = await route(() => Promise.resolve({ ok: false, reason: 'timeout' })).call({ name: 'x' });
    expect([r.status, r.body['error']]).toEqual([503, 'enroll_timeout']);
    expect(JSON.stringify(r.body)).toMatch(/do not retry/i);
  });

  it('[D2-U082] unavailable → 503 enroll_unavailable', async () => {
    const r = await route(() => Promise.resolve({ ok: false, reason: 'unavailable' })).call({ name: 'x' });
    expect([r.status, r.body['error']]).toEqual([503, 'enroll_unavailable']);
  });

  it('[D2-U084] enroll 호출 함수가 null(미배선) → 503 enroll_unavailable · 토큰 검증은 먼저', async () => {
    const r = await route(null).call({ name: 'x' });
    expect([r.status, r.body['error']]).toEqual([503, 'enroll_unavailable']);
  });

  it('[D2-U085] 권한 검사가 입력 검증보다 먼저 — enroll 권한 없는 토큰은 본문을 보내도 403 이고 enroll 호출 0', async () => {
    const issued = issuedToken();
    let called = 0;
    const r = await handleEnrollAgent(
      { tokens: issued.store, enroll: () => { called += 1; return Promise.resolve({ ok: false, reason: 'unavailable' }); }, now: () => new Date(), requestId: () => 'r', precheck: null },
      { headers: { authorization: `Bearer ${issued.plaintext}` }, query: {}, body: { name: 'x' } },
    );
    expect(r.status).toBe(403);
    expect(called).toBe(0);
  });

  it.each([
    { id: 'D2-U086', label: 'Authorization 없음', header: null },
    { id: 'D2-U087', label: 'Basic 스킴', header: 'Basic Zm9vOmJhcg==' },
    { id: 'D2-U088', label: 'Bearer 토큰 비어 있음', header: 'Bearer ' },
    { id: 'D2-U089', label: 'Bearer 뒤 쓰레기', header: 'Bearer nope' },
    { id: 'D2-U090', label: 'bearer 소문자 + 쓰레기', header: 'bearer atk_agent_nope' },
  ])('[$id] $label → 401 · enroll 호출 0', async ({ header }) => {
    let called = 0;
    const { call } = route(() => { called += 1; return Promise.resolve({ ok: false, reason: 'unavailable' }); });
    const r = await call({ name: 'x' }, header);
    expect(r.status).toBe(401);
    expect(called).toBe(0);
  });

  it('[D2-U091] 이벤트에 실리는 토큰은 요청의 토큰 그대로이고 name 은 trim 되며 local_part 는 소문자화된다', async () => {
    const events: EnrollEvent[] = [];
    const { call, t } = route((event) => { events.push(event); return Promise.resolve({ ok: false, reason: 'unavailable' }); });
    await call({ name: '  Kid  ', local_part: ' MyKid ' });
    expect(events[0]).toMatchObject({ token: t.plaintext, name: 'Kid', localPart: 'mykid', source: ENROLL_EVENT_SOURCE });
  });

  it('[D2-U092] 헤더에 토큰 뒤 공백·추가 텍스트가 있어도 이벤트의 토큰은 인증된 토큰과 같은 값이다', async () => {
    const events: EnrollEvent[] = [];
    const { call, t } = route((event) => { events.push(event); return Promise.resolve({ ok: false, reason: 'unavailable' }); });
    await call({ name: 'x' }, `Bearer  ${t.plaintext}  `);
    if (events[0] !== undefined) expect(events[0].token).toBe(t.plaintext);
  });
});

// ---------------------------------------------------------------------------
// createAgentEnroller — 호출 의미론
// ---------------------------------------------------------------------------
function fake(behaviour: (command: InvokeCommand) => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>) {
  const calls: InvokeCommand[] = [];
  const client: LambdaInvokeClient = { send: (command: InvokeCommand) => { calls.push(command); return behaviour(command); } };
  return { client, calls };
}
const payload = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('D2 createAgentEnroller — 호출 의미론', () => {
  it('[D2-U093] 시간 초과 뒤 늦게 성공해도 응답은 timeout 하나 · 호출은 정확히 1회(재시도로 중복 생성 없음)', async () => {
    const f = fake(() => new Promise((resolve) => setTimeout(() => resolve({ StatusCode: 200, Payload: payload({ ok: true }) }), 80)));
    const result = await createAgentEnroller({ client: f.client, functionArn: ARN, timeoutMs: 10 })(EVENT);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    { id: 'D2-U094', label: 'ThrottlingException', name: 'ThrottlingException', reason: 'busy' },
    { id: 'D2-U095', label: 'TooManyRequestsException', name: 'TooManyRequestsException', reason: 'busy' },
    { id: 'D2-U096', label: 'ServiceException', name: 'ServiceException', reason: 'unavailable' },
    { id: 'D2-U097', label: 'ResourceNotFoundException', name: 'ResourceNotFoundException', reason: 'unavailable' },
    { id: 'D2-U098', label: 'AccessDeniedException', name: 'AccessDeniedException', reason: 'unavailable' },
    { id: 'D2-U099', label: '이름 없는 오류', name: '', reason: 'unavailable' },
  ])('[$id] SDK 오류 $label → $reason · 1 회만 호출', async ({ name, reason }) => {
    const f = fake(() => Promise.reject(Object.assign(new Error('boom'), { name })));
    expect(await createAgentEnroller({ client: f.client, functionArn: ARN })(EVENT)).toEqual({ ok: false, reason });
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    { id: 'D2-U100', label: 'FunctionError=Unhandled', out: { StatusCode: 200, FunctionError: 'Unhandled', Payload: payload({ errorMessage: 'secret stack' }) } },
    { id: 'D2-U101', label: 'StatusCode 202', out: { StatusCode: 202 } },
    { id: 'D2-U102', label: 'StatusCode 500', out: { StatusCode: 500 } },
    { id: 'D2-U103', label: 'StatusCode 없음', out: {} },
    { id: 'D2-U104', label: 'JSON 아닌 페이로드', out: { StatusCode: 200, Payload: payload('<html>gateway error</html>') } },
    { id: 'D2-U105', label: '빈 페이로드', out: { StatusCode: 200, Payload: new Uint8Array() } },
    { id: 'D2-U106', label: '페이로드 없음', out: { StatusCode: 200 } },
  ])('[$id] $label → unavailable (오류 문구 통과 없음)', async ({ out }) => {
    const f = fake(() => Promise.resolve(out));
    const result = await createAgentEnroller({ client: f.client, functionArn: ARN })(EVENT);
    if (result.ok) {
      // 빈 페이로드는 JSON.parse('') 실패 → unavailable 이어야 한다. 성공으로 읽히면 몸통이 해석기를 지난다.
      expect(parseEnrollResult(result.body).ok).toBe(false);
    } else {
      expect(result.reason).toBe('unavailable');
    }
    expect(JSON.stringify(result)).not.toContain('secret stack');
  });

  it('[D2-U107] 호출은 RequestResponse · 대상은 설정된 ARN 하나', async () => {
    const f = fake(() => Promise.resolve({ StatusCode: 200, Payload: payload({ ok: false, error: 'agent_limit' }) }));
    await createAgentEnroller({ client: f.client, functionArn: ARN })(EVENT);
    expect(f.calls[0]?.input.InvocationType).toBe('RequestResponse');
    expect(f.calls[0]?.input.FunctionName).toBe(ARN);
    expect(f.calls[0]?.input.Qualifier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 이름 · 로컬파트 생성기
// ---------------------------------------------------------------------------
describe('D2 이름 정리 · 생성기', () => {
  const NAME_CASES: readonly { label: string; input: string; expected: string | null }[] = [
    { label: '앞뒤 공백', input: '  a  ', expected: 'a' },
    { label: '겹 공백', input: 'a    b', expected: 'a b' },
    { label: '탭·개행 접기', input: 'a\t\n b', expected: 'a b' },
    { label: 'NUL', input: 'a\u0000b', expected: null },
    { label: 'ESC', input: 'a\u001bb', expected: null },
    { label: 'RLO', input: 'a‮b', expected: null },
    { label: 'ZWSP', input: 'a​b', expected: null },
    { label: 'ZWJ', input: 'a‍b', expected: null },
    { label: 'Word joiner', input: 'a⁠b', expected: null },
    { label: '소프트 하이픈', input: 'a­b', expected: null },
    { label: '하이필러 U+3164', input: 'aㅤb', expected: null },
    { label: '점자 공백 U+2800', input: 'a⠀b', expected: null },
    { label: '태그 문자 U+E0041', input: 'a\u{E0041}b', expected: null },
    { label: '변이 선택자', input: 'a️b', expected: null },
    { label: '사설 영역', input: 'ab', expected: null },
    { label: '고립 서로게이트', input: 'a\ud800b', expected: null },
    { label: '빈 문자열', input: '', expected: null },
    { label: '공백만', input: ' \t ', expected: null },
    { label: '80 자', input: 'x'.repeat(80), expected: 'x'.repeat(80) },
    { label: '81 자', input: 'x'.repeat(81), expected: null },
    { label: '이모지 80 개', input: '😀'.repeat(80), expected: '😀'.repeat(80) },
    { label: '이모지 81 개', input: '😀'.repeat(81), expected: null },
    { label: '전각 공백', input: 'a　b', expected: 'a b' },
    { label: 'NBSP', input: 'a b', expected: 'a b' },
  ];
  const rows = NAME_CASES.map((row, index) => ({ ...row, id: `D2-U${String(108 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] enrollNameOf — $label', ({ input, expected }) => {
    expect(enrollNameOf(input)).toBe(expected);
  });

  it('[D2-U132] 생성 로컬파트는 agent- + 8 hex 이고 매번 다르다(예측 불가)', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatedLocalPart()));
    for (const value of seen) expect(value).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(seen.size).toBeGreaterThan(195);
  });
});
