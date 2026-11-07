/**
 * 결제 웹훅 λ 조립(`src/runtime/billing-webhook-composition.ts`) — 환경 계약 · 비밀 캐시 · 자리표시 거부 · DB 모름.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SECRET_PLACEHOLDER_VALUE } from '../../../infra/cdk/stacks/data-stack';
import {
  BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS,
  BILLING_WEBHOOK_POOL_MAX,
  BILLING_WEBHOOK_SECRET_TTL_MS,
  BillingWebhookNotConfiguredError,
  composeBillingWebhook,
} from '../../../src/runtime/billing-webhook-composition';
import { RuntimeConfigError } from '../../../src/runtime/config';
import type { FifoQueueSender } from '../../../src/runtime/sqs';

const SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/billing/paddle/webhook-secret-AbCdEf';
const QUEUE_URL = 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/atmark-billing-events.fifo';
const GOOD = JSON.stringify({ current: 'test-webhook-secret-current-0123456789', previous: null });

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ATMARK_ENV: 'production',
    AWS_REGION: 'ap-northeast-2',
    ATMARK_PADDLE_ENV: 'sandbox',
    ATMARK_BILLING_QUEUE_URL: QUEUE_URL,
    ATMARK_PADDLE_WEBHOOK_SECRET_ARN: SECRET_ARN,
    ...overrides,
  };
}

const queue: FifoQueueSender = { sendFifo: async () => undefined };

function compose(values: string[], overrides: Record<string, string | undefined> = {}, clock?: { t: number }) {
  const reads: string[] = [];
  const deps = composeBillingWebhook({
    env: env(overrides),
    clients: {
      queue,
      secrets: {
        async readSecretString(id) {
          reads.push(id);
          const value = values[Math.min(reads.length - 1, values.length - 1)];
          if (value === undefined) throw new Error('no value');
          return value;
        },
      },
      now: () => new Date(clock?.t ?? 0),
    },
  });
  return { deps, reads };
}

describe('결제 웹훅 조립 — 환경', () => {
  it('환경·큐 URL 을 읽는다 · 결제 스위치는 요구하지 않는다(스위치를 꺼도 수신은 계속)', () => {
    const { deps } = compose([GOOD]);
    expect(deps.environment).toBe('sandbox');
    expect(deps.queueUrl).toBe(QUEUE_URL);
  });

  it.each([
    ['ATMARK_ENV 가 production 이 아님', { ATMARK_ENV: 'development' }],
    ['ATMARK_PADDLE_ENV 없음', { ATMARK_PADDLE_ENV: undefined }],
    ['ATMARK_PADDLE_ENV 별칭', { ATMARK_PADDLE_ENV: 'live' }],
    ['ATMARK_PADDLE_ENV 대문자', { ATMARK_PADDLE_ENV: 'Sandbox' }],
    ['큐 URL 없음', { ATMARK_BILLING_QUEUE_URL: undefined }],
    ['비밀 ARN 없음', { ATMARK_PADDLE_WEBHOOK_SECRET_ARN: undefined }],
    ['로컬 개발 변수가 있음', { DATABASE_URL: 'postgres://x' }],
  ])('%s → RuntimeConfigError', (_name, overrides) => {
    expect(() => compose([GOOD], overrides)).toThrow(RuntimeConfigError);
  });

  it('큐 URL 이 FIFO 가 아니면 거부한다(표준 큐로 새지 않게)', () => {
    expect(() => compose([GOOD], { ATMARK_BILLING_QUEUE_URL: QUEUE_URL.replace('.fifo', '') })).toThrow(BillingWebhookNotConfiguredError);
  });

  it('DB 풀 0 — 이 λ 는 DB 를 모른다', () => {
    expect(BILLING_WEBHOOK_POOL_MAX).toBe(0);
  });

  it('소스가 DB·조립 루트·SES·S3 를 import 하지 않는다(번들 단언은 bundle.test.ts)', () => {
    for (const file of ['src/runtime/billing-webhook-composition.ts', 'src/runtime/handlers/billing-webhook.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from '\.\.?\/(\.\.\/)*(db\/|composition'|admin-composition|storage\/|mail\/)/);
      expect(source, file).not.toMatch(/from 'pg'/);
    }
  });
});

describe('결제 웹훅 조립 — 비밀', () => {
  it('비밀을 호출 때 읽고 5분 캐시한다 · 지나면 다시 읽는다', async () => {
    const clock = { t: 1_000_000 };
    const { deps, reads } = compose([GOOD], {}, clock);
    await deps.loadSecrets();
    clock.t += BILLING_WEBHOOK_SECRET_TTL_MS - 1;
    await deps.loadSecrets();
    expect(reads).toEqual([SECRET_ARN]);
    clock.t += 1;
    await deps.loadSecrets();
    expect(reads).toEqual([SECRET_ARN, SECRET_ARN]);
  });

  it('자리표시 판정은 30초 캐시한다(보안 L-1) — 인증 없는 요청마다 GetSecretValue 를 부르지 않는다 · 지나면 다시 읽고 채운 값이 산다', async () => {
    const clock = { t: 1_000_000 };
    const { deps, reads } = compose([SECRET_PLACEHOLDER_VALUE, GOOD], {}, clock);
    await expect(deps.loadSecrets()).rejects.toBeInstanceOf(BillingWebhookNotConfiguredError);
    for (let i = 0; i < 20; i += 1) await expect(deps.loadSecrets()).rejects.toBeInstanceOf(BillingWebhookNotConfiguredError);
    clock.t += BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS - 1;
    await expect(deps.loadSecrets()).rejects.toBeInstanceOf(BillingWebhookNotConfiguredError);
    expect(reads).toHaveLength(1);
    clock.t += 1;
    await expect(deps.loadSecrets()).resolves.toEqual({ current: 'test-webhook-secret-current-0123456789', previous: null });
    expect(reads).toHaveLength(2);
  });

  it('부정 캐시 수명은 30~60초이고 양성 캐시(5분)보다 짧다', () => {
    expect(BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS).toBeLessThan(BILLING_WEBHOOK_SECRET_TTL_MS);
  });

  it('형식 오류도 같은 부정 캐시를 탄다 · 읽기 실패(네트워크·권한)는 캐시하지 않는다', async () => {
    const wrong = JSON.stringify({ secret: 'x' });
    const bad = compose([wrong, GOOD]);
    await expect(bad.deps.loadSecrets()).rejects.toBeInstanceOf(BillingWebhookNotConfiguredError);
    await expect(bad.deps.loadSecrets()).rejects.toBeInstanceOf(BillingWebhookNotConfiguredError);
    expect(bad.reads).toHaveLength(1);

    let calls = 0;
    const flaky = composeBillingWebhook({
      env: env(),
      clients: {
        queue,
        secrets: {
          async readSecretString() {
            calls += 1;
            if (calls === 1) throw new Error('ThrottlingException');
            return GOOD;
          },
        },
        now: () => new Date(0),
      },
    });
    await expect(flaky.loadSecrets()).rejects.toThrow('ThrottlingException');
    await expect(flaky.loadSecrets()).resolves.toEqual({ current: 'test-webhook-secret-current-0123456789', previous: null });
    expect(calls).toBe(2);
  });

  it('형식이 틀린 비밀은 거부한다 · 오류에 값을 싣지 않는다', async () => {
    const wrong = JSON.stringify({ secret: 'value-that-must-not-leak-0000' });
    const { deps } = compose([wrong]);
    const error = await deps.loadSecrets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingWebhookNotConfiguredError);
    expect(String((error as Error).message)).not.toContain('value-that-must-not-leak');
  });
});
