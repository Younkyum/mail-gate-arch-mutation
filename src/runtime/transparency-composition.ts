/**
 * src/runtime/transparency-composition.ts — **투명성 로그 Lambda 둘의 조립 루트**(ADR-0008 · US-010).
 *
 *   - `atmark-transparency-log`(`handlers/transparency-log.ts`) — `composeTransparencyLog`: 서열·에폭·게시, DB 롤 `atmark_tlog`,
 *     체크포인트 서명기(KMS Ed25519), 게시 수위 읽기. 외부 HTTP 없음.
 *   - `atmark-transparency-anchor`(`handlers/transparency-anchor.ts`) — `composeTransparencyAnchor`: 외부 앵커, DB 롤 `atmark_tlog_anchor`,
 *     앵커 서명기(KMS P-256), OTS·Rekor HTTP.
 * **함수마다 자기 DB 비밀 하나 · 자기 KMS 키 하나만 읽고**(환경 변수도 그 함수의 것만 있다 — `transparency-stack.ts`), 풀(max 1)을 호출마다
 * 열고 닫는다 — 예약 동시성 1 × 연결 1 = 함수마다 연결 예산 1.
 *
 * **M5 해소(2026-09-24 리드 결정 ①):** 예전에는 한 함수·한 IAM 역할이 두 과제를 했다(연결 예산 ≤ 75 가 75 였다). `ses-events` 예약
 * 동시성을 2 → 1 로 줄여 함수·역할을 나눴다 — 외부 응답을 파싱하는 앵커 코드가 뚫려도 그 역할에는 체크포인트 키 `kms:Sign` 도
 * `atmark_tlog` 비밀도 없다(IAM · 키 정책 Deny · DB 롤). 이 파일은 과제마다 자기 키·자기 비밀만 조립한다(코드 층).
 *
 * 읽는 것: 운영 가드 · 그 함수의 DB 비밀 · 그 함수의 KMS 키 ARN · 로그 버킷 · (log) origin · (anchor) 캘린더·Rekor URL·Rekor 샤드 키(vkey).
 * **SES 클라이언트 없음.**
 */

import type { Pool } from 'pg';

import { createPool } from '../db/client';
import { log } from '../observability/logger';
import { ObjectNotFoundError } from '../storage/object-store';
import { createS3Client, createS3ObjectReader, createS3TransparencyLogWriter, type S3ObjectClient } from '../storage/s3-object-store';
import { anchorEndpoint, createHttpOtsClient, createHttpRekorClient, type OtsCalendarClient, type RekorClient } from '../tlog/anchor-http';
import { parseVkey, type VerifierKey } from '../tlog/checkpoint';
import { createKmsAnchorSigner, createKmsNoteSigner, createTlogKmsClient, type TlogKmsClient } from '../tlog/checkpoint-signer';
import { TLOG_ORIGIN } from '../tlog/constants';
import { PUBLISHED_CHECKPOINT_MAX_BYTES, type TlogPublishedReader } from '../tlog/publisher';
import type { TransparencyAnchorWorkerDependencies } from '../workers/transparency-anchor';
import type { TransparencyLoggerWorkerDependencies } from '../workers/transparency-logger';
import { beginInvocation, type LambdaContext, type ScheduledRunReport } from './lambda';
import {
  accountIdFromFunctionArn,
  databaseUrlOf,
  parseDatabaseSecret,
  requireEnv,
  requireProductionRuntime,
  requireRdsCaBundle,
  RUNTIME_ENV,
  RuntimeConfigError,
} from './config';
import { createSecretReader, type SecretReader } from './secrets';

/** 풀 크기 — 1. 연결 예산: 예약 동시성(1) × 이 값. 풀은 호출마다 열고 닫는다. */
export const TRANSPARENCY_POOL_MAX = 1;

/**
 * 이 조립 루트만 읽는 환경 변수(`transparency-stack.ts` 가 채운다).
 *   - origin: 체크포인트 origin = 서명 키 이름. 기본 `TLOG_ORIGIN`(운영). 스테이징은 다른 origin 을 써야 한다(런북 §3 — 같은 이름의 두 로그가
 *     생기지 않게). DB 는 체크포인트 origin = 서명 키 이름 · 에폭 사이 origin 불변을 본다(202609241800).
 *   - rekorVkey: Rekor v2 샤드의 체크포인트 키(C2SP vkey, Ed25519). 없으면 Rekor 앵커를 하지 않는다(응답을 확인할 키가 없다).
 */
export const TLOG_COMPOSITION_ENV = {
  origin: 'ATMARK_TLOG_ORIGIN',
  rekorVkey: 'ATMARK_TLOG_REKOR_VKEY',
} as const;

/** origin 모양 — 스키마 없는 URL(호스트[/경로]), 공백·`+` 없음(c2sp.org/tlog-checkpoint). */
export const TLOG_ORIGIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._-]+)*$/;

/** 남은 실행 시간이 없을 때(테스트 · 로컬)의 기본 예산 — 함수 시간 제한(240초)보다 짧게. */
export const DEFAULT_REMAINING_MS = 200_000;

/** OTS 캘린더는 두 곳 이상이어야 한다(한 곳의 장애가 그날의 앵커를 잃게 하지 않게 — ADR-0008 §2.7). */
export const MIN_OTS_CALENDARS = 2;

export interface TransparencyPlatform {
  readonly env: NodeJS.ProcessEnv;
  readonly invokedFunctionArn: string;
  /** Lambda 의 남은 실행 시간(ms) — 앵커 틱의 시간 예산. */
  readonly remainingMs?: () => number;
  /** 테스트만 채운다(가짜 SDK·HTTP, AWS·외부 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    readonly kms?: TlogKmsClient;
    readonly s3?: S3ObjectClient;
    readonly ots?: OtsCalendarClient;
    readonly rekor?: RekorClient;
  };
}

export interface Composed<T> {
  readonly deps: T;
  readonly pool: Pool;
}

interface Common {
  readonly region: string;
  readonly secrets: SecretReader;
  readonly s3: S3ObjectClient;
  readonly bucket: string;
  readonly expectedBucketOwner: string;
  readonly writer: ReturnType<typeof createS3TransparencyLogWriter>;
}

function common(platform: TransparencyPlatform): Common {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  requireRdsCaBundle(env);
  const s3 = platform.clients?.s3 ?? createS3Client(region);
  const bucket = requireEnv(env, RUNTIME_ENV.tlogBucket);
  const expectedBucketOwner = accountIdFromFunctionArn(platform.invokedFunctionArn);
  return {
    region,
    secrets: platform.clients?.secrets ?? createSecretReader(region),
    s3,
    bucket,
    expectedBucketOwner,
    writer: createS3TransparencyLogWriter({ client: s3, bucket, expectedBucketOwner }),
  };
}

/** 게시 수위 읽기 — `log/` 접두사 하나(로그 역할의 IAM 은 `log/checkpoint` GetObject 하나). 로그 함수만 쓴다. */
function publishedReader(base: Common): TlogPublishedReader {
  const reader = createS3ObjectReader({ client: base.s3, bucket: base.bucket, expectedBucketOwner: base.expectedBucketOwner, prefix: 'log/' });
  return {
    async readCheckpoint(): Promise<string | null> {
      try {
        return Buffer.from(await reader.get('log/checkpoint', PUBLISHED_CHECKPOINT_MAX_BYTES)).toString('utf8');
      } catch (error) {
        if (error instanceof ObjectNotFoundError) return null;
        throw error;
      }
    },
  };
}

function originOf(env: NodeJS.ProcessEnv): string {
  const origin = env[TLOG_COMPOSITION_ENV.origin]?.trim() || TLOG_ORIGIN;
  if (!TLOG_ORIGIN_SHAPE.test(origin)) throw new RuntimeConfigError(`${TLOG_COMPOSITION_ENV.origin} 는 origin 모양(호스트[/경로], 공백·+ 없음)이어야 한다.`);
  return origin;
}

async function openPool(secrets: SecretReader, env: NodeJS.ProcessEnv, variable: string, routeId: string): Promise<Pool> {
  const credentials = parseDatabaseSecret(await secrets.readSecretString(requireEnv(env, variable)), variable);
  const pool = createPool(databaseUrlOf(credentials), { max: TRANSPARENCY_POOL_MAX, ssl: { rejectUnauthorized: true } });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: routeId, error_kind: error.name });
  });
  return pool;
}

function kmsKeyArn(env: NodeJS.ProcessEnv, variable: string): string {
  const arn = requireEnv(env, variable);
  if (!arn.startsWith('arn:aws:kms:')) throw new RuntimeConfigError(`${variable} 는 KMS 키 ARN 이어야 한다(별칭 불가 — 키 정책이 ARN 에 묶인다).`);
  return arn;
}

/** 과제 `log` — `atmark_tlog` 풀 + 체크포인트 서명기(KMS Ed25519) + 로그 버킷 쓰기. */
export async function composeTransparencyLog(platform: TransparencyPlatform): Promise<Composed<TransparencyLoggerWorkerDependencies>> {
  const base = common(platform);
  const signer = createKmsNoteSigner(platform.clients?.kms ?? createTlogKmsClient(base.region), kmsKeyArn(platform.env, RUNTIME_ENV.tlogSigningKeyArn), originOf(platform.env));
  const pool = await openPool(base.secrets, platform.env, RUNTIME_ENV.dbTlogSecretArn, 'transparency_logger');
  return { deps: { db: pool, signer, writer: base.writer, published: publishedReader(base), now: () => new Date() }, pool };
}

/** 과제 `anchor` — `atmark_tlog_anchor` 풀 + 앵커 서명기(KMS P-256) + OTS·Rekor HTTP + 로그 버킷 쓰기. */
export async function composeTransparencyAnchor(platform: TransparencyPlatform): Promise<Composed<TransparencyAnchorWorkerDependencies>> {
  const base = common(platform);
  const calendars = requireEnv(platform.env, RUNTIME_ENV.tlogOtsCalendars)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => anchorEndpoint(value, 'opentimestamps'));
  if (new Set(calendars).size < MIN_OTS_CALENDARS) throw new RuntimeConfigError(`${RUNTIME_ENV.tlogOtsCalendars} 는 서로 다른 캘린더 ${String(MIN_OTS_CALENDARS)}곳 이상이어야 한다.`);
  const rekorRaw = platform.env[RUNTIME_ENV.tlogRekorUrl]?.trim() ?? '';
  const rekorUrl = rekorRaw === '' ? null : anchorEndpoint(rekorRaw, 'rekor');
  const rekorKey = rekorKeyOf(platform.env[TLOG_COMPOSITION_ENV.rekorVkey]?.trim() ?? '', rekorUrl);
  const signer = createKmsAnchorSigner(platform.clients?.kms ?? createTlogKmsClient(base.region), kmsKeyArn(platform.env, RUNTIME_ENV.tlogAnchorKeyArn));
  const pool = await openPool(base.secrets, platform.env, RUNTIME_ENV.dbTlogAnchorSecretArn, 'transparency_anchor');
  return {
    deps: {
      db: pool,
      ots: platform.clients?.ots ?? createHttpOtsClient(),
      rekor: platform.clients?.rekor ?? createHttpRekorClient(),
      signer,
      writer: base.writer,
      calendars,
      rekorUrl,
      rekorKey,
      now: () => new Date(),
      remainingMs: platform.remainingMs ?? (() => DEFAULT_REMAINING_MS),
    },
    pool,
  };
}

/** Rekor 샤드 키 — vkey 의 이름이 샤드 호스트와 같아야 한다(Rekor v2 체크포인트 origin = 샤드 호스트). URL 없이 키만 있으면 설정 오류. */
function rekorKeyOf(raw: string, rekorUrl: string | null): VerifierKey | null {
  if (raw === '') return null;
  if (rekorUrl === null) throw new RuntimeConfigError(`${TLOG_COMPOSITION_ENV.rekorVkey} 는 ${RUNTIME_ENV.tlogRekorUrl} 와 함께 준다.`);
  let key: VerifierKey;
  try {
    key = parseVkey(raw);
  } catch {
    throw new RuntimeConfigError(`${TLOG_COMPOSITION_ENV.rekorVkey} 는 C2SP vkey(Ed25519) 여야 한다.`);
  }
  if (key.name !== new URL(rekorUrl).hostname) throw new RuntimeConfigError(`${TLOG_COMPOSITION_ENV.rekorVkey} 의 이름이 Rekor 샤드 호스트와 다르다.`);
  return key;
}

// ---------------------------------------------------------------------------
// 핸들러 공용 — 과제 확인 · Lambda 컨텍스트 → 플랫폼 · 조립 → 실행 → 풀 닫기
// ---------------------------------------------------------------------------

export type TransparencyTask = 'log' | 'anchor';

/**
 * 스케줄 입력 `{"task": …}` 가 **이 함수의 과제**인지 본다. 함수가 둘이라 배선이 틀리면(앵커 스케줄이 로그 함수를 부르는 등) 조용히 다른 일을
 * 하지 않고 던진다. 알 수 없는 과제·다른 과제 모두.
 */
export function requireTask(event: unknown, expected: TransparencyTask): TransparencyTask {
  const task = (event as { task?: unknown } | null)?.task;
  if (task === expected) return expected;
  throw new Error(`이 함수의 과제는 ${expected} 다 — 받은 task: ${JSON.stringify(task ?? null).slice(0, 40)}`);
}

/** Lambda 컨텍스트의 남은 실행 시간 — 앵커 틱의 시간 예산(L8). 공용 `LambdaContext` 타입에는 없어 여기서만 좁혀 읽는다. */
function remainingOf(context: LambdaContext): (() => number) | undefined {
  const read = (context as LambdaContext & { getRemainingTimeInMillis?: unknown }).getRemainingTimeInMillis;
  return typeof read === 'function' ? () => Number((read as () => number).call(context)) : undefined;
}

export function lambdaPlatform(context: LambdaContext): TransparencyPlatform {
  const remainingMs = remainingOf(context);
  return { env: process.env, invokedFunctionArn: context.invokedFunctionArn, ...(remainingMs === undefined ? {} : { remainingMs }) };
}

/** 한 과제의 핸들러 — 과제 확인 → 조립 → 실행 → 풀 닫기(성공·실패 모두) → 실행 로그. */
export function createTransparencyTaskHandler<D>(options: {
  readonly task: TransparencyTask;
  readonly routeId: string;
  readonly compose: (platform: TransparencyPlatform) => Promise<Composed<D>>;
  readonly run: (deps: D) => Promise<Readonly<Record<string, number>>>;
  readonly platformOf: (context: LambdaContext) => TransparencyPlatform;
}): (event: unknown, context: LambdaContext) => Promise<ScheduledRunReport> {
  return async (event, context) => {
    beginInvocation(context);
    requireTask(event, options.task);
    const started = Date.now();
    try {
      const composed = await options.compose(options.platformOf(context));
      let counts: Readonly<Record<string, number>>;
      try {
        counts = await options.run(composed.deps);
      } finally {
        await composed.pool.end().catch(() => undefined);
      }
      log('info', 'runtime.scheduled_run', { route_id: options.routeId, latency_ms: Date.now() - started, detail: JSON.stringify(counts) });
      return { routeId: options.routeId, counts };
    } catch (error) {
      log('error', 'runtime.scheduled_failed', {
        route_id: options.routeId,
        latency_ms: Date.now() - started,
        error_kind: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      throw error;
    }
  };
}
