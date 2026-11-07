/**
 * src/runtime/admin-composition.ts — **admin Lambda 의 조립 루트**. `composition.ts` 와 **파일을 나눈 이유가 이 파일의 본체다:**
 *
 *   - `composition.ts` 는 api·워커 핸들러가 import 한다. 거기에 admin 조립을 두면 api 번들의 import 폐포에 `src/admin/**`
 *     (소유자 세션·프로비저닝·sender_marks 쓰기)가 들어온다. 반대로 이 파일이 `composition.ts` 를 import 하면 admin 번들에 SES
 *     전송단·S3 가 들어온다. 둘 다 `test/arch/admin-separation.arch.test.ts` 가 막는다 — 그래서 공통 부품(운영 가드·비밀·TLS 풀)
 *     몇 줄을 여기서 다시 쓴다(`config.ts`·`secrets.ts`·`db/client.ts` 의 같은 함수를 부른다 — 규칙은 하나다).
 *   - **admin DB 롤**(`ATMARK_DB_ADMIN_SECRET_ARN` → `atmark/db/admin`, 롤 `atmark_admin`)로 연다 — **소유자 롤이 아니다**
 *     (ADR-0006 · 검증 H2). 소유자 롤은 DDL·GRANT·트리거 DROP 을 할 수 있어 admin 탈취가 append-only 감사 해제·권한 재부여가
 *     됐다. `atmark_admin` 은 아무것도 소유하지 않고 202609230720 의 GRANT(컬럼 단위까지)만 가진다. 소유자 비밀·앱 롤 비밀은
 *     읽지도 요구하지도 않는다. 소유자 롤을 쓰는 조립은 migrate 둘(`composeMigration`·`composeRoleBootstrap`)뿐이다(arch 테스트).
 *   - SES 클라이언트가 없다 — admin 역할에는 SES 권한이 0 이다(Layer E). 로그인 메일은 outbox 에 적는다.
 *   - S3 는 **읽기 전용 리더 하나**(US-004 — 발신 로그 상세의 본문): 메일 버킷의 `outbound/content/` 접두사만, `GetObject` 만
 *     (`createS3ObjectReader` — 쓰기 면이 타입에 없다 · IAM 도 `s3:GetObject` on `outbound/content/*` 하나, ListBucket 없음).
 *     `createS3ObjectStore`(putIfAbsent)·서명기·신원 문서 쓰기는 부르지 않는다(`test/arch/admin-separation.arch.test.ts` ②).
 *   - 결제(WP-2): `ATMARK_PADDLE_ENV`·`ATMARK_BILLING_ENABLED`·`ATMARK_PADDLE_ADMIN_API_KEY_SECRET_ARN` 셋이 함께 있을 때만 admin 키로 Paddle 어댑터를
 *     만든다(없으면 결제 잠김 · 키 자리표시·오류면 provider 없음 — 콘솔은 정상). 비밀은 admin 키 하나 더 — sync 키·웹훅 비밀은 읽지 않는다. 키는
 *     5분 캐시로 요청마다 다시 본다(M-5) · Paddle 요청 하나는 `ADMIN_PADDLE_TIMEOUT_MS`(5초) — 체크아웃·포털 경로가 λ 25초 안에 끝난다.
 *   - **login-mailer 깨우기**(`kickLoginMailer`): outbox 행을 적는 요청(로그인·가입·초대·초대 claim)이 커밋된 뒤 login-mailer λ 를
 *     비동기(`InvocationType: 'Event'`, 고정 입력 `{"source":"atmark.kick"}`)로 부른다 — 메일이 1분 틱을 기다리지 않게. 보내는 주체는
 *     여전히 login-mailer 하나다(ADR-0006): admin 은 SES 0 · 로그인 메일 DB 롤 0 이고, 깨우기는 "지금 outbox 를 보라" 이상을 말하지 못한다.
 *     함수 ARN 은 `ATMARK_LOGIN_MAILER_FUNCTION_ARN`(없거나 `atmark-login-mailer` 가 아니면 기동 거부). 실패는 삼킨다(`runtime/lambda-invoke.ts`).
 *   - **웹훅 키링은 없다**(보안 M1, 2026-09-30). 콘솔 웹훅 등록·회전의 시크릿은 api λ 를 내부 이벤트로 불러 받는다
 *     (`createWebhookSecretIssuer` — `lambda:InvokeFunction` on api 함수 ARN 하나, `ATMARK_API_FUNCTION_ARN`). 변수가 없거나 모양이 틀리면
 *     발급기 없이 조립한다(경고 한 줄) — 콘솔의 등록·회전만 503 이고 기동은 막지 않는다(보안 L4).
 *   - 로그인 키링은 `atmark/owner-login-keys`(승인 링크 키와 분리). 프로비저닝 custody 는 AWS(KMS GenerateDataKey + Secrets
 *     Manager CreateSecret, `atmark/agent-keypairs/*`) — **부를 때** 만든다(로그인만 하는 콜드 스타트가 KMS 를 요구하지 않게).
 */

import type { Pool } from 'pg';

import type { AdminDependencies } from '../admin/context';
import { BILLING_SANDBOX_ORG_ALLOWLIST } from '../billing/constants';
import type { PaddleFetch } from '../billing/paddle/http';
import { PADDLE_PRICE_PLANS } from '../billing/paddle/prices';
import type { AdminBillingDependencies, BillingProviderApi } from '../billing/provider';
import { createObjectContentReader } from '../api/content-store';
import { createPool } from '../db/client';
import { createPostgresRealtimeInboundTargets } from '../db/repositories/realtime-connection-store';
import type { RealtimeTransport } from '../realtime/push';
import { unavailableDomainControlInvoker, type DomainControlInvoker, type ProvisionDomainNow } from '../domains/contract';
import { createDomainConnectDiscovery, systemDiscoveryPorts } from '../domains/dc-discovery';
import { createDcKmsClient, createKmsDcSigner, type DcKmsClient } from '../domains/dc-kms-signer';
import { provisionDomainNow } from '../domains/lifecycle';
import type { DomainPool } from '../domains/store';
import { log } from '../observability/logger';
import { AGENT_KEYPAIR_SECRET_PREFIX, createAwsKeyCustody } from '../passport/custody-aws';
import { parseHmacKeyring } from '../security/hmac-keyring';
import { OUTBOUND_CONTENT_PREFIX } from '../storage/object-store';
import { createS3Client, createS3ObjectReader, type S3ObjectReadClient } from '../storage/s3-object-store';
import {
  accountIdFromFunctionArn,
  databaseUrlOf,
  isPlaceholderSecret,
  parseDatabaseSecret,
  readBillingEnabled,
  readFeatureFlag,
  readFeatureRollout,
  readPaddleEnvironment,
  requireEnv,
  requireProductionRuntime,
  requireRdsCaBundle,
  RUNTIME_ENV,
  RuntimeConfigError,
} from './config';
import { createPaddleProviderLoader } from './billing-composition';
import { createDomainControlInvoker } from './domain-control-invoker';
import { createKmsClient, createKmsDataKeyGenerator, type KmsDataKeyClient } from './kms';
import { createLambdaInvokeClient, createLoginMailerKicker, createWebhookSecretIssuer, type LambdaInvokeClient } from './lambda-invoke';
import { realtimePusherOf } from './realtime-pusher';
import {
  createAgentKeypairSecretCreator,
  createSecretsManagerCreateClient,
  createSecretReader,
  type SecretCreateClient,
  type SecretReader,
} from './secrets';

/**
 * admin 실행 환경당 풀 크기 — 작게. 트랜잭션 하나 + 여유 하나.
 * 연결 예산: `RESERVED_CONCURRENCY.admin`(3) × 이 값 = 6(`test/unit/infra/compute-stack.test.ts` 합 × 풀 ≤ 75 — 전체가 정확히 75).
 */
export const ADMIN_POOL_MAX = 2;

/**
 * 고객 도메인 확인 틱 풀(ADR-0014 결정 12) — **틱 롤**(`atmark_domain_tick`)로 **이벤트마다 열고 `end()` 한다**(틱이 끝나면 연결 0). 크기 1:
 * 스케줄러(10분 · 틱 ≤ 20초 · 겹침 없음)만 부르므로 한 번에 하나(연결 예산은 `compute-stack.test.ts` 가 고정).
 */
export const DOMAIN_TICK_POOL_MAX = 1;

export interface AdminPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** Lambda 컨텍스트의 호출 ARN — 메일 버킷 소유 계정(`ExpectedBucketOwner`)을 여기서 읽는다(`composition.ts` 와 같다). */
  readonly invokedFunctionArn: string;
  /** 테스트만 채운다(가짜 SDK, AWS 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    readonly kms?: KmsDataKeyClient;
    readonly secretCreate?: SecretCreateClient;
    readonly s3?: S3ObjectReadClient;
    readonly paddleFetch?: PaddleFetch;
    /** Domain Connect 서명(KMS Sign · GetPublicKey). */
    readonly dcKms?: DcKmsClient;
    /** login-mailer 깨우기(`lambda:InvokeFunction` Event). */
    readonly lambda?: LambdaInvokeClient;
    /** 결제 키 캐시의 시계(ms). */
    readonly clock?: () => number;
    /** 실시간 `PostToConnection`(묶음 E — 풀기 뒤 힌트). */
    readonly realtime?: RealtimeTransport;
  };
}

/**
 * admin 경로의 Paddle 요청 하나의 시간 제한(ms). 체크아웃은 차례로 많아야 셋(상태 묶음 · 생성 · 취소 묶음 — 묶음은 병렬), 포털은 셋(목록 2쪽 ·
 * 세션)이라 λ 25초 안에 끝난다(보안 검증 M-1 · 코드 검토 L-11).
 */
export const ADMIN_PADDLE_TIMEOUT_MS = 5_000;

/** 깨우는 대상 — login-mailer 함수 ARN(한정자 없음). 다른 함수·별칭·버전을 가리키면 기동 거부(IAM 도 이 ARN 하나만 허락한다). */
const LOGIN_MAILER_FUNCTION_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:atmark-login-mailer$/;

/** 콘솔 웹훅 시크릿을 묻는 대상 — api 함수 ARN(한정자 없음). 다른 함수를 가리키면 발급기 없이 조립한다(IAM 도 이 ARN 하나만 허락한다). */
const API_FUNCTION_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:atmark-api$/;

/** 결제(WP-2)가 쓰는 환경 변수 셋 — 셋 다 없으면 결제 없이 조립한다(잠김), 일부만 있으면 설정 오류다(조용히 반쯤 켜지지 않게). */
const BILLING_ENV = [RUNTIME_ENV.paddleEnvironment, RUNTIME_ENV.billingEnabled, RUNTIME_ENV.paddleAdminApiKeySecretArn] as const;

/**
 * admin 의 결제 의존성(계획 §3-8 · D-5). admin 키(`atmark/billing/paddle/admin-api-key`, `{"apiKey":"…"}`)는 거래 생성·취소 · 포털 세션 권한이다.
 * **키가 자리표시면 provider 없이**(콘솔은 "결제 준비 중") — 결제 설정이 콘솔 전체를 503 으로 만들지 않는다. **키 오류도 같다**(보안 검증 N-2 ·
 * 코드 검토 N-3): 비밀 모양이 틀리거나 읽지 못하면(마지막 성공 값도 없으면) 조립은 계속하고 `loadProvider` 가 `null` 을 돌려준다 — 결제만
 * `not_configured`(잠김)이고 콘솔은 정상이다. 콜드 스타트(조립 때 읽기)와 웜(요청마다 5분 캐시 너머 읽기) 모두. 로그 `billing.admin_key_unavailable`
 * (`error_kind` 만 — 값·비밀 이름 없음). 결제 환경 변수 셋이 반쯤만 있는 것은 키 오류가 아니라 배포 설정 오류라 여전히 기동을 거부한다.
 */
async function composeAdminBilling(
  env: NodeJS.ProcessEnv,
  secrets: SecretReader,
  paddleFetch: PaddleFetch | undefined,
  clock: (() => number) | undefined,
): Promise<AdminBillingDependencies | undefined> {
  const present = BILLING_ENV.filter((name) => env[name] !== undefined && env[name] !== '');
  if (present.length === 0) return undefined;
  if (present.length !== BILLING_ENV.length) {
    throw new RuntimeConfigError(`결제 환경 변수는 셋이 함께다: ${BILLING_ENV.filter((name) => !present.includes(name)).join(', ')} 가 없다.`);
  }
  const environment = readPaddleEnvironment(env);
  const enabled = readBillingEnabled(env);
  const load = createPaddleProviderLoader({
    secrets,
    secretArn: requireEnv(env, RUNTIME_ENV.paddleAdminApiKeySecretArn),
    label: RUNTIME_ENV.paddleAdminApiKeySecretArn,
    environment,
    timeoutMs: ADMIN_PADDLE_TIMEOUT_MS,
    ...(paddleFetch === undefined ? {} : { paddleFetch }),
    ...(clock === undefined ? {} : { clock }),
  });
  // 키 오류는 결제만 잠근다(null → `not_configured`). 로더가 30초 부정 캐시·마지막 성공 값을 맡는다.
  const loadProvider = async (): Promise<BillingProviderApi | null> => {
    try {
      return await load();
    } catch (error) {
      log('warn', 'billing.admin_key_unavailable', { route_id: 'admin', outcome: 'not_configured', error_kind: error instanceof Error ? error.name : typeof error });
      return null;
    }
  };
  // 조립 때 한 번 읽는다 — 캐시를 데운다. 오류여도 기동은 한다(콘솔은 "결제 준비 중").
  await loadProvider();
  return { environment, enabled, loadProvider, prices: PADDLE_PRICE_PLANS[environment], sandboxAllowlist: BILLING_SANDBOX_ORG_ALLOWLIST };
}

export interface ComposedAdmin {
  readonly deps: AdminDependencies;
  readonly pool: Pool;
  /** 고객 도메인 제어면 포트(ADR-0014 · `src/domains/contract.ts`) — `domainControlInvokerOf` 가 고른다. */
  readonly domainControl: DomainControlInvoker;
}

export async function composeAdmin(platform: AdminPlatform): Promise<ComposedAdmin> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);
  requireRdsCaBundle(env);
  // custody 설정은 조립 때 확인한다(없으면 기동 거부) — 클라이언트는 부를 때 만든다.
  const cmk = requireEnv(env, RUNTIME_ENV.passportKmsKeyId);

  const loginRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.ownerLoginKeysSecretArn));
  if (isPlaceholderSecret(loginRaw)) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.ownerLoginKeysSecretArn} 가 아직 채워지지 않았다(placeholder). 배포 런북대로 키링을 넣어라.`);
  }
  const loginKeys = parseHmacKeyring(loginRaw, RUNTIME_ENV.ownerLoginKeysSecretArn);

  // 발신 본문 읽기(US-004) — 접두사 하나 · GetObject 하나. 버킷·계정이 없으면 기동 거부(fail-closed).
  const outboundContent = createObjectContentReader(
    createS3ObjectReader({
      client: platform.clients?.s3 ?? createS3Client(region),
      bucket: requireEnv(env, RUNTIME_ENV.mailBucket),
      expectedBucketOwner: accountIdFromFunctionArn(platform.invokedFunctionArn),
      prefix: OUTBOUND_CONTENT_PREFIX,
    }),
  );

  const billing = await composeAdminBilling(env, secrets, platform.clients?.paddleFetch, platform.clients?.clock);

  // 콘솔 웹훅 시크릿 — api λ 내부 이벤트(보안 M1). 설정이 없거나 틀리면 발급기 없이(등록·회전만 503 — 보안 L4).
  const apiFunctionArn = env[RUNTIME_ENV.apiFunctionArn];
  let webhookSecrets: AdminDependencies['webhookSecrets'];
  if (apiFunctionArn !== undefined && API_FUNCTION_ARN_PATTERN.test(apiFunctionArn)) {
    const issuer = createWebhookSecretIssuer({ client: platform.clients?.lambda ?? createLambdaInvokeClient(region), functionArn: apiFunctionArn });
    webhookSecrets = {
      activeKid: () => issuer.activeKid(),
      issue: (agentId, endpointId) => issuer.issue(agentId, endpointId),
      sealAuthorization: (target, authorization) => issuer.sealAuthorization(target, authorization),
    };
  } else {
    log('warn', 'runtime.webhook_secrets_unconfigured', { route_id: 'admin', outcome: apiFunctionArn === undefined ? 'missing' : 'malformed' });
  }

  const loginMailerArn = requireEnv(env, RUNTIME_ENV.loginMailerFunctionArn);
  if (!LOGIN_MAILER_FUNCTION_ARN_PATTERN.test(loginMailerArn)) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.loginMailerFunctionArn} 가 login-mailer 함수 ARN(한정자 없음)이 아니다.`);
  }
  const kickLoginMailer = createLoginMailerKicker({
    client: platform.clients?.lambda ?? createLambdaInvokeClient(region),
    functionArn: loginMailerArn,
  });

  // Domain Connect — 플래그가 켜져 있고 키 ARN 이 있을 때만(기본 끔 → `{supported:false}`). 켰는데 키가 없으면 기동 거부(조용히 꺼지지 않게).
  let domainConnect: AdminDependencies['domainConnect'];
  if (readFeatureFlag(env, RUNTIME_ENV.domainConnectEnabled)) {
    const keyArn = requireEnv(env, RUNTIME_ENV.domainConnectKeyArn);
    domainConnect = {
      discovery: createDomainConnectDiscovery(systemDiscoveryPorts()),
      signer: createKmsDcSigner(platform.clients?.dcKms ?? createDcKmsClient(region), keyArn),
    };
  }

  // 고객 도메인 즉시 실행(2026-10 one-shot) — domain-control 이 배선돼 있을 때만(없으면 추가 응답 `provision:'unavailable'` · 예약 틱이 잇는다).
  // 부를 때마다 틱 롤 풀을 열고 닫는다(`provisionNowOf`) — admin 롤로는 상태 칸을 쓰지 않는다(결정 12 · 보안 M2 그대로).
  const domainControlArn = env[RUNTIME_ENV.domainControlFunctionArn];
  const provisionNow = domainControlArn === undefined || domainControlArn === '' ? undefined : provisionNowOf(() => composeDomainTick(platform, { idleTimeoutMillis: PROVISION_IDLE_RELEASE_MS }));

  // ★ admin 롤(`atmark_admin`). 소유자 롤·앱 롤 비밀 ARN 은 읽지 않는다.
  const adminRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbAdminSecretArn));
  const credentials = parseDatabaseSecret(adminRaw, RUNTIME_ENV.dbAdminSecretArn);
  const pool = createPool(databaseUrlOf(credentials), { max: ADMIN_POOL_MAX, ssl: { rejectUnauthorized: true }, keepAlive: true });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'admin', error_kind: error.name });
  });

  // 실시간 힌트(묶음 E) — 콘솔 풀기 뒤 `message.received`(대상은 DB 가 정한다 — 보이는 메일 · 그 에이전트의 연결). 콜백 URL 이 없으면 없다.
  const realtime = realtimePusherOf(env, region, createPostgresRealtimeInboundTargets(pool), 'console_watch', platform.clients?.realtime);

  const deps: AdminDependencies = {
    pool,
    loginKeys,
    custody: () =>
      createAwsKeyCustody({
        kms: createKmsDataKeyGenerator(platform.clients?.kms ?? createKmsClient(region)),
        secrets: createAgentKeypairSecretCreator(platform.clients?.secretCreate ?? createSecretsManagerCreateClient(region)),
        cmkArn: cmk,
        secretNamePrefix: AGENT_KEYPAIR_SECRET_PREFIX,
      }),
    outboundContent,
    kickLoginMailer,
    now: () => new Date(),
    ...(billing === undefined ? {} : { billing }),
    ...(webhookSecrets === undefined ? {} : { webhookSecrets }),
    ...(domainConnect === undefined ? {} : { domainConnect }),
    ...(provisionNow === undefined ? {} : { provisionDomainNow: provisionNow }),
    ...(realtime === undefined ? {} : { realtime }),
    // 메일 기본기 2차 A6 — 별칭 API 단계 공개(기본 끔 · `true` · `orgs:<uuid>,…`).
    features: {
      addressAliases: readFeatureRollout(env, RUNTIME_ENV.addressAliasesEnabled),
      // 보안 리뷰 M3 — 새 코드 배포 뒤에 켠다(옛 로더는 null 정책을 읽지 못한다). 운영 명령 `pnpm admin:policy-attachment-default` 와 짝.
      policyAttachmentFollowPlan: readFeatureFlag(env, RUNTIME_ENV.policyAttachmentFollowPlan),
    },
  };
  return { deps, pool, domainControl: domainControlInvokerOf(env, platform.clients?.lambda ?? (() => createLambdaInvokeClient(region))) };
}

/**
 * domain-control 포트(ADR-0014 결정 3) — `ATMARK_DOMAIN_CONTROL_FUNCTION_ARN` 이 있으면 실제 호출 구현(한정자 없는 `atmark-domain-control` ARN 이
 * 아니면 기동 거부), 없으면 계획된 비활성 포트(부르면 던진다 — 틱은 아무것도 바꾸지 않고 끝난다).
 */
export function domainControlInvokerOf(env: NodeJS.ProcessEnv, client: LambdaInvokeClient | (() => LambdaInvokeClient)): DomainControlInvoker {
  const functionArn = env[RUNTIME_ENV.domainControlFunctionArn];
  if (functionArn === undefined || functionArn === '') return unavailableDomainControlInvoker;
  return createDomainControlInvoker({ client: typeof client === 'function' ? client() : client, functionArn });
}

/** 확인 틱 한 번의 의존성 — 틱 롤 풀(이 이벤트 전용) · domain-control 포트. 풀은 호출자가 `end()` 한다. */
export interface ComposedDomainTick {
  readonly pool: Pool & DomainPool;
  readonly invoker: DomainControlInvoker;
}

/**
 * `{task:'domain-recheck'}` 의 조립 — HTTP 조립(로그인 키 · S3 · 결제)을 거치지 않는다. 틱 롤 비밀이 자리표시면 기동 거부(롤이 아직 LOGIN 이 아니다 —
 * bootstrap-roles 를 먼저). admin 롤 비밀은 읽지 않는다(틱은 admin 롤로 상태를 바꿀 수 없다 — 보안 M2).
 */
export async function composeDomainTick(
  platform: Pick<AdminPlatform, 'env' | 'clients'>,
  options: { readonly idleTimeoutMillis?: number } = {},
): Promise<ComposedDomainTick> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  requireRdsCaBundle(env);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);
  const raw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbDomainTickSecretArn));
  if (isPlaceholderSecret(raw)) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.dbDomainTickSecretArn} 가 아직 채워지지 않았다(placeholder) — migrate bootstrap-roles 를 먼저.`);
  }
  const credentials = parseDatabaseSecret(raw, RUNTIME_ENV.dbDomainTickSecretArn);
  const invoker = domainControlInvokerOf(env, platform.clients?.lambda ?? (() => createLambdaInvokeClient(region)));
  const pool = createPool(databaseUrlOf(credentials), {
    max: DOMAIN_TICK_POOL_MAX,
    ssl: { rejectUnauthorized: true },
    keepAlive: false,
    ...(options.idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis: options.idleTimeoutMillis }),
  });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'domain-recheck', error_kind: error.name });
  });
  return { pool, invoker };
}

/**
 * 즉시 실행 풀의 유휴 연결 반납 시각(ms) — 틱 롤은 `CONNECTION LIMIT 1` 이라, 즉시 실행이 domain-control 호출(최대 8초)을 기다리는 동안 연결을 쥐고 있으면
 * 예약 틱이 53300 을 받는다(보안 리뷰 M2). DB 단계가 끝나 연결이 풀로 돌아오면 곧바로 닫아, 쥐는 시간을 DB 질의 동안으로 줄인다(호출 뒤 다시 연다 —
 * 그때 틱이 쥐고 있으면 `busy`, 예약 틱이 잇는다). 연속 질의는 같은 이벤트 루프 차례에 다시 빌려 가므로 이 타이머보다 먼저 재사용한다.
 */
export const PROVISION_IDLE_RELEASE_MS = 1;

/**
 * 즉시 실행 포트(계약 `ProvisionDomainNow`)의 조립 — 부를 때마다 틱 롤 풀(이 호출 전용)을 열어 `provisionDomainNow` 를 돌고 닫는다. 예약 틱과 겹치면
 * 틱 롤 `CONNECTION LIMIT 1` 이 53300 → `busy`(구현이 접는다). **던지지 않는다** — 조립 실패(자리표시 비밀 · 설정 없음)도 `unavailable` 로 접는다.
 */
export function provisionNowOf(compose: () => Promise<ComposedDomainTick>, now: () => Date = () => new Date()): ProvisionDomainNow {
  return async (rowId) => {
    let tick: ComposedDomainTick;
    try {
      tick = await compose();
    } catch (error) {
      log('warn', 'domain.provision_compose_failed', { route_id: 'admin', error_kind: error instanceof Error ? error.name : typeof error });
      return 'unavailable';
    }
    try {
      return await provisionDomainNow({ pool: tick.pool, invoker: tick.invoker, now }, rowId);
    } finally {
      await tick.pool.end().catch((error: unknown) => {
        log('warn', 'runtime.pool_end_failed', { route_id: 'admin', error_kind: error instanceof Error ? error.name : typeof error });
      });
    }
  };
}
