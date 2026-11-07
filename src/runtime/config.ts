/**
 * src/runtime/config.ts — 운영 런타임의 **환경 변수·비밀 형식**. 순수 함수만 있다(네트워크·풀 없음).
 *
 * 규율 셋:
 *   ① **없으면 던진다.** 조용한 기본값이 없다 — 버킷 이름·비밀 ARN 에 기본값이 있으면 그 기본값은 저장소에 적힌
 *      값이고, 틀린 배포가 "그럴듯한 다른 곳" 으로 조용히 붙는다(`db/client.ts` 가 접속 문자열 부재 시 던지는 것과 같다).
 *   ② **운영에서만 돈다.** 핸들러는 `ATMARK_ENV=production` 이 아니면 기동을 거부한다. 판정은
 *      `passport/custody.ts` 의 `isProductionEnvironment` 하나를 쓴다(판정이 둘이면 느슨한 쪽이 이긴다).
 *   ③ **평문 비밀이 환경에 있으면 던진다.** 로컬 개발 구현(`DATABASE_URL`·`ATMARK_APPROVAL_LINK_KEYS` 같은 env 평문,
 *      `ATMARK_DEV_STORAGE_DIR` 같은 로컬 파일 저장소)은 운영에서 선택될 자리가 없어야 한다 — 이 런타임은 그 값을
 *      읽지 않지만, **존재 자체**가 "누군가 로컬 방식으로 배포했다" 는 신호이고 그 신호를 무시하면 다음 사람이 그
 *      값을 읽는 코드를 쓴다.
 *
 * **오류 메시지에 값을 싣지 않는다** — 변수 이름·비밀 ARN 만. 이 메시지는 CloudWatch 로 간다.
 */

import { existsSync } from 'node:fs';

import { PADDLE_ENVIRONMENTS, type PaddleEnvironment } from '../billing/constants';
import { OPS_ENV } from '../ops/contract';
import { log } from '../observability/logger';
import { isProductionEnvironment } from '../passport/custody';
import { parseFeatureRollout, type FeatureRollout } from './feature-rollout';

/** 기동 설정이 없거나 형식이 틀리다. **복구하지 말고 죽어야 한다.** */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/**
 * 핸들러가 읽는 환경 변수 이름 — D2(CDK)와 공유하는 계약. 이름을 바꾸면 배포가 fail-closed 로 선다.
 * `…SecretArn` 변수의 **값**은 비밀의 위치다: Secrets Manager ARN, 또는 SSM 파라미터 이름 `/atmark/…`(2026-10-12 비밀 → SSM 이전 — 고르기는
 * `secrets.ts` `createSecretReader`). 이름은 계약이라 그대로 둔다.
 */
export const RUNTIME_ENV = {
  environment: 'ATMARK_ENV',
  region: 'AWS_REGION',
  dbSecretArn: 'ATMARK_DB_SECRET_ARN',
  dbMigrationSecretArn: 'ATMARK_DB_MIGRATION_SECRET_ARN',
  /** RDS 마스터 자격증명 — migrate 핸들러의 `bootstrap-roles` 만 읽는다. */
  dbMasterSecretArn: 'ATMARK_DB_MASTER_SECRET_ARN',
  /**
   * admin DB 롤(`atmark_admin`, `atmark/db/admin`) — admin Lambda 가 읽고 migrate `bootstrap-roles` 가 쓴다. 소유자 롤이 아니다
   * (ADR-0006): 아무것도 소유하지 않고 202609230720 의 GRANT 만 가진다.
   */
  dbAdminSecretArn: 'ATMARK_DB_ADMIN_SECRET_ARN',
  /** 로그인 메일 DB 롤(`atmark_login_mailer`, `atmark/db/login-mailer`) — login-mailer Lambda 가 읽고 `bootstrap-roles` 가 쓴다. */
  dbLoginMailerSecretArn: 'ATMARK_DB_LOGIN_MAILER_SECRET_ARN',
  mailBucket: 'ATMARK_MAIL_BUCKET',
  sesConfigurationSet: 'ATMARK_SES_CONFIGURATION_SET',
  approvalLinkKeysSecretArn: 'ATMARK_APPROVAL_LINK_KEYS_SECRET_ARN',
  webhookSecretKeysSecretArn: 'ATMARK_WEBHOOK_SECRET_KEYS_SECRET_ARN',
  /**
   * 소유자 로그인 링크 키링(`atmark/owner-login-keys`) — **승인 링크 키와 분리된 비밀**. 읽는 곳은 둘:
   * admin(검증·요청자 키 HMAC)과 login-mailer(로그인 메일 토큰 발급). 발송 역할(api·approval-notifier)은 읽지 못한다(ADR-0006).
   */
  ownerLoginKeysSecretArn: 'ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN',
  /**
   * login-mailer λ 의 함수 ARN(`atmark-login-mailer`) — **admin 만**. outbox 행을 적은 트랜잭션이 커밋된 뒤 이 함수를 비동기로 깨운다
   * (`lambda:InvokeFunction` 하나 · 이 ARN 정확히 하나, `runtime/lambda-invoke.ts`). 보내는 것은 여전히 login-mailer 다(ADR-0006).
   */
  loginMailerFunctionArn: 'ATMARK_LOGIN_MAILER_FUNCTION_ARN',
  /** api 함수 ARN — **admin 만**. 콘솔 웹훅 시크릿을 api λ 의 내부 이벤트로 받는다(보안 M1 · `runtime/internal-api-event.ts`). */
  apiFunctionArn: 'ATMARK_API_FUNCTION_ARN',
  /**
   * admin 함수 ARN(`atmark-admin`) — **api 만**. 자가 등록(`POST /v1/agents` · MCP `create_agent`)을 admin λ 의 내부 이벤트로 부른다(ADR-0016 2026-10-08 ·
   * `runtime/enroll-event.ts` — `lambda:InvokeFunction` 하나 · 이 ARN 정확히 하나). 없거나 틀리면 자가 등록만 503.
   */
  adminFunctionArn: 'ATMARK_ADMIN_FUNCTION_ARN',
  /**
   * 콘솔 HTTP API id(`atmark-console`) — **admin 만**. admin 핸들러는 HTTP 모양 이벤트의 `requestContext.apiId` 가 이 값일 때만 처리한다(적대 검증 D2-U048 — 직접
   * invoke 로 위조한 콘솔 요청을 거부). 없으면 HTTP 이벤트를 전부 거부한다(fail closed).
   */
  consoleApiId: 'ATMARK_CONSOLE_API_ID',
  /** 에이전트 키 envelope CMK(ARN 또는 별칭) — admin 의 프로비저닝(AWS custody)과 서명 Lambda(복호, `KeyId` 고정)가 읽는다. */
  passportKmsKeyId: 'ATMARK_PASSPORT_KMS_KEY_ID',
  /** 서명 DB 롤(`atmark_passport_signer`, `atmark/db/passport-signer`) — passport-signer Lambda 가 읽고 `bootstrap-roles` 가 쓴다. */
  dbPassportSignerSecretArn: 'ATMARK_DB_PASSPORT_SIGNER_SECRET_ARN',
  /** `id.atmark.ai` 문서 버킷(`identity-cdn-stack.ts` `DidDocumentBucketName`) — passport-signer 만. */
  identityBucket: 'ATMARK_IDENTITY_BUCKET',
  /** `id.atmark.ai` CloudFront 배포 ID — passport-signer 의 무효화만. */
  identityDistributionId: 'ATMARK_IDENTITY_DISTRIBUTION_ID',
  /** 투명성 로그 서열기 DB 롤(`atmark_tlog`, `atmark/db/tlog`) — transparency-logger Lambda 가 읽고 `bootstrap-roles` 가 쓴다(ADR-0008). */
  dbTlogSecretArn: 'ATMARK_DB_TLOG_SECRET_ARN',
  /** 투명성 로그 앵커 DB 롤(`atmark_tlog_anchor`, `atmark/db/tlog-anchor`) — transparency-anchor Lambda 가 읽고 `bootstrap-roles` 가 쓴다. */
  dbTlogAnchorSecretArn: 'ATMARK_DB_TLOG_ANCHOR_SECRET_ARN',
  /** 체크포인트 서명 KMS 키 ARN(Ed25519, 비추출) — transparency-logger 만. */
  tlogSigningKeyArn: 'ATMARK_TLOG_SIGNING_KEY_ARN',
  /** Rekor 앵커 서명 KMS 키 ARN(ECDSA P-256, 비추출) — transparency-anchor 만. */
  tlogAnchorKeyArn: 'ATMARK_TLOG_ANCHOR_KEY_ARN',
  /** 공개 로그 버킷(Object Lock) — `id.atmark.ai/log/*` 의 오리진. */
  tlogBucket: 'ATMARK_TLOG_BUCKET',
  /** OpenTimestamps 캘린더 URL 목록(쉼표) — 2곳 이상. */
  tlogOtsCalendars: 'ATMARK_TLOG_OTS_CALENDARS',
  /** Rekor v2 샤드 URL(해마다 바뀐다 — SigningConfig 로 확인, 런북 §5). */
  tlogRekorUrl: 'ATMARK_TLOG_REKOR_URL',
  /**
   * 문의 전달 주소 비밀(`atmark/contact-forward-to`, US-009 · ADR-0009) — **contact-forwarder Lambda 만** 이 변수를 받는다. IAM 도
   * 그 함수의 요청(`lambda:SourceFunctionArn`)으로만 읽기를 허락한다(발송 역할을 api 와 공유하므로 역할 단위로는 좁힐 수 없다).
   */
  contactForwardToSecretArn: 'ATMARK_CONTACT_FORWARD_TO_SECRET_ARN',
  // --- 결제 공급자(WP-2, Paddle — `.omc/plans/wp2-paddle-adapter.md` §6-0). 값의 형식은 아래 `readPaddleEnvironment`·`readBillingEnabled`.
  /** Paddle 환경(`sandbox`|`production`, `src/billing/constants.ts` `PADDLE_ENVIRONMENTS`) — billing-webhook · billing-sync · admin · site λ. */
  paddleEnvironment: 'ATMARK_PADDLE_ENV',
  /** 결제 스위치(`true`|`false`) — admin(체크아웃·포털 잠금) · site(꺼지면 `pay.atmark.ai` 404) · billing-sync(꺼지면 reconcile 건너뜀). */
  billingEnabled: 'ATMARK_BILLING_ENABLED',
  /** 결제 이벤트 FIFO 큐 URL(`atmark-billing-events.fifo`) — **billing-webhook 만**(SendMessage). sync 는 이벤트 소스 매핑으로 받는다. */
  billingQueueUrl: 'ATMARK_BILLING_QUEUE_URL',
  /** 웹훅 서명 비밀(`atmark/billing/paddle/webhook-secret`, `{"current","previous"}`) — **billing-webhook 만**. 이 λ 가 읽는 유일한 비밀이다. */
  paddleWebhookSecretArn: 'ATMARK_PADDLE_WEBHOOK_SECRET_ARN',
  /** Paddle sync API 키(`atmark/billing/paddle/sync-api-key` — 구독·거래·고객 읽기) — **billing-sync 만**. */
  paddleSyncApiKeySecretArn: 'ATMARK_PADDLE_SYNC_API_KEY_SECRET_ARN',
  /** Paddle admin API 키(`atmark/billing/paddle/admin-api-key` — 거래 생성·취소 · 포털 세션) — **admin 만**. */
  paddleAdminApiKeySecretArn: 'ATMARK_PADDLE_ADMIN_API_KEY_SECRET_ARN',
  /** 결제 동기화 DB 롤(`atmark_billing`, `atmark/db/billing`) — billing-sync 가 읽고 migrate `bootstrap-roles` 가 쓴다. */
  dbBillingSecretArn: 'ATMARK_DB_BILLING_SECRET_ARN',
  /**
   * 결제 운영자 DB 롤(`atmark_billing_operator`, `atmark/db/billing-operator`) — **migrate `bootstrap-roles` 만** 쓴다. 읽는 쪽은 Lambda 가 아니라
   * 운영자 `pnpm admin:plan`(터널 · `admin:db-env` → `DATABASE_BILLING_OPERATOR_URL`)이다.
   */
  dbBillingOperatorSecretArn: 'ATMARK_DB_BILLING_OPERATOR_SECRET_ARN',
  /** Paddle.js 클라이언트 토큰 — **공개값**(비밀 아님, 계획 §0 P21) · site λ 만(`pay.atmark.ai` 페이지의 `Paddle.Initialize`). */
  paddleClientToken: 'ATMARK_PADDLE_CLIENT_TOKEN',
  // --- 메일 기본기 2차(ADR-0013) — 단계 공개 플래그 둘(`readFeatureRollout`). **기본 끔**: 없거나 `false` = 꺼짐 · `true` = 전체 ·
  // `orgs:<uuid>,…` = 적힌 조직만. 무효 값은 꺼짐 + 기동 경고(fail closed — `feature-rollout.ts`).
  /** 별칭 주소(A6) — **admin 만**(콘솔 별칭 추가·폐기 API · 닫힌 조직은 404). 폐기된 주소의 효력(수신·발신 제외)은 플래그와 무관하게 선다. */
  addressAliasesEnabled: 'ATMARK_ADDRESS_ALIASES_ENABLED',
  /** 발신 첨부(A2) — **api 만**(`POST /v1/attachments` · `send`·`reply` 의 `attachments` · 닫힌 조직은 404/400). Stage 6 의 요금제 `min()` 은 플래그와 무관하다. */
  outboundAttachmentsEnabled: 'ATMARK_OUTBOUND_ATTACHMENTS_ENABLED',
  /**
   * 새 에이전트 정책의 첨부 총량을 "요금제를 따른다"(null)로 쓴다 — **admin**(콘솔·조직 키 프로비저닝) · CLI `admin:agent-provision`. 끄면 옛
   * 기본값 10 MiB. **새 코드가 모든 λ 에 배포된 뒤에** 켠다(옛 정책 로더는 null 을 읽지 못한다 — 보안 리뷰 M3).
   */
  policyAttachmentFollowPlan: 'ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN',
  /**
   * Domain Connect(고객 도메인 DNS 자동 입력) — **admin 만**(`readFeatureFlag` — 기본 끔). 켜려면 서명 키 ARN(`domainConnectKeyArn`)도 있어야 한다.
   * Cloudflare 온보딩(템플릿 병합 · 공개키 TXT)이 끝난 뒤 켠다(런북 deploy §Domain Connect).
   */
  domainConnectEnabled: 'ATMARK_DOMAIN_CONNECT_ENABLED',
  /** Domain Connect 서명 KMS 키 ARN(RSA_2048 · `alias/atmark-domain-connect-signing`). admin 만. */
  domainConnectKeyArn: 'ATMARK_DOMAIN_CONNECT_KEY_ARN',
  /**
   * 셀프 가입 환영 메일(`onve@atmark.ai`, 202609301510) — **login-mailer 만**(`readFeatureFlag` — 기본 끔). 꺼져 있으면 환영 메일 outbox 행은
   * `pending` 으로 쌓이기만 하고(48시간이 지나면 켠 뒤 `obsolete`), 켜면 login-mailer 틱이 `welcome` 단계를 돈다. **onve@ 로 온 답장이 지원
   * 에이전트로 가는 경로(배포 런북 §29)가 선 뒤에** 켠다(§30).
   */
  welcomeMailEnabled: 'ATMARK_WELCOME_MAIL_ENABLED',
  /**
   * 발신 DLP 지문 키(ADR-0016 B — `atmark/dlp-keys`, AtmarkCompute 소유 · 값은 CloudFormation 이 생성). api · approval-release · scheduled-sender
   * (발송 서비스) · inbound(복사 지문). 형식은 키 묶음(`kid:base64url,…`) 또는 생성된 첫 값(64자 영숫자 하나 → kid `g1`).
   */
  dlpKeysSecretArn: 'ATMARK_DLP_KEYS_SECRET_ARN',
  /**
   * 위험 보류 킬 스위치(ADR-0016 운영 — 운영자만): `observe` | `enforce`, **없으면 `enforce`**(진윤겸 2026-10-04 — 관찰 기간 없이 강제로 시작). 틀린 값은
   * `enforce` + 기동 경고(fail closed). 첨부 텍스트 보류(`withheld: "injection_risk"`)도 같은 스위치를 따른다.
   */
  riskHoldEnforce: 'ATMARK_RISK_HOLD_ENFORCE',
  /**
   * 격리 알림 킬 스위치(ADR-0016 2026-10-07 개정 — 운영자만, approval-notifier λ): `on` | `off`, **없으면 `on`**. `off` 면 그 λ 가 격리 알림 배출을
   * 싣지 않는다(창은 쌓이기만 하고 다시 켜면 24시간 넘은 창은 `obsolete`). 틀린 값은 `on` + 기동 경고. CDK 컨텍스트 `atmark:quarantineNotice`.
   */
  quarantineNotice: 'ATMARK_QUARANTINE_NOTICE',
  /**
   * RDS CA 번들 경로. Lambda Node.js 20+ 런타임은 RDS CA 를 **기본으로 싣지 않는다** — 이 변수를
   * `/var/runtime/ca-cert.pem` 으로 두어야 Node 가 기동 시 신뢰 저장소에 더한다. 없으면 `rejectUnauthorized: true`
   * 접속이 전부 실패하고, 그 실패를 피하려고 누군가 `false` 를 넣는다 — 그 한 줄을 막으려고 여기서 먼저 던진다.
   */
  extraCaCerts: 'NODE_EXTRA_CA_CERTS',
  // --- 호스팅 운영자 콘솔(ops.atmark.ai, `.omc/plans/ops-console.md` §3.1) — 이름은 계약 `OPS_ENV`(src/ops/contract.ts) 하나에서 온다.
  /** 운영 콘솔 DB 롤(`atmark_ops`, `atmark/db/ops`) — ops λ 가 읽고 migrate `bootstrap-roles` 가 쓴다. */
  dbOpsSecretArn: OPS_ENV.dbSecretArn,
  /** ops λ 의 쿠키·결속·요청자 키 키링(`atmark/ops-keys`) — **ops λ 만**. 코드 파생 키가 아니다. */
  opsKeysSecretArn: OPS_ENV.opsKeysSecretArn,
  /**
   * 운영 콘솔 코드 파생 키링(`atmark/ops-login-keys`) — **login-mailer 만**(결정 C2 — ops λ 에는 없다). 없거나 자리표시·형식 오류면 운영 코드 메일만
   * 건너뛴다(`mailer_skipped{reason}`) — 소유자 로그인·가입·초대 메일은 그대로 돈다(M1).
   */
  opsLoginKeysSecretArn: OPS_ENV.opsLoginKeysSecretArn,
  // --- 고객 도메인(ADR-0014 단계 2) — 이름은 여기 하나. 값은 AtmarkCompute 가 준다.
  /**
   * 고객 도메인 틱 DB 롤(`atmark_domain_tick`, `atmark/db/domain-tick` — AtmarkCompute 소유) — migrate `bootstrap-roles` 가 쓰고, admin λ 가 위치(ARN)를
   * 받는다(틱 풀은 단계 4 — 읽기 권한도 그때 붙는다).
   */
  dbDomainTickSecretArn: 'ATMARK_DB_DOMAIN_TICK_SECRET_ARN',
  /** domain-control λ 함수 ARN(`atmark-domain-control`) — **admin 만**(`lambda:InvokeFunction` on 이 ARN 하나, `runtime/domain-control-invoker.ts`). */
  domainControlFunctionArn: 'ATMARK_DOMAIN_CONTROL_FUNCTION_ARN',
  /**
   * 발송 역할 ARN — **domain-control λ 만**. identity policy 의 Principal 은 입력이 아니라 이 값으로만 조립한다(ADR-0014 결정 3 · 계약
   * `SENDER_ROLE_ARN_MAX_LENGTH`). 이름은 계약 그대로(`ATMARK_` 접두사 없음).
   */
  senderRoleArn: 'SENDER_ROLE_ARN',
  // --- AI 의심 메일 감시(ADR-0017 초안 · 경고 전용) — 계약 `AI_WATCH_ENV`(src/inbound/ai-watch/contract.ts)와 같은 글자(단위 테스트가 대조).
  //     import 하지 않는 이유: 이 파일은 판정 쪽에서도 읽히고, 판정 쪽 폐포에 `src/inbound/ai-watch/**` 가 없어야 한다(arch `ai-watch-boundary` ①).
  /** 킬 스위치 `off`|`shadow`|`on`(없으면 `off`) — **inbound λ 만**, 읽는 곳은 조립 루트 하나(arch `ai-watch-boundary` ⑤). */
  aiWatchMode: 'ATMARK_AI_WATCH',
  /** 요청 큐 URL(`atmark-ai-watch-req`) — **inbound λ 만**(SendMessage). */
  aiWatchRequestQueueUrl: 'ATMARK_AI_WATCH_REQUEST_QUEUE_URL',
  /** 결과 λ DB 롤(`atmark_ai_watch`, `atmark/db/ai-watch`) — 결과 λ 가 읽고 migrate `bootstrap-roles` 가 쓴다. */
  dbAiWatchSecretArn: 'ATMARK_DB_AI_WATCH_SECRET_ARN',
} as const;

/**
 * login-mailer λ 의 입력 `{"source": …}` 둘 — 둘 다 **고정값**이고 사용자 데이터가 없다(`handlers/login-mailer.ts` 가 가르고, 모르는 모양은 던진다).
 *   - `tick`: EventBridge Scheduler 1분 틱의 입력(`infra/cdk/stacks/compute-stack.ts` `LOGIN_MAILER_TICK_INPUT` — infra 테스트가 같은 값인지 본다).
 *   - `kick`: admin λ 가 outbox 행을 적은 트랜잭션이 커밋된 뒤 `InvocationType: 'Event'` 로 깨우는 입력(`runtime/lambda-invoke.ts`).
 * 어느 쪽이든 하는 일은 같다 — outbox 를 비운다(무엇을 보낼지는 DB 의 기한과 클레임이 정한다).
 */
export const LOGIN_MAILER_EVENT_SOURCE = { tick: 'atmark.schedule', kick: 'atmark.kick' } as const;

/**
 * 운영 환경에 **있으면 안 되는** 변수 — 로컬 개발 구현의 입력이다. 이 런타임은 어느 것도 읽지 않는다.
 * (`db/client.ts` 의 URL 둘, `security/hmac-keyring.ts` 의 env 키링 셋, 로컬 파일 저장소 둘, libpq 평문 비밀번호.)
 */
export const FORBIDDEN_PRODUCTION_ENV: readonly string[] = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'PGPASSWORD',
  'ATMARK_APPROVAL_LINK_KEYS',
  'ATMARK_WEBHOOK_SECRET_KEYS',
  'ATMARK_OWNER_LOGIN_KEYS',
  'ATMARK_DEV_STORAGE_DIR',
  'ATMARK_DEV_KEY_DIR',
];

/**
 * 핸들러 기동의 첫 줄. **운영이 아니면 던지고, 로컬 구현의 흔적이 있으면 던진다.**
 *
 * `ATMARK_ENV` 가 정확히 `production` 이어야 한다 — `isProductionEnvironment` 는 `prod` 와 `NODE_ENV` 폴백도
 * 운영으로 보지만(가드가 넓게 걸리게 하려는 판정이다), 여기서는 **계약 값 하나**만 받는다.
 */
export function requireProductionRuntime(env: NodeJS.ProcessEnv): void {
  if (env[RUNTIME_ENV.environment] !== 'production' || !isProductionEnvironment(env)) {
    throw new RuntimeConfigError(
      `${RUNTIME_ENV.environment}=production 이 아니다. 이 핸들러는 운영 전용이다 — 로컬은 pnpm 스크립트를 써라.`,
    );
  }
  const present = FORBIDDEN_PRODUCTION_ENV.filter((name) => (env[name] ?? '').trim() !== '');
  if (present.length > 0) {
    throw new RuntimeConfigError(
      `운영 환경에 로컬 개발용 변수가 있다: ${present.join(', ')}. 비밀은 Secrets Manager ARN 으로만 받는다.`,
    );
  }
}

/** 필수 변수. 없거나 공백이면 던진다 — 기본값을 만들지 않는다. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new RuntimeConfigError(`${name} 이 비어 있다. 기본값은 없다(fail-closed).`);
  }
  return value;
}

/** `NODE_EXTRA_CA_CERTS` 가 있고 그 파일이 실재해야 한다 — 없으면 TLS 검증이 RDS 인증서를 신뢰하지 못한다. */
export function requireRdsCaBundle(env: NodeJS.ProcessEnv): void {
  if (!existsSync(requireEnv(env, RUNTIME_ENV.extraCaCerts))) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.extraCaCerts} 가 가리키는 CA 번들이 없다. TLS 검증 없이 접속하지 않는다.`);
  }
}

/**
 * **코드 상수와 같아야 하는** 변수. 값을 바꿀 수 있는 설정이 아니라 **배포와 코드의 대조**다.
 *
 * 예: SES Configuration Set 은 `mail/transport/ses-transport.ts` 의 상수다 — 알림 전송단은 그 상수를 쓰고 주입받지
 * 않는다(알림 모듈 표면 동결). 그래서 환경 변수는 그 상수를 **바꾸지 못하고**, 배포가 같은 이름을 가리키는지만
 * 확인한다. 다르면 에이전트 메일과 알림 메일의 이벤트(bounce·complaint)가 다른 곳으로 흩어진다.
 */
export function requireEnvMatching(env: NodeJS.ProcessEnv, name: string, expected: string): string {
  const value = requireEnv(env, name);
  if (value !== expected) {
    throw new RuntimeConfigError(
      `${name} 이 코드 상수와 다르다(기대: ${expected}). 이 값은 설정이 아니라 대조다 — 바꾸려면 코드를 바꿔라.`,
    );
  }
  return value;
}

/**
 * `ATMARK_PADDLE_ENV` — `sandbox` 또는 `production` 정확히. 없거나 다르면 던진다(대소문자·별칭을 받지 않는다 — 샌드박스 λ 가 운영 값으로
 * 읽히는 길을 만들지 않는다). 봉투·표의 `environment` 대조가 이 값을 기준으로 한다.
 */
export function readPaddleEnvironment(env: NodeJS.ProcessEnv): PaddleEnvironment {
  const value = requireEnv(env, RUNTIME_ENV.paddleEnvironment);
  const known = PADDLE_ENVIRONMENTS.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.paddleEnvironment} 은 ${PADDLE_ENVIRONMENTS.join(' | ')} 중 하나여야 한다.`);
  }
  return known;
}

/**
 * `ATMARK_BILLING_ENABLED` — `true` 또는 `false` 정확히. 없거나 다른 값이면 던진다: 오타가 "꺼짐" 으로 조용히 읽히면 배포가 켜졌다고 믿는 동안
 * 결제가 잠기고, "켜짐" 으로 읽히면 준비되지 않은 결제가 열린다 — 어느 쪽도 조용해서는 안 된다(규율 ①).
 */
export function readBillingEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = requireEnv(env, RUNTIME_ENV.billingEnabled);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new RuntimeConfigError(`${RUNTIME_ENV.billingEnabled} 은 true | false 중 하나여야 한다.`);
}

/**
 * 기본 끔 불리언 기능 플래그(`policyAttachmentFollowPlan` — 단계 공개 둘은 `readFeatureRollout`). 없거나 빈 값·`false` = 꺼짐, `true` = 켬.
 * 다른 값(`TRUE`·`1`·오타)은 던진다 — 결제 스위치와 같은 규율(오타가 조용히 켜짐·꺼짐으로 읽히지 않게). 필수 변수가 아닌 이유: 새 플래그를
 * 모르는 옛 스택 정의로 배포해도 기동이 깨지지 않고 **꺼진 채** 돈다.
 */
export function readFeatureFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim() ?? '';
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new RuntimeConfigError(`${name} 은 true | false 중 하나여야 한다(없으면 false).`);
}

/**
 * 단계 공개 플래그(메일 기본기 2차 — `addressAliasesEnabled` · `outboundAttachmentsEnabled`): `false`(없음·빈 값) · `true` · `orgs:<uuid>,…`.
 * **무효 값은 던지지 않고 꺼짐으로 읽는다** — 기동 경고 `runtime.feature_flag_invalid {detail: 변수 이름, reason}` 한 줄(값은 싣지 않는다).
 * 새 기능을 여는 스위치라 닫힌 쪽이 안전하고, 기동 거부는 기존 표면까지 멈춘다(`feature-rollout.ts` 머리말). 합성은 같은 파서로 거부한다.
 */
export function readFeatureRollout(env: NodeJS.ProcessEnv, name: string): FeatureRollout {
  const parsed = parseFeatureRollout(env[name] ?? '');
  if (parsed.ok) return parsed.rollout;
  log('warn', 'runtime.feature_flag_invalid', { detail: name, reason: parsed.reason, outcome: 'disabled' });
  return false;
}

// ---------------------------------------------------------------------------
// 비밀 형식
// ---------------------------------------------------------------------------

/** DB 접속 비밀(JSON). RDS 가 만든 비밀의 필드 이름을 그대로 쓴다 — 나머지 필드(`engine` 등)는 무시한다. */
export interface DatabaseCredentials {
  readonly host: string;
  readonly port: number;
  readonly dbname: string;
  readonly username: string;
  readonly password: string;
}

/**
 * CDK 가 자리만 만든 비밀의 초기값인가(`{"_unset": …}` — `infra/cdk/stacks/data-stack.ts` `SECRET_PLACEHOLDER_VALUE`).
 * 런타임은 이것을 **거부한다**(아래 파서가 명시적으로 던진다) — 롤 부트스트랩만 "아직 비었다" 로 읽는다.
 */
export function isPlaceholderSecret(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && '_unset' in parsed;
  } catch {
    return false;
  }
}

/** DB 비밀 JSON 을 읽는다. **값을 오류에 싣지 않는다** — 어느 필드가 틀렸는지만. */
export function parseDatabaseSecret(raw: string, label: string): DatabaseCredentials {
  if (isPlaceholderSecret(raw)) {
    throw new RuntimeConfigError(`${label} 이 아직 채워지지 않았다(placeholder). migrate 의 bootstrap-roles 를 먼저 돌려라.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeConfigError(`${label} 이 JSON 이 아니다.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RuntimeConfigError(`${label} 이 JSON 객체가 아니다.`);
  }
  const record = parsed as Record<string, unknown>;
  const text = (field: string): string => {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RuntimeConfigError(`${label} 의 ${field} 가 비어 있거나 문자열이 아니다.`);
    }
    return value;
  };
  const portRaw = record['port'];
  const port = typeof portRaw === 'string' && /^\d+$/.test(portRaw) ? Number(portRaw) : portRaw;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeConfigError(`${label} 의 port 가 1~65535 정수가 아니다.`);
  }
  return {
    host: text('host'),
    port,
    dbname: text('dbname'),
    username: text('username'),
    password: text('password'),
  };
}

/** `pg` 접속 문자열. 사용자·비밀번호·DB 이름은 URL 인코딩한다(비밀번호의 `@`·`/` 가 호스트를 바꾸지 않게). */
export function databaseUrlOf(credentials: DatabaseCredentials): string {
  const user = encodeURIComponent(credentials.username);
  const password = encodeURIComponent(credentials.password);
  const database = encodeURIComponent(credentials.dbname);
  return `postgres://${user}:${password}@${credentials.host}:${String(credentials.port)}/${database}`;
}

/**
 * 호출된 Lambda 함수 ARN 에서 계정 ID 를 꺼낸다 — S3 `ExpectedBucketOwner` 의 값이다.
 *
 * 환경 변수로 받지 않는 이유: 계정 ID 는 **배포가 이미 아는 사실**이고, 변수로 받으면 틀릴 수 있는 입력이 하나
 * 늘어난다. 버킷은 같은 계정의 스택에 있으므로 "이 함수가 도는 계정" 이 곧 기대 소유자다. 형식이 아니면 던진다.
 */
export function accountIdFromFunctionArn(arn: string): string {
  const parts = arn.split(':');
  const account = parts[4];
  if (parts[0] !== 'arn' || parts[2] !== 'lambda' || account === undefined || !/^\d{12}$/.test(account)) {
    throw new RuntimeConfigError('invokedFunctionArn 에서 12자리 계정 ID 를 읽지 못했다.');
  }
  return account;
}
