/**
 * 적대적 검증(실시간 WebSocket E) — 영역 6: 발견 문서 · `GET /v1/agents/{id}/realtime` · MCP `get_realtime_connection`.
 * 응답은 토큰을 되돌리지 않고, 접속 주소 모양은 검증되며, 남의 에이전트 · 권한 없는 토큰 · 인자 주입은 막힌다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { discoveryDocument, realtimeConnectionInfo, realtimeUrlOf, REALTIME_URL } from '../../../src/api/discovery';
import { openApiDocument } from '../../../src/api/openapi/document';
import { handleGetRealtimeConnection } from '../../../src/api/routes/discovery';
import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { resetLogSink } from '../../../src/observability/logger';
import { routeHttpApiEvent, type ApiDependencies, type HttpApiEvent } from '../../../src/runtime/router';
import { recordingExposures } from '../../support/injection-doubles';
import { numbered } from './realtime-support';

afterEach(() => {
  resetLogSink();
});

const AGENT = 'c1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6';
const OTHER = 'd1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6';
const NOW = (): Date => new Date('2026-10-08T00:00:00.000Z');
const EXECUTE_API = 'wss://abc123.execute-api.ap-northeast-2.amazonaws.com/v1';

function store(capabilities: readonly string[], overrides: { revoked?: boolean } = {}): { plaintext: string; store: AgentTokenStore } {
  const issued = issueAgentToken(toAgentId(AGENT));
  return {
    plaintext: issued.plaintext,
    store: {
      findByHash: (hash) =>
        Promise.resolve(
          hash === hashAgentToken(issued.plaintext)
            ? { tokenHash: hash, agentId: toAgentId(AGENT), capabilities: capabilities as never, revokedAt: overrides.revoked === true ? new Date('2026-10-01T00:00:00Z') : null, expiresAt: null }
            : null,
        ),
    },
  };
}

function untouchable(label: string): never {
  return new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : (() => { throw new Error(`${label}.${String(p)} 를 건드렸다`); })()) }) as never;
}

const EMPTY_MESSAGE_STATE = {
  riskFacts: () => Promise.resolve(new Map()),
  markRead: () => Promise.resolve(),
  setLabels: () => Promise.reject(new Error('unused')),
  listLabels: () => Promise.resolve([]),
};

function apiDeps(tokens: AgentTokenStore, realtimeUrl?: string): ApiDependencies {
  return {
    send: untouchable('send'),
    reply: untouchable('reply'),
    forward: untouchable('forward'),
    transitionAnnouncement: untouchable('transitionAnnouncement'),
    audit: untouchable('audit'),
    approvalLink: untouchable('approvalLink'),
    approvals: untouchable('approvals'),
    agentPolicy: { tokens, now: NOW, ...(realtimeUrl === undefined ? {} : { realtimeUrl }) } as never,
    webhookEndpoints: untouchable('webhookEndpoints'),
    inboundRead: { tokens, inbound: untouchable('inbound'), artifacts: untouchable('artifacts'), now: NOW, exposures: recordingExposures(), riskHoldMode: 'enforce', messageState: EMPTY_MESSAGE_STATE },
    attachments: untouchable('attachments'),
    scheduledMessages: untouchable('scheduledMessages'),
    scheduledQueries: untouchable('scheduledQueries'),
    verificationCode: untouchable('verificationCode'),
    webhookDeliveries: untouchable('webhookDeliveries'),
    outboundAttachments: untouchable('outboundAttachments'),
    drafts: untouchable('drafts'),
    draftSend: untouchable('draftSend'),
    labels: untouchable('labels'),
    agentEnroll: untouchable('agentEnroll'),
    identity: untouchable('identity'),
    health: untouchable('health'),
  } as unknown as ApiDependencies;
}

function http(path: string, headers: Record<string, string>, method = 'GET', rawQueryString = ''): HttpApiEvent {
  return { rawPath: path, rawQueryString, headers, body: null, isBase64Encoded: false, requestContext: { requestId: 'r', stage: '$default', http: { method } } } as unknown as HttpApiEvent;
}

function mcp(body: unknown, token: string | null): HttpApiEvent {
  return {
    rawPath: '/mcp',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { requestId: 'r', stage: '$default', http: { method: 'POST' } },
  } as HttpApiEvent;
}

describe('E6 — 접속 주소 모양 검증(realtimeUrlOf)', () => {
  const fallsBack = [
    ['ws:// (비암호)', 'ws://realtime.example'],
    ['https 스킴', 'https://realtime.example'],
    ['스킴 대문자 WSS://', 'WSS://realtime.example'],
    ['포트 포함', 'wss://realtime.example:8443'],
    ['userinfo 포함', 'wss://user:pw@realtime.example'],
    ['쿼리 포함', 'wss://realtime.example/v1?token=atk_agent_x'],
    ['프래그먼트 포함', 'wss://realtime.example/v1#frag'],
    ['경로 두 단계', 'wss://realtime.example/a/b'],
    ['경로 끝 슬래시', 'wss://realtime.example/v1/'],
    ['퍼센트 인코딩 경로', 'wss://realtime.example/%2e%2e'],
    ['호스트 안 공백', 'wss://real time.example'],
    ['호스트 뒤 개행 + 헤더', 'wss://realtime.example\nSet-Cookie: x=1'],
    ['호스트 뒤 CRLF', 'wss://realtime.example\r\nX: y'],
    ['IDN 호스트(키릴)', 'wss://реалтайм.example'],
    ['IPv6 리터럴', 'wss://[::1]'],
    ['스킴만', 'wss://'],
    ['빈 호스트 + 경로', 'wss:///v1'],
    ['@만', 'wss://@'],
    ['javascript 스킴', 'javascript:alert(1)'],
    ['data 스킴', 'data:text/html,<script>1</script>'],
    ['undefined', undefined],
    ['빈 문자열', ''],
    ['공백만', '   '],
    ['밑줄 호스트', 'wss://real_time.example'],
  ] as const;

  it.each(numbered('E6-U', fallsBack))('[%s] %s → 정본 호스트로 되돌아간다', (_id, _label, value) => {
    expect(realtimeUrlOf(value)).toBe(REALTIME_URL);
  });

  it('[E6-U-025] 정당한 execute-api 주소 · 앞뒤 공백은 받는다', () => {
    expect(realtimeUrlOf(EXECUTE_API)).toBe(EXECUTE_API);
    expect(realtimeUrlOf(`  ${EXECUTE_API}  `)).toBe(EXECUTE_API);
  });

  it.each(
    numbered('E6-V', [
      ['호스트가 점 하나', 'wss://.'],
      ['연속 점', 'wss://a..b'],
      ['하이픈만', 'wss://-'],
      ['루프백 IPv4', 'wss://127.0.0.1'],
      ['임의 외부 호스트(AWS 고정 아님)', 'wss://collector.evil.example'],
      ['경로 ..', 'wss://realtime.example/..'],
    ] as const),
  )('[%s] SUSPECT: %s 가 모양 검사를 통과한다(배포 환경 변수라 신뢰 경계 안이지만 호스트 형식 · 도메인 고정은 하지 않는다)', (_id, _label, value) => {
    expect(realtimeUrlOf(value)).toBe(value);
  });
});

describe('E6 — 안내 본문은 토큰을 싣지 않는다', () => {
  const documents: [string, () => unknown][] = [
    ['realtimeConnectionInfo()', () => realtimeConnectionInfo()],
    ['realtimeConnectionInfo(execute-api)', () => realtimeConnectionInfo(EXECUTE_API)],
    ['discoveryDocument()', () => discoveryDocument()],
    ['openApiDocument()', () => openApiDocument()],
  ];

  it.each(numbered('E6-D', documents))('[%s] %s — 토큰 모양(atk_agent_ + 43자)이 없다', (_id, _label, build) => {
    const text = JSON.stringify(build());
    expect(text).not.toMatch(/atk_agent_[A-Za-z0-9_-]{43}/);
    expect(text).not.toMatch(/atk_org_[A-Za-z0-9_-]{20}/);
  });

  it('[E6-D-005] 인증 안내는 쿼리 토큰 금지를 말하고, 예시는 자리표시자(…)다', () => {
    const auth = (realtimeConnectionInfo()['auth'] as { query_string: string; methods: { value: string }[] });
    expect(auth.query_string).toMatch(/Never put the token in the URL/);
    for (const method of auth.methods) expect(method.value).toContain('…');
  });

  it('[E6-D-006] 안내의 접속 주소는 wss:// 이고 쿼리 문자열 자리가 없다', () => {
    const info = realtimeConnectionInfo(realtimeUrlOf('wss://x.example/v1?t=1'));
    expect(String(info['url'])).toMatch(/^wss:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9_.-]+)?$/);
    expect(String(info['url'])).not.toContain('?');
  });
});

describe('E6 — GET /v1/agents/{id}/realtime', () => {
  const full = store(['messages:read']);
  const route = (agent: string, token: string | null, extra: Record<string, string> = {}, rawQueryString = '') =>
    routeHttpApiEvent(apiDeps(full.store, EXECUTE_API), http(`/v1/agents/${agent}/realtime`, { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra }, 'GET', rawQueryString));

  it('[E6-R-001] 올바른 토큰 → 200 · 응답 본문과 머리 어디에도 토큰이 없다', async () => {
    const result = await route(AGENT, full.plaintext);
    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(result)).not.toContain(full.plaintext);
    expect(JSON.parse(result.body)['url']).toBe(EXECUTE_API);
  });

  it('[E6-R-002] 토큰이 헤더 · 쿼리 · 다른 헤더에 다 실려 와도 응답에 되돌아오지 않는다', async () => {
    const result = await route(AGENT, full.plaintext, { 'x-token': full.plaintext, cookie: `t=${full.plaintext}` }, `token=${full.plaintext}`);
    expect(JSON.stringify(result)).not.toContain(full.plaintext);
  });

  it('[E6-R-003] 토큰 없음 → 401', async () => {
    expect((await route(AGENT, null)).statusCode).toBe(401);
  });

  it('[E6-R-004] 쿼리의 토큰만으로는 인증되지 않는다 → 401', async () => {
    expect((await route(AGENT, null, {}, `token=${full.plaintext}&access_token=${full.plaintext}`)).statusCode).toBe(401);
  });

  it('[E6-R-005] 남의 에이전트 id → 403(안내도 자기 것만)', async () => {
    expect((await route(OTHER, full.plaintext)).statusCode).toBe(403);
  });

  it('[E6-R-006] messages:read 없는 토큰 → 403', async () => {
    const sendOnly = store(['messages:send']);
    const result = await routeHttpApiEvent(apiDeps(sendOnly.store), http(`/v1/agents/${AGENT}/realtime`, { authorization: `Bearer ${sendOnly.plaintext}` }));
    expect(result.statusCode).toBe(403);
  });

  it('[E6-R-007] 폐기된 토큰 → 401', async () => {
    const revoked = store(['messages:read'], { revoked: true });
    const result = await routeHttpApiEvent(apiDeps(revoked.store), http(`/v1/agents/${AGENT}/realtime`, { authorization: `Bearer ${revoked.plaintext}` }));
    expect(result.statusCode).toBe(401);
  });

  it('[E6-R-008] 조직 키 모양 → 401', async () => {
    expect((await route(AGENT, `atk_org_${'K'.repeat(43)}`)).statusCode).toBe(401);
  });

  const badAgentIds = ['self', 'ME', 'A1C2C3C4C5C6C7C8C9C0D1D2D3D4D5D6', 'c1c2c3', `${AGENT}0`, `%2e%2e`, "x'--", 'null', '*'];
  it.each(numbered('E6-I', badAgentIds.map((a) => [JSON.stringify(a), a] as const)))('[%s] agentId=%s → 400 또는 404 · 토큰 에코 없음', async (_id, _label, agent) => {
    const result = await route(agent, full.plaintext);
    expect([400, 403, 404]).toContain(result.statusCode);
    expect(JSON.stringify(result)).not.toContain(full.plaintext);
  });

  it('[E6-I-010] 에이전트 id 자리에 토큰을 넣어도 오류 본문이 그 값을 되돌려 주지 않는다', async () => {
    const result = await handleGetRealtimeConnection(
      { tokens: full.store, now: NOW, realtimeUrl: EXECUTE_API },
      { method: 'GET', path: `/v1/agents/${full.plaintext}/realtime`, headers: { authorization: `Bearer ${full.plaintext}` }, query: {}, body: null } as never,
      { agentId: full.plaintext },
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain(full.plaintext);
  });

  it('[E6-R-009] POST · PUT · DELETE 는 안내 라우트에 닿지 않는다', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = await routeHttpApiEvent(apiDeps(full.store), http(`/v1/agents/${AGENT}/realtime`, { authorization: `Bearer ${full.plaintext}` }, method));
      expect(result.statusCode, method).not.toBe(200);
    }
  });
});

describe('E6 — MCP get_realtime_connection', () => {
  const call = (token: string | null, args: Record<string, unknown>, tokens = store(['messages:read'])) =>
    routeHttpApiEvent(apiDeps(tokens.store, EXECUTE_API), mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_realtime_connection', arguments: args } }, token ?? tokens.plaintext));

  it('[E6-M-001] 인자 없이 부르면 자기 에이전트 안내 · 본문에 토큰이 없다', async () => {
    const tokens = store(['messages:read']);
    const result = await call(null, {}, tokens);
    const parsed = JSON.parse(result.body) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(parsed.result.isError).not.toBe(true);
    expect(result.body).not.toContain(tokens.plaintext);
    expect(parsed.result.content[0]?.text).toContain(EXECUTE_API);
  });

  it('[E6-M-002] agent_id 인자로 남의 에이전트를 가리킬 수 없다(invalid_arguments)', async () => {
    const result = await call(null, { agent_id: OTHER });
    expect(result.body).toContain('invalid_arguments');
  });

  it('[E6-M-003] 모르는 인자(token · url · subprotocol)를 주입해도 안내 본문이 바뀌지 않는다', async () => {
    const tokens = store(['messages:read']);
    const base = await call(null, {}, tokens);
    const injected = await call(null, { token: 'atk_agent_x', url: 'wss://evil.example', subprotocol: 'x' }, tokens);
    const text = JSON.parse(injected.body).result.content[0]?.text as string | undefined;
    expect(text ?? injected.body).not.toContain('evil.example');
    expect(JSON.parse(base.body).result.content[0]?.text).toContain(EXECUTE_API);
  });

  it('[E6-M-004] messages:read 없는 토큰은 도구 목록에서 보이지 않고 부를 수도 없다', async () => {
    const sendOnly = store(['messages:send']);
    const list = await routeHttpApiEvent(apiDeps(sendOnly.store), mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sendOnly.plaintext));
    expect(list.body).not.toContain('get_realtime_connection');
    const called = await call(null, {}, sendOnly);
    expect(called.body).not.toContain(EXECUTE_API);
  });

  it('[E6-M-005] 도구는 읽기 전용이다(주석) · 입력 스키마에 속성이 없다', async () => {
    const tokens = store(['messages:read']);
    const list = await routeHttpApiEvent(apiDeps(tokens.store), mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, tokens.plaintext));
    const tools = (JSON.parse(list.body) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties?: Record<string, unknown> } }[] } }).result.tools;
    const tool = tools.find((t) => t.name === 'get_realtime_connection');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([]);
  });

  it('[E6-M-006] 토큰 없는 MCP 호출은 401', async () => {
    const result = await routeHttpApiEvent(apiDeps(store(['messages:read']).store), mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_realtime_connection', arguments: {} } }, null));
    expect(result.statusCode).toBe(401);
  });
});
