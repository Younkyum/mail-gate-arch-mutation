/**
 * AtmarkBilling — 결제 공급자 연동(WP-2, Paddle)의 **큐와 비밀 자리**. 함수·HTTP API·IAM 은 `compute-stack.ts` 에 있다
 * (역할·예약 동시성·연결 예산을 한 스택에서 보려고). 계획 `.omc/plans/wp2-paddle-adapter.md` §3-1 · Step 2.
 *
 * **큐** — `atmark-billing-events.fifo`(+ DLQ `atmark-billing-events-dlq.fifo`):
 *   - FIFO: 웹훅 λ 가 `MessageDeduplicationId = event_id`(5분 창)·`MessageGroupId = sub:<id>|txn:<id>` 로 넣는다. **내용 기반 중복 제거는 끈다** —
 *     같은 이벤트의 재전송은 바디가 같아도 `ts` 헤더만 다르고, 다른 이벤트가 우연히 같은 바디일 일은 없지만 "id 로만 가른다" 가 규칙이다.
 *   - 가시성 360s ≥ 6 × sync 타임아웃(60s) — sync 예약 동시성(1)을 넘는 SQS 폴링(최대 동시성 미지정)은 스로틀되고, 스로틀된 배치는 가시성 창 안에서 다시 불린다
 *     (`ses-stack.ts` 와 같은 이유 · `compute-stack.test.ts` 가 고정).
 *   - 보존 14일 — 되돌리기 절차(스위치 끔 · sync 이벤트 소스 매핑 끔)가 메시지를 잃지 않는 기간(런북 deploy §21).
 *     **이벤트 소스 매핑이 켜져 있는 동안은 다르다** — 처리 못 한 메시지(`failed`·`deferred`)는 가시성(6분)마다 다시 받아 수신 10회,
 *     즉 **약 1시간 뒤 DLQ** 로 간다. DLQ 에서 되돌리려면 redrive 가 필요하다(런북 billing.md).
 *   - `enforceSSL` · SQS 관리형 SSE(KMS 키 정책·권한 불필요 — 웹훅 역할은 `sqs:SendMessage` 하나로 넣는다). 본문은 식별자뿐이다.
 *   - DLQ: 10회 받고도 실패한 메시지(FIFO 는 그룹이 막히므로 너무 오래 두지 않는다). 알람 `atmark-billing-dlq-depth`.
 *     5 가 아닌 10 인 이유(코드 L-7): 예약 동시성 1 을 넘는 SQS 폴링(최대 동시성 미지정)은 스로틀되고 **스로틀된 수신도 수신 횟수를 올린다** — 5 면 짧은 DB·NAT
 *     장애에 스로틀 재전달이 겹쳐 멀쩡한 메시지가 DLQ 로 간다. 10 × 가시성 360s = 1시간 — 그룹이 막히는 상한이다(테스트가 고정).
 *   - 둘 다 RETAIN — 스택 삭제·교체가 결제 이벤트(DLQ 포함) 삭제가 되면 안 된다(런북 billing.md "큐").
 *
 * **비밀 자리 다섯**(값은 **진윤겸이 직접 넣는다** — 채팅·리포·문서에 없다, 런북 `docs/runbooks/billing.md`):
 *   - `atmark/billing/paddle/webhook-secret` `{"current","previous"}` — billing-webhook 만 읽는다.
 *   - `atmark/billing/paddle/sync-api-key` — billing-sync 만(구독·거래·고객 읽기 권한의 키).
 *   - `atmark/billing/paddle/admin-api-key` — admin 만(거래 생성·취소 · 포털 세션).
 *   - `atmark/db/billing` · `atmark/db/billing-operator` — DB 롤 `atmark_billing`·`atmark_billing_operator`. migrate `bootstrap-roles` 가 쓴다.
 *     `data-stack.ts` 의 자리표시 패턴 그대로(같은 `SECRET_PLACEHOLDER_VALUE`)이되 이 스택에 둔다 — AtmarkData 는 바꾸지 않는다.
 * 전부 RETAIN — 스택 삭제가 키 삭제가 되면 안 된다. 자리표시 문자열이 바뀌지 않는 한 CloudFormation 은 넣은 값을 덮지 않는다.
 *
 * 배포 순서는 런북 deploy §21(AtmarkBilling → … → AtmarkCompute).
 */

import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import { SECRET_PLACEHOLDER_VALUE } from './data-stack';

export const BILLING_QUEUE_NAME = 'atmark-billing-events.fifo';
export const BILLING_DLQ_NAME = 'atmark-billing-events-dlq.fifo';

/** sync λ 타임아웃(초) — `compute-stack.ts` 의 `billing-sync` 명세가 이 값을 쓴다. */
export const BILLING_SYNC_TIMEOUT_SECONDS = 60;

/** 큐 가시성(초) = 6 × sync 타임아웃(예약 1 — 넘친 폴링은 스로틀, 머리말). */
export const BILLING_QUEUE_VISIBILITY_SECONDS = 6 * BILLING_SYNC_TIMEOUT_SECONDS;

export const BILLING_QUEUE_RETENTION_DAYS = 14;

/**
 * DLQ 로 가기 전 수신 횟수(코드 L-7 — 머리말). 스로틀 재전달이 수신을 올려도 버티게 넉넉히 두되, FIFO 그룹이 막히는 시간
 * (`BILLING_DLQ_MAX_RECEIVE_COUNT × BILLING_QUEUE_VISIBILITY_SECONDS` = 3 600s)은 1시간을 넘기지 않는다.
 */
export const BILLING_DLQ_MAX_RECEIVE_COUNT = 10;

export const PADDLE_WEBHOOK_SECRET_NAME = 'atmark/billing/paddle/webhook-secret';
export const PADDLE_SYNC_API_KEY_SECRET_NAME = 'atmark/billing/paddle/sync-api-key';
export const PADDLE_ADMIN_API_KEY_SECRET_NAME = 'atmark/billing/paddle/admin-api-key';
export const DB_BILLING_SECRET_NAME = 'atmark/db/billing';
export const DB_BILLING_OPERATOR_SECRET_NAME = 'atmark/db/billing-operator';

export class BillingStack extends cdk.Stack {
  public readonly queue: sqs.IQueue;
  public readonly deadLetterQueue: sqs.IQueue;
  public readonly paddleWebhookSecret: secretsmanager.ISecret;
  public readonly paddleSyncApiKeySecret: secretsmanager.ISecret;
  public readonly paddleAdminApiKeySecret: secretsmanager.ISecret;
  public readonly dbBillingSecret: secretsmanager.ISecret;
  public readonly dbBillingOperatorSecret: secretsmanager.ISecret;

  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const retention = cdk.Duration.days(BILLING_QUEUE_RETENTION_DAYS);
    const deadLetterQueue = new sqs.Queue(this, 'BillingEventsDlq', {
      queueName: BILLING_DLQ_NAME,
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: retention,
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const queue = new sqs.Queue(this, 'BillingEventsQueue', {
      queueName: BILLING_QUEUE_NAME,
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.seconds(BILLING_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: retention,
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: BILLING_DLQ_MAX_RECEIVE_COUNT },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // `exactOptionalPropertyTypes` 에서 `Queue`·`Secret` 클래스는 인터페이스에 대입되지 않는다(data-stack 과 같은 사정).
    this.queue = queue as sqs.IQueue;
    this.deadLetterQueue = deadLetterQueue as sqs.IQueue;

    const placeholder = (constructId: string, secretName: string, description: string): secretsmanager.ISecret =>
      new secretsmanager.Secret(this, constructId, {
        secretName,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText(SECRET_PLACEHOLDER_VALUE),
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }) as secretsmanager.ISecret;

    this.paddleWebhookSecret = placeholder(
      'PaddleWebhookSecret',
      PADDLE_WEBHOOK_SECRET_NAME,
      'Paddle notification destination secret key {"current","previous"}. Read only by the billing-webhook Lambda. Filled by the billing runbook.',
    );
    this.paddleSyncApiKeySecret = placeholder(
      'PaddleSyncApiKeySecret',
      PADDLE_SYNC_API_KEY_SECRET_NAME,
      'Paddle API key for billing-sync (read subscriptions, transactions, customers). Read only by the billing-sync Lambda. Filled by the billing runbook.',
    );
    this.paddleAdminApiKeySecret = placeholder(
      'PaddleAdminApiKeySecret',
      PADDLE_ADMIN_API_KEY_SECRET_NAME,
      'Paddle API key for the console (create/cancel transactions, portal sessions). Read only by the admin Lambda. Filled by the billing runbook.',
    );
    this.dbBillingSecret = placeholder(
      'DbBillingSecret',
      DB_BILLING_SECRET_NAME,
      'Postgres billing sync role (atmark_billing, owns nothing, column-level grants) credentials. Written by the migrate handler; read by the billing-sync Lambda only.',
    );
    this.dbBillingOperatorSecret = placeholder(
      'DbBillingOperatorSecret',
      DB_BILLING_OPERATOR_SECRET_NAME,
      'Postgres billing operator role (atmark_billing_operator) credentials. Written by the migrate handler; read by the operator CLI (admin:plan) only.',
    );

    // 2026-10-12 비밀 → SSM 이전 — AtmarkCompute 가 Paddle 비밀 셋을 더는 참조하지 않는다(읽기는 SSM `/atmark/billing/paddle/…`). 옛 비밀을 지우는
    //   다음 PR 까지 자동 교차 스택 export 를 **같은 이름으로 고정**한다(DB 롤 비밀 둘은 migrate 의 옛 자리 읽기가 계속 참조한다).
    for (const secret of [this.paddleWebhookSecret, this.paddleSyncApiKeySecret, this.paddleAdminApiKeySecret]) this.exportValue(secret.secretArn);

    new cdk.CfnOutput(this, 'BillingQueueUrl', { value: queue.queueUrl, description: `${BILLING_QUEUE_NAME} — billing-webhook 이 넣고 billing-sync 가 받는다` });
    new cdk.CfnOutput(this, 'BillingDlqName', { value: deadLetterQueue.queueName, description: '알람 atmark-billing-dlq-depth 가 보는 DLQ' });
    new cdk.CfnOutput(this, 'PaddleWebhookSecretArn', {
      value: this.paddleWebhookSecret.secretArn,
      description: `${PADDLE_WEBHOOK_SECRET_NAME} — 진윤겸이 put-secret-value 로 채운다(docs/runbooks/billing.md). 값은 문서에 적지 않는다`,
    });
    new cdk.CfnOutput(this, 'PaddleSyncApiKeySecretArn', { value: this.paddleSyncApiKeySecret.secretArn, description: PADDLE_SYNC_API_KEY_SECRET_NAME });
    new cdk.CfnOutput(this, 'PaddleAdminApiKeySecretArn', { value: this.paddleAdminApiKeySecret.secretArn, description: PADDLE_ADMIN_API_KEY_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbBillingSecretArn', { value: this.dbBillingSecret.secretArn, description: DB_BILLING_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbBillingOperatorSecretArn', { value: this.dbBillingOperatorSecret.secretArn, description: DB_BILLING_OPERATOR_SECRET_NAME });
  }
}
