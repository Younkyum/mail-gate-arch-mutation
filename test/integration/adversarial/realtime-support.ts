/**
 * 적대적 검증(실시간 WebSocket E) 통합 공용 지반 — 실제 Postgres 위 실시간 λ 본체 · 대상 함수 · 푸시.
 * 이 파일은 테스트가 아니다(시험 파일이 가져다 쓴다). 운영 소스는 건드리지 않는다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createPool } from '../../../src/db/client';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { createPostgresRealtimeConnectionStore, createPostgresRealtimeInboundTargets } from '../../../src/db/repositories/realtime-connection-store';
import { issueAgentToken, type AgentTokenCapability } from '../../../src/identity/agent-token';
import { handleRealtimeEvent, type RealtimeGatewayDependencies, type WebSocketEvent } from '../../../src/realtime/gateway';
import { createRealtimePusher, type RealtimeTargetStore, type RealtimeTransport } from '../../../src/realtime/push';
import type { InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import { provisioningPool, testPool, type Fixture } from '../db/support/harness';
import { deliver, eml, newSesMessageId } from '../inbound/support';

const appUrl = process.env['TEST_DATABASE_URL'] ?? '';

/** 앱 URL 의 사용자만 바꾼 풀(로컬 · CI 비밀번호 'atmark'). */
export function rolePool(role: string, max = 1): Pool {
  const parsed = new URL(appUrl);
  parsed.username = role;
  parsed.password = 'atmark';
  return createPool(parsed.toString(), { max });
}

export const owner = (): Pool => provisioningPool();

export async function isSuperuser(): Promise<boolean> {
  return (await owner().query<{ s: boolean }>('SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')).rows[0]?.s === true;
}

export async function issueToken(
  f: Fixture,
  capabilities: readonly AgentTokenCapability[] = ['messages:read', 'messages:send'],
  expiresInSeconds: number | null = null,
): Promise<{ plaintext: string; id: string; hash: string }> {
  const issued = issueAgentToken(f.agentId, capabilities);
  const result = await owner().query<{ id: string }>(
    `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, expires_at)
     VALUES ($1, $2, $3::agent_token_capability[], CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END) RETURNING id`,
    [f.agentId, issued.tokenHash, [...capabilities], expiresInSeconds],
  );
  return { plaintext: issued.plaintext, id: result.rows[0]?.id ?? '', hash: issued.tokenHash };
}

export const gatewayWith = (pool: Pool = testPool()): RealtimeGatewayDependencies => ({
  tokens: createPostgresAgentTokenStore(pool),
  connections: createPostgresRealtimeConnectionStore(pool),
  now: () => new Date(),
});

export const newConnectionId = (): string => `${randomUUID().replace(/-/g, '').slice(0, 14)}=`;

export interface ConnectOptions {
  readonly id?: string;
  readonly via?: 'header' | 'subprotocol';
  readonly pool?: Pool;
  readonly query?: Record<string, string>;
  readonly headers?: Record<string, string>;
}

export async function connectWith(plaintext: string, options: ConnectOptions = {}) {
  const id = options.id ?? newConnectionId();
  const event: WebSocketEvent = {
    requestContext: { routeKey: '$connect', eventType: 'CONNECT', connectionId: id, requestId: randomUUID() },
    headers: options.headers ?? (options.via === 'subprotocol' ? { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${plaintext}` } : { Authorization: `Bearer ${plaintext}` }),
    ...(options.query === undefined ? {} : { queryStringParameters: options.query }),
  };
  return { id, result: await handleRealtimeEvent(gatewayWith(options.pool), event) };
}

export const disconnectWith = (id: string) =>
  handleRealtimeEvent(gatewayWith(), { requestContext: { routeKey: '$disconnect', eventType: 'DISCONNECT', connectionId: id } });

export const pingWith = (id: string) =>
  handleRealtimeEvent(gatewayWith(), { requestContext: { routeKey: '$default', eventType: 'MESSAGE', connectionId: id }, body: '{"action":"ping"}' });

export interface Row {
  agent_id: string;
  organization_id: string;
  api_key_id: string;
  closed_at: Date | null;
  close_reason: string | null;
  expires_at: Date;
  connected_at: Date;
  last_seen_at: Date;
}

export async function rowOf(id: string): Promise<Row | undefined> {
  return (
    await owner().query<Row>(
      'SELECT agent_id, organization_id, api_key_id, closed_at, close_reason, expires_at, connected_at, last_seen_at FROM realtime_connections WHERE connection_id = $1',
      [id],
    )
  ).rows[0];
}

export async function openCount(agentId: string): Promise<number> {
  return Number((await owner().query<{ n: string }>('SELECT count(*) AS n FROM realtime_connections WHERE agent_id = $1 AND closed_at IS NULL', [agentId])).rows[0]?.n ?? 0);
}

/** 소유자(초사용자)가 트리거를 끄고 행의 시각을 옮긴다 — 시간 여행. 운영 경로에는 없다. */
export async function timeTravel(id: string, sql: string, params: unknown[] = []): Promise<void> {
  const client = await owner().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, [id, ...params]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 연결을 지금 만료로 만든다(만료 2시간 경과). */
export const expireNow = (id: string) =>
  timeTravel(id, `UPDATE realtime_connections SET connected_at = now() - interval '3 hours', last_seen_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' WHERE connection_id = $1`);

/** 핑이 `minutes` 분 전이 마지막이었던 것처럼. */
export const staleBy = (id: string, minutes: number) =>
  timeTravel(id, `UPDATE realtime_connections SET connected_at = now() - make_interval(mins => $2::int + 1), last_seen_at = now() - make_interval(mins => $2::int), expires_at = now() - make_interval(mins => $2::int + 1) + interval '2 hours' WHERE connection_id = $1`, [minutes]);

export interface Posted {
  readonly connectionId: string;
  readonly frame: Record<string, unknown>;
  readonly raw: string;
}

export function fakeTransport(gone: ReadonlySet<string> = new Set()): RealtimeTransport & { readonly posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    posted,
    post(connectionId, frame) {
      if (gone.has(connectionId)) return Promise.resolve('gone');
      posted.push({ connectionId, frame: JSON.parse(frame) as Record<string, unknown>, raw: frame });
      return Promise.resolve('sent');
    },
  };
}

export function pushing(transport: RealtimeTransport, targets: RealtimeTargetStore = createPostgresRealtimeInboundTargets(testPool()), timeoutMs?: number) {
  return createRealtimePusher({ targets, transport, routeId: 'adv', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

export async function receiveMail(
  f: Fixture,
  deps: InboundConsumerDependencies,
  options: { from?: string; subject?: string; text?: string; sesMessageId?: string; recipients?: readonly string[] } = {},
): Promise<{ id: string; sesMessageId: string; outcome: string }> {
  const sesMessageId = options.sesMessageId ?? newSesMessageId();
  const outcome = await deliver(deps, eml({ from: options.from ?? `s-${randomUUID().slice(0, 6)}@partner.example`, subject: options.subject ?? 'hi', text: options.text ?? 'Hello there, see you Tuesday.' }), {
    sesMessageId,
    recipients: options.recipients ?? [f.address],
  });
  const row = await owner().query<{ id: string }>('SELECT id FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [f.agentId, sesMessageId]);
  return { id: row.rows[0]?.id ?? '', sesMessageId, outcome };
}
