/**
 * admin λ 의 과제 이벤트(ADR-0014 단계 4 · 계획 §3.4) — **엄격 판별**과 틱 풀 수명.
 *   - `{"task":"domain-recheck"}` 정확히(키 하나 · 값 상수)만 과제 · `requestContext.http` 가 있으면 HTTP · **둘 다 아니면 던진다**.
 *   - 과제는 HTTP 조립을 부르지 않는다 · 틱 풀은 이벤트마다 열고 **성공·실패 모두 `end()`** 한다 · 조립: 틱 롤 비밀이 자리표시면 기동 거부 ·
 *     domain-control ARN 이 없으면 비활성 포트(부르면 던진다 — 틱은 아무것도 바꾸지 않는다).
 */

import { describe, expect, it, vi } from 'vitest';

import { DomainControlUnavailableError } from '../../../src/domains/contract';
import { composeDomainTick, domainControlInvokerOf, DOMAIN_TICK_POOL_MAX } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { adminEventKind, createAdminHandler, isDomainRecheckEvent, runDomainRecheckTask } from '../../../src/runtime/handlers/admin';
import type { LambdaContext } from '../../../src/runtime/lambda';

const context = (): LambdaContext => ({ awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin', callbackWaitsForEmptyEventLoop: true });

/** 행 0 인 DB 를 흉내 내는 풀 — 모든 SELECT 가 빈 결과 · count 는 0. */
function emptyPool() {
  const ended = { value: false };
  const query = vi.fn(async (sql: string) => ({ rows: /count\(\*\)/.test(sql) ? [{ n: 0 }] : [], rowCount: 0 }));
  const pool = {
    query,
    connect: vi.fn(async () => ({ query, release: () => undefined })),
    end: vi.fn(async () => {
      ended.value = true;
    }),
    on: vi.fn(),
  };
  return { pool, ended, query };
}

describe('판별', () => {
  it('과제는 정확히 {task:"domain-recheck"} — 키가 더 있거나 값이 다르면 아니다', () => {
    expect(isDomainRecheckEvent({ task: 'domain-recheck' })).toBe(true);
    for (const event of [{ task: 'domain-recheck', extra: 1 }, { task: 'other' }, { Task: 'domain-recheck' }, [], null, 'domain-recheck', {}]) {
      expect(isDomainRecheckEvent(event), JSON.stringify(event)).toBe(false);
    }
  });

  it('HTTP(requestContext.http) · 과제 — 그 밖은 던진다(모르는 이벤트를 어느 쪽으로도 읽지 않는다)', () => {
    expect(adminEventKind({ task: 'domain-recheck' })).toBe('domain-recheck');
    expect(adminEventKind({ requestContext: { http: { method: 'GET' }, requestId: 'x' } })).toBe('http');
    for (const event of [{ task: 'domain-recheck', requestContext: {} }, { requestContext: {} }, { source: 'aws.events' }, undefined]) {
      expect(() => adminEventKind(event), JSON.stringify(event)).toThrow(/모르는 이벤트/);
    }
  });

  it('핸들러 — 과제는 HTTP 조립을 부르지 않는다 · 모르는 이벤트는 둘 다 부르지 않고 던진다', async () => {
    const compose = vi.fn();
    const { pool } = emptyPool();
    const composeTick = vi.fn(async () => ({ pool: pool as never, invoker: { invoke: vi.fn(async () => []) } }));
    const handler = createAdminHandler(compose, composeTick);
    const report = await handler({ task: 'domain-recheck' }, context());
    expect(report).toMatchObject({ outcome: 'ok', requests: 0, dueBacklog: 0 });
    expect(compose).not.toHaveBeenCalled();
    expect(composeTick).toHaveBeenCalledTimes(1);
    await expect(handler({ hello: 'world' }, context())).rejects.toThrow(/모르는 이벤트/);
    expect(compose).not.toHaveBeenCalled();
    expect(composeTick).toHaveBeenCalledTimes(1);
  });
});

describe('틱 풀 수명', () => {
  it('성공해도 실패해도 end() — 이벤트마다 연결 0 으로 돌아간다', async () => {
    const ok = emptyPool();
    await runDomainRecheckTask(async () => ({ pool: ok.pool as never, invoker: { invoke: vi.fn(async () => []) } }));
    expect(ok.ended.value).toBe(true);
    const failing = emptyPool();
    failing.query.mockRejectedValueOnce(new Error('db down'));
    await expect(runDomainRecheckTask(async () => ({ pool: failing.pool as never, invoker: { invoke: vi.fn(async () => []) } }))).rejects.toThrow('db down');
    expect(failing.ended.value).toBe(true);
  });
});

describe('조립', () => {
  const env = (patch: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.extraCaCerts]: __filename,
    [RUNTIME_ENV.dbDomainTickSecretArn]: 'arn:tick',
    ...patch,
  });

  it('틱 롤 비밀이 자리표시면 기동 거부 · 채워져 있으면 풀 크기 1', async () => {
    const placeholder = { readSecretString: vi.fn(async () => JSON.stringify({ _unset: 'placeholder' })) };
    await expect(composeDomainTick({ env: env(), clients: { secrets: placeholder } })).rejects.toThrow(/placeholder/);
    const filled = {
      readSecretString: vi.fn(async () => JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_domain_tick', password: 'p'.repeat(32) })),
    };
    const composed = await composeDomainTick({ env: env(), clients: { secrets: filled } });
    expect(DOMAIN_TICK_POOL_MAX).toBe(1);
    expect((composed.pool as unknown as { options: { max: number } }).options.max).toBe(1);
    await composed.pool.end();
    await expect(composed.invoker.invoke([{ op: 'check_expiry', rowId: 'x', domain: 'a.b.c', registrable: 'b.c' }])).rejects.toBeInstanceOf(DomainControlUnavailableError);
  });

  it('domain-control ARN — 없으면 비활성 포트 · 한정자 없는 atmark-domain-control 이 아니면 기동 거부', () => {
    const client = { send: vi.fn() };
    expect(() => domainControlInvokerOf({}, client as never)).not.toThrow();
    expect(() => domainControlInvokerOf({ [RUNTIME_ENV.domainControlFunctionArn]: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-api' }, client as never)).toThrow();
    expect(() =>
      domainControlInvokerOf({ [RUNTIME_ENV.domainControlFunctionArn]: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-domain-control' }, client as never),
    ).not.toThrow();
  });

  it('틱 예산(20초) + 마감 여유가 admin λ 타임아웃(25초) 안이다(#13 L6)', async () => {
    const { API_TIMEOUT_SECONDS } = await import('../../../infra/cdk/stacks/compute-stack');
    const { DOMAIN_TICK_BUDGET_MS, DOMAIN_CONTROL_INVOKE_TIMEOUT_MS } = await import('../../../src/domains/contract');
    expect(DOMAIN_TICK_BUDGET_MS + 4_000).toBeLessThanOrEqual(API_TIMEOUT_SECONDS * 1000);
    expect(DOMAIN_CONTROL_INVOKE_TIMEOUT_MS + 2_000).toBeLessThan(DOMAIN_TICK_BUDGET_MS);
  });
});
