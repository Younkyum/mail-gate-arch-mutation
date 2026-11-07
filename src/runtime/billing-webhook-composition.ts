/**
 * src/runtime/billing-webhook-composition.ts — **결제 웹훅 λ(`atmark-billing-webhook`)의 조립 루트**(WP-2, 계획 §3-1 · 원칙 1).
 *
 * 이 함수는 **인터넷에 열려 있고 DB 를 모른다**: DB 클라이언트·풀·DB 비밀·조립 루트 `composition.ts` 를 import 하지 않는다
 * (번들 metafile 에 `pg`·`src/db` 0 — `test/unit/runtime/bundle.test.ts`, 변이 BL-1). VPC 밖이고 역할에는 자기 로그 그룹 쓰기 ·
 * 웹훅 비밀 하나 읽기 · 결제 큐 `SendMessage` 만 있다(`infra/cdk/stacks/compute-stack.ts`).
 *
 * 읽는 환경: `ATMARK_ENV`(운영 가드) · `AWS_REGION` · `ATMARK_PADDLE_ENV`(`readPaddleEnvironment`) · `ATMARK_BILLING_QUEUE_URL` ·
 * `ATMARK_PADDLE_WEBHOOK_SECRET_ARN`. **결제 스위치(`ATMARK_BILLING_ENABLED`)를 읽지 않는다** — 스위치를 꺼도 수신은 계속하고
 * 메시지는 큐에 14일 남는다(되돌리기 절차, 런북 deploy §21). 환경이 틀리면 조립이 던지고 핸들러가 503 을 준다(Paddle 이 재시도한다).
 *
 * **비밀은 호출 때 읽고 5분 캐시한다**(콜드 스타트 1회가 아니다): 진윤겸이 비밀을 채우거나 교체한 뒤 실행 환경이 재활용될 때까지
 * 기다리지 않게. 자리표시·형식 오류는 `BillingWebhookNotConfiguredError` 로 던지고(→ 503) **그 판정을 30초 캐시한다**(보안 L-1 —
 * 인증 없는 요청마다 `GetSecretValue` 를 부르면 두드림이 Secrets Manager 호출·비용·스로틀로 번진다). 30초는 비밀을 채운 뒤 Paddle 재시도가
 * 살아나기까지의 추가 지연 상한이다. 읽기 실패(네트워크·권한)는 캐시하지 않는다 — 일시 장애일 수 있다. 값은 오류·로그에 없다.
 */

import { parsePaddleWebhookSecrets, type PaddleWebhookSecrets } from '../billing/paddle/signature';
import type { PaddleEnvironment } from '../billing/constants';
import { isPlaceholderSecret, readPaddleEnvironment, requireEnv, requireProductionRuntime, RUNTIME_ENV } from './config';
import { createSecretReader, type SecretReader } from './secrets';
import { createSqsFifoSender, type FifoQueueSender } from './sqs';

/**
 * 웹훅 λ 의 DB 연결 풀 — **0**(DB 가 없다). 연결 예산 표(`compute-stack.ts` 머리말 · `transparency-stack.test.ts` `pools`)가 이 값을 곱한다.
 * 0 이 아니게 되는 변경은 이 함수의 전제(원칙 1)를 깨는 것이다.
 */
export const BILLING_WEBHOOK_POOL_MAX = 0;

/** 비밀 캐시 수명(ms). */
export const BILLING_WEBHOOK_SECRET_TTL_MS = 5 * 60_000;

/** "설정 전"(자리표시·형식 오류) 판정의 캐시 수명(ms) — 보안 L-1. 30~60초 사이로 둔다(머리말). */
export const BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS = 30_000;

/** 비밀이 자리표시거나 형식이 틀리다 — 설정 전 상태. 핸들러는 503 을 준다(Paddle 이 재시도 — 그 사이 비밀을 채우면 산다). */
export class BillingWebhookNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingWebhookNotConfiguredError';
  }
}

export interface BillingWebhookDependencies {
  readonly environment: PaddleEnvironment;
  readonly queueUrl: string;
  readonly queue: FifoQueueSender;
  /** 검증용 비밀(캐시). 자리표시·형식 오류면 `BillingWebhookNotConfiguredError`, 읽기 실패면 그 오류를 던진다. */
  loadSecrets(): Promise<PaddleWebhookSecrets>;
  now(): Date;
}

export interface BillingWebhookPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** 테스트 주입. 운영은 실제 Secrets Manager · SQS. */
  readonly clients?: { readonly secrets?: SecretReader; readonly queue?: FifoQueueSender; readonly now?: () => Date };
}

/** 조립 — 환경만 읽는다(네트워크 없음). 틀리면 `RuntimeConfigError`. */
export function composeBillingWebhook(platform: BillingWebhookPlatform): BillingWebhookDependencies {
  const { env } = platform;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  const environment = readPaddleEnvironment(env);
  const queueUrl = requireEnv(env, RUNTIME_ENV.billingQueueUrl);
  if (!/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]+\.fifo$/.test(queueUrl)) {
    throw new BillingWebhookNotConfiguredError(`${RUNTIME_ENV.billingQueueUrl} 가 FIFO 큐 URL 모양이 아니다.`);
  }
  const secretArn = requireEnv(env, RUNTIME_ENV.paddleWebhookSecretArn);
  const reader = platform.clients?.secrets ?? createSecretReader(region);
  const queue = platform.clients?.queue ?? createSqsFifoSender(region);
  const now = platform.clients?.now ?? (() => new Date());

  let cached: { readonly secrets: PaddleWebhookSecrets; readonly at: number } | undefined;
  let notConfigured: { readonly message: string; readonly at: number } | undefined;
  const refuse = (message: string, at: number): never => {
    notConfigured = { message, at };
    throw new BillingWebhookNotConfiguredError(message);
  };
  return {
    environment,
    queueUrl,
    queue,
    now,
    async loadSecrets() {
      const at = now().getTime();
      if (cached !== undefined && at - cached.at < BILLING_WEBHOOK_SECRET_TTL_MS) return cached.secrets;
      if (notConfigured !== undefined && at - notConfigured.at < BILLING_WEBHOOK_NOT_CONFIGURED_TTL_MS) {
        throw new BillingWebhookNotConfiguredError(notConfigured.message);
      }
      const raw = await reader.readSecretString(secretArn);
      if (isPlaceholderSecret(raw)) {
        return refuse(`${RUNTIME_ENV.paddleWebhookSecretArn} 가 아직 채워지지 않았다(placeholder). 런북 billing.md 대로 넣어라.`, at);
      }
      const secrets = parsePaddleWebhookSecrets(raw);
      if (secrets === null) {
        return refuse(`${RUNTIME_ENV.paddleWebhookSecretArn} 의 형식이 {"current","previous"} 가 아니다.`, at);
      }
      notConfigured = undefined;
      cached = { secrets, at };
      return secrets;
    },
  };
}
