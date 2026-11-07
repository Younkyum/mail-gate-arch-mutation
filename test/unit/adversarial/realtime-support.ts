/**
 * 적대적 검증(실시간 WebSocket E) 단위 공용 지반 — 가짜 토큰 저장소 · 가짜 연결 저장소 · 시도 번호.
 * 이 파일은 테스트가 아니다(시험 파일이 가져다 쓴다). 운영 소스는 건드리지 않는다.
 */

import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, type AgentTokenCapability, type AgentTokenRecord, type AgentTokenStore } from '../../../src/identity/agent-token';
import type { RealtimeConnectionStore, RealtimeConnectOutcome, RealtimeGatewayDependencies, WebSocketEvent } from '../../../src/realtime/gateway';

export const AGENT = 'a'.repeat(32);
export const OTHER_AGENT = 'b'.repeat(32);
export const TOKEN = `atk_agent_${'Q'.repeat(43)}`;
export const OTHER_TOKEN = `atk_agent_${'W'.repeat(43)}`;
export const REVOKED_TOKEN = `atk_agent_${'R'.repeat(43)}`;
export const EXPIRED_TOKEN = `atk_agent_${'E'.repeat(43)}`;
export const SEND_ONLY_TOKEN = `atk_agent_${'S'.repeat(43)}`;
export const ORG_KEY = `atk_org_${'K'.repeat(43)}`;
export const NOW = new Date('2026-10-08T10:00:00Z');
export const CONNECTION_ID = 'L0SM9cOFvHcCIhw=';

/** 시도 번호 — `[E1-A-001]` 모양. 보고서 생성기가 제목에서 영역(E1…E6)과 번호를 읽는다. */
export function numbered<T extends readonly unknown[]>(prefix: string, rows: readonly T[]): [string, ...T][] {
  return rows.map((row, index) => [`${prefix}-${String(index + 1).padStart(3, '0')}`, ...row] as [string, ...T]);
}

export function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(3, '0')}`;
}

export interface TokenStoreSpy extends AgentTokenStore {
  readonly lookups: string[];
  readonly touches: string[];
}

export function tokenStore(): TokenStoreSpy {
  const lookups: string[] = [];
  const touches: string[] = [];
  const record = (token: string, agent: string, capabilities: readonly AgentTokenCapability[], extra: Partial<AgentTokenRecord> = {}): [string, AgentTokenRecord] => [
    hashAgentToken(token),
    { tokenHash: hashAgentToken(token), agentId: toAgentId(agent), capabilities, revokedAt: null, expiresAt: null, ...extra },
  ];
  const records = new Map<string, AgentTokenRecord>([
    record(TOKEN, AGENT, ['messages:read']),
    record(OTHER_TOKEN, OTHER_AGENT, ['messages:read']),
    record(REVOKED_TOKEN, AGENT, ['messages:read'], { revokedAt: new Date('2026-10-01T00:00:00Z') }),
    record(EXPIRED_TOKEN, AGENT, ['messages:read'], { expiresAt: new Date('2026-10-08T09:00:00Z') }),
    record(SEND_ONLY_TOKEN, AGENT, ['messages:send']),
  ]);
  return {
    lookups,
    touches,
    findByHash(hash: string) {
      lookups.push(hash);
      return Promise.resolve(records.get(hash) ?? null);
    },
    touch(hash: string) {
      touches.push(hash);
      return Promise.resolve();
    },
  };
}

export interface ConnectionsSpy extends RealtimeConnectionStore {
  readonly calls: { readonly kind: string; readonly connectionId: unknown; readonly agentId?: string; readonly tokenHash?: string }[];
}

/** `fail` — 끊기 · 핑 저장소가 거부한다(DB 장애). */
export function connections(outcome: RealtimeConnectOutcome = 'connected', fail = false): ConnectionsSpy {
  const calls: ConnectionsSpy['calls'] = [];
  return {
    calls,
    connect(input) {
      calls.push({ kind: 'connect', ...input });
      return Promise.resolve(outcome);
    },
    disconnect(connectionId) {
      calls.push({ kind: 'disconnect', connectionId });
      return fail ? Promise.reject(new Error('db down')) : Promise.resolve();
    },
    seen(connectionId) {
      calls.push({ kind: 'seen', connectionId });
      return fail ? Promise.reject(new Error('db down')) : Promise.resolve();
    },
  };
}

export function deps(store: RealtimeConnectionStore = connections(), tokens: AgentTokenStore = tokenStore()): RealtimeGatewayDependencies {
  return { tokens, connections: store, now: () => NOW };
}

export function connectEvent(extra: Partial<WebSocketEvent> = {}, connectionId: string = CONNECTION_ID): WebSocketEvent {
  return { requestContext: { routeKey: '$connect', eventType: 'CONNECT', connectionId, requestId: 'r-adv' }, ...extra };
}

export function defaultEvent(body: string | null | undefined, extra: Partial<WebSocketEvent> = {}, routeKey = '$default'): WebSocketEvent {
  return { requestContext: { routeKey, eventType: 'MESSAGE', connectionId: CONNECTION_ID, requestId: 'r-adv' }, body: body as string | null, ...extra };
}
