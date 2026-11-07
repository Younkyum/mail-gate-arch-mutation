/**
 * 실시간 λ 본체(`src/realtime/gateway.ts`) — 가짜 저장소. `$connect` 판정 순서(자격 증명 → 토큰 판정 → 권한 → 연결 행) · 상태 코드 · 하위 프로토콜 되돌림 ·
 * `$default` 핑/구독 · `$disconnect` · 잘못된 연결 id · 실시간 λ 핸들러의 조립 실패.
 */

import { describe, expect, it } from 'vitest';

import { hashAgentToken } from '../../../src/identity/agent-token';
import { handleRealtimeEvent, type WebSocketEvent } from '../../../src/realtime/gateway';
import { createRealtimeHandler } from '../../../src/runtime/handlers/realtime';
import {
  AGENT,
  CONNECTION_ID,
  EXPIRED_TOKEN,
  REVOKED_TOKEN,
  SEND_ONLY_TOKEN,
  TOKEN,
  connectEvent,
  connections,
  defaultEvent,
  deps,
} from '../adversarial/realtime-support';

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe('$connect', () => {
  it('헤더 토큰 → 200 · 연결 행에는 해시만(평문 토큰 없음) · 하위 프로토콜을 제안하지 않았으면 응답 머리 없음', async () => {
    const store = connections();
    const result = await handleRealtimeEvent(deps(store), connectEvent(bearer(TOKEN)));
    expect(result).toEqual({ statusCode: 200 });
    expect(store.calls).toEqual([{ kind: 'connect', connectionId: CONNECTION_ID, agentId: AGENT, tokenHash: hashAgentToken(TOKEN) }]);
    expect(JSON.stringify(store.calls)).not.toContain(TOKEN);
  });

  it('하위 프로토콜 토큰 → 200 + Sec-WebSocket-Protocol: atmark.v1(토큰은 되돌리지 않는다)', async () => {
    const result = await handleRealtimeEvent(deps(), connectEvent({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}` } }));
    expect(result).toEqual({ statusCode: 200, headers: { 'Sec-WebSocket-Protocol': 'atmark.v1' } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('★ 쿼리 토큰 → 400(토큰 판정 · 연결 행 없음) · 토큰 없음 · 모르는 · 폐기 · 만료 토큰 → 401 · messages:read 없음 → 403', async () => {
    const store = connections();
    const status = async (event: WebSocketEvent) => (await handleRealtimeEvent(deps(store), event)).statusCode;
    expect(await status(connectEvent({ queryStringParameters: { token: TOKEN } }))).toBe(400);
    expect(await status(connectEvent())).toBe(401);
    for (const token of [`atk_agent_${'Z'.repeat(43)}`, REVOKED_TOKEN, EXPIRED_TOKEN]) expect(await status(connectEvent(bearer(token)))).toBe(401);
    expect(await status(connectEvent(bearer(SEND_ONLY_TOKEN)))).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it('DB 결과 → 상태: limit 429 · inactive 403 · token_invalid 401 · duplicate 200', async () => {
    for (const [outcome, status] of [['limit', 429], ['inactive', 403], ['token_invalid', 401], ['duplicate', 200]] as const) {
      expect((await handleRealtimeEvent(deps(connections(outcome)), connectEvent(bearer(TOKEN)))).statusCode, outcome).toBe(status);
    }
  });

  it('연결 id 모양이 아니면 400(저장소에 가지 않는다)', async () => {
    const store = connections();
    const result = await handleRealtimeEvent(deps(store), connectEvent(bearer(TOKEN), "x'; DROP"));
    expect(result.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe('$default · $disconnect', () => {
  it('ping → pong + 마지막 핑 시각(DB) · 핑 기록 실패해도 pong', async () => {
    const store = connections();
    expect(await handleRealtimeEvent(deps(store), defaultEvent('{"action":"ping"}'))).toEqual({ statusCode: 200, body: '{"type":"pong"}' });
    expect(store.calls).toEqual([{ kind: 'seen', connectionId: CONNECTION_ID }]);
    expect((await handleRealtimeEvent(deps(connections('connected', true)), defaultEvent('{"action":"ping"}'))).body).toBe('{"type":"pong"}');
    const base64 = defaultEvent(Buffer.from('{"action":"ping"}').toString('base64'), { isBase64Encoded: true });
    expect((await handleRealtimeEvent(deps(), base64)).body).toBe('{"type":"pong"}');
  });

  it('subscribe → 고정 응답(이벤트 종류) · 모르는 것 · 깨진 JSON · 너무 큰 본문 → error(보낸 문자열을 되돌리지 않는다)', async () => {
    expect(JSON.parse((await handleRealtimeEvent(deps(), defaultEvent('{"action":"subscribe","events":["x"]}'))).body ?? '')).toEqual({
      type: 'subscribed',
      events: ['message.received', 'approval.resolved'],
    });
    for (const body of ['{"action":"<script>"}', 'not json', '[]', null, JSON.stringify({ action: 'ping', pad: 'x'.repeat(2_000) })]) {
      const result = await handleRealtimeEvent(deps(), defaultEvent(body));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? '')).toEqual({ type: 'error', error: 'unknown_action', actions: ['ping', 'subscribe'] });
      expect(result.body).not.toContain('<script>');
    }
  });

  it('$disconnect → 행 닫기 · 실패해도 200', async () => {
    const store = connections();
    const disconnect = defaultEvent(undefined, {}, '$disconnect');
    expect(await handleRealtimeEvent(deps(store), disconnect)).toEqual({ statusCode: 200 });
    expect(store.calls).toEqual([{ kind: 'disconnect', connectionId: CONNECTION_ID }]);
    expect(await handleRealtimeEvent(deps(connections('connected', true)), disconnect)).toEqual({ statusCode: 200 });
  });
});

describe('실시간 λ 핸들러', () => {
  const context = () => ({ awsRequestId: 'x', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-realtime', callbackWaitsForEmptyEventLoop: true });

  it('조립 실패 → $connect 503(핸드셰이크 거절) · 그 밖 200 · 라우트 예외 → 500(메시지 없음)', async () => {
    const broken = createRealtimeHandler(() => Promise.reject(new Error('secret unavailable')));
    expect(await broken(connectEvent(bearer(TOKEN)), context())).toEqual({ statusCode: 503 });
    expect(await broken(defaultEvent(undefined, {}, '$disconnect'), context())).toEqual({ statusCode: 200 });
    const throwing = createRealtimeHandler(() =>
      Promise.resolve({ deps: deps(connections(), { findByHash: () => Promise.reject(new Error('boom secret')) }) }),
    );
    expect(await throwing(connectEvent(bearer(TOKEN)), context())).toEqual({ statusCode: 500 });
  });
});
