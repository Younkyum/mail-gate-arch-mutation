/**
 * src/realtime/gateway.ts — API Gateway WebSocket 의 세 라우트(`$connect` · `$disconnect` · `$default`)를 처리한다. 실시간 λ(`atmark-realtime`)의 본체.
 *
 *   - `$connect` — 자격 증명 읽기(`auth.ts` — 헤더 · 하위 프로토콜만, 쿼리 토큰은 거부) → **토큰 판정은 `authenticateAgentToken` 하나**(REST · MCP 와 같다)
 *     → `messages:read` 권한 → 연결 행(정의 함수 `atmark_realtime_connect` — 에이전트 · 조직 활성 · 토큰 재확인 · 에이전트당 5개 상한은 트리거).
 *     거부는 HTTP 상태로 끝난다(핸드셰이크가 열리지 않는다): 401 토큰 · 400 쿼리 토큰 · 403 권한/비활성 · 429 상한.
 *   - `$disconnect` — 행을 닫는다(`closed_at` — 지우지 않는다). 실패해도 200(API Gateway 는 이 결과를 쓰지 않는다 · 스윕이 따라잡는다).
 *   - `$default` — `{"action":"ping"}` → `{"type":"pong"}`(1분에 한 번만 `last_seen_at` 을 적는다) · `{"action":"subscribe"}` → 고정 응답(구독은 연결 단위 —
 *     지금은 모든 종류를 받는다). 그 밖은 `{"type":"error"}`. **에이전트가 보낸 문자열을 되돌려 보내지 않는다.**
 */

import { authenticateAgentToken, hashAgentToken, type AgentTokenStore } from '../identity/agent-token';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { readRealtimeCredential } from './auth';
import { REALTIME_CLIENT_ACTIONS, REALTIME_EVENT_TYPES, REALTIME_REQUIRED_SCOPE } from './contract';

export const REALTIME_ROUTE_ID = 'realtime';

/** API Gateway WebSocket → Lambda 프록시 이벤트(쓰는 칸만). */
export interface WebSocketEvent {
  readonly requestContext: {
    readonly routeKey: string;
    readonly eventType?: string;
    readonly connectionId: string;
    readonly requestId?: string;
  };
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface WebSocketResult {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type RealtimeConnectOutcome = 'connected' | 'limit' | 'inactive' | 'token_invalid' | 'duplicate';

/** 연결 행 포트(`src/db/repositories/realtime-connection-store.ts`). 평문 토큰을 받는 메서드는 없다(해시만). */
export interface RealtimeConnectionStore {
  connect(input: { readonly connectionId: string; readonly agentId: string; readonly tokenHash: string }): Promise<RealtimeConnectOutcome>;
  disconnect(connectionId: string): Promise<void>;
  seen(connectionId: string): Promise<void>;
}

export interface RealtimeGatewayDependencies {
  readonly tokens: AgentTokenStore;
  readonly connections: RealtimeConnectionStore;
  readonly now: () => Date;
  /** `$disconnect` · `$default` 의 DB 호출 시간 상한(ms) — 기본 `REALTIME_DB_TIMEOUT_MS`. 넘기면 기다리지 않고 응답한다(스윕이 따라잡는다). */
  readonly dbTimeoutMs?: number;
}

/** `$disconnect` · `$default` DB 호출 상한(적대 검증 E2-S-002 — λ 타임아웃 10초에 기대지 않는다). */
export const REALTIME_DB_TIMEOUT_MS = 2_000;

class DbTimeout extends Error {
  constructor() {
    super('realtime db call timed out');
    this.name = 'DbTimeout';
  }
}

/** 상한 안에서 기다린다 — 넘기면 `DbTimeout`(늦게 끝나는 실패는 삼킨다). */
async function within(ms: number, work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => undefined);
  try {
    await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new DbTimeout()), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const CONNECTION_ID = /^[A-Za-z0-9_=+/-]{1,128}$/;
/** `$default` 본문 상한 — 클라이언트 메시지는 `{"action":"ping"}` 정도다. */
const MAX_CLIENT_MESSAGE_BYTES = 1_024;

function reject(statusCode: number, reason: string, traceId: string | null): WebSocketResult {
  countMetric(METRIC_NAMES.realtimeConnectRejected);
  log('info', 'realtime.connect_rejected', { route_id: REALTIME_ROUTE_ID, trace_id: traceId, reason, http_status: statusCode });
  return { statusCode, body: JSON.stringify({ error: reason }) };
}

async function handleConnect(deps: RealtimeGatewayDependencies, event: WebSocketEvent): Promise<WebSocketResult> {
  const traceId = event.requestContext.requestId ?? null;
  const credential = readRealtimeCredential(event);
  if (credential.kind === 'rejected') return reject(credential.reason === 'token_in_query' ? 400 : 401, credential.reason, traceId);

  const authentication = await authenticateAgentToken(deps.tokens, credential.token, deps.now());
  if (authentication.kind === 'rejected') return reject(401, authentication.reason, traceId);
  const { principal } = authentication;
  if (!principal.capabilities.includes(REALTIME_REQUIRED_SCOPE)) return reject(403, 'capability_not_granted', traceId);

  const outcome = await deps.connections.connect({
    connectionId: event.requestContext.connectionId,
    agentId: principal.agentId,
    tokenHash: hashAgentToken(credential.token),
  });
  switch (outcome) {
    case 'connected':
    case 'duplicate':
      log('info', 'realtime.connected', { route_id: REALTIME_ROUTE_ID, trace_id: traceId, agent_id: principal.agentId, outcome, detail: credential.via });
      return credential.echoProtocol === null
        ? { statusCode: 200 }
        : { statusCode: 200, headers: { 'Sec-WebSocket-Protocol': credential.echoProtocol } };
    case 'limit':
      return reject(429, 'connection_limit', traceId);
    case 'inactive':
      return reject(403, 'agent_inactive', traceId);
    case 'token_invalid':
      return reject(401, 'token_invalid', traceId);
  }
}

function clientMessage(event: WebSocketEvent): string | null {
  const raw = event.body;
  if (typeof raw !== 'string') return null;
  const text = event.isBase64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const action = (parsed as Record<string, unknown>)['action'];
    return typeof action === 'string' ? action : null;
  } catch {
    return null;
  }
}

async function handleDefault(deps: RealtimeGatewayDependencies, event: WebSocketEvent): Promise<WebSocketResult> {
  const action = clientMessage(event);
  if (action === 'ping') {
    try {
      await within(deps.dbTimeoutMs ?? REALTIME_DB_TIMEOUT_MS, deps.connections.seen(event.requestContext.connectionId));
    } catch (error) {
      log('warn', 'realtime.seen_failed', { route_id: REALTIME_ROUTE_ID, error_kind: error instanceof Error ? error.name : typeof error });
    }
    return { statusCode: 200, body: JSON.stringify({ type: 'pong' }) };
  }
  if (action === 'subscribe') {
    return { statusCode: 200, body: JSON.stringify({ type: 'subscribed', events: [...REALTIME_EVENT_TYPES] }) };
  }
  return { statusCode: 200, body: JSON.stringify({ type: 'error', error: 'unknown_action', actions: [...REALTIME_CLIENT_ACTIONS] }) };
}

async function handleDisconnect(deps: RealtimeGatewayDependencies, event: WebSocketEvent): Promise<WebSocketResult> {
  try {
    await within(deps.dbTimeoutMs ?? REALTIME_DB_TIMEOUT_MS, deps.connections.disconnect(event.requestContext.connectionId));
  } catch (error) {
    log('warn', 'realtime.disconnect_failed', { route_id: REALTIME_ROUTE_ID, error_kind: error instanceof Error ? error.name : typeof error });
  }
  return { statusCode: 200 };
}

export async function handleRealtimeEvent(deps: RealtimeGatewayDependencies, event: WebSocketEvent): Promise<WebSocketResult> {
  // 문자열인지 먼저 — 정규식 `.test()` 는 값을 문자열로 바꿔(undefined → "undefined", 배열 · toString 객체) 통과시킨다(V-E-04).
  const connectionId: unknown = event.requestContext.connectionId;
  if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return { statusCode: 400 };
  switch (event.requestContext.routeKey) {
    case '$connect':
      return handleConnect(deps, event);
    case '$disconnect':
      return handleDisconnect(deps, event);
    default:
      return handleDefault(deps, event);
  }
}
