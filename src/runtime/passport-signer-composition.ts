/**
 * src/runtime/passport-signer-composition.ts — **서명 Lambda(`atmark-passport-signer`)의 조립 루트** (계획 §3.5 · §4B.2, 계약 §3).
 *
 * `src/passport/signer.ts`(개인키를 복호하는 유일한 파일)를 import 하는 **유일한 곳**이다 — `.dependency-cruiser.cjs`
 * `passport-signer-only-from-signer-composition` · `test/arch/passport-signer-isolation.arch.test.ts`. api·워커의 조립 루트
 * (`composition.ts`)와 admin 조립 루트는 이 파일을 모른다 — 그 번들에는 복호 코드가 **들어가지 않는다**(번들 테스트).
 *
 * 읽는 것: 운영 가드 · 자기 DB 비밀(`atmark/db/passport-signer`) · envelope CMK ARN · identity 버킷·배포 ID. 쓰는 AWS: Secrets Manager
 * (에이전트 키 envelope 읽기) · KMS(envelope 복호 — `signer.ts` 안에서) · S3 PutObject(identity 버킷) · CloudFront CreateInvalidation. **SES 클라이언트 없음.**
 */

import type { Pool } from 'pg';

import { createPool } from '../db/client';
import { log } from '../observability/logger';
import { createPassportSigner, createSignerKmsClient } from '../passport/signer';
import { createS3Client, createS3IdentityDocumentWriter, type S3ObjectClient } from '../storage/s3-object-store';
import type { PassportSignerWorkerDependencies } from '../workers/passport-signer';
import { createCloudFrontClient, createCloudFrontInvalidator, type CloudFrontInvalidationClient } from './cloudfront';
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

/**
 * 실행 환경당 풀 크기 — **1**. 틱은 요청을 하나씩 순차로 처리한다(서명 트랜잭션 하나 → 실패 기록 한 문장 — 동시에 두 커넥션을 쥐지
 * 않는다). 연결 예산: `RESERVED_CONCURRENCY['passport-signer']`(1) × 이 값(`test/unit/infra/compute-stack.test.ts`).
 */
export const PASSPORT_SIGNER_POOL_MAX = 1;

export interface PassportSignerPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** Lambda 호출 ARN — identity 버킷의 `ExpectedBucketOwner` 를 여기서 읽는다. */
  readonly invokedFunctionArn: string;
  /** 테스트만 채운다(가짜 SDK, AWS 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    /** 서명기의 KMS 면(`signer.ts` 가 정한다 — 이 파일은 그 이름을 모른다). */
    readonly kms?: ReturnType<typeof createSignerKmsClient>;
    readonly s3?: S3ObjectClient;
    readonly cloudfront?: CloudFrontInvalidationClient;
  };
}

export interface ComposedPassportSigner {
  readonly deps: PassportSignerWorkerDependencies;
  readonly pool: Pool;
}

export async function composePassportSigner(platform: PassportSignerPlatform): Promise<ComposedPassportSigner> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  const cmkArn = requireEnv(env, RUNTIME_ENV.passportKmsKeyId);
  if (!cmkArn.startsWith('arn:aws:kms:')) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.passportKmsKeyId} 는 CMK ARN 이어야 한다(복호 KeyId 로 고정한다 — 별칭 불가).`);
  }
  const bucket = requireEnv(env, RUNTIME_ENV.identityBucket);
  const distributionId = requireEnv(env, RUNTIME_ENV.identityDistributionId);
  requireRdsCaBundle(env);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);

  // ★ 서명 롤. 앱·admin·소유자 롤 비밀은 읽지도 요구하지도 않는다.
  const dbRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbPassportSignerSecretArn));
  const credentials = parseDatabaseSecret(dbRaw, RUNTIME_ENV.dbPassportSignerSecretArn);
  const pool = createPool(databaseUrlOf(credentials), {
    max: PASSPORT_SIGNER_POOL_MAX,
    ssl: { rejectUnauthorized: true },
    keepAlive: true,
  });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'passport_signer', error_kind: error.name });
  });

  return {
    deps: {
      db: pool,
      signer: createPassportSigner({ kind: 'aws', secrets, kms: platform.clients?.kms ?? createSignerKmsClient(region), cmkArn }),
      documents: createS3IdentityDocumentWriter({
        client: platform.clients?.s3 ?? createS3Client(region),
        bucket,
        expectedBucketOwner: accountIdFromFunctionArn(platform.invokedFunctionArn),
      }),
      cdn: createCloudFrontInvalidator(platform.clients?.cloudfront ?? createCloudFrontClient(), distributionId),
      now: () => new Date(),
    },
    pool,
  };
}
