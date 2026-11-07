/**
 * 적대적 검증(실시간 WebSocket E) — 영역 2: 격리 · `$default` 동작 한정 · 연결 id 검증 · 라우트 키 혼동 · 핸들러 실패 모양.
 * `$default` 는 ping · subscribe 만 한다. 되돌려 보내는 문자열이 없고, 크기 · 깊이 · 프로토타입 오염에 흔들리지 않는다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { handleRealtimeEvent, REALTIME_DB_TIMEOUT_MS, type RealtimeConnectionStore, type WebSocketEvent } from '../../../src/realtime/gateway';
import { createRealtimeHandler } from '../../../src/runtime/handlers/realtime';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { TOKEN, CONNECTION_ID, connectEvent, connections, defaultEvent, deps, numbered } from './realtime-support';

afterEach(() => {
  resetLogSink();
});

async function sendBody(body: string | null | undefined, extra: Partial<WebSocketEvent> = {}) {
  const store = connections();
  const result = await handleRealtimeEvent(deps(store), defaultEvent(body, extra));
  return { result, store, parsed: result.body === undefined ? undefined : (JSON.parse(result.body) as Record<string, unknown>) };
}

describe('E2 — $default 는 ping 과 subscribe 만 한다', () => {
  const unknownActions = [
    'PING',
    ' ping',
    'ping ',
    'ping\u0000',
    'pïng',
    'Ping',
    'unsubscribe',
    'subscribe_all',
    'subscribe:other-agent',
    'admin',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'send',
    'publish',
    'broadcast',
    'close',
    'disconnect',
    'connect',
    'auth',
    'sql',
    '',
    'ping;disconnect',
    'ping\nsubscribe',
  ];

  it.each(numbered('E2-A', unknownActions.map((a) => [JSON.stringify(a), a] as const)))('[%s] action=%s → unknown_action · DB 호출 없음', async (_id, _label, action) => {
    const { parsed, store } = await sendBody(JSON.stringify({ action }));
    expect(parsed).toMatchObject({ type: 'error', error: 'unknown_action' });
    expect(store.calls).toEqual([]);
  });

  const nonStringActions: unknown[] = [1, 0, null, true, false, ['ping'], { action: 'ping' }, { toString: 'ping' }];
  it.each(numbered('E2-N', nonStringActions.map((a) => [JSON.stringify(a), a] as const)))('[%s] action 이 문자열이 아니다(%s) → unknown_action', async (_id, _label, action) => {
    const { parsed, store } = await sendBody(JSON.stringify({ action }));
    expect(parsed).toMatchObject({ type: 'error' });
    expect(store.calls).toEqual([]);
  });

  const badBodies = [
    ['본문 null', null],
    ['본문 undefined', undefined],
    ['빈 문자열', ''],
    ['평문 ping', 'ping'],
    ['빈 객체', '{}'],
    ['닫히지 않은 JSON', '{"action":"ping"'],
    ['배열', '[{"action":"ping"}]'],
    ['빈 배열', '[]'],
    ['JSON 문자열', '"ping"'],
    ['null', 'null'],
    ['true', 'true'],
    ['숫자', '123'],
    ['키 대소문자(Action)', '{"Action":"ping"}'],
    ['키 앞 공백', '{" action":"ping"}'],
    ['BOM 이 붙은 JSON', '﻿{"action":"ping"}'],
    ['NUL 이 붙은 JSON', '{"action":"ping"}\u0000'],
    ['주석이 붙은 JSON', '{"action":"ping"}//x'],
  ] as const;
  it.each(numbered('E2-B', badBodies))('[%s] %s → error 프레임 · DB 호출 없음', async (_id, _label, body) => {
    const { parsed, store } = await sendBody(body);
    expect(parsed).toMatchObject({ type: 'error', error: 'unknown_action' });
    expect(store.calls).toEqual([]);
  });

  it('[E2-C-001] 정상 ping → pong · 연결 id 만으로 핑 기록(본문의 다른 필드는 무시)', async () => {
    const { parsed, store } = await sendBody(JSON.stringify({ action: 'ping', agent_id: 'b'.repeat(32), connection_id: 'OTHER_CONN=', connectionId: 'OTHER=' }));
    expect(parsed).toEqual({ type: 'pong' });
    expect(store.calls).toEqual([{ kind: 'seen', connectionId: CONNECTION_ID }]);
  });

  it('[E2-C-002] 본문이 가리키는 다른 연결(connection_id)로 ping 을 대신 칠 수 없다', async () => {
    const { store } = await sendBody(JSON.stringify({ action: 'ping', connection_id: 'VICTIM_CONN=' }));
    expect(JSON.stringify(store.calls)).not.toContain('VICTIM_CONN=');
  });

  it('[E2-C-003] subscribe 는 고정 응답 — 본문이 고른 이벤트 종류 · 다른 에이전트 · 와일드카드를 받지 않는다', async () => {
    const { parsed, store } = await sendBody(
      JSON.stringify({ action: 'subscribe', events: ['*', 'admin.secret', 'message.sent'], agent_id: 'b'.repeat(32), filter: { from: 'x' } }),
    );
    expect(parsed).toEqual({ type: 'subscribed', events: ['message.received', 'approval.resolved'] });
    expect(store.calls).toEqual([]);
  });

  it('[E2-C-004] 같은 action 키가 두 번이면 마지막 값이 이긴다 — ping 이 아니라 admin 으로 읽히면 error', async () => {
    const { parsed } = await sendBody('{"action":"ping","action":"admin"}');
    expect(parsed).toMatchObject({ type: 'error' });
  });

  it('[E2-C-005] 응답에 되돌려 보내는 클라이언트 문자열이 없다(에코 마커 · 로그)', async () => {
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });
    const marker = 'ECHO_MARKER_9f3a';
    const { result } = await sendBody(JSON.stringify({ action: marker, extra: marker }));
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(lines.join('\n')).not.toContain(marker);
  });
});

describe('E2 — 크기 · 깊이 · 프로토타입 오염', () => {
  it('[E2-D-001] __proto__ 키로 action 을 주입 → error · Object.prototype 오염 없음', async () => {
    const { parsed } = await sendBody('{"__proto__":{"action":"ping"}}');
    expect(parsed).toMatchObject({ type: 'error' });
    expect(({} as Record<string, unknown>)['action']).toBeUndefined();
  });

  it('[E2-D-002] constructor.prototype 오염 시도 → 전역 오염 없음', async () => {
    await sendBody('{"action":"ping","constructor":{"prototype":{"polluted":"yes"}}}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('[E2-D-003] ping + __proto__ 추가 필드 → pong 이고 오염 없음', async () => {
    const { parsed } = await sendBody('{"action":"ping","__proto__":{"isAdmin":true}}');
    expect(parsed).toEqual({ type: 'pong' });
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('[E2-D-004] 1 KiB 안에 들어가는 깊은 중첩(깊이 ~300) → 던지지 않고 error', async () => {
    const depth = 300;
    const { parsed } = await sendBody(`{"action":"ping","x":${'['.repeat(depth)}${']'.repeat(depth)}}`);
    expect(parsed).toBeDefined();
  });

  it('[E2-D-005] 200 KB 깊이 100000 중첩 → 크기 한도로 파싱 전에 거부 · 빠르게', async () => {
    const started = Date.now();
    const { parsed, store } = await sendBody('['.repeat(100_000) + ']'.repeat(100_000));
    expect(parsed).toMatchObject({ type: 'error' });
    expect(store.calls).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('[E2-D-006] 1025 바이트 ping(공백 채움) → 한도 초과 error', async () => {
    const body = `{"action":"ping"${' '.repeat(1025 - '{"action":"ping"}'.length)}}`;
    expect(Buffer.byteLength(body)).toBe(1025);
    const { parsed } = await sendBody(body);
    expect(parsed).toMatchObject({ type: 'error' });
  });

  it('[E2-D-007] 정확히 1024 바이트 ping → 받는다(경계)', async () => {
    const body = `{"action":"ping"${' '.repeat(1024 - '{"action":"ping"}'.length)}}`;
    expect(Buffer.byteLength(body)).toBe(1024);
    expect((await sendBody(body)).parsed).toEqual({ type: 'pong' });
  });

  it('[E2-D-008] 글자 수는 1024 아래지만 UTF-8 로 1024 바이트를 넘는 본문(한글 400자) → error(바이트로 센다)', async () => {
    const body = JSON.stringify({ action: 'ping', pad: '한'.repeat(400) });
    expect(body.length).toBeLessThan(1024);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024);
    expect((await sendBody(body)).parsed).toMatchObject({ type: 'error' });
  });

  it('[E2-D-009] base64 로 감싼 정상 ping → pong', async () => {
    const body = Buffer.from('{"action":"ping"}').toString('base64');
    expect((await sendBody(body, { isBase64Encoded: true })).parsed).toEqual({ type: 'pong' });
  });

  it('[E2-D-010] base64 디코딩 후 1 KiB 초과 → error', async () => {
    const body = Buffer.from(`{"action":"ping","p":"${'a'.repeat(2000)}"}`).toString('base64');
    expect((await sendBody(body, { isBase64Encoded: true })).parsed).toMatchObject({ type: 'error' });
  });

  it('[E2-D-011] base64 표시인데 본문이 base64 가 아니다 → error(던지지 않는다)', async () => {
    expect((await sendBody('{"action":"ping"}', { isBase64Encoded: true })).parsed).toMatchObject({ type: 'error' });
  });

  it('[E2-D-012] 128 KB 본문(API Gateway 상한) → 빠르게 error', async () => {
    const started = Date.now();
    const { parsed } = await sendBody(JSON.stringify({ action: 'ping', pad: 'x'.repeat(128 * 1024) }));
    expect(parsed).toMatchObject({ type: 'error' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('[E2-D-013] 같은 $default 를 10000 번 연속 처리해도 DB 호출은 ping 마다 한 번이다(증폭 없음)', async () => {
    const store = connections();
    for (let i = 0; i < 10_000; i += 1) await handleRealtimeEvent(deps(store), defaultEvent('{"action":"ping"}'));
    expect(store.calls).toHaveLength(10_000);
  });
});

describe('E2 — 라우트 키 혼동 · 연결 id 검증', () => {
  const lookalikeRoutes = ['$CONNECT', '$connect ', ' $connect', '$connect\n', '$Connect', 'connect', '$disconnect\u0000', '$DISCONNECT', 'admin', '$default;$connect', ''];
  it.each(numbered('E2-R', lookalikeRoutes.map((r) => [JSON.stringify(r), r] as const)))('[%s] routeKey=%s 는 연결을 만들지 않는다', async (_id, _label, routeKey) => {
    const store = connections();
    const event: WebSocketEvent = {
      requestContext: { routeKey, eventType: 'MESSAGE', connectionId: CONNECTION_ID },
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{"action":"subscribe"}',
    };
    const result = await handleRealtimeEvent(deps(store), event);
    expect(store.calls.filter((c) => c.kind === 'connect')).toEqual([]);
    expect(result.statusCode).toBe(200);
  });

  const badIds = ['', 'a b', 'a\nb', 'ab\n', '../x', 'a;b', "a' OR '1'='1", 'a'.repeat(129), 'ID\u0000', 'ａｂｃ', '%2e%2e', '.', '$default', 'a,b', 'a\\b', '<script>', 'ab\r\n'];
  it.each(numbered('E2-I', badIds.map((id) => [JSON.stringify(id), id] as const)))('[%s] 연결 id %s → 세 라우트 모두 400 · 저장소 호출 없음', async (_id, _label, connectionId) => {
    const store = connections();
    for (const routeKey of ['$connect', '$disconnect', '$default']) {
      const result = await handleRealtimeEvent(
        deps(store),
        { requestContext: { routeKey, connectionId }, headers: { Authorization: `Bearer ${TOKEN}` }, body: '{"action":"ping"}' },
      );
      expect(result.statusCode, routeKey).toBe(400);
    }
    expect(store.calls).toEqual([]);
  });

  it('[E2-I-018] 정당한 id 문자(= + / - _)는 받는다', async () => {
    const store = connections();
    const result = await handleRealtimeEvent(deps(store), connectEvent({ headers: { Authorization: `Bearer ${TOKEN}` } }, 'Ab1_=+/-'));
    expect(result.statusCode).toBe(200);
  });

  const nonStringIds: [string, unknown][] = [
    ['connectionId 없음(undefined)', undefined],
    ['connectionId null', null],
    ['connectionId 숫자 123', 123],
    ['connectionId 배열 ["abc"]', ['abc']],
    ['connectionId toString 객체', { toString: () => 'abc' }],
  ];
  it.each(numbered('E2-T', nonStringIds))('[%s] VULN: %s — 문자열이 아닌 id 는 400 이어야 한다(정규식이 값을 문자열로 바꿔 통과시키지 않는다)', async (_id, _label, connectionId) => {
    const store = connections();
    const result = await handleRealtimeEvent(
      deps(store),
      { requestContext: { routeKey: '$connect', connectionId: connectionId as never }, headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(result.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('[E2-S-001] SUSPECT: $disconnect · $default 는 호출한 쪽의 신원을 보지 않는다 — 연결 id 만 안다(API Gateway 가 신뢰의 뿌리다). 다른 id 의 disconnect 도 그대로 저장소에 닿는다', async () => {
    const store = connections();
    await handleRealtimeEvent(deps(store), { requestContext: { routeKey: '$disconnect', connectionId: 'VICTIM_CONN=' } });
    expect(store.calls).toEqual([{ kind: 'disconnect', connectionId: 'VICTIM_CONN=' }]);
  });

  it('[E2-S-002] (수정 뒤) 끊김 · 핑 저장소가 멈춰도 핸들러는 시간 상한(기본 2초)에서 응답한다 — pong · 200', async () => {
    const hanging: RealtimeConnectionStore = { ...connections(), seen: () => new Promise<void>(() => undefined), disconnect: () => new Promise<void>(() => undefined) };
    const quick = { ...deps(hanging), dbTimeoutMs: 50 };
    const race = <T,>(work: Promise<T>) => Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000))]);
    expect(await race(handleRealtimeEvent(quick, defaultEvent('{"action":"ping"}')))).toEqual({ statusCode: 200, body: '{"type":"pong"}' });
    expect(await race(handleRealtimeEvent(quick, { requestContext: { routeKey: '$disconnect', connectionId: CONNECTION_ID } }))).toEqual({ statusCode: 200 });
    expect(REALTIME_DB_TIMEOUT_MS).toBe(2_000);
  });
});

describe('E2 — 실시간 λ 핸들러 실패 모양', () => {
  const context = { awsRequestId: 'req', functionName: 'atmark-realtime', getRemainingTimeInMillis: () => 10_000 } as never;

  it('[E2-H-001] 조립이 실패하면 $connect 는 503 · 나머지는 200 · 오류 메시지가 응답에 없다', async () => {
    const handler = createRealtimeHandler(() => Promise.reject(new Error('secret connection string postgres://u:pw@h/db')));
    const connect = await handler(connectEvent({ headers: { Authorization: `Bearer ${TOKEN}` } }), context);
    const ping = await handler(defaultEvent('{"action":"ping"}'), context);
    const gone = await handler({ requestContext: { routeKey: '$disconnect', connectionId: CONNECTION_ID } }, context);
    expect([connect.statusCode, ping.statusCode, gone.statusCode]).toEqual([503, 200, 200]);
    expect(JSON.stringify([connect, ping, gone])).not.toContain('postgres://');
  });

  it('[E2-H-002] 라우트가 던지면 500 · 본문 없음 · 비밀이 응답에 없다', async () => {
    const failing = { ...connections(), connect: () => Promise.reject(new Error('db password=hunter2')) };
    const handler = createRealtimeHandler(() => Promise.resolve({ deps: deps(failing) } as never));
    const result = await handler(connectEvent({ headers: { Authorization: `Bearer ${TOKEN}` } }), context);
    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('[E2-H-003] $disconnect 저장소 실패는 200 으로 삼킨다(API Gateway 가 결과를 쓰지 않고 스윕이 따라잡는다)', async () => {
    const failing = { ...connections(), disconnect: () => Promise.reject(new Error('down')) };
    const result = await handleRealtimeEvent(deps(failing), { requestContext: { routeKey: '$disconnect', connectionId: CONNECTION_ID } });
    expect(result.statusCode).toBe(200);
  });

  it('[E2-H-004] $default 핑 저장소 실패도 pong 을 준다', async () => {
    const failing = { ...connections(), seen: () => Promise.reject(new Error('down')) };
    const result = await handleRealtimeEvent(deps(failing), defaultEvent('{"action":"ping"}'));
    expect(JSON.parse(result.body ?? '{}')).toEqual({ type: 'pong' });
  });

  it('[E2-H-005] SUSPECT: requestContext 가 없는 이벤트(직접 호출 · 잘못된 통합)는 핸들러 밖으로 TypeError 가 샌다 — 500 응답 모양으로 막히지 않는다', async () => {
    const handler = createRealtimeHandler(() => Promise.resolve({ deps: deps() } as never));
    await expect(handler({} as never, context)).rejects.toThrow(TypeError);
  });

  it('[E2-H-006] 토큰 판정 저장소가 던져도 응답 본문에 예외 메시지가 없다', async () => {
    const broken = { findByHash: () => Promise.reject(new Error('relation "agent_api_keys" does not exist')) };
    const handler = createRealtimeHandler(() => Promise.resolve({ deps: deps(connections(), broken as never) } as never));
    const result = await handler(connectEvent({ headers: { Authorization: `Bearer ${TOKEN}` } }), context);
    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result)).not.toContain('agent_api_keys');
  });
});
