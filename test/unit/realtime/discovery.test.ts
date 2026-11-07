/**
 * 실시간 안내(묶음 E) — 발견 문서 `realtime` · OpenAPI `x-atmark-realtime` · `GET /v1/agents/{id}/realtime`(MCP `get_realtime_connection`).
 * 주소는 배포가 정한다(모양이 틀리면 정본 호스트) · 권한 `messages:read` · 남의 에이전트 403 · **응답에 토큰이 없다.**
 */

import { describe, expect, it } from 'vitest';

import { discoveryDocument, realtimeUrlOf, REALTIME_STATUS, REALTIME_URL } from '../../../src/api/discovery';
import { openApiDocument } from '../../../src/api/openapi/document';
import { handleGetRealtimeConnection } from '../../../src/api/routes/discovery';
import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, type AgentTokenCapability, type AgentTokenStore } from '../../../src/identity/agent-token';

const AGENT = 'c'.repeat(32);
const TOKEN = `atk_agent_${'R'.repeat(43)}`;
const EXECUTE_API = 'wss://abc123.execute-api.ap-northeast-2.amazonaws.com/v1';

function tokens(capabilities: readonly AgentTokenCapability[]): AgentTokenStore {
  return {
    findByHash: (hash) =>
      Promise.resolve(hash === hashAgentToken(TOKEN) ? { tokenHash: hash, agentId: toAgentId(AGENT), capabilities, revokedAt: null, expiresAt: null } : null),
  };
}

const request = { method: 'GET', path: `/v1/agents/${AGENT}/realtime`, headers: { authorization: `Bearer ${TOKEN}` }, query: {}, body: null } as never;

describe('발견 문서 · OpenAPI', () => {
  it('available · 배포 주소 · 인증 둘(헤더 · 하위 프로토콜) · 쿼리 토큰 금지 문구 · 이벤트 둘 · 연결 안내 경로', () => {
    expect(REALTIME_STATUS).toBe('available');
    const realtime = discoveryDocument(EXECUTE_API)['realtime'] as Record<string, unknown>;
    expect(realtime).toMatchObject({
      url: EXECUTE_API,
      protocol: 'websocket',
      subprotocol: 'atmark.v1',
      status: 'available',
      events: ['message.received', 'approval.resolved'],
      mcp_tool: 'get_realtime_connection',
      limits: { max_connections_per_agent: 5, connection_max_seconds: 7200 },
    });
    const auth = realtime['auth'] as { methods: { kind: string }[]; query_string: string };
    expect(auth.methods.map((m) => m.kind)).toEqual(['header', 'subprotocol']);
    expect(auth.query_string).toMatch(/Never put the token in the URL/);
    expect((discoveryDocument()['realtime'] as { url: string }).url).toBe(REALTIME_URL);
  });

  it('realtimeUrlOf — wss 호스트(+ 스테이지)만 · 그 밖은 정본 호스트', () => {
    expect(realtimeUrlOf(EXECUTE_API)).toBe(EXECUTE_API);
    expect(realtimeUrlOf('wss://realtime.atmark.ai')).toBe('wss://realtime.atmark.ai');
    for (const bad of [undefined, '', 'ws://insecure.example', 'https://x.example', 'wss://x.example/v1?token=atk_agent_x', 'wss://evil.example/a/b']) {
      expect(realtimeUrlOf(bad), String(bad)).toBe(REALTIME_URL);
    }
  });

  it('OpenAPI 확장 x-atmark-realtime — 이벤트 스키마 · 봉투 · 라우트 getRealtimeConnection', () => {
    const document = openApiDocument();
    expect(document['x-atmark-realtime']).toMatchObject({ protocol: 'websocket', events: ['message.received', 'approval.resolved'] });
    const schemas = (document['x-atmark-realtime'] as { event_schemas: Record<string, { data: Record<string, unknown> }> }).event_schemas;
    // 받은 메일 힌트에는 보낸 사람 · 제목 · 본문 칸이 없다.
    expect(Object.keys(schemas['message.received']?.data ?? {}).sort()).toEqual(['message_id', 'received_at', 'risk', 'thread_id']);
    const paths = document['paths'] as Record<string, Record<string, { operationId: string; 'x-atmark-scope'?: string }>>;
    expect(paths['/v1/agents/{agentId}/realtime']?.['get']).toMatchObject({ operationId: 'getRealtimeConnection', 'x-atmark-scope': 'messages:read' });
  });
});

describe('GET /v1/agents/{id}/realtime', () => {
  const now = () => new Date('2026-10-08T00:00:00Z');

  it('messages:read 토큰 → 200 · 배포 주소 · 응답 어디에도 토큰이 없다', async () => {
    const response = await handleGetRealtimeConnection({ tokens: tokens(['messages:read']), now, realtimeUrl: EXECUTE_API }, request, { agentId: AGENT });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ agent_id: AGENT, url: EXECUTE_API, subprotocol: 'atmark.v1' });
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('권한 없음 403 · 남의 에이전트 403 · 토큰 없음 401 · 잘못된 id 400', async () => {
    expect((await handleGetRealtimeConnection({ tokens: tokens(['messages:send']), now }, request, { agentId: AGENT })).status).toBe(403);
    expect((await handleGetRealtimeConnection({ tokens: tokens(['messages:read']), now }, request, { agentId: 'd'.repeat(32) })).status).toBe(403);
    expect((await handleGetRealtimeConnection({ tokens: tokens(['messages:read']), now }, { ...(request as object), headers: {} } as never, { agentId: AGENT })).status).toBe(401);
    expect((await handleGetRealtimeConnection({ tokens: tokens(['messages:read']), now }, request, { agentId: 'self' })).status).toBe(400);
  });
});
