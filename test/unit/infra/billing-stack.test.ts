/**
 * `AtmarkBilling` — 결제 FIFO 큐 + DLQ · 비밀 자리 다섯(WP-2, 계획 Step 2). 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * 런타임 앱 synth(`runtime-app.ts` 캐시)에서 읽는다 — Compute 가 이 스택의 큐·비밀을 참조하는 배선까지 같은 synth 다.
 */

import { describe, expect, it } from 'vitest';

import {
  BILLING_DLQ_MAX_RECEIVE_COUNT,
  BILLING_DLQ_NAME,
  BILLING_QUEUE_NAME,
  BILLING_QUEUE_RETENTION_DAYS,
  BILLING_QUEUE_VISIBILITY_SECONDS,
  BILLING_SYNC_TIMEOUT_SECONDS,
  DB_BILLING_OPERATOR_SECRET_NAME,
  DB_BILLING_SECRET_NAME,
  PADDLE_ADMIN_API_KEY_SECRET_NAME,
  PADDLE_SYNC_API_KEY_SECRET_NAME,
  PADDLE_WEBHOOK_SECRET_NAME,
} from '../../../infra/cdk/stacks/billing-stack';
import { SECRET_PLACEHOLDER_VALUE } from '../../../infra/cdk/stacks/data-stack';
import { runtimeStackTemplate } from './runtime-app';

interface QueueResource {
  readonly Properties: {
    readonly QueueName: string;
    readonly FifoQueue?: boolean;
    readonly ContentBasedDeduplication?: boolean;
    readonly VisibilityTimeout?: number;
    readonly MessageRetentionPeriod?: number;
    readonly SqsManagedSseEnabled?: boolean;
    readonly KmsMasterKeyId?: unknown;
    readonly RedrivePolicy?: { readonly deadLetterTargetArn: unknown; readonly maxReceiveCount: number };
  };
}

const queuesByName = (): Map<string, QueueResource['Properties']> => {
  const queues = runtimeStackTemplate('billing').findResources('AWS::SQS::Queue') as Record<string, QueueResource>;
  return new Map(Object.values(queues).map((q) => [q.Properties.QueueName, q.Properties]));
};

describe('AtmarkBilling — 결제 이벤트 FIFO 큐', () => {
  it('큐 둘(본 큐 · DLQ) — 둘 다 FIFO · 내용 기반 중복 제거 끔(event_id 로만 가른다) · 보존 14일 · SQS 관리형 SSE', () => {
    const queues = queuesByName();
    expect([...queues.keys()].sort()).toEqual([BILLING_DLQ_NAME, BILLING_QUEUE_NAME].sort());
    for (const [name, queue] of queues) {
      expect(queue.FifoQueue, name).toBe(true);
      expect(queue.ContentBasedDeduplication ?? false, name).toBe(false);
      expect(queue.MessageRetentionPeriod, name).toBe(BILLING_QUEUE_RETENTION_DAYS * 86_400);
      expect(queue.SqsManagedSseEnabled, name).toBe(true);
      expect(queue.KmsMasterKeyId, name).toBeUndefined();
    }
    expect(BILLING_QUEUE_RETENTION_DAYS).toBe(14);
  });

  it('본 큐: 가시성 360s = 6 × sync 타임아웃 · 10회 받고 DLQ(코드 L-7) — 그룹이 막히는 상한 = 10 × 360s = 1시간', () => {
    const queue = queuesByName().get(BILLING_QUEUE_NAME);
    expect(queue?.VisibilityTimeout).toBe(BILLING_QUEUE_VISIBILITY_SECONDS);
    expect(BILLING_QUEUE_VISIBILITY_SECONDS).toBe(360);
    expect(BILLING_QUEUE_VISIBILITY_SECONDS).toBeGreaterThanOrEqual(6 * BILLING_SYNC_TIMEOUT_SECONDS);
    expect(queue?.RedrivePolicy?.maxReceiveCount).toBe(BILLING_DLQ_MAX_RECEIVE_COUNT);
    // 스로틀된 수신(예약 1 < SQS 동시성 2)도 수신 횟수를 올린다 — 8 이상이어야 짧은 장애가 멀쩡한 메시지를 DLQ 로 보내지 않는다.
    expect(BILLING_DLQ_MAX_RECEIVE_COUNT).toBe(10);
    expect(BILLING_DLQ_MAX_RECEIVE_COUNT).toBeGreaterThanOrEqual(8);
    // 처리 못 한 메시지(failed·deferred)가 DLQ 로 가기까지 = 수신 횟수 × 가시성 — 런북 deploy §21 · billing.md 의 "약 1시간".
    expect(BILLING_DLQ_MAX_RECEIVE_COUNT * BILLING_QUEUE_VISIBILITY_SECONDS).toBe(3_600);
    expect(JSON.stringify(queue?.RedrivePolicy?.deadLetterTargetArn)).toMatch(/BillingEventsDlq/);
  });

  it('두 큐 모두 RETAIN(코드 L-10) — 스택 삭제·교체가 결제 이벤트(DLQ 포함) 삭제가 되지 않는다', () => {
    const queues = runtimeStackTemplate('billing').findResources('AWS::SQS::Queue') as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
    expect(Object.keys(queues)).toHaveLength(2);
    for (const [id, queue] of Object.entries(queues)) {
      expect(queue.DeletionPolicy, id).toBe('Retain');
      expect(queue.UpdateReplacePolicy, id).toBe('Retain');
    }
  });

  it('두 큐 모두 평문 전송을 거부한다(enforceSSL — aws:SecureTransport=false Deny)', () => {
    const policies = runtimeStackTemplate('billing').findResources('AWS::SQS::QueuePolicy') as Record<
      string,
      { Properties: { Queues: unknown[]; PolicyDocument: { Statement: { Effect: string; Condition?: unknown }[] } } }
    >;
    expect(Object.keys(policies)).toHaveLength(2);
    for (const policy of Object.values(policies)) {
      expect(policy.Properties.PolicyDocument.Statement).toContainEqual(
        expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      );
    }
  });
});

describe('AtmarkBilling — 비밀 자리 다섯', () => {
  it('이름 다섯 · 값은 자리표시(data-stack 과 같은 문자열 — 넣은 값을 덮지 않는다) · RETAIN', () => {
    const secrets = runtimeStackTemplate('billing').findResources('AWS::SecretsManager::Secret') as Record<
      string,
      { DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: { Name: string; SecretString?: string; GenerateSecretString?: unknown } }
    >;
    const byName = new Map(Object.values(secrets).map((secret) => [secret.Properties.Name, secret]));
    expect([...byName.keys()].sort()).toEqual(
      [PADDLE_WEBHOOK_SECRET_NAME, PADDLE_SYNC_API_KEY_SECRET_NAME, PADDLE_ADMIN_API_KEY_SECRET_NAME, DB_BILLING_SECRET_NAME, DB_BILLING_OPERATOR_SECRET_NAME].sort(),
    );
    for (const [name, secret] of byName) {
      expect(secret.Properties.SecretString, name).toBe(SECRET_PLACEHOLDER_VALUE);
      expect(secret.Properties.GenerateSecretString, name).toBeUndefined();
      expect(secret.DeletionPolicy, name).toBe('Retain');
      expect(secret.UpdateReplacePolicy, name).toBe('Retain');
    }
  });

  it('비밀 이름 규칙 — Paddle 셋은 atmark/billing/paddle/*, DB 둘은 atmark/db/*', () => {
    expect(PADDLE_WEBHOOK_SECRET_NAME).toBe('atmark/billing/paddle/webhook-secret');
    expect(PADDLE_SYNC_API_KEY_SECRET_NAME).toBe('atmark/billing/paddle/sync-api-key');
    expect(PADDLE_ADMIN_API_KEY_SECRET_NAME).toBe('atmark/billing/paddle/admin-api-key');
    expect(DB_BILLING_SECRET_NAME).toBe('atmark/db/billing');
    expect(DB_BILLING_OPERATOR_SECRET_NAME).toBe('atmark/db/billing-operator');
  });

  it('이 스택에는 함수·역할이 없다(IAM 은 AtmarkCompute 한 곳에서 본다)', () => {
    const template = runtimeStackTemplate('billing');
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::IAM::Role', 0);
  });
});
