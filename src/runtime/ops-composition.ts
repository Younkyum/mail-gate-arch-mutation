/**
 * src/runtime/ops-composition.ts — **ops λ(`atmark-ops`, `ops.atmark.ai`)의 조립 루트**(`.omc/plans/ops-console.md` §3.1 · §5).
 *
 * - DB 롤은 `atmark_ops` 하나(`atmark/db/ops`). 도메인 표 쓰기 0 · 계약의 definer EXECUTE 만. 다른 DB 비밀은 읽지 않는다.
 * - 키는 `atmark/ops-keys` 하나(요청 파생값 — `src/ops/hosted/keys.ts`). **로그인 코드 키는 없다**(결정 C2 — login-mailer 만).
 * - SES · S3 · KMS 클라이언트가 없다. 부르는 AWS 는 Secrets Manager 읽기 둘과 login-mailer 깨우기(`lambda:InvokeFunction` 하나)뿐이다.
 * - 풀은 `OPS_POOL_MAX`(1) × 예약 동시성 `OPS_RESERVED_CONCURRENCY`(2) — 연결 예산 72/75(§3.1).
 *
 * **자리표시 비밀이면 크래시하지 않는다**(M1 · §5 2~7단계): DB 비밀이나 ops-keys 가 아직 자리표시(또는 키 형식 오류)면 `unavailable` 을 돌려주고
 * 핸들러는 모든 요청에 503 `ops_unavailable` 을 낸다. 그 판정은 `UNAVAILABLE_RETRY_MS` 동안만 기억한다 — 사람이 비밀을 넣으면(§5 7단계) 재배포
 * 없이도 곧 다시 읽는다. 설정 오류(변수 없음 · ARN 이 login-mailer 가 아님)는 결정적이라 던진다(핸들러가 503 과 요청 id 만 낸다).
 */

import type { Pool } from 'pg';

import { createPool } from '../db/client';
import { log } from '../observability/logger';
import { OPS_ENV, OPS_POOL_MAX } from '../ops/contract';
import type { HostedDeps } from '../ops/hosted/app';
import { createOpsKeys } from '../ops/hosted/keys';
import { parseHmacKeyring } from '../security/hmac-keyring';
import { databaseUrlOf, isPlaceholderSecret, parseDatabaseSecret, requireEnv, requireProductionRuntime, requireRdsCaBundle, RUNTIME_ENV, RuntimeConfigError } from './config';
import { createLambdaInvokeClient, createLoginMailerKicker, type LambdaInvokeClient } from './lambda-invoke';
import { createSecretReader, type SecretReader } from './secrets';

export { OPS_POOL_MAX };

/** 자리표시 · 키 형식 오류 판정을 기억하는 시간(ms). 그 뒤 다음 요청이 비밀을 다시 읽는다. */
export const UNAVAILABLE_RETRY_MS = 60_000;

/** 깨우는 대상 — login-mailer 함수 ARN(한정자 없음). 다른 함수·별칭·버전이면 기동 거부. */
const LOGIN_MAILER_FUNCTION_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:atmark-login-mailer$/;

export interface OpsPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** 테스트만 채운다(가짜 SDK · 가짜 풀, AWS 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    readonly lambda?: LambdaInvokeClient;
    readonly pool?: (connectionString: string) => Pool;
  };
}

export type OpsUnavailableReason = 'db_placeholder' | 'keys_placeholder' | 'keys_invalid';

export type ComposedOps =
  | { readonly kind: 'ready'; readonly deps: HostedDeps; readonly pool: Pool }
  | { readonly kind: 'unavailable'; readonly reason: OpsUnavailableReason };

export async function composeOps(platform: OpsPlatform): Promise<ComposedOps> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  requireRdsCaBundle(env);
  const mailerArn = requireEnv(env, OPS_ENV.loginMailerFunctionArn);
  if (!LOGIN_MAILER_FUNCTION_ARN_PATTERN.test(mailerArn)) throw new RuntimeConfigError(`${OPS_ENV.loginMailerFunctionArn} 가 login-mailer 함수 ARN(한정자 없음)이 아니다.`);
  const dbArn = requireEnv(env, OPS_ENV.dbSecretArn);
  const keysArn = requireEnv(env, OPS_ENV.opsKeysSecretArn);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);

  const keysRaw = await secrets.readSecretString(keysArn);
  if (isPlaceholderSecret(keysRaw)) return { kind: 'unavailable', reason: 'keys_placeholder' };
  let keys;
  try {
    keys = createOpsKeys(parseHmacKeyring(keysRaw, OPS_ENV.opsKeysSecretArn));
  } catch {
    return { kind: 'unavailable', reason: 'keys_invalid' };
  }

  const dbRaw = await secrets.readSecretString(dbArn);
  if (isPlaceholderSecret(dbRaw)) return { kind: 'unavailable', reason: 'db_placeholder' };
  const url = databaseUrlOf(parseDatabaseSecret(dbRaw, OPS_ENV.dbSecretArn));
  const pool = platform.clients?.pool?.(url) ?? createPool(url, { max: OPS_POOL_MAX, ssl: { rejectUnauthorized: true }, keepAlive: true, connectionTimeoutMillis: 3_000 });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'ops', error_kind: error.name });
  });

  const kickMailer = createLoginMailerKicker({ client: platform.clients?.lambda ?? createLambdaInvokeClient(region), functionArn: mailerArn, routeId: 'ops' });
  return { kind: 'ready', pool, deps: { pool, keys, kickMailer, now: () => new Date() } };
}

/**
 * 실행 환경당 조립 — `ready` 는 수명 내내, `unavailable` 은 `UNAVAILABLE_RETRY_MS` 동안 기억한다. 실패(던짐)는 기억하지 않는다(다음 요청이 다시).
 */
export function createOpsComposer(compose: () => Promise<ComposedOps>, clock: () => number = Date.now): () => Promise<ComposedOps> {
  let pending: Promise<ComposedOps> | undefined;
  let unavailableAt: number | null = null;
  return () => {
    if (pending !== undefined && unavailableAt !== null && clock() - unavailableAt >= UNAVAILABLE_RETRY_MS) {
      pending = undefined;
      unavailableAt = null;
    }
    pending ??= compose().then(
      (composed) => {
        if (composed.kind === 'unavailable') unavailableAt = clock();
        return composed;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}
