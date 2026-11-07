/**
 * `src/runtime/router.ts` — API Gateway payload v2 번역과 배정.
 *
 * 각 단언이 겨냥하는 방어:
 *   - 모르는 경로 404 · 메서드 405(+allow) · 스테이지 접두사 · 경로 파라미터 추출(퍼센트 디코딩)
 *   - 본문 상한 413(10 MiB) · 깨진 JSON 400 · 중복 쿼리 400
 *   - ★ 라우트가 던지면 500 `internal_error` — **응답에 예외 메시지·스택이 없다**
 *   - ★ 조립 실패 503 — 원인(비밀·설정)이 응답에 없다
 *   - 매직링크 페이지는 모듈의 CSP 헤더 그대로 · HEAD 는 빈 본문 · GET 은 포트를 건드리지 않는다
 *   - 멱등 키 검사가 라우터 뒤 라우트 안에서 그대로 일어난다(라우터가 그 순서를 앞지르지 않는다)
 */

import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentId } from '../../../src/db/schema';
import { issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { createApiHandler } from '../../../src/runtime/handlers/api';
import type { LambdaContext } from '../../../src/runtime/lambda';
import {
  MAX_REQUEST_BODY_BYTES,
  routeHttpApiEvent,
  type ApiDependencies,
  type HttpApiEvent,
} from '../../../src/runtime/router';
import { recordingExposures } from '../../support/injection-doubles';

afterEach(() => {
  resetLogSink();
});

/** 건드리면 던지는 의존성 — 이 테스트가 부르지 않는 라우트의 조각. */
function untouchable(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error(`${label}.${String(property)} 를 건드렸다`);
      },
    },
  ) as never;
}

const NO_TOKENS: AgentTokenStore = { findByHash: () => Promise.resolve(null) };
const NOW = (): Date => new Date('2026-09-23T00:00:00.000Z');
const LINK_KEYS = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST_KEYS');

function deps(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  const base: ApiDependencies = {
    send: untouchable('send'),
    reply: { tokens: NO_TOKENS, service: untouchable('reply.service'), transport: untouchable('transport'), replyTargets: untouchable('replyTargets'), artifacts: untouchable('artifacts') },
    forward: untouchable('forward'),
    transitionAnnouncement: untouchable('transitionAnnouncement'),
    audit: untouchable('audit'),
    approvalLink: {
      ports: {
        keyring: LINK_KEYS,
        findApprovalSummary: () => Promise.reject(new Error('GET 은 포트를 건드리면 안 된다')),
        runInTransaction: () => Promise.reject(new Error('GET 은 포트를 건드리면 안 된다')),
      },
      now: NOW,
    },
    approvals: untouchable('approvals'),
    agentPolicy: untouchable('agentPolicy'),
    webhookEndpoints: untouchable('webhookEndpoints'),
    inboundRead: untouchable('inboundRead'),
    attachments: { tokens: NO_TOKENS, inbound: untouchable('inbound'), artifacts: untouchable('artifacts'), signer: untouchable('signer'), contents: untouchable('contents'), pdfSlots: untouchable('pdfSlots'), now: NOW, exposures: recordingExposures(), riskHoldMode: 'enforce', messageState: untouchable('messageState') },
    agentEnroll: untouchable('agentEnroll'),
    policyRequests: untouchable('policyRequests'),
    identity: untouchable('identity'),
    scheduledMessages: untouchable('scheduledMessages'),
    scheduledQueries: untouchable('scheduledQueries'),
    verificationCode: untouchable('verificationCode'),
    webhookDeliveries: untouchable('webhookDeliveries'),
    outboundAttachments: untouchable('outboundAttachments'),
    drafts: untouchable('drafts'),
    draftSend: untouchable('draftSend'),
    labels: untouchable('labels'),
    health: { check: () => Promise.resolve({ ok: true, checks: { database: true, tls: true, appRole: true, appRoleNotOwner: true } }) },
  };
  return { ...base, ...overrides };
}

function event(method: string, rawPath: string, options: Partial<HttpApiEvent> = {}): HttpApiEvent {
  return {
    rawPath,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    ...options,
    requestContext: { requestId: 'req-123', stage: '$default', http: { method }, ...options.requestContext },
  };
}

function bodyOf(result: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

describe('배정', () => {
  it('모르는 경로는 404 route_not_found (JSON · no-store · nosniff)', async () => {
    const result = await routeHttpApiEvent(deps(), event('GET', '/v1/unknown'));
    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)['error']).toBe('route_not_found');
    expect(result.headers['content-type']).toMatch(/^application\/json/);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  });

  it('초안 발송(POST /v1/drafts/{id}/send)은 묶음 B(2026-10-08)부터 실제 발송 경로다 — Idempotency-Key 없이는 의존성에 닿기 전에 400', async () => {
    const result = await routeHttpApiEvent(deps(), event('POST', '/v1/drafts/11111111-1111-4111-8111-111111111111/send'));
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)['error']).toBe('idempotency_key_required');
  });

  it('발견 문서 · OpenAPI 는 무인증 · CORS * · 공개 캐시(묶음 B)', async () => {
    for (const path of ['/.well-known/atmark.json', '/v1/openapi.json']) {
      const result = await routeHttpApiEvent(deps(), event('GET', path));
      expect(result.statusCode, path).toBe(200);
      expect(result.headers['access-control-allow-origin'], path).toBe('*');
      expect(result.headers['cache-control'], path).toBe('public, max-age=300');
    }
  });

  it('경로는 있는데 메서드가 없으면 405 + allow', async () => {
    const result = await routeHttpApiEvent(deps(), event('DELETE', '/v1/messages'));
    expect(result.statusCode).toBe(405);
    expect(result.headers['allow']).toBe('POST');
  });

  it('이름 붙은 스테이지 접두사를 벗긴다', async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('GET', '/prod/healthz', { requestContext: { requestId: 'r', stage: 'prod', http: { method: 'GET' } } }),
    );
    expect(result.statusCode).toBe(200);
  });

  it('경로 파라미터를 라우트의 params 로 넘긴다 — 퍼센트 디코딩 후', async () => {
    // 첨부 라우트는 인증 전에 id·index 형식을 본다. 둘 다 라우터가 넘긴 값이다.
    const badId = await routeHttpApiEvent(deps(), event('GET', '/v1/messages/inbound/NOT-A-UUID/attachments/0'));
    expect(badId.statusCode).toBe(400);
    expect(String(bodyOf(badId)['detail'])).toContain('uuid');

    const id = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
    const badIndex = await routeHttpApiEvent(deps(), event('GET', `/v1/messages/inbound/${id}/attachments/a%20b`));
    expect(badIndex.statusCode).toBe(400);
    expect(String(bodyOf(badIndex)['detail'])).toContain('index');

    const unauthenticated = await routeHttpApiEvent(deps(), event('GET', `/v1/messages/inbound/${id}/attachments/0`));
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('발송 경로의 순서(멱등 키 먼저)는 라우트 안의 것이다 — 키 없는 회신은 400 idempotency_key_required', async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('POST', '/v1/threads/3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8/reply', { body: '{}' }),
    );
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)['error']).toBe('idempotency_key_required');
  });

  it('전환 공지 — 경로의 agent id 와 본문의 agent_id 가 다르면 400 path_body_mismatch', async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('POST', '/v1/agents/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/transition-announcement', {
        body: JSON.stringify({ agent_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)['error']).toBe('path_body_mismatch');
  });

  describe('전환 공지 — agent_id 생략 · 경로 별칭 me (2026-10-11)', () => {
    const SELF = 'a'.repeat(32) as AgentId;
    const OTHER = 'b'.repeat(32);
    const issued = issueAgentToken(SELF);
    function announcement(): { readonly deps: ApiDependencies; readonly seen: string[] } {
      const seen: string[] = [];
      const tokens: AgentTokenStore = {
        findByHash: (hash) =>
          Promise.resolve(hash === issued.tokenHash ? { tokenHash: issued.tokenHash, agentId: SELF, capabilities: issued.capabilities, revokedAt: null, expiresAt: null } : null),
      };
      const transitionAnnouncement = {
        tokens,
        service: { now: NOW } as never,
        seeds: {
          listSeedContacts: (agentId: AgentId) => {
            seen.push(agentId);
            return Promise.resolve([]);
          },
        },
      } as unknown as ApiDependencies['transitionAnnouncement'];
      return { deps: deps({ transitionAnnouncement }), seen };
    }
    const post = (path: string, body: Record<string, unknown>): HttpApiEvent =>
      event('POST', path, {
        headers: { authorization: `Bearer ${issued.plaintext}`, 'idempotency-key': 'k1' },
        body: JSON.stringify({ from: 'scout@atmark.ai', owner_name: '진윤겸', ...body }),
      });

    it('경로에 남의 id · 본문 생략 → 경로의 id 가 대상이라 403(토큰의 에이전트로 조용히 바뀌지 않는다)', async () => {
      const a = announcement();
      const result = await routeHttpApiEvent(a.deps, post(`/v1/agents/${OTHER}/transition-announcement`, {}));
      expect(result.statusCode).toBe(403);
      expect(a.seen).toEqual([]);
    });

    it('경로에 자기 id · 본문 생략 → 자기 에이전트 · me · 본문 생략 → 토큰의 에이전트', async () => {
      for (const path of [`/v1/agents/${SELF}/transition-announcement`, '/v1/agents/me/transition-announcement']) {
        const a = announcement();
        const result = await routeHttpApiEvent(a.deps, post(path, {}));
        expect(result.statusCode, path).toBe(409); // 시드 연락처 0 — 대상이 정해진 뒤의 결과
        expect(a.seen, path).toEqual([SELF]);
      }
    });

    it('me + 본문에 남의 id → 라우트가 그 값으로 인가해 403 · me + 본문에 자기 id → 통과', async () => {
      const foreign = announcement();
      expect((await routeHttpApiEvent(foreign.deps, post('/v1/agents/me/transition-announcement', { agent_id: OTHER }))).statusCode).toBe(403);
      expect(foreign.seen).toEqual([]);
      const own = announcement();
      expect((await routeHttpApiEvent(own.deps, post('/v1/agents/me/transition-announcement', { agent_id: SELF }))).statusCode).toBe(409);
      expect(own.seen).toEqual([SELF]);
    });
  });
});

describe('입력 경계', () => {
  it(`본문이 ${String(MAX_REQUEST_BODY_BYTES)}바이트를 넘으면 413 — 라우트에 닿지 않는다`, async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('POST', '/v1/messages', { body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) }),
    );
    expect(result.statusCode).toBe(413);
    expect(MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);
  });

  it('base64 본문은 디코드한 크기로 잰다', async () => {
    const body = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 0x20).toString('base64');
    const result = await routeHttpApiEvent(deps(), event('POST', '/v1/messages', { body, isBase64Encoded: true }));
    expect(result.statusCode).toBe(413);
  });

  it('JSON 이 아닌 본문은 400 invalid_json', async () => {
    const result = await routeHttpApiEvent(deps(), event('POST', '/v1/messages', { body: '{not json' }));
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)['error']).toBe('invalid_json');
  });

  it('같은 쿼리 키가 두 번이면 400 — 어느 값을 믿을지 파서마다 다르다', async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('GET', '/v1/messages/inbound', { rawQueryString: 'agent_id=a&agent_id=b' }),
    );
    expect(result.statusCode).toBe(400);
  });
});

describe('★ 오류 응답에 내부가 새지 않는다', () => {
  it('라우트가 던지면 500 internal_error — 메시지·스택·파일 경로가 응답에 없고 로그에만 있다', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const secret = 'relation "audit_logs" password=hunter2';
    const exploding = deps({
      health: { check: () => Promise.reject(new Error(secret)) },
    });
    const result = await routeHttpApiEvent(exploding, event('GET', '/healthz'));
    expect(result.statusCode).toBe(500);
    const body = bodyOf(result);
    expect(body['error']).toBe('internal_error');
    expect(result.body).not.toContain('hunter2');
    expect(result.body).not.toContain('audit_logs');
    expect(result.body).not.toMatch(/\bat \S+:\d+/); // 스택 프레임
    expect(result.body).not.toContain('.ts');
    expect(result.body).toContain('req-123'); // 운영자가 로그와 잇는 고리
    expect(lines.some((line) => line.includes('runtime.api_unhandled'))).toBe(true);
  });

  it('조립이 실패하면 503 service_unavailable — 비밀·설정 오류의 문장이 응답에 없다', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const handler = createApiHandler(() =>
      Promise.reject(new Error('ATMARK_DB_SECRET_ARN 이 비어 있다 host=db.internal password=hunter2')),
    );
    const context: LambdaContext = {
      awsRequestId: 'a',
      invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:api',
      callbackWaitsForEmptyEventLoop: true,
    };
    const result = await handler(event('GET', '/healthz'), context);
    expect(result.statusCode).toBe(503);
    expect(bodyOf(result)['error']).toBe('service_unavailable');
    expect(result.body).not.toContain('hunter2');
    expect(result.body).not.toContain('ATMARK_DB_SECRET_ARN');
    expect(context.callbackWaitsForEmptyEventLoop).toBe(false);
    expect(lines.some((line) => line.includes('runtime.compose_failed'))).toBe(true);
  });
});

describe('매직링크 페이지 (/approve)', () => {
  it('GET — 200 HTML, 모듈의 CSP 그대로, 포트를 건드리지 않는다', async () => {
    const result = await routeHttpApiEvent(deps(), event('GET', '/approve'));
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(result.headers['content-type']).toMatch(/text\/html/);
    expect(result.body).toContain('<script>');
  });

  it('HEAD — 같은 헤더, 빈 본문', async () => {
    const result = await routeHttpApiEvent(deps(), event('HEAD', '/approve'));
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-security-policy']).toBeDefined();
    expect(result.body).toBe('');
  });

  it('POST — 원문 본문(form)을 넘긴다: 서명이 틀린 토큰의 미리보기는 거부된다', async () => {
    const result = await routeHttpApiEvent(
      deps(),
      event('POST', '/approve', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'intent=preview&token=atk_link_garbage',
      }),
    );
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(result.statusCode).toBeLessThan(500);
  });
});

describe('/healthz', () => {
  it('프로브가 ok 면 200, 아니면 503 — 불리언만 싣는다', async () => {
    const ok = await routeHttpApiEvent(deps(), event('GET', '/healthz'));
    expect(ok.statusCode).toBe(200);
    expect(bodyOf(ok)).toEqual({ status: 'ok', checks: { database: true, tls: true, appRole: true, appRoleNotOwner: true } });

    const failing = await routeHttpApiEvent(
      deps({ health: { check: () => Promise.resolve({ ok: false, checks: { database: true, tls: false, appRole: true, appRoleNotOwner: true } }) } }),
      event('GET', '/healthz'),
    );
    expect(failing.statusCode).toBe(503);
    expect(bodyOf(failing)['status']).toBe('fail');
  });
});
