/**
 * 적대적 검증(실시간 WebSocket E) — 영역 1: `$connect` 인증. 쿼리 · 헤더 · 하위 프로토콜 변형 · 토큰 상태 · 오류 본문 누출.
 * 가짜 토큰/연결 저장소 위에서 운영과 같은 `handleRealtimeEvent` 를 부른다. 안전 동작을 단언한다(깨지면 `VULN:`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { readRealtimeCredential } from '../../../src/realtime/auth';
import { handleRealtimeEvent, type WebSocketEvent } from '../../../src/realtime/gateway';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  AGENT,
  CONNECTION_ID,
  EXPIRED_TOKEN,
  ORG_KEY,
  OTHER_TOKEN,
  REVOKED_TOKEN,
  SEND_ONLY_TOKEN,
  TOKEN,
  connectEvent,
  connections,
  deps,
  numbered,
  tokenStore,
} from './realtime-support';

afterEach(() => {
  resetLogSink();
});

async function run(extra: Partial<WebSocketEvent>) {
  const store = connections();
  const tokens = tokenStore();
  const result = await handleRealtimeEvent(deps(store, tokens), connectEvent(extra));
  return { result, store, tokens };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('E1 — 쿼리 문자열의 토큰은 거부한다(받지도 무시하지도 않는다)', () => {
  const rows = [
    ['?token=<토큰>', { token: TOKEN }],
    ['?access_token=<토큰>', { access_token: TOKEN }],
    ['?Token=<토큰> (대소문자)', { Token: TOKEN }],
    ['?TOKEN=<토큰>', { TOKEN: TOKEN }],
    ['?authorization=Bearer <토큰>', { authorization: `Bearer ${TOKEN}` }],
    ['?Authorization=<토큰>', { Authorization: TOKEN }],
    ['?bearer=<토큰>', { bearer: TOKEN }],
    ['?api_key=<토큰>', { api_key: TOKEN }],
    ['?apikey=<토큰>', { apikey: TOKEN }],
    ['?key=<토큰>', { key: TOKEN }],
    ['?atk=<토큰>', { atk: TOKEN }],
    ['?auth=<토큰>', { auth: TOKEN }],
    ['?accessToken=<토큰> (카멜)', { accessToken: TOKEN }],
    ['?x=<토큰> (임의 키, 값에 접두사)', { x: TOKEN }],
    ['?x=ATK_AGENT_… (접두사 대문자)', { x: TOKEN.toUpperCase() }],
    ['?x=앞글자+토큰 (값 중간에)', { x: `hello-${TOKEN}-world` }],
    ['키 자체가 토큰 (?<토큰>=)', { [TOKEN]: '' }],
    ['?token= (빈 값)', { token: '' }],
    ['?token (값 undefined)', { token: undefined }],
    ['?x=atk_org_… (조직 키 접두사도 같은 접두사)', { x: ORG_KEY }],
  ] as const;

  it.each(numbered('E1-Q', rows))('[%s] 헤더가 올바른 토큰이어도 쿼리에 토큰 모양이 있으면 400 — %s', async (_id, _label, query) => {
    const { result, store, tokens } = await run({ headers: bearer(TOKEN), queryStringParameters: query });
    expect(result.statusCode).toBe(400);
    // 거부는 토큰 판정 · 연결 행보다 먼저다.
    expect(tokens.lookups).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('[E1-Q-021] 쿼리 토큰만 있고 헤더가 없어도 400(쿼리의 토큰으로 연결되지 않는다)', async () => {
    const { result, store } = await run({ queryStringParameters: { token: TOKEN } });
    expect(result.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('[E1-Q-022] 하위 프로토콜 인증 + 쿼리 토큰 → 400', async () => {
    const { result } = await run({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}` }, queryStringParameters: { access_token: TOKEN } });
    expect(result.statusCode).toBe(400);
  });

  it('[E1-Q-023] 토큰 모양이 없는 평범한 쿼리(?lang=ko)는 막지 않는다 — 과차단 없음', async () => {
    const { result } = await run({ headers: bearer(TOKEN), queryStringParameters: { lang: 'ko', v: '1' } });
    expect(result.statusCode).toBe(200);
  });

  it('[E1-Q-024] (수정 뒤) 퍼센트 인코딩한 접두사(atk%5Fagent_… · 소문자 %5f · 이중 인코딩 · 인코딩한 키)도 거부한다(디코딩해 본다)', async () => {
    for (const query of [
      { x: TOKEN.replace('atk_', 'atk%5F') },
      { x: TOKEN.replace('atk_', 'ATK%5f') },
      { x: TOKEN.replace('atk_', '%2561tk_') },
      { 'acc%65ss_token': 'x' },
    ]) {
      const { result } = await run({ headers: bearer(TOKEN), queryStringParameters: query });
      expect(result.statusCode, JSON.stringify(query)).toBe(400);
    }
    // 잘못된 인코딩은 그대로 본다(던지지 않는다).
    expect((await run({ headers: bearer(TOKEN), queryStringParameters: { x: '%E0%A4%A' } })).result.statusCode).toBe(200);
  });

  it('[E1-Q-025] SUSPECT: 접두사가 없는 비밀(?jwt=eyJ… · ?session=…)은 쿼리 검사를 지나친다 — 이 표면의 토큰이 아니라 해는 없다', async () => {
    const { result } = await run({ headers: bearer(TOKEN), queryStringParameters: { jwt: 'eyJhbGciOiJIUzI1NiJ9.e30.x', session: 'ses_123' } });
    expect(result.statusCode).toBe(200);
  });
});

describe('E1 — Authorization 헤더 변형', () => {
  const rejected = [
    ['스킴 없이 토큰만', { Authorization: TOKEN }],
    ['Basic 스킴', { Authorization: `Basic ${TOKEN}` }],
    ['Token 스킴', { Authorization: `Token ${TOKEN}` }],
    ['Bearer 만(토큰 없음)', { Authorization: 'Bearer' }],
    ['Bearer + 공백만', { Authorization: 'Bearer    ' }],
    ['탭으로 구분한 Bearer\\t토큰', { Authorization: `Bearer\t${TOKEN}` }],
    ['스킴 앞 공백( Bearer 토큰)', { Authorization: ` Bearer ${TOKEN}` }],
    ['Bearer Bearer 토큰(중복 스킴)', { Authorization: `Bearer Bearer ${TOKEN}` }],
    ['토큰 뒤에 단어', { Authorization: `Bearer ${TOKEN} extra` }],
    ['쉼표로 이은 두 토큰', { Authorization: `Bearer ${TOKEN}, Bearer ${OTHER_TOKEN}` }],
    ['토큰 뒤 NUL', { Authorization: `Bearer ${TOKEN}\u0000` }],
    ['토큰 뒤 제로폭 공백', { Authorization: `Bearer ${TOKEN}​` }],
    ['토큰 앞 제로폭 공백', { Authorization: `Bearer ​${TOKEN}` }],
    ['접두사의 a 를 키릴 а 로(동형 문자)', { Authorization: `Bearer ${TOKEN.replace('a', 'а')}` }],
    ['접두사 전각 문자', { Authorization: `Bearer ${TOKEN.replace('atk', 'ａｔｋ')}` }],
    ['접두사 대문자(ATK_AGENT_)', { Authorization: `Bearer ${TOKEN.replace('atk_agent_', 'ATK_AGENT_')}` }],
    ['비밀부 42자', { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['비밀부 44자', { Authorization: `Bearer ${TOKEN}Q` }],
    ['base64 의 + 와 /', { Authorization: `Bearer atk_agent_${'+/'.repeat(21)}Q` }],
    ['빈 헤더 값', { Authorization: '' }],
    ['관리 세션 모양(ses_…)', { Authorization: `Bearer ses_${'a'.repeat(43)}` }],
    ['초대 토큰 모양(inv_…)', { Authorization: `Bearer inv_${'a'.repeat(43)}` }],
    ['JWT 모양', { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig' }],
    ['X-Authorization 헤더', { 'X-Authorization': `Bearer ${TOKEN}` }],
    ['Proxy-Authorization 헤더', { 'Proxy-Authorization': `Bearer ${TOKEN}` }],
    ['X-Api-Key 헤더', { 'X-Api-Key': TOKEN }],
    ['Cookie 에 토큰', { Cookie: `token=${TOKEN}; Authorization=Bearer ${TOKEN}` }],
    ['Sec-WebSocket-Key 에 토큰', { 'Sec-WebSocket-Key': TOKEN }],
    ['Origin 에 토큰', { Origin: `https://x.example/?t=${TOKEN}` }],
    ['__proto__ 이름의 헤더', { __proto__: { Authorization: `Bearer ${TOKEN}` } } as unknown as Record<string, string>],
  ] as const;

  it.each(numbered('E1-H', rejected))('[%s] 401 · 연결 행 없음 — %s', async (_id, _label, headers) => {
    const { result, store } = await run({ headers: headers as Record<string, string> });
    expect(result.statusCode).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it('[E1-H-031] 조직 키(atk_org_)는 저장소를 부르지 않고 401', async () => {
    const { result, tokens } = await run({ headers: bearer(ORG_KEY) });
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ error: 'org_key' });
    expect(tokens.lookups).toEqual([]);
  });

  it('[E1-H-032] 조직 키를 하위 프로토콜로 보내도 401(org_key)', async () => {
    const { result, tokens } = await run({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${ORG_KEY}` } });
    expect(result.statusCode).toBe(401);
    expect(tokens.lookups).toEqual([]);
  });

  it('[E1-H-033] 모양이 틀린 토큰은 저장소를 한 번도 부르지 않는다(임의 문자열로 DB 를 때리지 못한다)', async () => {
    const { result, tokens } = await run({ headers: bearer('atk_agent_short') });
    expect(result.statusCode).toBe(401);
    expect(tokens.lookups).toEqual([]);
  });

  it('[E1-H-034] 1 MiB 짜리 Authorization 헤더 → 401, 해시 · 조회 없음, 빠르게', async () => {
    const started = Date.now();
    const { result, tokens } = await run({ headers: bearer('A'.repeat(1024 * 1024)) });
    expect(result.statusCode).toBe(401);
    expect(tokens.lookups).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('[E1-H-035] 8 MiB 짜리 Sec-WebSocket-Protocol(수십만 항목) → 401, 빠르게', async () => {
    const started = Date.now();
    const { result } = await run({ headers: { 'Sec-WebSocket-Protocol': 'a,'.repeat(4 * 1024 * 1024) } });
    expect(result.statusCode).toBe(401);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('[E1-H-036] 정당한 변형은 통과한다 — 소문자 헤더 이름 · 대문자 스킴 · 스킴 뒤 공백 둘', async () => {
    for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { AUTHORIZATION: `BEARER ${TOKEN}` }, { Authorization: `bearer  ${TOKEN}` }]) {
      expect((await run({ headers })).result.statusCode).toBe(200);
    }
  });

  it('[E1-H-037] SUSPECT: 대소문자만 다른 Authorization 헤더가 둘이면 먼저 나온 것을 쓴다(충돌로 거부하지 않는다)', async () => {
    const first = await run({ headers: { Authorization: `Bearer ${TOKEN}`, authorization: `Bearer ${OTHER_TOKEN}` } });
    expect(first.result.statusCode).toBe(200);
    expect(first.store.calls[0]).toMatchObject({ agentId: AGENT });
  });

  it('[E1-H-038] Authorization 의 토큰과 하위 프로토콜의 토큰이 다르면 401(conflicting_tokens)', async () => {
    const { result, store } = await run({ headers: { ...bearer(TOKEN), 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${OTHER_TOKEN}` } });
    expect(result.statusCode).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe('E1 — Sec-WebSocket-Protocol 변형', () => {
  const rejected = [
    ['bearer.<토큰> 만(atmark.v1 없음)', `bearer.${TOKEN}`],
    ['atmark.v1 + 빈 bearer.', 'atmark.v1, bearer.'],
    ['bearer. 두 개(같은 토큰)', `atmark.v1, bearer.${TOKEN}, bearer.${TOKEN}`],
    ['bearer. 두 개(다른 토큰)', `atmark.v1, bearer.${TOKEN}, bearer.${OTHER_TOKEN}`],
    ['접두사 대문자 Bearer.', `atmark.v1, Bearer.${TOKEN}`],
    ['프로토콜 이름 대문자 ATMARK.V1', `ATMARK.V1, bearer.${TOKEN}`],
    ['모르는 버전 atmark.v2', `atmark.v2, bearer.${TOKEN}`],
    ['atmark.v1 가 토큰 항목 안에 붙음', `atmark.v1.bearer.${TOKEN}`],
    ['토큰에 쉼표 삽입', `atmark.v1, bearer.${TOKEN.slice(0, 20)},${TOKEN.slice(20)}`],
    ['bearer. 뒤 토큰 모양 아님', 'atmark.v1, bearer.not-a-token'],
    ['bearer. 뒤 동형 문자', `atmark.v1, bearer.${TOKEN.replace('t', 'т')}`],
    ['bearer. 뒤 제로폭 공백', `atmark.v1, bearer.${TOKEN}​`],
    ['bearer. 뒤 비밀부 42자', `atmark.v1, bearer.${TOKEN.slice(0, -1)}`],
    ['bearer. 뒤 조직 키', `atmark.v1, bearer.${ORG_KEY}`],
    ['빈 헤더', ''],
    ['쉼표만', ',,,'],
    ['atmark.v1 만(토큰 없음)', 'atmark.v1'],
  ] as const;

  it.each(numbered('E1-P', rejected))('[%s] 401 · 연결 행 없음 — %s', async (_id, _label, protocol) => {
    const { result, store } = await run({ headers: { 'Sec-WebSocket-Protocol': protocol } });
    expect(result.statusCode).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it('[E1-P-018] bearer. 가 비었는데 올바른 Authorization 헤더가 함께 오면 401(빈 토큰과 충돌)', async () => {
    const { result } = await run({ headers: { ...bearer(TOKEN), 'Sec-WebSocket-Protocol': 'atmark.v1, bearer.' } });
    expect(result.statusCode).toBe(401);
  });

  it('[E1-P-019] Authorization 으로 인증하고 하위 프로토콜에 bearer.<토큰> 만 있으면(atmark.v1 없음) 401', async () => {
    const { result } = await run({ headers: { ...bearer(TOKEN), 'Sec-WebSocket-Protocol': `bearer.${TOKEN}` } });
    expect(result.statusCode).toBe(401);
  });

  it.each(
    numbered('E1-P', [
      ['atmark.v1, bearer.<토큰>', `atmark.v1, bearer.${TOKEN}`],
      ['bearer.<토큰>, atmark.v1 (순서 바꿈)', `bearer.${TOKEN}, atmark.v1`],
      ['공백 없이 쉼표', `atmark.v1,bearer.${TOKEN}`],
      ['공백 여럿 · 탭', `atmark.v1 ,\t bearer.${TOKEN}  `],
      ['모르는 프로토콜이 섞임', `chat, atmark.v1, bearer.${TOKEN}, superchat`],
    ] as const).map((row, index) => [row[0].replace('-00', '-02'), row[1], row[2], index] as const),
  )('[%s] 정당한 하위 프로토콜은 200 + 응답 Sec-WebSocket-Protocol 은 atmark.v1 하나뿐 · 토큰 없음 — %s', async (_id, _label, protocol) => {
    const { result } = await run({ headers: { 'Sec-WebSocket-Protocol': protocol } });
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ 'Sec-WebSocket-Protocol': 'atmark.v1' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('[E1-P-030] Authorization 만 쓰고 atmark.v1 없이 다른 프로토콜을 제안하면 응답에 프로토콜 머리를 싣지 않는다(제안 문자열을 되돌려 주지 않는다)', async () => {
    const { result } = await run({ headers: { ...bearer(TOKEN), 'Sec-WebSocket-Protocol': 'chat, bearer-ish, evil' } });
    expect(result).toEqual({ statusCode: 200 });
  });

  it('[E1-P-031] readRealtimeCredential 은 같은 입력에 같은 판정을 한다(헤더 이름 대소문자 무관)', () => {
    const a = readRealtimeCredential({ headers: { 'sec-websocket-protocol': `atmark.v1, bearer.${TOKEN}` } });
    const b = readRealtimeCredential({ headers: { 'SEC-WEBSOCKET-PROTOCOL': `atmark.v1, bearer.${TOKEN}` } });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'presented', via: 'subprotocol', echoProtocol: 'atmark.v1' });
  });

  it('[E1-P-032] readRealtimeCredential(headers null · query null)은 던지지 않고 missing_token', () => {
    expect(readRealtimeCredential({ headers: null, queryStringParameters: null })).toEqual({ kind: 'rejected', reason: 'missing_token' });
  });
});

describe('E1 — 토큰 · 에이전트 상태', () => {
  it.each(
    numbered('E1-S', [
      ['폐기된 토큰', REVOKED_TOKEN, 401, 'token_revoked'],
      ['만료된 토큰', EXPIRED_TOKEN, 401, 'token_expired'],
      ['모르는 토큰(형식은 맞다)', `atk_agent_${'Z'.repeat(43)}`, 401, 'unknown_token'],
      ['messages:read 없는 토큰', SEND_ONLY_TOKEN, 403, 'capability_not_granted'],
    ] as const),
  )('[%s] %s → %s', async (_id, _label, token, status, reason) => {
    const { result, store } = await run({ headers: bearer(token) });
    expect(result.statusCode).toBe(status);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ error: reason });
    expect(store.calls).toEqual([]);
  });

  it('[E1-S-005] 만료 시각 정각(now == expires_at)은 만료다(<= 경계)', async () => {
    const tokens = tokenStore();
    const exact = { ...tokens, findByHash: async (hash: string) => ({ ...(await tokens.findByHash(hash))!, expiresAt: new Date('2026-10-08T10:00:00Z') }) };
    const result = await handleRealtimeEvent(deps(connections(), exact), connectEvent({ headers: bearer(TOKEN) }));
    expect(result.statusCode).toBe(401);
  });

  it('[E1-S-006] 만료 1ms 전은 유효하다', async () => {
    const tokens = tokenStore();
    const soon = { ...tokens, findByHash: async (hash: string) => ({ ...(await tokens.findByHash(hash))!, expiresAt: new Date('2026-10-08T10:00:00.001Z') }) };
    const result = await handleRealtimeEvent(deps(connections(), soon), connectEvent({ headers: bearer(TOKEN) }));
    expect(result.statusCode).toBe(200);
  });

  it.each(
    numbered('E1-S', [
      ['audit:read 만', ['audit:read']],
      ['agent:read_self 만', ['agent:read_self']],
      ['webhooks:manage 만', ['webhooks:manage']],
      ['agents:enroll 만', ['agents:enroll']],
      ['messages:send + audit:read', ['messages:send', 'audit:read']],
    ] as const),
  )('[%s] messages:read 가 없으면 403 — %s', async (_id, _label, capabilities) => {
    const tokens = tokenStore();
    const narrowed = { ...tokens, findByHash: async (hash: string) => ({ ...(await tokens.findByHash(hash))!, capabilities: [...capabilities] }) };
    const store = connections();
    const result = await handleRealtimeEvent(deps(store, narrowed as never), connectEvent({ headers: bearer(TOKEN) }));
    expect(result.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it.each(
    numbered('E1-S', [
      ['limit → 429', 'limit', 429],
      ['inactive → 403', 'inactive', 403],
      ['token_invalid → 401', 'token_invalid', 401],
    ] as const),
  )('[%s] 연결 행 결과 %s — 핸드셰이크 거부에 프로토콜 머리가 없다', async (_id, _label, outcome, status) => {
    const result = await handleRealtimeEvent(deps(connections(outcome)), connectEvent({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}` } }));
    expect(result.statusCode).toBe(status);
    expect(result.headers).toBeUndefined();
  });

  it('[E1-S-017] 연결 저장소가 던지면 예외가 그대로 올라간다(핸들러가 500 으로 바꾼다 — 스택 누출은 gateway 테스트가 본다)', async () => {
    const failing = { ...connections(), connect: () => Promise.reject(new Error('db down: password=hunter2')) };
    await expect(handleRealtimeEvent(deps(failing), connectEvent({ headers: bearer(TOKEN) }))).rejects.toThrow();
  });

  it('[E1-S-018] 연결 행에는 토큰 해시만 간다 — 평문 토큰이 저장소 인자 어디에도 없다', async () => {
    const { store } = await run({ headers: bearer(TOKEN) });
    expect(JSON.stringify(store.calls)).not.toContain(TOKEN);
  });

  it('[E1-S-019] SUSPECT: messages:read 가 없어 403 으로 거절된 연결도 토큰 "마지막 사용"을 갱신한다(touch 가 권한 검사보다 앞이다)', async () => {
    const { result, tokens } = await run({ headers: bearer(SEND_ONLY_TOKEN) });
    expect(result.statusCode).toBe(403);
    expect(tokens.touches).toHaveLength(1);
  });

  it('[E1-S-020] SUSPECT: 형식이 맞는 모르는 토큰 하나가 DB 조회 한 번을 쓴다 — 예약 동시성 1 · 풀 1 이라 무인증 폭주가 정상 재연결을 굶길 수 있다', async () => {
    const { tokens } = await run({ headers: bearer(`atk_agent_${'Y'.repeat(43)}`) });
    expect(tokens.lookups).toHaveLength(1);
  });
});

describe('E1 — 오류 본문 · 로그 누출', () => {
  const variants: [string, Partial<WebSocketEvent>][] = [
    ['정상', { headers: bearer(TOKEN) }],
    ['폐기', { headers: bearer(REVOKED_TOKEN) }],
    ['만료', { headers: bearer(EXPIRED_TOKEN) }],
    ['권한 없음', { headers: bearer(SEND_ONLY_TOKEN) }],
    ['쿼리 토큰', { headers: bearer(TOKEN), queryStringParameters: { token: TOKEN } }],
    ['하위 프로토콜', { headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}` } }],
    ['충돌', { headers: { ...bearer(TOKEN), 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${OTHER_TOKEN}` } }],
    ['조직 키', { headers: bearer(ORG_KEY) }],
  ];

  it.each(numbered('E1-L', variants))('[%s] %s — 응답과 로그 어디에도 토큰이 없다', async (_id, _label, extra) => {
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });
    const { result } = await run(extra);
    const everything = JSON.stringify(result) + lines.join('\n');
    for (const secret of [TOKEN, OTHER_TOKEN, REVOKED_TOKEN, EXPIRED_TOKEN, SEND_ONLY_TOKEN, ORG_KEY]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/atk_agent_[A-Za-z0-9_-]{20}/);
  });

  it('[E1-L-009] 거부 본문은 {error} 한 칸뿐이고 값은 닫힌 사유 집합이다', async () => {
    const allowed = new Set(['token_in_query', 'missing_token', 'org_key', 'subprotocol_required', 'conflicting_tokens', 'malformed_token', 'unknown_token', 'token_revoked', 'token_expired', 'capability_not_granted']);
    for (const [, extra] of variants) {
      const { result } = await run(extra);
      if (result.statusCode === 200) continue;
      const body = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['error']);
      expect(allowed.has(String(body['error']))).toBe(true);
    }
  });

  it('[E1-L-010] SUSPECT: 폐기 토큰 · 모르는 토큰 · 만료 토큰의 응답 본문이 서로 다르다 — 유효했던 토큰인지 알려 준다(REST 와 같은 설계 — 토큰이 256비트라 열거는 못 한다)', async () => {
    const bodies = await Promise.all(
      [REVOKED_TOKEN, `atk_agent_${'Z'.repeat(43)}`, EXPIRED_TOKEN].map(async (token) => (await run({ headers: bearer(token) })).result.body),
    );
    expect(new Set(bodies).size).toBe(3);
  });

  it('[E1-L-011] 연결 id 는 응답에 되돌아오지 않는다', async () => {
    const { result } = await run({ headers: bearer(REVOKED_TOKEN) });
    expect(JSON.stringify(result)).not.toContain(CONNECTION_ID);
  });
});
