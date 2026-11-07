/**
 * 자가 등록 내부 이벤트(api λ → admin λ, ADR-0016 2026-10-08 — 리드 조건 1~5). AWS · DB 호출 0.
 *
 *   ① `parseEnrollEvent` — 정확한 키 집합 · 상수(source · action · v) · 값 모양만. 하나라도 어긋나면 `null`.
 *   ② ★ admin 핸들러의 이 입구로는 **자가 등록 하나만** 닿는다 — 다른 action · 키 하나 더 · 다른 판은 던지고 조립(관리 연산)을 부르지 않는다. 핸들러 소스가
 *      `admin/ops/` 에서 가져오는 것은 `enroll` 하나다(다른 관리 연산이 이 입구에 묶이지 않는다).
 *   ③ 조립이 실패해도 던지지 않고 `{ok:false, error:'unavailable'}` — 토큰 원문은 로그에 없다.
 *   ④ `createAgentEnroller` — RequestResponse · 대상 ARN · 스로틀 = busy · 시간 초과 = timeout · 함수 오류 = unavailable. 재시도 없음(한 번).
 *   ⑤ 라우트 — busy → 503 enroll_busy · timeout → 503 enroll_timeout · 권한 없음 403 · admin 결과 해석(모양이 틀리면 503).
 */

import { readFileSync } from 'node:fs';

import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it } from 'vitest';

import { handleEnrollAgent } from '../../../src/api/routes/agents-enroll';
import { issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { ENROLL_EVENT_ACTION, ENROLL_EVENT_SOURCE, ENROLL_EVENT_VERSION, parseEnrollEvent, parseEnrollResult, type EnrollEvent } from '../../../src/runtime/enroll-event';
import { adminEventKind, createAdminHandler, isEnrollAliasInvocation } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { createAgentEnroller, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';

afterEach(() => resetLogSink());

const AGENT = 'b'.repeat(32);
const TOKEN = `atk_agent_${'Q'.repeat(43)}`;
const EVENT: EnrollEvent = { source: ENROLL_EVENT_SOURCE, action: ENROLL_EVENT_ACTION, v: ENROLL_EVENT_VERSION, token: TOKEN, name: 'child', localPart: null, requestId: 'req-1' };
const ADMIN_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';

const ENROLL_ALIAS_ARN = `${ADMIN_ARN}:enroll`;

function context(arn = ENROLL_ALIAS_ARN): LambdaContext {
  return { callbackWaitsForEmptyEventLoop: true, invokedFunctionArn: arn, awsRequestId: 'r', getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;
}

describe('① parseEnrollEvent — 정확한 모양만', () => {
  it('맞는 모양', () => {
    expect(parseEnrollEvent({ ...EVENT })).toEqual(EVENT);
    expect(parseEnrollEvent({ ...EVENT, localPart: 'kid' })?.localPart).toBe('kid');
  });

  it.each([
    ['다른 action', { ...EVENT, action: 'agent.delete' }],
    ['다른 source', { ...EVENT, source: 'atmark.internal' }],
    ['다른 판', { ...EVENT, v: 2 }],
    ['키 하나 더', { ...EVENT, organizationId: 'x' }],
    ['키 하나 빠짐', { source: EVENT.source, action: EVENT.action, v: EVENT.v, token: TOKEN, name: 'x', requestId: 'r' }],
    ['토큰 모양', { ...EVENT, token: 'atk_org_xxx' }],
    ['빈 이름', { ...EVENT, name: '' }],
    ['로컬파트 숫자', { ...EVENT, localPart: 7 }],
    ['요청 id 모양', { ...EVENT, requestId: 'a b' }],
    ['배열', [EVENT]],
    ['null', null],
    ['HTTP 이벤트에 같은 본문', { version: '2.0', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(EVENT) }],
  ])('%s → null', (_label, value) => {
    expect(parseEnrollEvent(value)).toBeNull();
  });

  it('결과 해석 — 모양이 틀리면 unavailable · 모르는 거절 코드도 unavailable', () => {
    expect(parseEnrollResult({ ok: false, error: 'enroll_daily_cap' })).toEqual({ ok: false, error: 'enroll_daily_cap' });
    expect(parseEnrollResult({ ok: false, error: 'drop_tables' })).toEqual({ ok: false, error: 'unavailable' });
    expect(parseEnrollResult({ ok: true, agent: { id: 'x' } })).toEqual({ ok: false, error: 'unavailable' });
    expect(parseEnrollResult('nope')).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('② ★ admin 입구 — 자가 등록 하나뿐', () => {
  it('판별 — 자가 등록 · 과제 · HTTP 셋, 그 밖은 던진다', () => {
    expect(adminEventKind({ ...EVENT })).toBe('agent-enroll');
    expect(() => adminEventKind({ ...EVENT, action: 'agent.policy.change' })).toThrow();
    expect(() => adminEventKind({ ...EVENT, extra: true })).toThrow();
    expect(() => adminEventKind({ source: ENROLL_EVENT_SOURCE })).toThrow();
  });

  it('모양이 틀린 이벤트는 조립(관리 연산)을 부르지 않고 던진다', async () => {
    let composed = 0;
    const handler = createAdminHandler(() => {
      composed += 1;
      return Promise.reject(new Error('조립 금지'));
    });
    for (const bad of [{ ...EVENT, action: 'agent.suspend' }, { ...EVENT, v: 0 }, { ...EVENT, sessionId: 's' }]) {
      await expect(handler(bad, context())).rejects.toThrow();
    }
    expect(composed).toBe(0);
  });

  it('★ 별칭 경계 — 자가 등록은 enroll 별칭으로만 · 별칭으로는 자가 등록만(HTTP · 과제 이벤트 거부) · 어느 쪽이든 조립 0', async () => {
    let composed = 0;
    const handler = createAdminHandler(
      () => {
        composed += 1;
        return Promise.reject(new Error('조립 금지'));
      },
      () => Promise.reject(new Error('과제 금지')),
      () => 'consoleapi1',
    );
    const http = { version: '2.0', rawPath: '/api/me', requestContext: { requestId: 'r', apiId: 'consoleapi1', http: { method: 'GET', sourceIp: '203.0.113.9' } }, headers: {} };
    await expect(handler({ ...EVENT }, context(ADMIN_ARN))).rejects.toThrow();
    await expect(handler({ ...EVENT }, context(`${ADMIN_ARN}:live`))).rejects.toThrow();
    await expect(handler(http, context())).rejects.toThrow();
    await expect(handler({ task: 'domain-recheck' }, context())).rejects.toThrow();
    expect(composed).toBe(0);
    expect(isEnrollAliasInvocation({ invokedFunctionArn: ENROLL_ALIAS_ARN })).toBe(true);
    expect(isEnrollAliasInvocation({ invokedFunctionArn: ADMIN_ARN })).toBe(false);
  });

  it('핸들러가 admin/ops 에서 가져오는 것은 enroll 하나다', () => {
    const source = readFileSync(new URL('../../../src/runtime/handlers/admin.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '\.\.\/\.\.\/admin\/ops\/([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['enroll']);
  });
});

describe('③ 조립 실패 — 던지지 않는다 · 토큰 원문은 로그에 없다', () => {
  it('unavailable', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const handler = createAdminHandler(() => Promise.reject(new Error('secret unavailable')));
    expect(await handler({ ...EVENT }, context())).toEqual({ ok: false, error: 'unavailable' });
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).toContain('agent.enroll_failed');
  });
});

function fakeClient(behaviour: (command: InvokeCommand) => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>): {
  readonly client: LambdaInvokeClient;
  readonly calls: InvokeCommand[];
} {
  const calls: InvokeCommand[] = [];
  return {
    calls,
    client: {
      send: (command: InvokeCommand) => {
        calls.push(command);
        return behaviour(command);
      },
    },
  };
}

describe('④ createAgentEnroller', () => {
  it('RequestResponse · 대상 ARN · 이벤트 그대로 · 몸통 해석', async () => {
    const fake = fakeClient(() => Promise.resolve({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ ok: false, error: 'agent_limit' })) }));
    const enroll = createAgentEnroller({ client: fake.client, functionArn: ADMIN_ARN });
    expect(await enroll(EVENT)).toEqual({ ok: true, body: { ok: false, error: 'agent_limit' } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input.FunctionName).toBe(ADMIN_ARN);
    expect(fake.calls[0]?.input.InvocationType).toBe('RequestResponse');
    expect(JSON.parse(new TextDecoder().decode(fake.calls[0]?.input.Payload as Uint8Array))).toEqual(EVENT);
  });

  it('스로틀 = busy · 시간 초과 = timeout · 함수 오류 = unavailable · 재시도 없음', async () => {
    const throttled = fakeClient(() => Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException' })));
    expect(await createAgentEnroller({ client: throttled.client, functionArn: ADMIN_ARN })(EVENT)).toEqual({ ok: false, reason: 'busy' });
    expect(throttled.calls).toHaveLength(1);
    const slow = fakeClient(() => new Promise(() => undefined));
    expect(await createAgentEnroller({ client: slow.client, functionArn: ADMIN_ARN, timeoutMs: 20 })(EVENT)).toEqual({ ok: false, reason: 'timeout' });
    const broken = fakeClient(() => Promise.resolve({ StatusCode: 200, FunctionError: 'Unhandled' }));
    expect(await createAgentEnroller({ client: broken.client, functionArn: ADMIN_ARN })(EVENT)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('⑤ 라우트 — 거절 매핑', () => {
  const issued = issueAgentToken(AGENT as never, ['agents:enroll', 'agent:read_self']);
  const plain = issueAgentToken(AGENT as never, ['messages:read']);
  const tokens: AgentTokenStore = {
    findByHash: (hash) =>
      Promise.resolve(
        hash === issued.tokenHash
          ? { tokenHash: hash, agentId: AGENT as never, capabilities: issued.capabilities, revokedAt: null, expiresAt: null }
          : hash === plain.tokenHash
            ? { tokenHash: hash, agentId: AGENT as never, capabilities: plain.capabilities, revokedAt: null, expiresAt: null }
            : null,
      ),
  };
  const request = (token: string, body: unknown = { name: 'kid' }) => ({ headers: { authorization: `Bearer ${token}` }, query: {}, body });
  const deps = (enroll: Parameters<typeof handleEnrollAgent>[0]['enroll']) => ({ tokens, enroll, now: () => new Date(), requestId: () => 'req-x', precheck: null });

  it('권한 없음 403 · 본문 400 · 바쁨 503 · 시간 초과 503 · 상한 429 · 토큰 원문을 admin 에 넘긴다', async () => {
    let seen: EnrollEvent | null = null;
    const ok = deps((event) => {
      seen = event;
      return Promise.resolve({ ok: true, body: { ok: false, error: 'enroll_daily_cap' } });
    });
    expect((await handleEnrollAgent(ok, request(plain.plaintext))).status).toBe(403);
    expect(seen).toBeNull();
    expect((await handleEnrollAgent(ok, request(issued.plaintext, { name: 'x', local_part: 5 }))).status).toBe(400);
    expect((await handleEnrollAgent(ok, request(issued.plaintext, { name: 'y'.repeat(81) }))).status).toBe(400);
    const capped = await handleEnrollAgent(ok, request(issued.plaintext, { name: 'kid', local_part: 'Kid' }));
    expect([capped.status, capped.body['error']]).toEqual([429, 'enroll_daily_cap']);
    expect(seen).toMatchObject({ token: issued.plaintext, name: 'kid', localPart: 'kid', requestId: 'req-x' });
    const busy = await handleEnrollAgent(deps(() => Promise.resolve({ ok: false, reason: 'busy' })), request(issued.plaintext));
    expect([busy.status, busy.body['error']]).toEqual([503, 'enroll_busy']);
    const late = await handleEnrollAgent(deps(() => Promise.resolve({ ok: false, reason: 'timeout' })), request(issued.plaintext));
    expect([late.status, late.body['error']]).toEqual([503, 'enroll_timeout']);
    const garbled = await handleEnrollAgent(deps(() => Promise.resolve({ ok: true, body: { ok: true } })), request(issued.plaintext));
    expect([garbled.status, garbled.body['error']]).toEqual([503, 'enroll_unavailable']);
  });
});
