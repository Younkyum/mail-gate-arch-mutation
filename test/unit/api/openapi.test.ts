/**
 * 묶음 B — OpenAPI 3.1(`GET /v1/openapi.json`)과 발견 문서(`/.well-known/atmark.json`)는 **단일 정본 표**(`src/api/openapi/operations.ts`)에서 나온다.
 *
 *   ① 라우터 표의 `/v1/**` · `/.well-known/**` 항목 ⇔ 정본 표 — **양방향**(라우트를 더하고 표에 안 적거나, 표에만 있는 경로가 있으면 빨갛다).
 *   ② 매니페스트의 http 발송 경로는 전부 `Idempotency-Key: required` 다(§4.5-1). 첨부 업로드는 `optional`.
 *   ③ 문서 모양 — openapi 3.1.0 · 모든 `$ref` 가 components 에 있다 · operationId 유일 · 경로 파라미터가 템플릿과 같다.
 *   ④ 발견 문서 — 실시간 · SDK 게시 표지는 상수로만(묶음 E · F 가 뒤집는다), MCP URL 은 콘솔 연결 안내와 같은 값.
 */

import { describe, expect, it } from 'vitest';

import { SELF_AGENT_ALIAS } from '../../../src/api/auth';
import { isAgentId } from '../../../src/db/schema';
import { DISCOVERY_URL, discoveryDocument, MCP_ENDPOINT_URL, OPENAPI_URL, REALTIME_STATUS, SDK_PUBLISHED } from '../../../src/api/discovery';
import { openApiDocument } from '../../../src/api/openapi/document';
import { API_OPERATIONS } from '../../../src/api/openapi/operations';
import { MCP_URL } from '../../../src/admin/ui/setup-message';
import { OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import { ROUTE_TABLE } from '../../../src/runtime/router';

const PUBLIC_PREFIXES = ['/v1/', '/.well-known/'];

function routerOperations(): string[] {
  return ROUTE_TABLE.filter((entry) => PUBLIC_PREFIXES.some((prefix) => entry.path.startsWith(prefix)))
    .map((entry) => `${entry.method} ${entry.path}`)
    .sort();
}

describe('OpenAPI 정본 표 ↔ 라우터 표', () => {
  it('① /v1 · /.well-known 의 모든 라우트가 표에 있고, 표의 모든 항목이 라우트다(양방향)', () => {
    const spec = API_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`).sort();
    expect(routerOperations().length).toBeGreaterThan(30); // 비공허성
    expect(spec).toEqual(routerOperations());
  });

  it('② 매니페스트 http 발송 경로는 Idempotency-Key required, 첨부 업로드는 optional', () => {
    for (const route of OUTBOUND_ROUTES.filter((candidate) => candidate.kind === 'http')) {
      const [method, ref] = route.ref.split(' ');
      const path = (ref ?? '').replace(/:id\b/g, '{id}');
      const operation = API_OPERATIONS.find(
        (candidate) => candidate.method === method && candidate.path.replace(/\{[A-Za-z]+\}/g, '{id}') === path,
      );
      expect(operation, route.id).toBeDefined();
      expect(operation?.idempotencyKey, route.id).toBe('required');
    }
    expect(API_OPERATIONS.find((operation) => operation.path === '/v1/attachments')?.idempotencyKey).toBe('optional');
  });

  it('③ 문서 모양 — 3.1.0 · $ref 는 전부 components 에 · operationId 유일 · 경로 파라미터 = 템플릿', () => {
    const document = openApiDocument();
    expect(document['openapi']).toBe('3.1.0');
    const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((name) => name === undefined || !(name in schemas))).toEqual([]);
    const ids = API_OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = document['paths'] as Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>;
    for (const operation of API_OPERATIONS) {
      const object = paths[operation.path]?.[operation.method.toLowerCase()];
      const declared = (object?.parameters ?? []).filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name);
      const template = [...operation.path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]);
      expect(declared, operation.operationId).toEqual(template);
    }
    // 무인증 셋은 security 가 비어 있다.
    expect(paths['/.well-known/atmark.json']?.['get']).toMatchObject({ security: [] });
    expect(paths['/v1/openapi.json']?.['get']).toMatchObject({ security: [] });
  });

  it('⑤ agent_id 는 어디서도 필수가 아니다(생략 = 토큰의 에이전트) · {agentId} 는 me 별칭을 문서에 적는다 · me 는 에이전트 id 가 될 수 없다', () => {
    const document = openApiDocument();
    const paths = document['paths'] as Record<string, Record<string, { parameters?: { in: string; name: string; required: boolean; description?: string }[] }>>;
    let agentPaths = 0;
    let agentQueries = 0;
    for (const operation of API_OPERATIONS) {
      const parameters = paths[operation.path]?.[operation.method.toLowerCase()]?.parameters ?? [];
      for (const parameter of parameters) {
        if (parameter.in === 'query' && parameter.name === 'agent_id') {
          agentQueries += 1;
          expect(parameter.required, operation.operationId).toBe(false);
          expect(parameter.description, operation.operationId).toContain("Defaults to the token's agent");
        }
        if (parameter.in === 'path' && parameter.name === 'agentId') {
          agentPaths += 1;
          expect(operation.auth.kind, operation.operationId).toBe('bearer');
          expect(parameter.description, operation.operationId).toContain('"me"');
        }
      }
    }
    expect(agentQueries).toBeGreaterThanOrEqual(5);
    expect(agentPaths).toBeGreaterThanOrEqual(10);
    const schemas = (document['components'] as { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }).schemas;
    for (const name of ['SendRequest', 'DraftInput', 'AttachmentUploadInput']) {
      expect(schemas[name]?.required ?? [], name).not.toContain('agent_id');
      expect(schemas[name]?.properties?.['agent_id'], name).toMatchObject({ type: 'string' });
    }
    expect(isAgentId(SELF_AGENT_ALIAS)).toBe(false);
  });
});

describe('발견 문서', () => {
  it('④ URL · 표지 — 실시간은 available(묶음 E) · SDK 는 미게시 · MCP URL 은 콘솔 안내와 같다', () => {
    const document = discoveryDocument();
    expect(MCP_ENDPOINT_URL).toBe(MCP_URL);
    expect(document).toMatchObject({
      service: 'atmark',
      api: { base_url: 'https://api.atmark.ai/v1', openapi_url: OPENAPI_URL },
      mcp: { url: MCP_URL, capabilities_tool: 'get_capabilities' },
      realtime: { url: 'wss://realtime.atmark.ai', status: REALTIME_STATUS },
      idempotency: { header: 'Idempotency-Key', conflict_error: 'idempotency_key_reused' },
    });
    expect(REALTIME_STATUS).toBe('available');
    expect(SDK_PUBLISHED).toBe(false);
    expect((document['sdks'] as { package: string; published: boolean }[]).map((sdk) => [sdk.package, sdk.published])).toEqual([
      ['atmark-sdk', false],
      ['atmark-sdk', false],
    ]);
    const required = (document['idempotency'] as { required_on: string[]; optional_on: string[] });
    expect(required.required_on).toContain('POST /v1/drafts/{draftId}/send');
    expect(required.optional_on).toEqual(['POST /v1/attachments']);
    expect(DISCOVERY_URL).toBe('https://api.atmark.ai/.well-known/atmark.json');
  });

  it('카피 규칙 — 타사 제품 이름 · 과장 표현이 없다', () => {
    const text = JSON.stringify([discoveryDocument(), openApiDocument()]);
    for (const banned of ['Claude', 'Codex', 'Cursor', 'OpenAI', '100%', 'immutable']) expect(text, banned).not.toContain(banned);
  });
});
