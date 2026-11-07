/**
 * AtmarkAiWatch — AI 의심 메일 감시(ADR-0017 초안 · `docs/internal/plans/ai-mail-watch.md` §1 · §7.2)의 **선로**: CMK 하나 · 큐 셋 · IAM 사용자 하나.
 * 런북: `docs/runbooks/ai-watch.md`.
 *
 * **CD 가 배포하지 않는다**(AtmarkCiCd 와 같은 이유 — Mac 이 쓰는 IAM 사용자의 권한을 CD 역할이 고치지 못하게). 리드가 손으로
 * `cdk deploy AtmarkAiWatch --exclusively`. 다른 스택과 **참조 0**(export 0) — AtmarkCompute 는 이 스택의 이름(계약 상수)으로만 맞춘다.
 *
 * ## 만드는 것
 *
 *   - CMK `alias/atmark-ai-watch` — 요청 큐 SSE-KMS. **키 정책이 데이터 권한의 전부다:** 계정 루트 문장은 관리 동작만(Decrypt · GenerateDataKey ·
 *     CreateGrant 없음 — 그래서 IAM 정책으로는 아무에게도 복호화를 줄 수 없다). 데이터 동작은 이름 붙은 주체 **둘**:
 *       - Mac IAM 사용자 `atmark-ai-watch` — `kms:Decrypt`
 *       - inbound λ 역할 `atmark-runtime-inbound` — `kms:GenerateDataKey` · `kms:Decrypt`(SSE-KMS 생산자 요건 — `AI_WATCH_IAM_ACTIONS.inboundKms`)
 *     두 문장 모두 조건 `kms:ViaService = sqs.ap-northeast-2.amazonaws.com` + `kms:EncryptionContext:aws:sqs:arn = 요청 큐 ARN`(`infra/cdk/ai-watch-iam.ts` `AI_WATCH_KMS_CONDITIONS`)
 *     — 그 키 · 그 큐 · SQS 경유로만. inbound 역할 IAM 쪽에는 KMS 문장을 두지 않는다(키 정책이 주체를 이름으로 준다 — 와일드카드 키 ARN 을 피한다).
 *   - 요청 큐 `atmark-ai-watch-req` — 보존 300초 · 가시성 15초 · **DLQ 없음**(본문의 두 번째 보관 장소를 만들지 않는다, 설계 §1.1) · SSE-KMS · TLS 강제.
 *   - 결과 큐 `atmark-ai-watch-result` + DLQ — 본문 없음 → SSE-SQS · 보존 1일(DLQ 14일) · maxReceive 3 · 가시성 = 결과 λ 타임아웃 × 6.
 *   - IAM 사용자 `atmark-ai-watch` — 콘솔 로그인 없음 · **액세스 키를 만들지 않는다**(진윤겸이 CLI 로 → `ops/ai-watch/store-key.sh`).
 *     허용: 요청 큐 Receive/Delete/ChangeVisibility/GetQueueAttributes · 결과 큐 SendMessage · CMK Decrypt(같은 두 조건). CloudWatch · STS · 그 밖 0.
 *     그리고 **명시 Deny(NotAction)** — 나중에 누가 이 사용자에게 넓은 정책을 붙여도 위 동작 밖은 막힌다. SES 발송 Deny 는 그 안에 든다.
 *
 * inbound 역할 주체를 키 정책에 이름(ARN 문자열)으로 넣으므로 **그 역할이 먼저 있어야 한다**(KMS 는 없는 주체를 거부한다) — 운영에는 이미 있다.
 * 결과 λ(`atmark-ai-watch-result`)와 inbound 의 SendMessage·환경은 AtmarkCompute 에 있다(`compute-stack.ts` "AI 의심 메일 감시").
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import {
  AI_WATCH_IAM_USER,
  AI_WATCH_KMS_ALIAS,
  AI_WATCH_QUEUES,
  AI_WATCH_REQUEST_RETENTION_SECONDS,
  AI_WATCH_REQUEST_VISIBILITY_SECONDS,
  AI_WATCH_RESULT_MAX_RECEIVE,
  AI_WATCH_RESULT_RETENTION_SECONDS,
} from '../../../src/inbound/ai-watch/contract';
import { AI_WATCH_IAM_ACTIONS, AI_WATCH_KMS_CONDITIONS } from '../ai-watch-iam';

/** inbound λ 역할 이름 — `compute-stack.ts` `makeRole('inbound')` 의 `atmark-runtime-${key}` 와 같아야 한다(테스트가 대조). */
export const AI_WATCH_INBOUND_ROLE_NAME = 'atmark-runtime-inbound';

/** 결과 λ 타임아웃(초) — Compute 의 `HANDLER_SPECS['ai-watch-result']` 와 같다(테스트가 대조). 결과 큐 가시성 = 이 값 × 6. */
export const AI_WATCH_RESULT_TIMEOUT_SECONDS = 30;
export const AI_WATCH_RESULT_VISIBILITY_SECONDS = AI_WATCH_RESULT_TIMEOUT_SECONDS * 6;
export const AI_WATCH_RESULT_DLQ_RETENTION_DAYS = 14;

/** 키 정책 Sid — 테스트·런북이 이름으로 찾는다. */
export const AI_WATCH_KEY_SIDS = {
  admin: 'KeyAdministrationOnly',
  worker: 'MacWorkerDecryptViaSqsRequestQueue',
  inbound: 'InboundProduceViaSqsRequestQueue',
} as const;

/** 계정 루트(= IAM 관리자)에 주는 관리 동작 — **데이터 동작 · CreateGrant 없음.** PutKeyPolicy 가 있어야 CloudFormation 이 키를 계속 관리한다. */
export const AI_WATCH_KEY_ADMIN_ACTIONS: readonly string[] = [
  'kms:CancelKeyDeletion',
  'kms:CreateAlias',
  'kms:DeleteAlias',
  'kms:DescribeKey',
  'kms:DisableKey',
  'kms:DisableKeyRotation',
  'kms:EnableKey',
  'kms:EnableKeyRotation',
  'kms:GetKeyPolicy',
  'kms:GetKeyRotationStatus',
  'kms:ListAliases',
  'kms:ListGrants',
  'kms:ListKeyPolicies',
  'kms:ListResourceTags',
  'kms:PutKeyPolicy',
  'kms:RevokeGrant',
  'kms:ScheduleKeyDeletion',
  'kms:TagResource',
  'kms:UntagResource',
  'kms:UpdateAlias',
  'kms:UpdateKeyDescription',
];

export function aiWatchQueueArn(account: string, region: string, name: string): string {
  return `arn:aws:sqs:${region}:${account}:${name}`;
}

export function aiWatchQueueUrl(account: string, region: string, name: string): string {
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

export interface AiWatchStackProps extends cdk.StackProps {
  readonly env: { readonly account: string; readonly region: string };
}

export class AiWatchStack extends cdk.Stack {
  public readonly key: kms.Key;
  public readonly requestQueue: sqs.Queue;
  public readonly resultQueue: sqs.Queue;
  public readonly resultDlq: sqs.Queue;
  public readonly workerUser: iam.User;

  public constructor(scope: Construct, id: string, props: AiWatchStackProps) {
    super(scope, id, props);
    const { account, region } = props.env;
    const requestQueueArn = aiWatchQueueArn(account, region, AI_WATCH_QUEUES.request);
    const viaSqsRequestQueue = {
      StringEquals: {
        [AI_WATCH_KMS_CONDITIONS.viaServiceKey]: AI_WATCH_KMS_CONDITIONS.viaService,
        [AI_WATCH_KMS_CONDITIONS.queueArnContextKey]: requestQueueArn,
      },
    };

    this.workerUser = new iam.User(this, 'WorkerUser', { userName: AI_WATCH_IAM_USER });

    const keyPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: AI_WATCH_KEY_SIDS.admin,
          principals: [new iam.AccountRootPrincipal()],
          actions: [...AI_WATCH_KEY_ADMIN_ACTIONS],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: AI_WATCH_KEY_SIDS.worker,
          principals: [new iam.ArnPrincipal(this.workerUser.userArn)],
          actions: [...AI_WATCH_IAM_ACTIONS.workerKms],
          resources: ['*'],
          conditions: viaSqsRequestQueue,
        }),
        new iam.PolicyStatement({
          sid: AI_WATCH_KEY_SIDS.inbound,
          principals: [new iam.ArnPrincipal(`arn:aws:iam::${account}:role/${AI_WATCH_INBOUND_ROLE_NAME}`)],
          actions: [...AI_WATCH_IAM_ACTIONS.inboundKms],
          resources: ['*'],
          conditions: viaSqsRequestQueue,
        }),
      ],
    });

    this.key = new kms.Key(this, 'RequestQueueKey', {
      alias: AI_WATCH_KMS_ALIAS,
      description: 'AI mail watch request queue SSE-KMS (ADR-0017 draft). Decrypt: Mac worker IAM user + inbound role, via SQS on atmark-ai-watch-req only.',
      enableKeyRotation: true,
      policy: keyPolicy,
      // 요청 큐의 본문은 길어야 300초 산다 — 스택을 지울 때 키도 지운다(대기 7일).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    this.requestQueue = new sqs.Queue(this, 'RequestQueue', {
      queueName: AI_WATCH_QUEUES.request,
      retentionPeriod: cdk.Duration.seconds(AI_WATCH_REQUEST_RETENTION_SECONDS),
      visibilityTimeout: cdk.Duration.seconds(AI_WATCH_REQUEST_VISIBILITY_SECONDS),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      // 데이터 키 재사용 5분(기본) — 메일마다 KMS 를 부르지 않는다.
      dataKeyReuse: cdk.Duration.minutes(5),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.resultDlq = new sqs.Queue(this, 'ResultDlq', {
      queueName: AI_WATCH_QUEUES.resultDlq,
      retentionPeriod: cdk.Duration.days(AI_WATCH_RESULT_DLQ_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.resultQueue = new sqs.Queue(this, 'ResultQueue', {
      queueName: AI_WATCH_QUEUES.result,
      retentionPeriod: cdk.Duration.seconds(AI_WATCH_RESULT_RETENTION_SECONDS),
      visibilityTimeout: cdk.Duration.seconds(AI_WATCH_RESULT_VISIBILITY_SECONDS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.resultDlq, maxReceiveCount: AI_WATCH_RESULT_MAX_RECEIVE },
    });

    // ── Mac IAM 사용자 — 허용 셋 + NotAction Deny ────────────────────────────────────────────────────────────────────────
    const allowed: string[] = [...AI_WATCH_IAM_ACTIONS.workerRequestQueue, ...AI_WATCH_IAM_ACTIONS.workerResultQueue, ...AI_WATCH_IAM_ACTIONS.workerKms];
    const policy = new iam.Policy(this, 'WorkerPolicy', {
      policyName: 'atmark-ai-watch-worker',
      statements: [
        new iam.PolicyStatement({
          sid: 'RequestQueueConsume',
          actions: [...AI_WATCH_IAM_ACTIONS.workerRequestQueue],
          resources: [this.requestQueue.queueArn],
        }),
        new iam.PolicyStatement({
          sid: 'ResultQueueSend',
          actions: [...AI_WATCH_IAM_ACTIONS.workerResultQueue],
          resources: [this.resultQueue.queueArn],
        }),
        new iam.PolicyStatement({
          sid: 'RequestQueueKeyDecryptViaSqs',
          actions: [...AI_WATCH_IAM_ACTIONS.workerKms],
          resources: [this.key.keyArn],
          conditions: viaSqsRequestQueue,
        }),
        new iam.PolicyStatement({
          sid: 'DenyEverythingElse',
          effect: iam.Effect.DENY,
          notActions: allowed,
          resources: ['*'],
        }),
      ],
    });
    policy.attachToUser(this.workerUser);

    new cdk.CfnOutput(this, 'RequestQueueUrl', { value: this.requestQueue.queueUrl });
    new cdk.CfnOutput(this, 'ResultQueueUrl', { value: this.resultQueue.queueUrl });
    new cdk.CfnOutput(this, 'WorkerUserName', {
      value: this.workerUser.userName,
      description: 'Access key: created by the owner with the CLI and piped into ops/ai-watch/store-key.sh (docs/runbooks/ai-watch.md section 3)',
    });
  }
}
