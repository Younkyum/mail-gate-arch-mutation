/**
 * src/runtime/composition.ts — **운영 조립 루트.** Lambda 핸들러가 쓰는 의존성을 여기서만 만든다.
 *
 * 규율:
 *
 *   - **전송단을 조립하는 프로덕션 파일은 이것 하나다.** Layer B(`test/arch/gate-chokepoint.arch.test.ts`)의
 *     허용목록에 **파일 이름으로** 올라 있다(와일드카드 아님). 여기서 만든 에이전트 전송단은 라우트·워커의
 *     `transport` 슬롯으로만 들어가고, 그 슬롯은 관문(`gateDependenciesFor` → `dispatch`)으로만 흐른다.
 *     이 파일은 전송단의 `send` 를 **부르지 않는다**(`test/unit/runtime/composition.test.ts` 가 AST 로 본다).
 *   - **로컬 개발 구현을 import 하지 않는다** — `local-object-store`·`custody-local`·메모리 본문 저장소·env 키링.
 *     운영에서 선택될 자리가 코드에 없다(같은 테스트가 import 폐포로 본다). 그리고 `ATMARK_ENV=production` 이므로
 *     누가 그것을 끌어오더라도 그 구현 자신의 가드가 던진다.
 *   - **비밀은 Secrets Manager 에서 조립 1회 읽는다.** 조립은 핸들러의 `memoize` 안에서 실행 환경당 한 번 돈다
 *     (콜드 스타트). 키 회전은 새 실행 환경에서 반영된다(배포 또는 환경 재활용).
 *   - **필요한 것만 요구한다.** 핸들러마다 조립 함수가 따로 있고, 각자 쓰는 변수·비밀만 읽는다. 하나라도 없으면
 *     던진다(fail-closed) — 쓰지도 않는 변수를 요구하면 D2 가 모든 함수에 모든 비밀 권한을 붙이게 된다.
 *
 * **DB 풀:** TLS 필수(`rejectUnauthorized: true`, 서버 인증서 + 호스트명 검증). RDS CA 는 Lambda 런타임의
 * `/var/runtime/ca-cert.pem` 을 `NODE_EXTRA_CA_CERTS` 로 싣는다(`config.ts` `RUNTIME_ENV.extraCaCerts`).
 * `max` 는 작게(`DB_POOL_MAX`): Lambda 한 실행 환경은 한 번에 요청 하나를 처리하지만, 관문의 조직 잠금이 커넥션
 * 하나를 쥔 채 같은 풀에서 평가 조회를 한다(`outbound-serializer.ts`) — 최소 2, 여유 1.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createPostgresAuditReader } from '../api/audit-reader';
import type { AgentEnroller } from './enroll-event';
import { createAgentEnroller, createLambdaInvokeClient, type LambdaInvokeClient } from './lambda-invoke';
import { createObjectContentStore, type MessageContentStore } from '../api/content-store';
import { createOutboundAttachmentService, loadAgentOrganizationId, loadAttachmentLimits, type OutboundAttachmentService } from '../api/outbound-attachments';
import { createPostgresOutboundMessageStore } from '../api/outbound-store';
import type { OutboundServiceDependencies } from '../api/outbound-service';
import { createPostgresSeedContactReader } from '../api/seed-contact-store';
import { createPool } from '../db/client';
import { createPostgresInboundWatchSource } from '../db/repositories/watch-settings-store';
import { createPostgresAgentSignupStore } from '../db/repositories/agent-signup-store';
import { createPostgresSelfEnrollStatus } from '../db/repositories/self-enroll-status';
import { createPostgresPolicyRequestStore } from '../db/repositories/policy-request-store';
import {
  createPostgresAgentTokenStore,
  createPostgresApprovalStore,
  createPostgresGateStores,
  createPostgresInboundPolicySource,
  createPostgresInboundReadStore,
  createPostgresInboundStore,
  createPostgresReplyTargetLookup,
  createPostgresScheduledSendStore,
  createPostgresSendingClock,
  createPostgresSesEventStore,
  createPostgresThreadLookup,
  createPostgresTrustFacts,
} from '../db/repositories';
import { createPostgresApprovalLinkPorts } from '../db/repositories/approval-link-use-store';
import { createPostgresInvitedUserErasure } from '../db/repositories/invited-user-erasure';
import { createPostgresOrgApiWindowRetention } from '../db/repositories/org-api-window-retention';
import { createPostgresSignupLinkRetention } from '../db/repositories/signup-link-retention';
import { createPostgresLoginCodeAttemptRetention } from '../db/repositories/login-code-attempt-retention';
import { createPostgresOpsRetention } from '../db/repositories/ops-retention';
import { createPostgresInjectionSignalRetention } from '../db/repositories/injection-signal-retention';
import { createPostgresComplaintHashRetention } from '../db/repositories/complaint-hash-retention';
import { createPostgresAiWatchInboundPort } from '../db/repositories/inbound-store';
import { AI_WATCH_RESULT_POOL_MAX, parseAiWatchMode } from '../inbound/ai-watch/contract';
import { createPostgresAiWatchResultStore } from '../db/repositories/ai-watch-result-store';
import type { AiWatchResultDependencies } from '../workers/ai-watch-result';
import type { InboundAiWatchDependencies } from '../workers/inbound-consumer';
import { createSqsStandardSender, type StandardQueueSender } from './sqs';
import { createPostgresSnippetRetention } from '../db/repositories/snippet-retention';
import { createPostgresDlpSignalStore } from '../db/repositories/dlp-signal-store';
import { createPostgresExposureRecorder } from '../db/repositories/exposure-store';
import { createPostgresRiskSignalSource } from '../db/repositories/risk-signal-store';
import { parseRiskHoldMode, type RiskHoldMode } from '../policy/risk-signals';
import { createPostgresWebhookOutbox } from '../db/repositories/webhook-store';
import {
  createSesClient,
  createSesTransport,
  SES_CONFIGURATION_SET,
  SES_REGION,
  type SesSendClient,
} from '../mail/transport/ses-transport';
import { createApprovalNotifier } from '../notify/approval-notifier';
import { createDomainNotifier } from '../notify/domain-notifier';
import { createQuarantineNotifier } from '../notify/quarantine-notifier';
import { createContactForwarder } from '../notify/contact-forwarder';
import { createContactDocumentReader, createPostgresContactIntake } from '../contact/contact-store';
import { createContactDestinationLoader } from '../contact/destination';
import { CONTACT_DOCUMENT_PREFIX } from '../contact/intake';
import { CONTACT_ROUTING_ENV, forwardsNotifyOnly, readContactRouting, type ContactRouting } from '../contact/routing';
import { log } from '../observability/logger';
import { parseHmacKeyring, type HmacKeyring } from '../security/hmac-keyring';
import { createInboundArtifactReader, createInboundArtifactStore, createInboundAttachmentReader } from '../storage/inbound-artifact-store';
import type { ObjectStore } from '../storage/object-store';
import { createRawMailStore } from '../storage/raw-mail-store';
import {
  createS3AttachmentClient,
  createS3Client,
  createS3DownloadSigner,
  createS3MalwareTagScanner,
  createS3ObjectReader,
  createS3ObjectStore,
  createS3OutboundAttachmentObjects,
  createS3UploadSigningClient,
  type S3AttachmentClient,
  type S3DownloadSignerOptions,
  type S3ObjectClient,
} from '../storage/s3-object-store';
import type { OutboundAttachmentObjects } from '../storage/object-store';
import { createPostgresOutboundAttachmentStore } from '../db/repositories/outbound-attachment-store';
import { createPostgresPdfParseSlots } from '../db/repositories/pdf-parse-slots';
import { createScheduledContentStore } from '../storage/scheduled-content-store';
import { createDraftContentStore } from '../storage/draft-content-store';
import { createPostgresDraftStore } from '../db/repositories/draft-store';
import { createPostgresMessageStateStore } from '../db/repositories/message-state-store';
import { createPinnedHttpsTransport, createSystemResolver } from '../webhooks/https-transport';
import type { ApprovalExpiryDependencies } from '../workers/approval-expiry';
import type { ApprovalNotifierWorkerDependencies } from '../workers/approval-notifier';
import type { DomainNotifierWorkerDependencies } from '../workers/domain-notifier';
import type { QuarantineNotifierWorkerDependencies } from '../workers/quarantine-notifier';
import type { ApprovalReleaseDependencies } from '../workers/approval-release';
import type { ContactForwarderWorkerDependencies } from '../workers/contact-forwarder';
import type { InboundConsumerDependencies } from '../workers/inbound-consumer';
import type { ScheduledSenderTickDependencies } from '../workers/scheduled-sender';
import type { SesEventConsumerDependencies } from '../workers/ses-event-consumer';
import type { WebhookDispatcherDependencies } from '../workers/webhook-dispatcher';
import {
  accountIdFromFunctionArn,
  databaseUrlOf,
  isPlaceholderSecret,
  parseDatabaseSecret,
  type DatabaseCredentials,
  requireEnv,
  requireEnvMatching,
  requireProductionRuntime,
  requireRdsCaBundle,
  readFeatureRollout,
  RUNTIME_ENV,
  RuntimeConfigError,
} from './config';
import { createPostgresIdentityDirectory } from '../passport/public-directory';
import { createHealthProbe } from './health';
import type { ApiDependencies } from './router';
import {
  createPostgresRealtimeApprovalTargets,
  createPostgresRealtimeConnectionRetention,
  createPostgresRealtimeConnectionStore,
  createPostgresRealtimeInboundTargets,
  createPostgresRealtimeJobTargets,
} from '../db/repositories/realtime-connection-store';
import { REALTIME_ENV, REALTIME_POOL_IDLE_MS, REALTIME_POOL_MAX } from '../realtime/contract';
import { realtimeUrlOf } from '../api/discovery';
import type { RealtimeGatewayDependencies } from '../realtime/gateway';
import type { RealtimePusher, RealtimeTargetStore, RealtimeTransport } from '../realtime/push';
import { realtimePusherOf } from './realtime-pusher';
import {
  ADMIN_ROLE,
  AI_WATCH_ROLE,
  APP_ROLE_NAME,
  BILLING_OPERATOR_ROLE,
  BILLING_ROLE,
  DOMAIN_TICK_ROLE,
  LOGIN_MAILER_ROLE,
  OPS_ROLE,
  OWNER_ROLE,
  PASSPORT_SIGNER_ROLE,
  TLOG_ANCHOR_ROLE,
  TLOG_ROLE,
} from './role-bootstrap';
import {
  createSecretReader,
  createSecretWriter,
  isSsmParameterName,
  legacySecretIdOf,
  SecretNotFoundError,
  type SecretReader,
  type SecretWriter,
} from './secrets';

/** AI 감시 결과 λ 풀의 유휴 연결 수명(ms). */
export const AI_WATCH_RESULT_POOL_IDLE_MS = 5_000;

/** 실행 환경당 풀 크기. 동시성 × 이 값 ≤ RDS 연결 한도(t4g.micro ≈ 80, 관리 연결 몇 개 제외). */
export const DB_POOL_MAX = 3;

/** 마이그레이션은 커넥션 하나로 순차 적용한다(`db/migrate.ts` — 파일 하나 = 트랜잭션 하나). */
export const MIGRATION_POOL_MAX = 1;

/**
 * lease TTL(초) — `scripts/demo-p1c.ts` 의 "프로덕션 값" 과 같다. 워커 최대 실행시간(Lambda 타임아웃)보다 길어야
 * 한다: 짧으면 아직 도는 잡을 다른 호출이 다시 집는다. API(≤ 30초 통합 타임아웃)·스케줄 워커(≤ 수 분) 모두 아래.
 */
export const LEASE_TTL_SECONDS = 300;

/** AWS 클라이언트. 생략하면 실제 클라이언트를 만든다 — **테스트만 채운다**(가짜 SDK, AWS 호출 0). */
export interface RuntimeClients {
  readonly secrets: SecretReader;
  /** migrate 의 `bootstrap-roles` 만 받는다. */
  readonly secretWriter: SecretWriter;
  readonly s3: S3ObjectClient;
  /** 발신 첨부(A2) — 머리·범위 읽기·복사·태그. 생략하면 실제 클라이언트. */
  readonly s3Attachments: S3AttachmentClient;
  readonly ses: SesSendClient;
  /** AI 감시 요청 큐(inbound λ 만). 생략하면 실제 SQS — 테스트는 가짜를 준다. */
  readonly aiWatchQueue: StandardQueueSender;
  /** 자가 등록 admin λ 호출(api λ 만 — ADR-0016 2026-10-08). 생략하면 실제 Lambda 클라이언트. */
  readonly lambda: LambdaInvokeClient;
  /** 실시간 `PostToConnection`(묶음 E — 만드는 λ). 생략하면 실제 API Gateway(콜백 URL 이 있을 때만) — 테스트는 가짜를 준다. */
  readonly realtime: RealtimeTransport;
}

export interface RuntimePlatform {
  readonly env: NodeJS.ProcessEnv;
  /** Lambda 컨텍스트의 호출 ARN — 버킷 소유 계정(`ExpectedBucketOwner`)을 여기서 읽는다(`config.ts`). */
  readonly invokedFunctionArn: string;
  readonly clients?: Partial<RuntimeClients>;
}

/** 조립 결과. `pool` 은 핸들러가 재사용하고 테스트가 닫는다. */
export interface Composed<T> {
  readonly deps: T;
  readonly pool: Pool;
}

// ---------------------------------------------------------------------------
// 공통 부품
// ---------------------------------------------------------------------------

interface Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly region: string;
  readonly platform: RuntimePlatform;
  readonly secrets: SecretReader;
}

/** 모든 조립의 첫 줄 — 운영 판정·평문 비밀 부재·리전. 비밀 클라이언트는 하나(만들기만 해서는 네트워크를 타지 않는다). */
function runtimeOf(platform: RuntimePlatform): Runtime {
  requireProductionRuntime(platform.env);
  const region = requireEnv(platform.env, RUNTIME_ENV.region);
  return { env: platform.env, region, platform, secrets: platform.clients?.secrets ?? createSecretReader(region) };
}

function s3Of(runtime: Runtime): S3ObjectClient {
  return runtime.platform.clients?.s3 ?? createS3Client(runtime.region);
}

/** admin 자가 등록 **별칭** ARN 모양 — `atmark-admin:enroll` 하나(compute-stack 의 IAM 문장과 같은 ARN — 한정자 없는 함수는 받지 않는다). */
const ADMIN_FUNCTION_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:atmark-admin:enroll$/;

/**
 * 자가 등록 호출(api λ → admin λ, ADR-0016 2026-10-08 · `runtime/enroll-event.ts`). 변수가 없거나 모양이 틀리면 `null` — 자가 등록만 503 이고 나머지는 그대로다
 * (로그 한 줄).
 */
function agentEnrollerOf(runtime: Runtime): AgentEnroller | null {
  const arn = runtime.env[RUNTIME_ENV.adminFunctionArn];
  if (arn === undefined || !ADMIN_FUNCTION_ARN_PATTERN.test(arn)) {
    log('warn', 'runtime.agent_enroll_unconfigured', { route_id: 'api', outcome: arn === undefined ? 'missing' : 'malformed' });
    return null;
  }
  return createAgentEnroller({ client: runtime.platform.clients?.lambda ?? createLambdaInvokeClient(runtime.region), functionArn: arn });
}

/** SES 는 수신 리전과 같은 리전으로 고정이다(`SES_REGION` — DKIM·Configuration Set 이 그 리전에 있다). */
function sesOf(runtime: Runtime): SesSendClient {
  return runtime.platform.clients?.ses ?? createSesClient(SES_REGION);
}

function runtimeRealtimePusher(runtime: Runtime, targets: RealtimeTargetStore, routeId: string): RealtimePusher | undefined {
  return realtimePusherOf(runtime.env, runtime.region, targets, routeId, runtime.platform.clients?.realtime);
}

/** 비밀 ARN 변수 이름 → 비밀 문자열. */
async function readSecret(runtime: Runtime, arnVariable: string): Promise<string> {
  const arn = requireEnv(runtime.env, arnVariable);
  return runtime.secrets.readSecretString(arn);
}

async function readKeyring(runtime: Runtime, arnVariable: string): Promise<HmacKeyring> {
  const raw = await readSecret(runtime, arnVariable);
  if (isPlaceholderSecret(raw)) {
    throw new RuntimeConfigError(`${arnVariable} 가 아직 채워지지 않았다(placeholder). 배포 런북대로 키링을 넣어라.`);
  }
  // 형식 규칙(kid·32바이트 이상·정규 base64url)은 `security/hmac-keyring.ts` 하나다. 오류 메시지에 키가 없다.
  return parseHmacKeyring(raw, arnVariable);
}

/**
 * 발신 DLP 지문 키(ADR-0016 B — `atmark/dlp-keys`). CloudFormation 이 만든 첫 값은 64자 영숫자 하나(kid 없음)라 `g1` 로 읽는다 — 회전은 운영자가
 * 키 묶음 형식(`k2:<새 키>,g1:<옛 값>`)으로 넣는다(옛 키는 30일 이상 남긴다 — 복사 지문 보존, ADR-0016 키링 운영 계약).
 */
async function readDlpKeyring(runtime: Runtime): Promise<HmacKeyring> {
  const raw = (await readSecret(runtime, RUNTIME_ENV.dlpKeysSecretArn)).trim();
  if (isPlaceholderSecret(raw)) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.dlpKeysSecretArn} 가 아직 채워지지 않았다(placeholder).`);
  }
  return parseHmacKeyring(/^[A-Za-z0-9]{64}$/.test(raw) ? `g1:${raw}` : raw, RUNTIME_ENV.dlpKeysSecretArn);
}

/**
 * 위험 보류 킬 스위치(`ATMARK_RISK_HOLD_ENFORCE`) — 운영자 env 만. 틀린 값은 `enforce`(fail closed) + 기동 경고 한 줄(값은 싣지 않는다).
 */
function riskHoldModeOf(env: NodeJS.ProcessEnv): RiskHoldMode {
  const { mode, invalid } = parseRiskHoldMode(env[RUNTIME_ENV.riskHoldEnforce]);
  if (invalid) log('warn', 'runtime.feature_flag_invalid', { detail: RUNTIME_ENV.riskHoldEnforce, reason: 'unknown_mode', outcome: mode });
  return mode;
}

/**
 * 격리 알림 킬 스위치(`ATMARK_QUARANTINE_NOTICE`) — 운영자 env 만. 없으면 켜짐, `off` 면 꺼짐. 틀린 값은 켜짐 + 기동 경고 한 줄(값은 싣지 않는다).
 */
function quarantineNoticeEnabledOf(env: NodeJS.ProcessEnv): boolean {
  const raw = env[RUNTIME_ENV.quarantineNotice];
  if (raw === undefined || raw === '' || raw === 'on') return true;
  if (raw === 'off') return false;
  log('warn', 'runtime.feature_flag_invalid', { detail: RUNTIME_ENV.quarantineNotice, reason: 'unknown_mode', outcome: 'on' });
  return true;
}

/**
 * DB 풀. **TLS 필수** — `ssl.rejectUnauthorized: true` 는 인증서 체인과 호스트명을 둘 다 검증한다.
 * 만들기만 하고 접속하지 않는다(첫 쿼리에서 붙는다). 유휴 커넥션 오류는 로그로 삼킨다: 리스너가 없으면 pg 가
 * `error` 이벤트를 던져 **실행 환경이 죽는다**(Lambda 동결·해동 사이에 서버가 끊은 유휴 소켓이 흔한 원인이다).
 */
async function openPool(runtime: Runtime, secretVariable: string, max: number, idleTimeoutMillis?: number): Promise<Pool> {
  requireRdsCaBundle(runtime.env);
  return poolFor(parseDatabaseSecret(await readSecret(runtime, secretVariable), secretVariable), max, idleTimeoutMillis);
}

function poolFor(credentials: DatabaseCredentials, max: number, idleTimeoutMillis?: number): Pool {
  const pool = createPool(databaseUrlOf(credentials), {
    max,
    ssl: { rejectUnauthorized: true },
    keepAlive: true,
    ...(idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis }),
  });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'runtime', error_kind: error.name });
  });
  return pool;
}

/** 메일 버킷. `ExpectedBucketOwner` = 이 함수가 도는 계정. SSE-S3(`storage-stack.ts` 가 `S3_MANAGED`). */
function mailObjects(runtime: Runtime, client: S3ObjectClient = s3Of(runtime)): ObjectStore {
  return createS3ObjectStore({
    client,
    bucket: requireEnv(runtime.env, RUNTIME_ENV.mailBucket),
    expectedBucketOwner: accountIdFromFunctionArn(runtime.platform.invokedFunctionArn),
    encryption: { kind: 'sse-s3' },
  });
}

/** Configuration Set — 설정이 아니라 대조다(`config.ts` `requireEnvMatching`). 알림 전송단은 상수를 쓴다. */
function configurationSetOf(runtime: Runtime): string {
  return requireEnvMatching(runtime.env, RUNTIME_ENV.sesConfigurationSet, SES_CONFIGURATION_SET);
}

/**
 * 발신 첨부 서비스(메일 기본기 2차 A2). **스위치와 무관하게 조립한다** — 꺼져 있으면 업로드 404·발송의 `attachments` 400 이지만, 이미 결속된
 * 첨부(승인 대기)의 릴리스는 영구본 읽기가 필요하다. 네트워크는 부를 때만(클라이언트 생성은 호출이 아니다).
 */
function attachmentsOf(runtime: Runtime, pool: Pool): { readonly service: OutboundAttachmentService; readonly objects: OutboundAttachmentObjects } {
  const bucket = requireEnv(runtime.env, RUNTIME_ENV.mailBucket);
  const expectedBucketOwner = accountIdFromFunctionArn(runtime.platform.invokedFunctionArn);
  const client = runtime.platform.clients?.s3Attachments ?? createS3AttachmentClient(runtime.region);
  const objects = createS3OutboundAttachmentObjects({ signingClient: createS3UploadSigningClient(runtime.region), client, bucket, expectedBucketOwner });
  const service = createOutboundAttachmentService({
    enabled: readFeatureRollout(runtime.env, RUNTIME_ENV.outboundAttachmentsEnabled),
    organizationOf: (agentId) => loadAgentOrganizationId(pool, agentId),
    store: createPostgresOutboundAttachmentStore(pool),
    objects,
    scanner: createS3MalwareTagScanner({ client, bucket, expectedBucketOwner }),
    limitsFor: (agentId, now) => loadAttachmentLimits(pool, agentId, now),
  });
  return { service, objects };
}

function outboundServiceOf(
  runtime: Runtime,
  pool: Pool,
  content: MessageContentStore,
  dlpKeys: HmacKeyring,
  attachments?: OutboundAttachmentService,
): OutboundServiceDependencies {
  const gate = createPostgresGateStores(pool);
  return {
    // ADR-0016 — 위험 신호(별도 포트 · 운영자 킬 스위치)와 발신 DLP. 발송 서비스 타입이 둘 다 요구한다.
    riskSignals: createPostgresRiskSignalSource(pool, { mode: riskHoldModeOf(runtime.env) }),
    dlp: { keyring: dlpKeys, signals: createPostgresDlpSignalStore(pool) },
    source: gate.source,
    audit: gate.audit,
    dispatchStore: gate.leases,
    serializer: gate.serializer,
    sendEvidence: gate.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content,
    leaseTtlSeconds: LEASE_TTL_SECONDS,
    now: () => new Date(),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

/** 에이전트 메일 전송단 — **관문으로만 흐르는 슬롯에 넣는다.** 여기서 부르지 않는다. */
function agentTransportOf(runtime: Runtime, pool: Pool, content: MessageContentStore, configurationSet: string) {
  return createSesTransport({
    client: sesOf(runtime),
    content,
    sendingClock: createPostgresSendingClock(pool),
    configurationSet,
  });
}

/** 풀을 연 뒤의 조립이 던지면 풀을 닫고 다시 던진다 — 반쯤 조립된 실행 환경이 커넥션을 쥐고 남지 않게. */
async function withPool<T>(pool: Pool, build: () => T | Promise<T>): Promise<Composed<T>> {
  try {
    return { deps: await build(), pool };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 핸들러별 조립
// ---------------------------------------------------------------------------

/** `handlers/api.ts` — HTTP API 전부. */
export async function composeApi(platform: RuntimePlatform): Promise<Composed<ApiDependencies>> {
  const runtime = runtimeOf(platform);
  const configurationSet = configurationSetOf(runtime);
  const s3 = s3Of(runtime);
  const objects = mailObjects(runtime, s3);
  const linkKeys = await readKeyring(runtime, RUNTIME_ENV.approvalLinkKeysSecretArn);
  const webhookKeys = await readKeyring(runtime, RUNTIME_ENV.webhookSecretKeysSecretArn);
  const dlpKeys = await readDlpKeyring(runtime);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);

  return withPool(pool, () => {
    const now = (): Date => new Date();
    const tokens = createPostgresAgentTokenStore(pool);
    const attachments = attachmentsOf(runtime, pool);
    const content = createObjectContentStore(objects, attachments.objects);
    const service = outboundServiceOf(runtime, pool, content, dlpKeys, attachments.service);
    const transport = agentTransportOf(runtime, pool, content, configurationSet);
    const artifacts = createInboundArtifactReader(objects);
    const inbound = createPostgresInboundReadStore(pool);
    const approvals = createPostgresApprovalStore(pool);
    // ADR-0016 A — 읽기 라우트는 본문을 돌려주기 전에 노출을 기록한다(실패 503). 첨부 텍스트 보류도 같은 킬 스위치를 따른다.
    // 묶음 B — 받은 메일의 라벨 · 읽음 · 응답 `risk` 재료(보이는 메일만).
    const messageState = createPostgresMessageStateStore(pool);
    const inboundRead = {
      tokens,
      inbound,
      artifacts,
      now,
      exposures: createPostgresExposureRecorder(pool, { keyring: dlpKeys }),
      riskHoldMode: riskHoldModeOf(runtime.env),
      messageState,
    };
    const replyTargets = createPostgresReplyTargetLookup(pool);
    const realtimeUrl = realtimeUrlOf(runtime.env[REALTIME_ENV.publicUrl]);
    // 실시간(묶음 E) — 승인 결과 힌트(대상 = 승인 요청의 에이전트의 열린 연결, DB 가 정한다).
    const approvalPusher = runtimeRealtimePusher(runtime, createPostgresRealtimeApprovalTargets(pool), 'approval_link');
    // 묶음 B — 초안(행 + 본문 객체 `outbound/drafts/`). 보내기는 send · reply 와 같은 서비스 · 전송단(관문).
    const drafts = createPostgresDraftStore(pool);
    const draftContent = createDraftContentStore(objects);
    const schedules = {
      tokens,
      schedules: createPostgresScheduledSendStore(pool),
      content: createScheduledContentStore(objects),
      now,
      // ADR-0016 리뷰 H1 — 예약 생성 때 위험 고정(발송 서비스와 같은 위험 신호 포트 · 발신 DLP).
      risk: service,
    };
    const enrollStatus = createPostgresSelfEnrollStatus(pool);
    const deps: ApiDependencies = {
      send: { tokens, service, transport },
      reply: { tokens, service, transport, replyTargets, artifacts },
      forward: { tokens, service, transport, inbound, artifacts },
      transitionAnnouncement: { tokens, service, seeds: createPostgresSeedContactReader(pool) },
      audit: { tokens, audit: createPostgresAuditReader(pool), now },
      approvalLink: {
        ports: createPostgresApprovalLinkPorts(pool, {
          keyring: linkKeys,
          // 승인 전이 트리거가 같은 트랜잭션에서 `approval_releases` 일정을 만든다(마이그레이션 2300). 릴리스는
          // 1분 주기 스윕(`handlers/approval-release.ts`)이 집는다 — API 함수는 SES 로 보내지 않는다.
          onApproved: (approvalId) => {
            log('info', 'approval.release_scheduled', { route_id: 'approval_link', approval_id: approvalId });
            return Promise.resolve();
          },
          // 실시간 `approval.resolved`(묶음 E) — 커밋 뒤 · 던지지 않는다 · 1초 상한.
          ...(approvalPusher === undefined ? {} : { onResolved: (approvalId: string) => approvalPusher.approvalResolved(approvalId) }),
        }),
        now,
      },
      approvals: { tokens, approvals, now },
      agentPolicy: {
        tokens,
        policies: service.source,
        inboundPolicies: createPostgresInboundPolicySource(pool),
        now,
        selfEnroll: enrollStatus,
        // 묶음 E — 실시간 접속 주소(CDK 가 넣는다 — 커스텀 도메인 전에는 execute-api `wss://` 주소). 모양이 틀리면 정본 호스트.
        realtimeUrl,
      },
      agentEnroll: { tokens, enroll: agentEnrollerOf(runtime), now, requestId: () => randomUUID(), precheck: (agentId) => enrollStatus.precheck(agentId) },
      // 정책 변경 요청(ADR-0007 2026-10-13) — 앱 롤 정의자 하나로 만든다(표 쓰기 0). 바꾸는 것은 콘솔의 소유자 승인이다.
      policyRequests: { tokens, policyRequests: createPostgresPolicyRequestStore(pool), now },
      discovery: { realtimeUrl },
      webhookEndpoints: { tokens, db: pool, keyring: webhookKeys, now },
      inboundRead,
      attachments: {
        ...inboundRead,
        // presigner 는 `S3Client` 전체를 받는다(자격증명·리전으로 **로컬에서** 서명한다). `createS3Client` 가 돌려주는
        // 값이 바로 그 `S3Client` 다 — 여기서 `@aws-sdk/client-s3` 를 import 할 수 없으므로(Layer A 계열 격리) 타입만 좁혀 넘긴다.
        signer: createS3DownloadSigner({
          client: s3 as unknown as S3DownloadSignerOptions['client'],
          bucket: requireEnv(runtime.env, RUNTIME_ENV.mailBucket),
        }),
        // 첨부 내용 조회(`…/content`) — 같은 메일 객체 저장소, 수신 첨부 접두사만(읽기 권한은 이미 있다 — 다운로드 URL 서명과 같은 접두사).
        contents: createInboundAttachmentReader(objects),
        // PDF 해석 함대 칸(2) — 같은 풀에서 전용 연결 하나를 해석 동안만 쥔다(λ 인스턴스는 요청을 하나씩 받는다 — 풀 3 이면 넉넉하다).
        pdfSlots: createPostgresPdfParseSlots(pool),
      },
      scheduledMessages: schedules,
      // 메일 기본기 1차 — 예약 조회·취소는 생성과 **같은** 저장소·본문 객체를 쓴다(C0 조립, 본문은 W2).
      scheduledQueries: schedules,
      // 인증코드 조회(A1)는 수신 조회와 같은 칸 — `visibleToAgent` 를 거치는 저장소로만 읽는다(W1).
      verificationCode: inboundRead,
      // 웹훅 전달 목록·재전송(A4) — 등록과 같은 풀·토큰(W3).
      webhookDeliveries: { tokens, db: pool, now },
      outboundAttachments: { tokens, attachments: attachments.service, now },
      drafts: { tokens, drafts, content: draftContent, replyTargets, now },
      draftSend: { tokens, service, transport, drafts, draftContent, replyTargets, artifacts },
      labels: { tokens, messageState, now },
      identity: { directory: createPostgresIdentityDirectory(pool) },
      health: createHealthProbe(pool),
    };
    return deps;
  });
}

/**
 * 문의 라우팅(`ATMARK_CONTACT_ROUTING` — `src/contact/routing.ts`). 틀린 값은 기동을 거부하지 않고 `forward`(지금 운영)로 읽고 경고 한 줄 —
 * `readFeatureRollout` 과 같은 규율(값은 싣지 않는다). 합성은 같은 표로 던진다.
 */
function contactRoutingOf(env: NodeJS.ProcessEnv): ContactRouting {
  const { mode, invalid } = readContactRouting(env);
  if (invalid) log('warn', 'runtime.feature_flag_invalid', { detail: CONTACT_ROUTING_ENV, reason: 'unknown_mode', outcome: mode });
  return mode;
}

/**
 * AI 의심 메일 감시 킬 스위치(`ATMARK_AI_WATCH` — ADR-0017 초안). **이 env 를 읽는 곳은 여기 하나다**(arch `ai-watch-boundary` ⑤). 없거나 모르는 값은
 * `off`(+ 경고 한 줄 — fail closed = 감시 안 함). `off` 가 아닌데 요청 큐 URL 이 없으면 역시 `off` + 경고(작업을 만들고 보낼 곳이 없으면 보류만
 * 남는다). 결과는 inbound 소비자의 선택 의존성 — `undefined` = 꺼짐.
 */
function aiWatchOf(runtime: Runtime, pool: Pool): InboundAiWatchDependencies | undefined {
  const { mode, valid } = parseAiWatchMode(runtime.env[RUNTIME_ENV.aiWatchMode]);
  if (!valid) log('warn', 'runtime.feature_flag_invalid', { detail: RUNTIME_ENV.aiWatchMode, reason: 'unknown_mode', outcome: mode });
  if (mode === 'off') return undefined;
  const queueUrl = (runtime.env[RUNTIME_ENV.aiWatchRequestQueueUrl] ?? '').trim();
  if (queueUrl === '') {
    log('warn', 'runtime.feature_flag_invalid', { detail: RUNTIME_ENV.aiWatchRequestQueueUrl, reason: 'missing', outcome: 'off' });
    return undefined;
  }
  return {
    mode,
    store: createPostgresAiWatchInboundPort(pool),
    queue: runtime.platform.clients?.aiWatchQueue ?? createSqsStandardSender(runtime.region, queueUrl),
  };
}

/** `handlers/inbound.ts` — SES 수신 알림 소비자. 보내지 않는다(SES 클라이언트 없음). */
export async function composeInboundConsumer(platform: RuntimePlatform): Promise<Composed<InboundConsumerDependencies>> {
  const runtime = runtimeOf(platform);
  const objects = mailObjects(runtime);
  const dlpKeys = await readDlpKeyring(runtime);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => {
    const contactRouting = contactRoutingOf(runtime.env);
    // 실시간 힌트(묶음 E) — 콜백 URL 이 없으면 키가 없다(밀지 않는다).
    const realtime = runtimeRealtimePusher(runtime, createPostgresRealtimeInboundTargets(pool), 'inbound_consumer');
    // AI 의심 메일 감시(ADR-0017 초안 · 경고 전용) — 꺼져 있으면 키가 없다.
    const aiWatch = aiWatchOf(runtime, pool);
    return {
      // ADR-0016 B — 받은 메일의 복사 지문(메일 행과 같은 트랜잭션).
      dlpKeys,
      receipts: createPostgresInboundStore(pool),
      threads: createPostgresThreadLookup(pool),
      rawMail: createRawMailStore(objects),
      artifacts: createInboundArtifactStore(objects),
      trust: createPostgresTrustFacts(pool),
      inboundPolicy: createPostgresInboundPolicySource(pool),
      // 받기 등급(ADR-0016 2026-10-08) — 감시 탭 설정(위험 처리 · 신뢰 발신자). 앱 롤은 읽기만.
      watch: createPostgresInboundWatchSource(pool),
      signups: createPostgresAgentSignupStore(pool),
      // US-009 — `support@atmark.ai` 문의의 outbox·문서(S3 `contact/forward/`). 보내지 않는다(SES 클라이언트 없음).
      contact: createPostgresContactIntake(pool, objects),
      contactRouting,
      ...(realtime === undefined ? {} : { realtime }),
      ...(aiWatch === undefined ? {} : { aiWatch }),
    };
  });
}

/**
 * `handlers/ai-watch-result.ts` — AI 의심 메일 감시 결과 소비자(ADR-0017 초안 · 경고 전용). **롤 `atmark_ai_watch`**(정의 함수 둘 EXECUTE 만,
 * `atmark/db/ai-watch`) — 앱 롤 비밀을 읽지 않는다. SES·S3 클라이언트 없음.
 */
export async function composeAiWatchResult(platform: RuntimePlatform): Promise<Composed<AiWatchResultDependencies>> {
  const runtime = runtimeOf(platform);
  // 롤 CONNECTION LIMIT 1(보안 리뷰 L10) — 유휴 연결을 오래 쥐지 않는다(새 실행 환경이 53300 으로 막히지 않게). 결과는 분에 한 번(하트비트) 이상 온다.
  const pool = await openPool(runtime, RUNTIME_ENV.dbAiWatchSecretArn, AI_WATCH_RESULT_POOL_MAX, AI_WATCH_RESULT_POOL_IDLE_MS);
  return withPool(pool, () => {
    // 실시간 힌트(묶음 E) — 판정이 보류를 풀면 그 작업의 메일(대상은 `atmark_realtime_job_targets` 가 정한다).
    const realtime = runtimeRealtimePusher(runtime, createPostgresRealtimeJobTargets(pool), 'ai_watch_result');
    return { store: createPostgresAiWatchResultStore(pool), ...(realtime === undefined ? {} : { realtime }) };
  });
}

/** `handlers/ses-events.ts` — 발송 결과 이벤트 소비자. DB 만. */
export async function composeSesEventConsumer(platform: RuntimePlatform): Promise<Composed<SesEventConsumerDependencies>> {
  const runtime = runtimeOf(platform);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => ({ events: createPostgresSesEventStore(pool), now: () => new Date() }));
}

/** `handlers/approval-release.ts` — 승인된 요청의 발송. **실제 전송단**이다(관문을 다시 지난다). */
export async function composeApprovalRelease(platform: RuntimePlatform): Promise<Composed<ApprovalReleaseDependencies>> {
  const runtime = runtimeOf(platform);
  const configurationSet = configurationSetOf(runtime);
  const objects = mailObjects(runtime);
  const dlpKeys = await readDlpKeyring(runtime);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => {
    // 첨부가 결속된 승인 대기 메일 — 영구본을 읽어 체크섬을 대조한 뒤 보낸다(스위치와 무관).
    const attachments = attachmentsOf(runtime, pool);
    const content = createObjectContentStore(objects, attachments.objects);
    return {
      service: outboundServiceOf(runtime, pool, content, dlpKeys, attachments.service),
      approvals: createPostgresApprovalStore(pool),
      transport: agentTransportOf(runtime, pool, content, configurationSet),
    };
  });
}

/**
 * `handlers/approval-notifier.ts` — 소유자 승인 알림(시스템 메일 범주). 전송단은 알림 모듈 안에서 알림면만 만든다.
 * **로그인 키를 읽지 않는다** — 소유자 로그인 메일은 전용 Lambda(`handlers/login-mailer.ts`, 조립은
 * `login-mailer-composition.ts`)가 보낸다. 이 Lambda 는 api 와 역할을 공유하므로 여기서 로그인 키를 읽으면 api 탈취가
 * 곧 소유자 세션이 된다(ADR-0006).
 */
export async function composeApprovalNotifier(
  platform: RuntimePlatform,
): Promise<Composed<ApprovalNotifierLambdaDependencies>> {
  const runtime = runtimeOf(platform);
  // 알림 전송단은 Configuration Set 을 **상수로** 쓴다 — 여기서는 배포가 같은 값을 가리키는지만 본다.
  // 승인 링크 호스트는 `notify/approval-notifier.ts` 의 상수다(주입 불가 — T2). 환경 변수로 넘기지도 대조하지도 않는다.
  configurationSetOf(runtime);
  const keyring = await readKeyring(runtime, RUNTIME_ENV.approvalLinkKeysSecretArn);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => {
    const now = (): Date => new Date();
    const client = sesOf(runtime);
    // 고객 도메인 알림(ADR-0014 M3b) · 격리 알림(ADR-0016 2026-10-07) — 같은 Lambda · 같은 발송 역할 · 같은 앱 롤 풀. 알림기는 SES 호출면만 받는다
    //   (수신자는 DB 정의자 함수). 격리 알림은 킬 스위치가 꺼져 있으면 싣지 않는다(`null`).
    return {
      db: pool,
      notifier: createApprovalNotifier({ pool, client, keyring, now }),
      now,
      domainNotices: { db: pool, notifier: createDomainNotifier({ pool, client, now }), now },
      quarantineNotices: quarantineNoticeEnabledOf(runtime.env) ? { db: pool, notifier: createQuarantineNotifier({ pool, client, now }), now } : null,
    };
  });
}

/** 승인 알림 Lambda 의 의존성 — 승인 알림 워커 + 고객 도메인 알림 워커(ADR-0014 M3b) + 격리 알림 워커(ADR-0016 — 꺼지면 `null`). 같은 1분 틱. */
export type ApprovalNotifierLambdaDependencies = ApprovalNotifierWorkerDependencies & {
  readonly domainNotices: DomainNotifierWorkerDependencies;
  readonly quarantineNotices: QuarantineNotifierWorkerDependencies | null;
};

/**
 * 문의 전달 Lambda 의 풀 — 1. 1분 틱에 순차 처리하고(예약 동시성 1), RDS 연결 예산(합 ≤ 75)을 지킨다.
 */
export const CONTACT_FORWARDER_POOL_MAX = 1;

/**
 * `handlers/contact-forwarder.ts` — 문의 전달 outbox 배출(US-009, ADR-0009). 시스템 메일 모듈에 SES **클라이언트**만 준다.
 * 전달 주소는 비밀에서 **로더**로 넘긴다 — 조립 시점에 읽지 않는다: 자리값이면 조립이 던지는 대신 틱마다 `unconfigured` 로 멈추고,
 * 운영자가 값을 넣으면 실행 환경을 재활용하지 않아도 다음 틱부터 나간다(`src/contact/destination.ts`).
 */
export async function composeContactForwarder(
  platform: RuntimePlatform,
): Promise<Composed<ContactForwarderWorkerDependencies>> {
  const runtime = runtimeOf(platform);
  // 전송면은 Configuration Set 을 상수로 쓴다 — 여기서는 배포가 같은 값을 가리키는지만 본다.
  configurationSetOf(runtime);
  const destinationArn = requireEnv(runtime.env, RUNTIME_ENV.contactForwardToSecretArn);
  // 쓰기 면이 없는 리더 — 접두사 `contact/forward/` 하나(IAM 도 같은 접두사 GetObject 하나, 이 함수에만).
  const documents = createS3ObjectReader({
    client: s3Of(runtime),
    bucket: requireEnv(runtime.env, RUNTIME_ENV.mailBucket),
    expectedBucketOwner: accountIdFromFunctionArn(runtime.platform.invokedFunctionArn),
    prefix: CONTACT_DOCUMENT_PREFIX,
  });
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, CONTACT_FORWARDER_POOL_MAX);
  return withPool(pool, () => {
    const now = (): Date => new Date();
    const forwarder = createContactForwarder({
      pool,
      client: sesOf(runtime),
      documents: createContactDocumentReader(documents),
      destination: createContactDestinationLoader(() => runtime.secrets.readSecretString(destinationArn)),
      now,
      // `agent_and_notify` 면 알림만(제목 + 보낸 사람 도메인 — 본문·Reply-To 없음). inbound 와 같은 환경 값이다.
      notifyOnly: forwardsNotifyOnly(contactRoutingOf(runtime.env)),
    });
    return { db: pool, forwarder, now };
  });
}

/** `handlers/approval-expiry.ts` — TTL 스윕. 보내지 않는다. */
export async function composeApprovalExpiry(platform: RuntimePlatform): Promise<Composed<ApprovalExpiryDependencies>> {
  const runtime = runtimeOf(platform);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => ({
    approvals: createPostgresApprovalStore(pool),
    // 발신 스니펫 보존 스윕(검증 F3) — 같은 앱 롤 풀. 쓰기는 `messages.snippet` → NULL(365일 넘은 행)뿐(202609241700).
    snippets: createPostgresSnippetRetention(pool),
    // `/org-api` 창 행 보존(ADR-0010 L5, 202609250200) — 같은 앱 롤 풀. 권한은 보존 함수 EXECUTE 하나(표 권한 0).
    orgApiWindows: createPostgresOrgApiWindowRetention(pool),
    // 코드 verify 시도 원장 보존(2026-09-28 L3, 202609280102) — 같은 앱 롤 풀. 권한은 보존 함수 EXECUTE 하나(표 권한 0).
    loginCodeAttempts: createPostgresLoginCodeAttemptRetention(pool),
    // 호스팅 운영자 콘솔(202609290500) — 같은 앱 롤 풀. 권한은 보존·만료·census 함수 셋 EXECUTE(ops 표 권한 0, I-6).
    ops: createPostgresOpsRetention(pool),
    // 인젝션 구조 방어 신호 보존(202610041000) — 같은 앱 롤 풀. 권한은 보존 함수 EXECUTE 하나(세 표의 DELETE 0).
    injectionSignals: createPostgresInjectionSignalRetention(pool),
    // 신고자 해시 보존(202610131612 · 재검증 I-1) — 같은 앱 롤 풀. 권한은 보존 함수 EXECUTE 하나(ses_events UPDATE 0).
    complaintHashes: createPostgresComplaintHashRetention(pool),
    // 초대만 받은 사용자 주소 지우기(ADR-0010 L7, 202609250220) — 같은 앱 롤 풀. 권한은 배치 함수 EXECUTE 하나(표 권한 0).
    invitedUsers: createPostgresInvitedUserErasure(pool),
    // 쓰이지 않은 가입 링크 보존(M2, 202609250240) — 같은 앱 롤 풀. 권한은 보존 함수 EXECUTE 하나(표 권한 0).
    signupLinks: createPostgresSignupLinkRetention(pool),
    // 실시간 연결 스윕(묶음 E, 202610081300) — 같은 앱 롤 풀. 권한은 스윕 함수 EXECUTE 하나(표 권한 0).
    realtimeConnections: createPostgresRealtimeConnectionRetention(pool),
    now: () => new Date(),
  }));
}

/**
 * `handlers/realtime.ts` — 실시간 WebSocket(묶음 E)의 `$connect` · `$disconnect` · `$default`. **앱 롤**(`atmark/db/app` — api λ 와 같은 표면, 쓰는 것은
 * 토큰 조회 · 마지막 사용 시각과 실시간 정의 함수 셋뿐) · 풀 1 · 유휴 5초(연결 예산 — `REALTIME_POOL_MAX`). SES · S3 · KMS 클라이언트 없음.
 */
export async function composeRealtime(platform: RuntimePlatform): Promise<Composed<RealtimeGatewayDependencies>> {
  const runtime = runtimeOf(platform);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, REALTIME_POOL_MAX, REALTIME_POOL_IDLE_MS);
  return withPool(pool, () => ({
    tokens: createPostgresAgentTokenStore(pool),
    connections: createPostgresRealtimeConnectionStore(pool),
    now: () => new Date(),
  }));
}

/** `handlers/webhook-dispatcher.ts` — 웹훅 outbox 배출. 나가는 문은 `webhooks/https-transport` 하나(SSRF 고정). */
export async function composeWebhookDispatcher(
  platform: RuntimePlatform,
): Promise<Composed<WebhookDispatcherDependencies>> {
  const runtime = runtimeOf(platform);
  const keyring = await readKeyring(runtime, RUNTIME_ENV.webhookSecretKeysSecretArn);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => ({
    outbox: createPostgresWebhookOutbox(pool),
    resolve: createSystemResolver(),
    transport: createPinnedHttpsTransport(),
    keyring,
    now: () => new Date(),
  }));
}

/** `handlers/scheduled-sender.ts` — 예약 발송(발송 시점에 관문). */
export async function composeScheduledSender(
  platform: RuntimePlatform,
): Promise<Composed<ScheduledSenderTickDependencies>> {
  const runtime = runtimeOf(platform);
  const configurationSet = configurationSetOf(runtime);
  const objects = mailObjects(runtime);
  const dlpKeys = await readDlpKeyring(runtime);
  const pool = await openPool(runtime, RUNTIME_ENV.dbSecretArn, DB_POOL_MAX);
  return withPool(pool, () => {
    const content = createObjectContentStore(objects);
    return {
      service: outboundServiceOf(runtime, pool, content, dlpKeys),
      transport: agentTransportOf(runtime, pool, content, configurationSet),
      schedules: createPostgresScheduledSendStore(pool),
      content: createScheduledContentStore(objects),
      leaseSeconds: LEASE_TTL_SECONDS,
    };
  });
}

/** `handlers/migrate.ts` — **소유자 롤** 비밀로 연다. 앱 롤 비밀은 읽지도 않는다. */
export async function composeMigration(platform: RuntimePlatform): Promise<Composed<null>> {
  const runtime = runtimeOf(platform);
  const pool = await openPool(runtime, RUNTIME_ENV.dbMigrationSecretArn, MIGRATION_POOL_MAX);
  return { deps: null, pool };
}

// ---------------------------------------------------------------------------
// 롤 부트스트랩 (migrate `bootstrap-roles`)
// ---------------------------------------------------------------------------

export interface RoleBootstrapDependencies {
  /** 마스터 자격증명의 호스트·포트·DB — 새로 쓰는 비밀도 같은 곳을 가리킨다. */
  readonly master: Omit<DatabaseCredentials, 'password'>;
  readonly ownerSecretArn: string;
  readonly appSecretArn: string;
  /** `atmark/db/admin` — admin Lambda 의 제한 롤(ADR-0006). */
  readonly adminSecretArn: string;
  /** `atmark/db/login-mailer` — 로그인 메일 Lambda 의 제한 롤(ADR-0006). */
  readonly loginMailerSecretArn: string;
  /** `atmark/db/passport-signer` — passport 서명 Lambda 의 제한 롤(계약 §3). */
  readonly passportSignerSecretArn: string;
  /** `atmark/db/tlog` · `atmark/db/tlog-anchor` — 투명성 로그 Lambda 둘의 제한 롤(ADR-0008). */
  readonly tlogSecretArn: string;
  readonly tlogAnchorSecretArn: string;
  /** `atmark/db/billing` · `atmark/db/billing-operator` — 결제 동기화 Lambda 와 결제 운영자 CLI 의 제한 롤(WP-2, ADR-0012). */
  readonly billingSecretArn: string;
  readonly billingOperatorSecretArn: string;
  /** `atmark/db/ops` — 호스팅 운영자 콘솔 λ 의 제한 롤(`.omc/plans/ops-console.md` §3.2). */
  readonly opsSecretArn: string;
  /** `atmark/db/domain-tick` — 고객 도메인 확인 틱의 제한 롤(ADR-0014 단계 2 · AtmarkCompute 소유 비밀). */
  readonly domainTickSecretArn: string;
  /** `atmark/db/ai-watch` — AI 감시 결과 λ 의 제한 롤(ADR-0017 초안 · AtmarkCompute 소유 비밀). */
  readonly aiWatchSecretArn: string;
  /** 비밀이 이미 **그 롤의** 유효한 자격증명으로 채워져 있는가 — 채워져 있으면 그 롤은 건드리지 않는다(회전 없음). */
  readonly ownerFilled: boolean;
  readonly appFilled: boolean;
  readonly adminFilled: boolean;
  readonly loginMailerFilled: boolean;
  readonly passportSignerFilled: boolean;
  readonly tlogFilled: boolean;
  readonly tlogAnchorFilled: boolean;
  readonly billingFilled: boolean;
  readonly billingOperatorFilled: boolean;
  readonly opsFilled: boolean;
  readonly domainTickFilled: boolean;
  readonly aiWatchFilled: boolean;
  readonly writer: SecretWriter;
}

/**
 * 비밀이 채워져 있는가. placeholder 면 `false`. 채워져 있는데 **다른 롤·다른 호스트**를 가리키면 던진다 — 사람이
 * 손으로 잘못 넣은 값을 "이미 됐다" 로 넘기면 다음 단계(migrate)가 엉뚱한 롤로 돈다.
 */
function secretFilledFor(raw: string, label: string, role: string, master: Omit<DatabaseCredentials, 'password'>): boolean {
  if (isPlaceholderSecret(raw)) return false;
  const credentials = parseDatabaseSecret(raw, label);
  if (credentials.username !== role || credentials.host !== master.host || credentials.dbname !== master.dbname) {
    throw new RuntimeConfigError(`${label} 이 ${role}@마스터와 같은 호스트·DB 를 가리키지 않는다. 손으로 넣은 값인지 확인하라.`);
  }
  return true;
}

/**
 * 롤 비밀 하나를 읽는다. SSM 자리(`/atmark/…`)가 **없거나 자리표시면** "비었다"(부트스트랩이 새 비밀번호를 만든다) — 단 **옛 Secrets Manager 자리
 * (`atmark/…`)에 채워진 값이 남아 있으면 던진다**(2026-10-12 비밀 → SSM 이전). 그 상태에서 새로 만들면 운영 롤의 비밀번호가 바뀌고, 옛 값을 쓰는
 * 함수의 연결이 끊긴다 — 값은 이전 스크립트(`scripts/admin/secrets-to-ssm.sh`)가 **복사**한다. 옛 자리가 없거나 자리표시면 새로 만들어도 된다.
 * 옛 자리를 읽다가 다른 오류(권한 등)가 나면 그대로 던진다(fail closed). 돌려주는 값: SSM 의 값(자리표시 포함) 또는 `null`(자리 없음).
 */
async function readRoleSecretOrRefuse(secrets: SecretReader, id: string, variable: string): Promise<string | null> {
  let current: string | null;
  try {
    current = await secrets.readSecretString(id);
  } catch (error) {
    if (!(error instanceof SecretNotFoundError) || !isSsmParameterName(id)) throw error;
    current = null;
  }
  // 채워진 SSM 값 · Secrets Manager 자리(ARN — 옛 방식 그대로)는 옛 자리를 보지 않는다.
  if (!isSsmParameterName(id) || (current !== null && !isPlaceholderSecret(current))) return current;
  const legacyId = legacySecretIdOf(id);
  let legacy: string;
  try {
    legacy = await secrets.readSecretString(legacyId);
  } catch (error) {
    if (error instanceof SecretNotFoundError) return current;
    throw error;
  }
  if (isPlaceholderSecret(legacy)) return current;
  throw new RuntimeConfigError(
    `${variable}: SSM ${id} 가 비었는데(없음 · 자리표시) 옛 Secrets Manager ${legacyId} 에 값이 있다 — 비밀번호를 새로 만들지 않는다. ` +
      '값 이전 스크립트(bash scripts/admin/secrets-to-ssm.sh)를 먼저 돌려라(배포 런북 §49).',
  );
}

/** `handlers/migrate.ts` 의 `bootstrap-roles` — **마스터** 풀(max 1) + 롤 비밀들의 현재 상태 + 쓰기 면. */
export async function composeRoleBootstrap(platform: RuntimePlatform): Promise<Composed<RoleBootstrapDependencies>> {
  const runtime = runtimeOf(platform);
  requireRdsCaBundle(runtime.env);
  const ownerSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbMigrationSecretArn);
  const appSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbSecretArn);
  const adminSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbAdminSecretArn);
  const loginMailerSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbLoginMailerSecretArn);
  const passportSignerSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbPassportSignerSecretArn);
  const tlogSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbTlogSecretArn);
  const tlogAnchorSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbTlogAnchorSecretArn);
  const billingSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbBillingSecretArn);
  const billingOperatorSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbBillingOperatorSecretArn);
  const opsSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbOpsSecretArn);
  const domainTickSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbDomainTickSecretArn);
  const aiWatchSecretArn = requireEnv(runtime.env, RUNTIME_ENV.dbAiWatchSecretArn);
  const masterCredentials = parseDatabaseSecret(
    await readSecret(runtime, RUNTIME_ENV.dbMasterSecretArn),
    RUNTIME_ENV.dbMasterSecretArn,
  );
  const master = {
    host: masterCredentials.host,
    port: masterCredentials.port,
    dbname: masterCredentials.dbname,
    username: masterCredentials.username,
  };
  // 순차로 읽는다 — 잘못 채운 비밀이 여럿이면 언제나 같은(첫) 비밀로 던진다.
  const filled = async (id: string, variable: string, role: string): Promise<boolean> => {
    const raw = await readRoleSecretOrRefuse(runtime.secrets, id, variable);
    return raw === null ? false : secretFilledFor(raw, variable, role, master);
  };
  const ownerFilled = await filled(ownerSecretArn, RUNTIME_ENV.dbMigrationSecretArn, OWNER_ROLE);
  const appFilled = await filled(appSecretArn, RUNTIME_ENV.dbSecretArn, APP_ROLE_NAME);
  const adminFilled = await filled(adminSecretArn, RUNTIME_ENV.dbAdminSecretArn, ADMIN_ROLE);
  const loginMailerFilled = await filled(loginMailerSecretArn, RUNTIME_ENV.dbLoginMailerSecretArn, LOGIN_MAILER_ROLE);
  const passportSignerFilled = await filled(passportSignerSecretArn, RUNTIME_ENV.dbPassportSignerSecretArn, PASSPORT_SIGNER_ROLE);
  const tlogFilled = await filled(tlogSecretArn, RUNTIME_ENV.dbTlogSecretArn, TLOG_ROLE);
  const tlogAnchorFilled = await filled(tlogAnchorSecretArn, RUNTIME_ENV.dbTlogAnchorSecretArn, TLOG_ANCHOR_ROLE);
  const billingFilled = await filled(billingSecretArn, RUNTIME_ENV.dbBillingSecretArn, BILLING_ROLE);
  const billingOperatorFilled = await filled(billingOperatorSecretArn, RUNTIME_ENV.dbBillingOperatorSecretArn, BILLING_OPERATOR_ROLE);
  const opsFilled = await filled(opsSecretArn, RUNTIME_ENV.dbOpsSecretArn, OPS_ROLE);
  const domainTickFilled = await filled(domainTickSecretArn, RUNTIME_ENV.dbDomainTickSecretArn, DOMAIN_TICK_ROLE);
  const aiWatchFilled = await filled(aiWatchSecretArn, RUNTIME_ENV.dbAiWatchSecretArn, AI_WATCH_ROLE);
  const writer = platform.clients?.secretWriter ?? createSecretWriter(runtime.region);
  const pool = poolFor(masterCredentials, MIGRATION_POOL_MAX);
  return {
    deps: {
      master,
      ownerSecretArn,
      appSecretArn,
      adminSecretArn,
      loginMailerSecretArn,
      passportSignerSecretArn,
      tlogSecretArn,
      tlogAnchorSecretArn,
      billingSecretArn,
      billingOperatorSecretArn,
      opsSecretArn,
      domainTickSecretArn,
      aiWatchSecretArn,
      ownerFilled,
      appFilled,
      adminFilled,
      loginMailerFilled,
      passportSignerFilled,
      tlogFilled,
      tlogAnchorFilled,
      billingFilled,
      billingOperatorFilled,
      opsFilled,
      domainTickFilled,
      aiWatchFilled,
      writer,
    },
    pool,
  };
}
