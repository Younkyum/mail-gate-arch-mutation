/**
 * src/runtime/billing-composition.ts — **결제 동기화 Lambda(`atmark-billing-sync`)의 조립 루트**(WP-2, 계획 §3-1 · §3-5 · §5).
 *
 * 한 λ 가 두 입력을 받는다 — SQS FIFO(`atmark-billing-events.fifo`, 이벤트 소스 매핑)와 Scheduler 15분 틱(`{"action":"reconcile"}`).
 * 둘 다 같은 조립 결과를 쓴다:
 *   - **DB 롤 `atmark_billing`**(`ATMARK_DB_BILLING_SECRET_ARN` → `atmark/db/billing`) — 결제 표 넷 · `org_entitlements` provider 출처 쓰기 ·
 *     `billing_audit` INSERT 만(202609250400). 소유자·앱·admin 롤 비밀은 읽지도 요구하지도 않는다.
 *   - **Paddle sync 키**(`ATMARK_PADDLE_SYNC_API_KEY_SECRET_ARN` → `atmark/billing/paddle/sync-api-key`) — 구독·거래·고객 **읽기** 권한의 키.
 *     비밀 형식은 `{"apiKey":"…"}`. **자리표시면 기동을 거부하지 않는다** — `provider: null` 로 조립하고, reconcile 은 스위치가 꺼져 있거나
 *     키가 자리표시면 알람 없이 건너뛴다(설정 전 — 계획 §3-5 "설정 전 동작"). 스위치가 켜진 뒤의 자리표시는 `billing.provider_auth_failed` 알람이다.
 *     키는 **5분 캐시**(`PADDLE_KEY_TTL_MS` — 웹훅 비밀과 같은 방식)로 호출마다 다시 본다: 자리표시였던 비밀에 실제 키를 넣거나 키를 교체하면
 *     λ 를 다시 띄우지 않아도 5분 안에 반영된다(코드 검토 M-5). 다시 읽기가 실패하면 마지막으로 성공한 값을 30초 쓰고, 모양 오류는 30초 부정
 *     캐시한다(N-2/N-3 — `createPaddleProviderLoader`). admin 조립(admin 키)도 같은 로더를 쓴다.
 *   - 환경 변수는 일곱 개뿐이다(`ATMARK_ENV` · `ATMARK_PADDLE_ENV` · `ATMARK_BILLING_ENABLED` · 두 비밀 ARN · `PGSSLMODE` · `NODE_EXTRA_CA_CERTS`,
 *     + 런타임의 `AWS_REGION`) — 큐 URL 은 없다(이벤트 소스 매핑이 넣는다).
 *
 * api·워커 조립(`composition.ts`)을 import 하지 않는다 — 그 파일은 에이전트 전송단·S3·관문을 품는다. 공통 부품(운영 가드·비밀·TLS 풀)은
 * `login-mailer-composition.ts` 처럼 `config.ts`·`secrets.ts`·`db/client.ts` 의 같은 함수를 부른다.
 */

import type { Pool } from 'pg';

import { BILLING_SANDBOX_ORG_ALLOWLIST, type PaddleEnvironment } from '../billing/constants';
import { createPaddleProvider } from '../billing/paddle/adapter';
import { createPaddleHttp, PADDLE_API_KEY_SHAPE, type PaddleFetch } from '../billing/paddle/http';
import type { BillingProviderApi } from '../billing/provider';
import type { BillingSyncDependencies } from '../billing/sync';
import { createPool } from '../db/client';
import { log } from '../observability/logger';
import {
  databaseUrlOf,
  isPlaceholderSecret,
  parseDatabaseSecret,
  readBillingEnabled,
  readPaddleEnvironment,
  requireEnv,
  requireProductionRuntime,
  requireRdsCaBundle,
  RUNTIME_ENV,
  RuntimeConfigError,
} from './config';
import { createSecretReader, type SecretReader } from './secrets';

/**
 * 실행 환경당 풀 크기 — **1**. 메시지는 배치 1 · 순차로 처리하고, Paddle 호출은 트랜잭션 밖이라 두 커넥션을 동시에 쥐지 않는다.
 * 연결 예산: `RESERVED_CONCURRENCY['billing-sync']`(1) × 이 값 = 1(계획 §5 · `test/unit/infra/compute-stack.test.ts`·`transparency-stack.test.ts`).
 */
export const BILLING_SYNC_POOL_MAX = 1;

/**
 * Paddle API 키 비밀(`{"apiKey":"…"}`) → 키. **자리표시면 null**(설정 전). 모양이 틀리면 던진다 — 값은 싣지 않고 비밀 이름만.
 * admin 조립(`admin-composition.ts`, admin 키)도 같은 함수를 쓴다.
 */
export function parsePaddleApiKeySecret(raw: string, label: string): string | null {
  if (isPlaceholderSecret(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeConfigError(`${label} 는 {"apiKey":"…"} JSON 이어야 한다.`);
  }
  const key = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)['apiKey'] : undefined;
  if (typeof key !== 'string' || !PADDLE_API_KEY_SHAPE.test(key)) {
    throw new RuntimeConfigError(`${label} 의 apiKey 가 없거나 모양이 아니다.`);
  }
  return key;
}

/** Paddle API 키 비밀 캐시 수명(ms) — 웹훅 비밀(`BILLING_WEBHOOK_SECRET_TTL_MS`)과 같다. */
export const PADDLE_KEY_TTL_MS = 5 * 60_000;
/**
 * 키 읽기가 실패한 뒤 다시 읽지 않는 시간(ms) — 요청마다 Secrets Manager 를 두드리지 않게(보안 검증 N-2 · 코드 검토 N-3). 모양 오류는 이 동안 같은
 * 오류를 다시 던지고(부정 캐시), 읽기 실패는 이 동안 마지막으로 성공한 값을 쓴다.
 */
export const PADDLE_KEY_ERROR_TTL_MS = 30_000;

export interface PaddleProviderLoaderOptions {
  readonly secrets: SecretReader;
  /** 비밀 ARN 을 담은 환경 변수의 값. */
  readonly secretArn: string;
  /** 오류 메시지의 비밀 이름(환경 변수 이름 — 값은 싣지 않는다). */
  readonly label: string;
  readonly environment: PaddleEnvironment;
  readonly paddleFetch?: PaddleFetch;
  /** Paddle 요청 하나의 시간 제한 — admin 은 5초(λ 25초 안), sync 는 기본(10초). */
  readonly timeoutMs?: number;
  /** 테스트가 시계를 바꾼다(ms). */
  readonly clock?: () => number;
}

/**
 * Paddle 어댑터 로더 — 키 비밀을 `PADDLE_KEY_TTL_MS` 동안 캐시하고, 지나면 다시 읽어 어댑터를 새로 만든다. 자리표시면 `null`(그것도 캐시한다 —
 * 5분 안에 실제 키로 바뀌면 다음 읽기가 잡는다). 실패는 둘로 가른다(N-2/N-3):
 *   - **읽기 실패**(Secrets Manager 장애·권한·네트워크): 마지막으로 성공한 값이 있으면 그것을 `PADDLE_KEY_ERROR_TTL_MS` 동안 쓰고 그 뒤 다시 읽는다 —
 *     일시 장애가 결제를 멈추지 않게. 성공한 적이 없으면 던진다(같은 시간 동안 다시 읽지 않고 같은 오류).
 *   - **모양 오류**(`RuntimeConfigError` — 값 없이 이름만): 설정 실수다. 옛 키로 이어 가지 않고(fail-closed) `PADDLE_KEY_ERROR_TTL_MS` 동안 같은 오류를
 *     다시 던진다(부정 캐시 — 요청마다 다시 읽지 않는다). 고친 비밀은 그 뒤 첫 호출이 잡는다.
 */
export function createPaddleProviderLoader(options: PaddleProviderLoaderOptions): () => Promise<BillingProviderApi | null> {
  const clock = options.clock ?? Date.now;
  let good: { readonly provider: BillingProviderApi | null; readonly at: number } | undefined;
  let failure: { readonly error: unknown; readonly shape: boolean; readonly at: number } | undefined;
  return async () => {
    const at = clock();
    if (good !== undefined && at - good.at < PADDLE_KEY_TTL_MS) return good.provider;
    if (failure !== undefined && at - failure.at < PADDLE_KEY_ERROR_TTL_MS) {
      if (!failure.shape && good !== undefined) return good.provider;
      throw failure.error;
    }
    let raw: string;
    try {
      raw = await options.secrets.readSecretString(options.secretArn);
    } catch (error) {
      failure = { error, shape: false, at };
      if (good !== undefined) return good.provider;
      throw error;
    }
    let apiKey: string | null;
    try {
      apiKey = parsePaddleApiKeySecret(raw, options.label);
    } catch (error) {
      failure = { error, shape: true, at };
      good = undefined;
      throw error;
    }
    const provider =
      apiKey === null
        ? null
        : createPaddleProvider({
            http: createPaddleHttp({
              environment: options.environment,
              apiKey,
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
              ...(options.paddleFetch === undefined ? {} : { fetchImpl: options.paddleFetch }),
            }),
          });
    good = { provider, at };
    failure = undefined;
    return provider;
  };
}

/**
 * 결제 DB 롤이 아직 없다 — `atmark/db/billing` 이 자리표시(배포 순서 "새 Compute → bootstrap-roles → migrate" 의 첫 구간). 설정 실수가 아니라 배포 중이다:
 * 핸들러는 reconcile 틱을 알람 없이 건너뛰고, SQS 배치는 그대로 던져 메시지를 지킨다(재전달).
 */
export class BillingNotReadyError extends RuntimeConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'BillingNotReadyError';
  }
}

export interface BillingSyncPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** 테스트만 채운다(가짜 Secrets Manager · 가짜 Paddle — AWS·Paddle 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    readonly paddleFetch?: PaddleFetch;
    /** 키 캐시의 시계(ms). */
    readonly clock?: () => number;
  };
}

export interface ComposedBillingSync {
  /** 조립 때의 의존성(그때 읽은 키의 어댑터). 호출마다는 `currentBillingSyncDeps` 로 새 키를 반영한다. */
  readonly deps: BillingSyncDependencies;
  readonly pool: Pool;
  /** 키 캐시(5분) 너머의 어댑터. */
  readonly loadProvider: () => Promise<BillingProviderApi | null>;
}

/** 이번 호출의 의존성 — 조립은 그대로, 어댑터만 키 캐시에서(M-5: 자리표시 → 실제 키가 λ 재기동 없이 반영된다). */
export async function currentBillingSyncDeps(composed: ComposedBillingSync): Promise<BillingSyncDependencies> {
  return { ...composed.deps, provider: await composed.loadProvider() };
}

export async function composeBillingSync(platform: BillingSyncPlatform): Promise<ComposedBillingSync> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  const environment = readPaddleEnvironment(env);
  const enabled = readBillingEnabled(env);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);
  requireRdsCaBundle(env);

  const loadProvider = createPaddleProviderLoader({
    secrets,
    secretArn: requireEnv(env, RUNTIME_ENV.paddleSyncApiKeySecretArn),
    label: RUNTIME_ENV.paddleSyncApiKeySecretArn,
    environment,
    ...(platform.clients?.paddleFetch === undefined ? {} : { paddleFetch: platform.clients.paddleFetch }),
    ...(platform.clients?.clock === undefined ? {} : { clock: platform.clients.clock }),
  });
  // 조립 때 한 번 읽는다 — 비밀 모양이 틀리면 여기서 기동을 거부한다(자리표시는 null).
  const provider = await loadProvider();

  // ★ 결제 동기화 롤. 소유자·앱·admin 롤 비밀은 읽지 않는다.
  const dbRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbBillingSecretArn));
  if (isPlaceholderSecret(dbRaw)) {
    throw new BillingNotReadyError(`${RUNTIME_ENV.dbBillingSecretArn} 이 아직 채워지지 않았다(placeholder). migrate 의 bootstrap-roles 를 먼저 돌려라.`);
  }
  const credentials = parseDatabaseSecret(dbRaw, RUNTIME_ENV.dbBillingSecretArn);
  const pool = createPool(databaseUrlOf(credentials), { max: BILLING_SYNC_POOL_MAX, ssl: { rejectUnauthorized: true }, keepAlive: true });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'billing_sync', error_kind: error.name });
  });

  return {
    deps: { pool, environment, enabled, provider, sandboxAllowlist: BILLING_SANDBOX_ORG_ALLOWLIST, now: () => new Date() },
    pool,
    loadProvider,
  };
}
