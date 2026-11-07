/**
 * ops λ 조립 · 핸들러 — 자리표시 비밀이면 크래시 없이 503 `ops_unavailable`(M1 · §5 2~7단계) · 기억은 60초 · Host 421 은 조립 전.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { OPS_ENV, OPS_POOL_MAX as CONTRACT_POOL_MAX } from '../../../src/ops/contract';
import { createOpsHandler } from '../../../src/runtime/handlers/ops';
import { composeOps, createOpsComposer, OPS_POOL_MAX, UNAVAILABLE_RETRY_MS, type ComposedOps } from '../../../src/runtime/ops-composition';
import { event, fakePool, KEYRING, TOUCH_OK } from './hosted-support';

const PLACEHOLDER = JSON.stringify({ _unset: true });
const DB_SECRET = JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_ops', password: 'p@ss/word' });
const MAILER = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer';

let ca: string;
beforeEach(() => {
  setLogSink(() => undefined);
  ca = join(mkdtempSync(join(tmpdir(), 'ops-ca-')), 'ca.pem');
  writeFileSync(ca, 'x');
});
afterEach(() => resetLogSink());

function env(): NodeJS.ProcessEnv {
  return {
    ATMARK_ENV: 'production',
    NODE_ENV: 'production',
    AWS_REGION: 'ap-northeast-2',
    NODE_EXTRA_CA_CERTS: ca,
    [OPS_ENV.dbSecretArn]: 'arn:db',
    [OPS_ENV.opsKeysSecretArn]: 'arn:keys',
    [OPS_ENV.loginMailerFunctionArn]: MAILER,
  };
}

function secrets(values: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      readSecretString: async (id: string) => {
        reads.push(id);
        const value = values[id];
        if (value === undefined) throw new Error('no secret');
        return value;
      },
    },
  };
}

const context = () => ({ awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-ops', callbackWaitsForEmptyEventLoop: true });

describe('조립', () => {
  it('OPS_POOL_MAX 는 계약 값(1)', () => {
    expect(OPS_POOL_MAX).toBe(CONTRACT_POOL_MAX);
    expect(OPS_POOL_MAX).toBe(1);
  });

  it('ops-keys 자리표시 · 형식 오류 · DB 비밀 자리표시 → unavailable(던지지 않는다)', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ 'arn:keys': PLACEHOLDER, 'arn:db': DB_SECRET }, 'keys_placeholder'],
      [{ 'arn:keys': 'short:abc', 'arn:db': DB_SECRET }, 'keys_invalid'],
      [{ 'arn:keys': KEYRING, 'arn:db': PLACEHOLDER }, 'db_placeholder'],
    ];
    for (const [values, reason] of cases) {
      const s = secrets(values);
      const composed = await composeOps({ env: env(), clients: { secrets: s.reader, pool: () => fakePool([]).pool } });
      expect(composed).toEqual({ kind: 'unavailable', reason });
    }
  });

  it('준비됨 — DB 비밀과 ops-keys 둘만 읽는다 · 풀 max = OPS_POOL_MAX', async () => {
    const s = secrets({ 'arn:keys': KEYRING, 'arn:db': DB_SECRET });
    let url = '';
    const composed = await composeOps({
      env: env(),
      clients: {
        secrets: s.reader,
        pool: (u) => {
          url = u;
          return fakePool([]).pool;
        },
      },
    });
    expect(composed.kind).toBe('ready');
    expect(s.reads.sort()).toEqual(['arn:db', 'arn:keys']);
    expect(url).toBe('postgres://atmark_ops:p%40ss%2Fword@db.internal:5432/atmark');
  });

  it('설정 오류는 던진다 — login-mailer 가 아닌 ARN · 운영 아님', async () => {
    const s = secrets({ 'arn:keys': KEYRING, 'arn:db': DB_SECRET });
    await expect(composeOps({ env: { ...env(), [OPS_ENV.loginMailerFunctionArn]: MAILER.replace('login-mailer', 'api') }, clients: { secrets: s.reader } })).rejects.toThrow();
    await expect(composeOps({ env: { ...env(), ATMARK_ENV: 'development' }, clients: { secrets: s.reader } })).rejects.toThrow();
  });

  it('unavailable 은 60초만 기억한다 · ready 는 계속 · 던진 것은 기억하지 않는다', async () => {
    let now = 0;
    let calls = 0;
    const results: ComposedOps[] = [{ kind: 'unavailable', reason: 'db_placeholder' }, { kind: 'ready', deps: {} as never, pool: {} as Pool }];
    const compose = createOpsComposer(async () => results[Math.min(calls++, 1)] as ComposedOps, () => now);
    expect((await compose()).kind).toBe('unavailable');
    now = UNAVAILABLE_RETRY_MS - 1;
    expect((await compose()).kind).toBe('unavailable');
    expect(calls).toBe(1);
    now = UNAVAILABLE_RETRY_MS;
    expect((await compose()).kind).toBe('ready');
    now = 10 * UNAVAILABLE_RETRY_MS;
    expect((await compose()).kind).toBe('ready');
    expect(calls).toBe(2);

    let attempts = 0;
    const flaky = createOpsComposer(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('secrets down');
      return { kind: 'unavailable', reason: 'keys_placeholder' } as ComposedOps;
    });
    await expect(flaky()).rejects.toThrow();
    expect((await flaky()).kind).toBe('unavailable');
  });
});

describe('핸들러', () => {
  it('unavailable → 모든 요청 503 ops_unavailable(페이지 포함) · execute-api Host 는 조립 전에 421', async () => {
    let composed = 0;
    const handler = createOpsHandler(async () => {
      composed += 1;
      return { kind: 'unavailable', reason: 'db_placeholder' };
    });
    const api = await handler(event({ path: '/api/dashboard' }), context());
    expect([api.statusCode, JSON.parse(api.body).error]).toEqual([503, 'ops_unavailable']);
    const page = await handler(event({ path: '/', site: 'none' }), context());
    expect(page.statusCode).toBe(503);
    const auth = await handler(event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null }), context());
    expect(auth.statusCode).toBe(503);
    expect(composed).toBe(3);
    const misdirected = await handler(event({ path: '/api/dashboard', host: 'x1.execute-api.ap-northeast-2.amazonaws.com' }), context());
    expect(misdirected.statusCode).toBe(421);
    expect(composed).toBe(3);
  });

  it('조립이 던지면 503 과 요청 id 만', async () => {
    const handler = createOpsHandler(async () => {
      throw new Error('secret arn:aws:secretsmanager:… missing');
    });
    const result = await handler(event({ path: '/api/dashboard' }), context());
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: 'ops_unavailable', detail: '요청 req-1' });
  });

  it('준비됨 → 라우터로', async () => {
    const fake = fakePool([TOUCH_OK]);
    const { deps } = await import('./hosted-support');
    const handler = createOpsHandler(async () => ({ kind: 'ready', deps: deps(fake), pool: fake.pool }));
    const result = await handler(event({ path: '/api/review' }), context());
    expect(result.statusCode).toBe(200);
    expect(fake.sql[0]).toContain('ops_session_touch');
  });
});
