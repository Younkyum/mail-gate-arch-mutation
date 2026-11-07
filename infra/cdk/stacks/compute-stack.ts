/**
 * AtmarkCompute — Lambda 16개 · HTTP API 넷(api · console · billing · ops) · SQS 이벤트 소스 · EventBridge Scheduler · **IAM(Layer E 의 본체)**.
 *
 * 핸들러 계약(D1 과 공유 — 고정): 코드 = `dist/lambda/<name>/index.js`, `export const handler`.
 *
 * ---
 *
 * ## IAM — SES 발송 권한을 가진 런타임 주체는 정확히 둘 (ADR-0006, 2026-09-23 전에는 하나)
 *
 * 발송하는 핸들러는 넷이다: `api`(send·reply·forward·transition) · `approval-release` · `approval-notifier` ·
 * `scheduled-sender`. 넷에 역할을 하나씩 주면 발송 주체가 넷이 되고, Layer E 의 "정확히 1" 은 "정확히 4" 가
 * 된다 — 그러면 다섯 번째를 더하는 것도 숫자 하나 고치는 일이 된다. **넷이 역할 하나(`atmark-runtime-sender`)를
 * 공유한다.** 대가는 권한의 합집합이다(예: `approval-notifier` 도 `outbound/content/*` 를 쓸 수 있다). 그 대가를
 * 받아들이는 이유: 이 층이 막으려는 것은 "관문 밖에서 SES 에 닿는 주체" 이고, 발송 4핸들러는 전부 관문(또는
 * 알림 모듈) 안에서 SES 를 부른다 — 합집합이 넓히는 것은 S3 접두사·비밀 몇 개이지 발송 경로가 아니다.
 *
 * **둘째 발송 주체 — `atmark-runtime-login-mailer`(Lambda `login-mailer` 하나).** 소유자 로그인 링크 메일은 로그인 키로 토큰을
 * 만든다. 로그인 키 + 링크 id·만료를 쥔 쪽은 스스로 로그인을 요청해(자기 브라우저 논스) 소유자 세션을 만들 수 있다 — 그 둘이
 * 발송 역할(= api Lambda 의 역할)에 있으면 **api 탈취가 곧 소유자 세션**이었다(검증 H1 실증). 그래서 로그인 메일만 따로 뗐다.
 * 이 역할의 발송 문장은 `ses:FromAddress` **= 정확히 `login@atmark.ai` · `onve@atmark.ai`**(StringEquals — 환영 메일, ADR-0006 2026-09-30 개정)이고,
 * 발송 역할은 반대로 `login@` 을 **명시 Deny** 한다 — `onve@` 는 지원 에이전트의 별칭이라 두 주체가 함께 쓴다(리드 수용). 주체 수는 1 → 2 가 됐지만 둘째는 시스템 주소 하나에 묶여 있어
 * "에이전트 메일을 관문 밖에서 보내는 주체" 가 늘지 않는다(Layer E `mustEqual: 2` — `docs/ops/ses-principals-allowlist.json`).
 *
 * **문의 전달 — `contact-forwarder`(US-009, ADR-0009)는 발송 역할을 공유한다(발송 주체 수 그대로 2).** `support@atmark.ai` 로 온
 * 문의를 운영자 메일함으로 보내는 시스템 메일 Lambda 다. 역할을 공유하므로 이 함수만의 것은 **함수 단위 조건**
 * (`lambda:SourceFunctionArn` — Lambda 가 실행 역할 자격증명의 모든 요청에 싣는 키)으로 묶는다: 전달 주소 비밀
 * (`atmark/contact-forward-to`) 읽기 · 전달 문서(`contact/forward/*`) 읽기. 그리고 `support@atmark.ai` 발신은 이 함수 **밖**에서
 * 명시 Deny 다(`SesDenySupportFromOutsideForwarder`) — api 가 탈취돼도 문의 주소를 사칭하지 못한다. 문서를 **쓰는** 것은 inbound
 * (`contact/forward/*` PutObject)뿐이다.
 *
 * 나머지(`inbound`·`ses-events`·`approval-expiry`·`webhook-dispatcher`·`migrate`·`admin`·`passport-signer`·결제 둘·`ops`·`domain-control`)은
 * **각자 역할**을 갖고 SES 발송 권한이 0 이다. 역할을 나누는 이유: 합치면 그들 사이의 합집합(migrate 의 DB 소유자 비밀, inbound 의
 * 원문 읽기)이 서로에게 새어 나간다. **그리고 전부 `ses:Send*` 명시 Deny 를 갖는다**(ADR-0014 단계 2 · `ses-send-deny.ts`) — 고객 도메인
 * identity policy(자원 기반 권한)가 넓어져도 이 역할들로는 보낼 수 없다.
 *
 * ## 고객 도메인(ADR-0014 단계 2 — **꺼진 채로** 들어온다)
 *
 * - **`domain-control` λ(`atmark-domain-control`)** — VPC 밖 · DB 없음(풀 0) · 예약 `RESERVED_CONCURRENCY['domain-control']`(2) · 256MB · 12초.
 *   역할 `atmark-runtime-domain-control` 은 `makeRole` 이 아니다(AWS 관리형 정책 0 — 자기 로그 그룹 쓰기만, 결제 웹훅과 같은 모양). 허용은 SES
 *   identity **제어면** 명령만이고 **태그로 묶인다**(보안 리뷰 M1): 변형은 `atmark:managed = customer-domain` 태그가 이미 있는 identity 에만 · 만들기는
 *   그 태그를 요청에 반드시 · 태그 쓰기는 `atmark:row` 하나만. 태그 없는 identity(플랫폼·수동·스파이크)는 이름과 무관하게 바꿀 수 없다. **명시 Deny**
 *   셋: `atmark.ai`·`*.atmark.ai`·주소 identity(`*@*`)의 `ses:*` · 관리 표시 태그 바꾸기 · `ses:Send*` 전부. identity policy 의 Principal 은 환경변수 `SENDER_ROLE_ARN`(발송 역할) 하나로만 조립한다.
 * - **`domain-policy-audit` λ** — 자원 정책 **독립 감사**(보안 리뷰 M2 — 쓰는 주체가 자기 감사만 하면 탈취 때 같이 무너진다). 역할은 SES
 *   `GetEmailIdentity`·`ListEmailIdentities` 뿐 · VPC 밖 · DB 없음 · 예약 1. 정책을 쓰는 CloudTrail 이벤트마다(EventBridge) + 하루 한 번 전수(Scheduler,
 *   켜짐 — 읽기 전용). 위반 → EMF → 알람 `atmark-domain-policy-shape`.
 * - **admin** 이 부르는 유일한 주체다 — `lambda:InvokeFunction` on 그 함수 ARN **하나**(`DomainControlInvoke` — 한정자·와일드카드 없음).
 * - **발송 역할 문장 분리(I2+)** — `SesSendAsAtmarkIdentity`(identity `atmark.ai` · `*@atmark.ai`, 예전 문장과 같은 조건) +
 *   `SesUseDefaultConfigurationSet`(구성 세트 하나 · 조건 없음 — 스파이크 S1 ③: 구성 세트 권한은 identity policy 로 줄 수 없다). 고객 identity 는
 *   IAM Allow 에 **없다**(identity policy 로만 — 행의 조직이 가진 주소 StringEquals). `atmark.ai` 발송의 실효 권한은 그대로다: 요청은 identity 와
 *   구성 세트 **둘 다** 허락받아야 하고 identity 쪽 조건이 예전과 같다.
 * - **틱 롤 비밀 `atmark/db/domain-tick`** — 이 스택 소유(AtmarkData 손 배포를 피한다 — 투명성 스택의 선례). migrate 가 쓰고(bootstrap-roles)
 *   admin 이 위치(ARN)를 받는다. **읽기 권한은 아직 없다**(틱 풀은 단계 4).
 * - **Scheduler `atmark-domain-recheck`**(10분 → admin `{"task":"domain-recheck"}`) — **ENABLED**(M5 — `DOMAIN_RECHECK_ENABLED_DEFAULT = true`,
 *   런북 deploy §39). M1~M4 동안은 DISABLED 였다. 끄려면 `-c atmark:domainRecheckEnabled=false`(관측 스택도 같이 — §39-3).
 *
 * ## admin — 소유자 관리 표면 (2026-09-23, 호스트 `console.atmark.ai`)
 *
 * **별도 HTTP API(`atmark-console`) + 별도 커스텀 도메인·인증서**의 라우트가 전부 admin Lambda 로 간다. `api.atmark.ai` 의
 * HTTP API 에는 관리 경로가 **하나도 없다**(템플릿 테스트) — 두 표면은 호스트·API·Lambda·역할·DB 롤이 전부 다르다. 역할
 * `atmark-runtime-admin`: **SES 0** · admin DB 비밀(`atmark/db/admin`, 롤 `atmark_admin` — 소유자 롤 아님, ADR-0006) 읽기 ·
 * 로그인 키 비밀 읽기(검증) · passport custody(GenerateDataKey · CreateSecret `atmark/agent-keypairs/*` · Decrypt ViaService SM)
 * · **S3 는 `s3:GetObject` on 메일 버킷 `outbound/content/*` 하나**(US-004 — 발신 로그 상세의 본문. ListBucket·PutObject 없음,
 * ADR-0006 "US-004 추가") · 앱 DB 비밀 0 · 소유자 DB 비밀 0. 로그인 메일은 outbox 에 적고 login-mailer(둘째 발송 주체)가 보낸다.
 * 커밋 뒤 admin 은 login-mailer 를 **깨운다** — `lambda:InvokeFunction` on login-mailer 함수 ARN **정확히 하나**(한정자·와일드카드 없음,
 * `grantInvoke` 를 쓰지 않는다 — 그 헬퍼는 `…:function:x:*` 를 붙인다). 입력은 고정값 `{"source":"atmark.kick"}`이고 login-mailer 는 틱과 같은 일
 * (outbox 비우기)만 한다 — admin 이 보내거나 로그인 키로 토큰을 만드는 길은 여전히 없다(ADR-0006). 1분 틱은 폴백으로 남는다.
 * 콘솔 HTTP API 는 execute-api 기본 엔드포인트를 끈다(커스텀 도메인이 있을 때) — 입구는 `console.atmark.ai` 하나.
 * 스로틀은 버킷을 나눈다: 로그인 요청·검증 라우트는 낮게, 나머지(`$default` — 세션 API·kill-switch·페이지)는 높게 — 로그인
 * 남용이 로그인한 소유자의 kill-switch 를 429 로 막지 못하게(검증 M3).
 * custody 는 migrate 에서 admin 으로 **옮겼다**: 운영 프로비저닝 경로가 둘(CLI = 운영자 IAM, 관리 API = admin 역할)이고
 * migrate 는 어느 쪽도 아니다 — 쓰지 않는 역할에 키 생성 권한을 남겨 두지 않는다.
 *
 * 발송 문장은 `ses:FromAddress` = `*@atmark.ai` 로 좁히고, 리소스는 도메인 identity ARN + configuration set ARN
 * 둘뿐이다. 다른 도메인·다른 설정 세트로는 이 역할로도 못 보낸다. 표시 이름을 붙인 From(`"X" <a@atmark.ai>`)은
 * 이 조건에 걸려 거부된다 — 현행 코드는 맨 주소만 쓴다(`ses-transport.ts`).
 *
 * ## 결제(WP-2, Paddle — `.omc/plans/wp2-paddle-adapter.md` §3-1 · §5)
 *
 * - **`billing-webhook` — 인터넷에 열린 함수는 DB 를 모른다.** 이 스택에서 **유일하게 VPC 밖**인 함수다(DB 가 없으니 VPC 가 필요 없고,
 *   VPC 에 두면 NAT 장애가 수신 장애가 된다). 전용 HTTP API `atmark-billing`(라우트 `POST /paddle/webhook` 하나, `$default` 없음)의
 *   통합이다 — api HTTP API 에 라우트를 더하지 않는다("api HTTP API 의 통합은 api Lambda 하나" 불변식). 역할(`atmark-runtime-billing-webhook`)은
 *   `makeRole` 을 쓰지 않는다: **AWS 관리형 정책 0**(Basic 은 모든 로그 그룹에 CreateLogGroup 을, VPC 는 ENI 권한을 준다) ·
 *   문장 셋 = 자기 로그 그룹 쓰기 · 웹훅 비밀 하나 GetSecretValue · 결제 큐 SendMessage. DB 비밀·다른 비밀·SES·S3·KMS 0(테스트 · 변이 BL-3).
 *   DB 연결 예산에 0 을 더한다(`BILLING_WEBHOOK_POOL_MAX`).
 * - **`billing-sync`** — VPC 안 · DB 롤 `atmark_billing`(`atmark/db/billing`) · sync API 키 읽기 · 결제 큐 소비(batch 1 · 부분 실패 보고 ·
 *   최대 동시성 미지정 — 예약 1 이 상한) · 예약 1 × 풀 1. reconcile 은 같은 함수를 Scheduler 가 15분마다 `{"action":"reconcile"}` 로 부른다(재시도 0 — 다음 틱이 잇는다).
 * - admin 은 admin API 키(거래 생성·포털)를 읽고, migrate 는 결제 DB 비밀 둘을 쓴다(bootstrap-roles).
 * - **결제 스위치** `atmark:billingEnabled`(기본 `BILLING_ENABLED_DEFAULT = false` — fail-closed)와 Paddle 환경(`PADDLE_ENVIRONMENT_DEFAULT`,
 *   지금 `sandbox`)이 admin·sync 환경으로 간다. 웹훅은 스위치를 모른다(꺼도 수신은 계속 — 큐에 14일).
 *
 * ## 운영자 콘솔 `ops.atmark.ai`(ADR-0015 · `.omc/plans/ops-console.md` §3.1) — 이름·한도는 `src/ops/contract.ts` 에서 온다
 *
 * - **`ops` λ(`atmark-ops`)** — VPC 안 · 256MB · 10초 · 예약 `OPS_RESERVED_CONCURRENCY`(2) × 풀 `OPS_POOL_MAX`(1). DB 롤 `atmark_ops`
 *   (도메인 표 쓰기 GRANT 0 — 특권 전이는 소유자 소유 definer 로만). 컨텍스트 **`atmark:opsLocked=true`** 면 예약을 **0** 으로 고정한다
 *   (하드 킬 스위치를 배포 너머로 유지 — 다음 배포가 동시성을 되살리지 못하게. 런북 `docs/runbooks/ops-console.md`).
 * - **역할 `atmark-runtime-ops`** — 로그·ENI(관리형 둘) · `GetSecretValue` 둘(`atmark/db/ops` · `atmark/ops-keys`) · login-mailer 깨우기
 *   (`lambda:InvokeFunction` on 그 ARN 하나 — admin 과 같은 문장). **SES · S3 · KMS · 로그인 키(`owner-login-keys`·`ops-login-keys`) ·
 *   다른 DB 비밀 0.** 코드 파생 키(`atmark/ops-login-keys`)는 login-mailer 만 읽는다(결정 C2 — ops λ 탈취 ≠ 코드 위조). 발송 주체 수는
 *   그대로 2 다(Layer E `mustEqual: 2` — 운영자 코드 메일도 login-mailer 가 `login@` 으로 보낸다, ADR-0006 추가 절).
 * - **HTTP API `atmark-ops`** — 통합은 ops λ 하나. 라우트 = `$default` + 인증 넷(`OPS_ROUTES`, 요청 1 rps / 버스트 5 · 검증 3 / 10 — 버킷을 따로),
 *   `$default` 10 / 20. **스로틀은 요청자별이 아니라 계정 전체다(H12)** — 인증 라우트 홍수는 운영자 전원의 로그인을 막는다. break-glass 는
 *   CLI 와 `pnpm ops`(재개방 조건 A2: CloudFront+WAF). 접근 로그에 **IP 를 남기지 않는다**(운영자 위치 = PII).
 * - **입구** — `opsDomain` prop(인증서 `AtmarkOpsCertificate` 발급 뒤 · `app.ts` 가 `opsDomainReadyOf` = 컨텍스트 ?? `OPS_DOMAIN_READY_DEFAULT` 일 때만 넘긴다)이
 *   있으면 커스텀 도메인 + execute-api 기본 엔드포인트 **끔**. 그 전(롤아웃 §5 2단계)에는 execute-api 호스트가 열려 있지만 λ 가
 *   **Host ≠ `ops.atmark.ai` 이면 421** 로 거절한다(`src/ops/hosted/` — W-APP) · 그 단계의 DB 비밀은 자리표시라 모든 요청이 503 이다.
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import { PADDLE_ENVIRONMENT_DEFAULT } from '../../../src/billing/constants';
import { DOMAIN_POLICY_AUDIT_SCHEDULE_INPUT, DOMAIN_POLICY_AUDIT_TRIGGER_EVENTS } from '../../../src/domains/policy-shape';
import {
  DOMAIN_TICK_INTERVAL_MS,
  IDENTITY_MANAGED_TAG,
  IDENTITY_MANAGED_TAG_VALUE,
  IDENTITY_PLATFORM_TAG,
  IDENTITY_PLATFORM_TAG_VALUE,
  IDENTITY_ROW_TAG,
} from '../../../src/domains/contract';
import { OPS_ENV, OPS_HANDLER_NAME, OPS_RESERVED_CONCURRENCY, OPS_ROUTES, OPS_SECRET_NAMES } from '../../../src/ops/contract';
import {
  AI_WATCH_DB_SECRET_NAME,
  AI_WATCH_ENV,
  AI_WATCH_QUEUES,
  AI_WATCH_RESULT_BATCH_SIZE,
  AI_WATCH_RESULT_HANDLER_NAME,
  AI_WATCH_RESULT_RESERVED_CONCURRENCY,
  parseAiWatchMode,
  type AiWatchMode,
} from '../../../src/inbound/ai-watch/contract';
import { AI_WATCH_IAM_ACTIONS } from '../ai-watch-iam';
import { AI_WATCH_RESULT_TIMEOUT_SECONDS, aiWatchQueueArn, aiWatchQueueUrl } from './ai-watch-stack';
import { RISK_HOLD_MODES, type RiskHoldMode } from '../../../src/policy/risk-signals';
import {
  REALTIME_ENV,
  REALTIME_HANDLER_NAME,
  REALTIME_PUBLIC_URL,
  REALTIME_RESERVED_CONCURRENCY,
} from '../../../src/realtime/contract';
import { parseFeatureRollout, ROLLOUT_ORGS_PREFIX } from '../../../src/runtime/feature-rollout';
import { SSM_DB_ROLE_SECRET_NAMES, ssmParameterNameOf } from '../../../src/runtime/ssm-secret-names';
import {
  CONTACT_ROUTING_ENV,
  CONTACT_ROUTING_MODES,
  isContactRouting,
  type ContactRouting,
} from '../../../src/contact/routing';
import {
  BILLING_SYNC_TIMEOUT_SECONDS,
  DB_BILLING_OPERATOR_SECRET_NAME,
  DB_BILLING_SECRET_NAME,
  PADDLE_ADMIN_API_KEY_SECRET_NAME,
  PADDLE_SYNC_API_KEY_SECRET_NAME,
  PADDLE_WEBHOOK_SECRET_NAME,
} from './billing-stack';
import {
  APPROVAL_LINK_KEYS_SECRET_NAME,
  CONTACT_FORWARD_TO_SECRET_NAME,
  DB_ADMIN_SECRET_NAME,
  DB_APP_SECRET_NAME,
  DB_LOGIN_MAILER_SECRET_NAME,
  DB_OWNER_SECRET_NAME,
  DB_PASSPORT_SIGNER_SECRET_NAME,
  OWNER_LOGIN_KEYS_SECRET_NAME,
  SECRET_PLACEHOLDER_VALUE,
} from './data-stack';
import { lambdaCodeOf, refuseStubDeployment, type LambdaCodeSource } from './lambda-code';
import { AGENT_KEYPAIR_SECRET_PREFIX } from './passport-stack';
import { denySesSendingInStack, exemptFromSesSendDeny } from './ses-send-deny';
import { denySsmDeleteInStack, grantSsmSecretRead, grantSsmSecretWrite } from './ssm-secrets';
import { TLOG_ANCHOR_DB_SECRET_NAME, TLOG_DB_SECRET_NAME } from './transparency-stack';
import { CONFIGURATION_SET_NAME } from './ses-stack';
import {
  INBOUND_ATTACHMENTS_PREFIX,
  INBOUND_PARSED_PREFIX,
  INBOUND_RAW_PREFIX,
  OUTBOUND_ATTACHMENTS_PREFIX,
  OUTBOUND_CONTENT_PREFIX,
  OUTBOUND_DRAFTS_PREFIX,
  OUTBOUND_UPLOADS_PREFIX,
} from './storage-stack';

/** domain-control 이 identity 에 다는 태그 키(계약) — 만들기 문장의 `aws:TagKeys` 조건(채택은 `atmark:row` 하나만). */
export const DOMAIN_IDENTITY_TAG_KEYS: readonly string[] = [IDENTITY_ROW_TAG, IDENTITY_MANAGED_TAG];

/** 발송 도메인. SES identity 이름이자 `ses:FromAddress` 조건의 꼬리다. */
export const SENDING_DOMAIN = 'atmark.ai';

/** `ses:FromAddress` 조건값. */
export const SES_FROM_ADDRESS_PATTERN = `*@${SENDING_DOMAIN}`;

/**
 * 로그인 메일 발신 주소 — login-mailer 역할의 `ses:FromAddress` **정확 일치** 조건값이자 발송 역할의 Deny 대상. 런타임 상수
 * `src/notify/owner-login-notifier.ts` `OWNER_LOGIN_FROM_ADDRESS` 와 같아야 한다(`test/unit/infra/compute-stack.test.ts`).
 */
export const LOGIN_MAILER_FROM_ADDRESS = `login@${SENDING_DOMAIN}`;

/**
 * 환영 메일 발신 주소(ADR-0006 2026-09-30 개정) — 지원 에이전트(`support@atmark.ai`)의 별칭 `onve@atmark.ai`. login-mailer 가 환영 메일을 이 주소로
 * 보내고(자격증명 없음), 회신은 지원 에이전트 수신함으로 온다. **발송 역할도 이 주소로 보낼 수 있다**(지원 에이전트의 별칭 — 관문을 지난다) — 두
 * 주체의 발신 주소가 겹치는 첫 주소다(리드 수용 — ADR-0006 M3(b) 트리거 ③). 대소문자·하위 주소·앞 글자 변형은 두 역할 모두 거부한다.
 */
export const WELCOME_MAIL_FROM_ADDRESS = `onve@${SENDING_DOMAIN}`;

/** login-mailer 역할의 `ses:FromAddress` StringEquals 값 — 정확히 이 둘. */
export const LOGIN_MAILER_FROM_ADDRESSES: readonly string[] = [LOGIN_MAILER_FROM_ADDRESS, WELCOME_MAIL_FROM_ADDRESS];

/**
 * 문의 주소이자 문의 전달의 발신 주소(US-009) — `src/contact/intake.ts` `CONTACT_ADDRESS` 와 같아야 한다
 * (`test/unit/infra/compute-stack.test.ts`). 발송 역할은 이 주소를 **contact-forwarder 함수에서만** 쓸 수 있다(명시 Deny).
 */
export const CONTACT_FORWARD_FROM_ADDRESS = `support@${SENDING_DOMAIN}`;

/**
 * **수신 전용 주소**(202609301540) — RFC 2142 `abuse@`·`postmaster@`. 운영자가 지원 에이전트에 별칭으로 붙이지만 **발신 주소는 될 수 없다** — 발송 역할의
 * 명시 Deny(`SesDenyReceiveOnlyFromAddress`, `StringEqualsIgnoreCase` — 대소문자 변형 포함, `+` 등 하위 주소는 정규형 밖 Deny 가 덮는다). login-mailer 는
 * 소문자 정확 일치 허용만이라 암묵 거부다. `src/identity/address.ts` `RECEIVE_ONLY_ADDRESSES` 와 같은 값(`test/unit/infra/compute-stack.test.ts`).
 * 예약 접미사 Deny(`SES_RESERVED_LOCAL_PARTS`)에는 넣지 않았다 — 예외 패턴이 78개 늘어 인라인 정책 상한(10,240)에 가까워진다. 앞에 제어문자가 붙은
 * 변형(`\vabuse@`)은 런타임 `assertHeaderSafe` 와 발송 전처리(수신 전용 판정은 정규형 소문자 비교)의 몫이다(ADR-0006 2026-09-30 개정 ②).
 */
export const SES_RECEIVE_ONLY_FROM_ADDRESSES: readonly string[] = [`abuse@${SENDING_DOMAIN}`, `postmaster@${SENDING_DOMAIN}`];

/**
 * 발송 역할의 **정규형 밖 발신 주소** Deny 패턴(`StringLike` — 대소문자 구분, ADR-0006 "2026-09-24 대소문자·하위 주소").
 *
 * `StringEquals`/`StringLike` 는 대소문자를 가린다 — `LOGIN@atmark.ai`·`Support@atmark.ai` 는 정확 일치 Deny 를 비켜 간다. IAM 에는
 * `StringLikeIgnoreCase` 가 없다(IAM 조건 연산자 표: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html#Conditions_String).
 * 그래서 거꾸로 묶는다: 발송 역할이 정당하게 쓰는 발신 주소는 전부 **소문자 정규형**이다 — 에이전트 로컬파트는
 * `AGENT_LOCAL_PART_PATTERN`(`[a-z0-9._-]`, `src/identity/address.ts`)·DB CHECK `address = lower(address)`, 시스템 주소는
 * `notify@`·`support@` 상수. 로컬파트에 그 밖의 문자가 **하나라도** 있으면 거부한다 — 대문자 26자(= 예약 주소의 모든 대소문자
 * 변형), `+`(하위 주소 `login+x@`·`support+x@`), 공백·따옴표·괄호·꺾쇠(RFC 5322 인용·주석·표시 이름 형태) 등 인쇄 가능 ASCII 특수문자.
 * `*`·`?`·`$` 는 IAM 와일드카드·변수 문자라 넣지 않았다(`${*}` 로 적을 수는 있으나 예약 주소와 시각적으로 닮지 않는다 — ADR 잔여).
 * 도메인 쪽 대소문자(`login@ATMARK.AI`)는 허용 문장 `*@atmark.ai`(대소문자 구분)에서 이미 떨어지고, 이 목록에도 걸린다.
 */
export const SES_NON_CANONICAL_FROM_PATTERNS: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `*${c}*`),
  ...[' ', '+', '"', '\'', '(', ')', '<', '>', ',', ';', ':', '\\', '[', ']', '!', '#', '%', '&', '/', '=', '^', '`', '{', '|', '}', '~'].map(
    (c) => `*${c}*`,
  ),
  // 로컬파트에 `@` 가 또 있으면(인용된 `"a@b"@atmark.ai` 등) — 정규형은 `@` 가 하나다.
  '*@*@*',
  // 2026-09-24 최종 검증 M3a — 접힘 공백(FWS)·제어문자(`\tlogin@`·`\r\n\tlogin@`·`\u000blogin@`)는 여기 적지 않는다: IAM API 는
  //   정책 문서에 **인쇄 가능 ASCII 만** 받는다(2026-09-24 운영 배포 실측 — `\t`·`\n`·`\r`·U+007F 패턴을 넣은 AtmarkCompute 가
  //   `policyDocument is invalid. It must contain only printable ASCII characters` 로 거부·롤백). 예약 주소 **앞**에 붙은 제어문자는
  //   `SES_RESERVED_SUFFIX_*`(앞 글자가 정규형 글자가 아니면 거부 — 글자를 적지 않고 판정)가 닫는다. 예약 주소 **사이**에 낀 제어문자는
  //   런타임 `assertHeaderSafe` 와 알람 10(`atmark-ses-from-mismatch`)의 몫이다(ADR-0006 M3 잔여).
];

/**
 * 예약 로컬파트(`login`·`support`·`onve`) — `SesDenyReservedSuffixFromAddress` 의 재료(M3a). 발송 역할이 정당하게 쓰는 발신 주소 중 이 둘로
 * **끝나는** 것은 예약 주소 자신(정확 일치 — 앞 글자 없음)과 에이전트 로컬파트(`[a-z0-9._-]` 로 끝나는 앞 글자 뒤에 오는 것)뿐이다.
 */
export const SES_RESERVED_LOCAL_PARTS: readonly string[] = ['login', 'support', 'onve'];

/** 에이전트 로컬파트 글자(`AGENT_LOCAL_PART_PATTERN` — `src/identity/address.ts`). 예약 접미사 앞에 와도 되는 글자는 이것뿐이다. */
export const SES_CANONICAL_LOCAL_PART_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-';

/**
 * 예약 주소 **앞에 무엇이든 한 글자 이상** 붙은 발신 주소(`StringLike` — `?` 는 정확히 한 글자). 정책에 적을 수 없는 제어문자
 * (`\v`·`\f`·NUL…)가 앞에 붙은 `\u000blogin@atmark.ai` 를 여기서 잡는다 — 그 글자를 적지 않고 "앞 글자가 정규형이 아니다" 로 판정한다.
 */
export const SES_RESERVED_SUFFIX_PATTERNS: readonly string[] = SES_RESERVED_LOCAL_PARTS.map((local) => `*?${local}@${SENDING_DOMAIN}`);

/**
 * 위 Deny 의 예외(`StringNotLike` — 값 목록 **전부**와 어긋날 때 참): 앞 글자가 정규형 글자면 에이전트 주소다(`xlogin@`·`my.support@`).
 * 에이전트 로컬파트 문법은 영숫자로 시작·끝나므로 예약 로컬파트로 끝나는 에이전트 주소의 앞 글자는 반드시 이 집합이다.
 */
export const SES_RESERVED_SUFFIX_CANONICAL_EXCEPTIONS: readonly string[] = SES_RESERVED_LOCAL_PARTS.flatMap((local) =>
  SES_CANONICAL_LOCAL_PART_CHARS.split('').map((c) => `*${c}${local}@${SENDING_DOMAIN}`),
);

/** 문의 전달 문서 접두사 — `src/contact/intake.ts` `CONTACT_DOCUMENT_PREFIX` 와 같은 값. inbound 가 쓰고 contact-forwarder 만 읽는다. */
export const CONTACT_DOCUMENT_PREFIX = 'contact/forward/';

/** 문의 전달 핸들러 — 발송 역할을 공유하는 다섯째 핸들러(주체 수는 그대로). */
export const CONTACT_FORWARDER_HANDLER = 'contact-forwarder';

/**
 * 예약 발송 본문 접두사 — `src/storage/object-store.ts` 의 `OUTBOUND_SCHEDULED_PREFIX` 와 같은 값
 * (`test/unit/infra/compute-stack.test.ts` 가 일치를 단언한다). storage-stack 은 이 접두사를 모른다 — SES 가 쓰지 않는다.
 */
export const OUTBOUND_SCHEDULED_PREFIX = 'outbound/scheduled/';

/** D1 계약의 핸들러 이름. `dist/lambda/<name>/index.js`. */
export const LAMBDA_HANDLERS = [
  'admin',
  'api',
  'login-mailer',
  'inbound',
  'ses-events',
  'approval-release',
  'approval-notifier',
  'approval-expiry',
  'webhook-dispatcher',
  'scheduled-sender',
  'migrate',
  'passport-signer',
  'contact-forwarder',
  'billing-webhook',
  'billing-sync',
  // 운영자 콘솔(ops.atmark.ai, ADR-0015) — 이름은 계약(`src/ops/contract.ts`)에서.
  OPS_HANDLER_NAME,
  // 고객 도메인 제어면(ADR-0014 단계 2) — DB 없음 · VPC 밖.
  'domain-control',
  // 고객 도메인 자원 정책 독립 감사(보안 리뷰 M2) — 읽기 전용 · DB 없음 · VPC 밖.
  'domain-policy-audit',
  // AI 의심 메일 감시 결과 소비자(ADR-0017 초안) — 이름은 계약(`src/inbound/ai-watch/contract.ts`)에서. 롤 atmark_ai_watch · SES 0 · S3 0.
  AI_WATCH_RESULT_HANDLER_NAME,
  // 실시간 WebSocket(묶음 E — `wss://realtime.atmark.ai`) — 이름은 계약(`src/realtime/contract.ts`)에서. 앱 롤 · 풀 1 · SES 0 · S3 0.
  REALTIME_HANDLER_NAME,
] as const;
export type HandlerName = (typeof LAMBDA_HANDLERS)[number];

/** SES 로 발송하는 핸들러. 이 다섯이 발송 역할 하나를 공유한다(머리말). `contact-forwarder` 는 US-009. */
export const SES_SENDING_HANDLERS: readonly HandlerName[] = [
  'api',
  'approval-release',
  'approval-notifier',
  'scheduled-sender',
  'contact-forwarder',
];

/**
 * 발송 역할의 물리 이름. **`scripts/check-ses-principals.sh` 가 실계정에서 보는 이름이고
 * `docs/ops/ses-principals-allowlist.json` 의 `runtimeRoles.allowed[].name` 과 같아야 한다.**
 */
export const SENDER_ROLE_NAME = 'atmark-runtime-sender';

/** 발송 역할의 CloudFormation 논리 ID — Layer E arch 테스트의 `EXPECTED_SES_SENDING_PRINCIPALS` 가 이 값을 본다. */
export const SENDER_ROLE_LOGICAL_ID = 'SesSenderRole';

/** 고객 도메인 제어면 핸들러(ADR-0014 단계 2). */
export const DOMAIN_CONTROL_HANDLER = 'domain-control';

/** domain-control 역할의 물리 이름 — 감사 EventBridge 규칙(observability)이 "이 역할 밖의 identity 변경" 을 이 이름으로 가른다. */
export const DOMAIN_CONTROL_ROLE_NAME = 'atmark-runtime-domain-control';

/** 자원 정책 독립 감사 핸들러·역할(보안 리뷰 M2). */
export const DOMAIN_POLICY_AUDIT_HANDLER = 'domain-policy-audit';
export const DOMAIN_POLICY_AUDIT_ROLE_NAME = 'atmark-runtime-domain-policy-audit';
/** 12시간마다 전수 감사(이벤트 감사의 그물 · 하트비트 — 하루 단위 결측 알람이 한 번 놓쳐도 울리지 않게 하루 두 번). */
export const DOMAIN_POLICY_AUDIT_SCAN_HOURS = 12;
export const DOMAIN_POLICY_AUDIT_SCHEDULE_NAME = 'atmark-domain-policy-audit';
export const DOMAIN_POLICY_AUDIT_RULE_NAME = 'atmark-domain-policy-audit-trigger';

/** 고객 도메인 틱 DB 롤 비밀(ADR-0014 단계 2) — **이 스택 소유**(`SECRET_PLACEHOLDER_VALUE` 자리표시 → migrate `bootstrap-roles` 가 채운다). */
export const DOMAIN_TICK_DB_SECRET_NAME = 'atmark/db/domain-tick';

/** CDK 컨텍스트를 읽는 노드(`app.node` · `stack.node`). */
export interface ContextNode {
  tryGetContext(key: string): unknown;
}

/** 컨텍스트 → 불리언 스위치. 없으면 `fallback`, 있으면 문자열 'true' 만 켬(오타는 꺼짐). */
export function contextFlagOf(node: ContextNode, key: string, fallback: boolean): boolean {
  const context: unknown = node.tryGetContext(key);
  return context === undefined ? fallback : String(context) === 'true';
}

/**
 * AI 의심 메일 감시(ADR-0017 초안 · 설계 ai-mail-watch §7.2) — 킬 스위치. inbound 환경 `ATMARK_AI_WATCH` = 컨텍스트 `atmark:aiWatch` ?? 이 기본값.
 * 롤아웃: off(어둠) → shadow(Chronostasis 만 · 보류·표시 0) → on(런북 ai-watch §7). 모르는 값은 synth 를 멈춘다(오타가 조용히 off 가 되지 않게 —
 * 런타임은 모르는 값을 off 로 읽지만, 배포 쪽은 사람이 고친다).
 */
export const AI_WATCH_MODE_DEFAULT: AiWatchMode = 'off';
export const AI_WATCH_MODE_CONTEXT_KEY = 'atmark:aiWatch';

export function aiWatchModeOf(node: ContextNode): AiWatchMode {
  const context: unknown = node.tryGetContext(AI_WATCH_MODE_CONTEXT_KEY);
  if (context === undefined) return AI_WATCH_MODE_DEFAULT;
  const parsed = parseAiWatchMode(String(context));
  if (!parsed.valid || String(context).trim() === '') {
    throw new Error(`${AI_WATCH_MODE_CONTEXT_KEY}=${String(context)} — off | shadow | on 중 하나여야 한다`);
  }
  return parsed.mode;
}

/**
 * 결과 큐(AtmarkAiWatch 소유) → 결과 λ 이벤트 소스 매핑을 만드는가. **AtmarkAiWatch 를 먼저 손으로 배포한 뒤에만** 켠다 — 큐가 없는 계정에 매핑을
 * 만들면 Compute 배포가 실패한다(다른 기능의 배포까지 막힌다). 값 = 컨텍스트 `atmark:aiWatchQueuesReady` ?? 이 기본값 — 붙인 배포가 끝나면 상수를
 * `true` 로 커밋한다(ops 도메인과 같은 규율 — 플래그를 빠뜨린 다음 배포가 매핑을 지우지 않게). 매핑이 없어도 결과는 결과 큐에 1일 남는다.
 * 2026-10-06 운영 AtmarkAiWatch 배포 뒤 true 로 굳힘(ai-watch 런북 7-2).
 */
export const AI_WATCH_QUEUES_READY_DEFAULT = true;
export const AI_WATCH_QUEUES_READY_CONTEXT_KEY = 'atmark:aiWatchQueuesReady';

export function aiWatchQueuesReadyOf(node: ContextNode): boolean {
  return contextFlagOf(node, AI_WATCH_QUEUES_READY_CONTEXT_KEY, AI_WATCH_QUEUES_READY_DEFAULT);
}

/**
 * 고객 도메인 확인 틱 스케줄(계약 `DOMAIN_TICK_INTERVAL_MS` — 10분) → admin λ `{"task":"domain-recheck"}`. **기본 ENABLED(M5 에서 굳힘 — 런북
 * deploy §39)** — M1~M4 동안은 false 였다. 결제 스위치와 같은 규율이다. 관측 스택의 `atmark-domain-check-stale`(결측 = 위반) 액션도 같은 값에
 * 묶인다 — 스케줄이 꺼져 있는 동안 울리지 않게. 비상 정지는 `-c atmark:domainRecheckEnabled=false` 를 **두 스택에 같이**(문자열 'true' 가 아니면 꺼짐).
 */
export const DOMAIN_RECHECK_ENABLED_DEFAULT = true;
export const DOMAIN_RECHECK_ENABLED_CONTEXT_KEY = 'atmark:domainRecheckEnabled';
export const DOMAIN_RECHECK_SCHEDULE_NAME = 'atmark-domain-recheck';
export const DOMAIN_RECHECK_MINUTES = DOMAIN_TICK_INTERVAL_MS / 60_000;
/** admin λ 의 과제 이벤트 — 키 집합이 정확히 `{task}`(계획 §3.4 — 핸들러가 HTTP 이벤트와 엄격히 가른다, 단계 4). */
export const DOMAIN_RECHECK_INPUT = { task: 'domain-recheck' } as const;

/** 컨텍스트 → 확인 틱 스케줄 켜짐(문자열 'true' 만). observability-stack 도 이 함수를 쓴다(두 스택이 같은 값을 보게). */
export function domainRecheckEnabledOf(node: ContextNode): boolean {
  return contextFlagOf(node, DOMAIN_RECHECK_ENABLED_CONTEXT_KEY, DOMAIN_RECHECK_ENABLED_DEFAULT);
}

/**
 * 둘째 발송 주체 — 로그인 메일 역할의 물리 이름(ADR-0006). `scripts/check-ses-principals.sh` 가 실계정에서 보는 이름이고
 * `docs/ops/ses-principals-allowlist.json` 의 `runtimeRoles.allowed[].name` 과 같아야 한다.
 */
export const LOGIN_MAILER_ROLE_NAME = 'atmark-runtime-login-mailer';

/** 로그인 메일 역할의 논리 ID — Layer E 의 `EXPECTED_SES_SENDING_PRINCIPALS` 가 이 값을 본다. */
export const LOGIN_MAILER_ROLE_LOGICAL_ID = 'SesLoginMailerRole';

/**
 * 에이전트 키 보관(PP-A)을 하는 핸들러 — 관리 API 의 프로비저닝(`POST /admin/api/agents`). CLI 프로비저닝은 운영자 IAM 으로
 * 노트북에서 돈다(`scripts/admin/custody.ts`) — 이 스택의 역할이 아니다.
 */
export const PASSPORT_CUSTODY_HANDLER: HandlerName = 'admin';

/**
 * ★ 에이전트 개인키를 **복호**하는 유일한 핸들러(계획 §3.5 AC-e2, 계약 §3). 역할 `atmark-runtime-passport-signer` 만 `kms:Decrypt`(ViaService
 * 조건 **없이** — envelope 의 DEK 를 직접 푼다)와 `atmark/agent-keypairs/*` 읽기를 갖는다. SES 0 · 다른 비밀 0 · S3 는 identity 버킷의
 * `agents/*` PutObject 하나 · CloudFront 는 identity 배포의 CreateInvalidation 하나. 코드 쪽 대응물은 `src/passport/signer.ts`(복호하는 유일한 파일).
 */
export const PASSPORT_SIGNER_HANDLER: HandlerName = 'passport-signer';

/**
 * 서명 역할의 물리 이름 — 정의는 `passport-stack.ts` 에 있다(CMK 키 정책이 이 이름으로 직접 Decrypt 를 허용한다 — 스택 순서상
 * Passport 가 Compute 보다 먼저라 역할 ARN 을 참조할 수 없어 이름으로 맞춘다). 아래 `makeRole` 의 `atmark-runtime-${key}` 와 같아야 한다
 * (`passport-signer-stack.test.ts` 가 대조).
 */
export { PASSPORT_SIGNER_ROLE_NAME } from './passport-stack';

/** 서명 Lambda 가 쓰는 identity 버킷 접두사 — ADR-0002 가 동결한 `/agents/{agentId}/…`. */
export const IDENTITY_OBJECT_PREFIX = 'agents/';

/**
 * api HTTP API 의 라우트 단위 스로틀. 공개 신원 조회(`GET /v1/identity/{address}`, **무인증**)는 `$default` 와 **다른 버킷**을 쓴다 —
 * 신원 조회를 두드려도 에이전트 API(발송·수신)의 버킷이 줄지 않는다(계획 §4B.3 "레이트 리밋은 오리진 보호"). 요청자별 상한이 아니다
 * (HTTP API 에는 없다) — 앞단 CloudFront(`id.atmark.ai/v1/identity/*`, 캐시 5분)가 대부분을 흡수한다.
 */
export const API_ROUTE_THROTTLES: Readonly<Record<string, { readonly rateLimit: number; readonly burstLimit: number }>> = {
  'GET /v1/identity/{address}': { rateLimit: 5, burstLimit: 10 },
};

/**
 * 로그인·가입 화면이 홈(`atmark.ai`)으로 옮겼는가(US-003) — admin 환경 `ATMARK_AUTH_ON_SITE`(`src/admin/http.ts` `authOnSite`).
 * 켜면 콘솔의 비로그인 `/`·`/signup`·`/app` 이 `https://atmark.ai/login`·`/signup`(영어 `/en/…`)으로 302 한다. **기본 끔** —
 * 홈 스택 배포 + atmark.ai DNS 전환(Vercel → AWS) **뒤에만** 켠다(`docs/runbooks/site.md` §7). 한 번 켜 보려면
 * `-c atmarkAuthOnSite=true`, 굳히려면 이 상수를 `true` 로 바꿔 커밋한다(컨텍스트를 빠뜨린 다음 배포가 끄지 않게).
 */
export const CONSOLE_AUTH_ON_SITE_DEFAULT = false;
export const AUTH_ON_SITE_CONTEXT_KEY = 'atmarkAuthOnSite';

/**
 * 홈 출처(`https://atmark.ai`)의 교차 출처 로그인·가입 CORS 를 여는가 — admin 환경 `ATMARK_SITE_CORS`(`src/admin/http.ts` `siteCors`).
 * **기본 끔**(2026-09-24 검증 F2 — atmark.ai 가 아직 Vercel 인 동안 열면 그 호스트의 스크립트가 콘솔에 자격 포함 요청을 보낸다).
 * 리다이렉트 스위치와 **따로** 둔다: 순서는 콘솔 배포(둘 다 끔) → 홈 배포 → DNS 전환 → CORS 켬 → 리다이렉트 켬
 * (`docs/runbooks/site.md` §7.3). 한 번 켜 보려면 `-c atmarkSiteCors=true`, 굳히려면 이 상수를 `true` 로 바꿔 커밋한다.
 */
export const CONSOLE_SITE_CORS_DEFAULT = false;
export const SITE_CORS_CONTEXT_KEY = 'atmarkSiteCors';

/**
 * 결제 스위치(WP-2) — admin(체크아웃·포털 잠금) · billing-sync(꺼지면 reconcile 건너뜀) · site(`pay.atmark.ai` 404) 환경 `ATMARK_BILLING_ENABLED`.
 * **기본 끔**(fail-closed). 한 번 켜 보려면 `-c atmark:billingEnabled=true`, 샌드박스 E2E 가 통과하면 이 상수를 `true` 로 커밋해 굳힌다
 * (`CONSOLE_AUTH_ON_SITE_DEFAULT` 와 같은 규율 — 컨텍스트를 빠뜨린 다음 배포가 끄지 않게). site-stack 도 같은 키·기본값을 읽는다.
 */
export const BILLING_ENABLED_DEFAULT = false;
export const BILLING_ENABLED_CONTEXT_KEY = 'atmark:billingEnabled';

/** 컨텍스트 → 결제 스위치(문자열 'true' 만 켬). site-stack 도 이 함수를 쓴다(두 스택이 같은 값을 보게). */
export function billingEnabledOf(node: ContextNode): boolean {
  return contextFlagOf(node, BILLING_ENABLED_CONTEXT_KEY, BILLING_ENABLED_DEFAULT);
}

/**
 * 메일 기본기 2차(ADR-0013) **단계 공개** 플래그 — **전체 공개(2026-09-29, 테스트 조직 24시간 관측 뒤)**. 값은 `false` · `true`(전체) · `orgs:<uuid>[,<uuid>…]`(적힌 조직만 —
 * `src/runtime/feature-rollout.ts`). 테스트 조직부터: `-c atmark:addressAliasesEnabled=orgs:<TEST_ORG_ID>`(admin 별칭 API) ·
 * `-c atmark:outboundAttachmentsEnabled=orgs:<TEST_ORG_ID>`(api 발신 첨부). 계획 §6 2차 7단계 · 런북 deploy §23-2.
 * 굳히려면 상수를 그 값으로 커밋한다(결제 스위치와 같은 규율 — 컨텍스트를 빠뜨린 다음 배포가 닫지 않게). 틀린 값은 **합성이 멈춘다**.
 */
export const ADDRESS_ALIASES_ENABLED_DEFAULT: FeatureRolloutSetting = true;
export const ADDRESS_ALIASES_ENABLED_CONTEXT_KEY = 'atmark:addressAliasesEnabled';
export const OUTBOUND_ATTACHMENTS_ENABLED_DEFAULT: FeatureRolloutSetting = true;
/** 새 에이전트 정책의 첨부 총량 = "요금제를 따른다"(null) — admin 만. 새 코드가 모든 λ 에 배포된 뒤 켠다(보안 리뷰 M3 · 런북 deploy §23). */
export const POLICY_ATTACHMENT_FOLLOW_PLAN_DEFAULT = true;
export const POLICY_ATTACHMENT_FOLLOW_PLAN_CONTEXT_KEY = 'atmark:policyAttachmentFollowPlan';
export const OUTBOUND_ATTACHMENTS_ENABLED_CONTEXT_KEY = 'atmark:outboundAttachmentsEnabled';

/** 단계 공개 설정값 — 불리언이나 `orgs:<uuid>,…` 문자열(합성 때 `parseFeatureRollout` 로 검증). */
export type FeatureRolloutSetting = boolean | `${typeof ROLLOUT_ORGS_PREFIX}${string}`;

/**
 * 컨텍스트(없으면 상수) → 단계 공개 환경 값의 정규형(`false` · `true` · `orgs:<소문자 uuid>,…`). 런타임과 **같은 파서**다 — 런타임은 무효 값을
 * 꺼짐으로 읽지만(fail closed) 합성은 **던진다**: 오타가 조용히 "닫힘" 으로 배포되어 켰다고 믿는 일이 없게.
 */
export function featureRolloutOf(node: ContextNode, key: string, fallback: FeatureRolloutSetting): string {
  const context: unknown = node.tryGetContext(key);
  const raw = context === undefined ? String(fallback) : String(context);
  const parsed = parseFeatureRollout(raw);
  if (!parsed.ok) throw new Error(`${key} 은 false | true | orgs:<uuid>[,<uuid>…] 중 하나여야 한다(${parsed.reason}).`);
  return parsed.canonical;
}

/**
 * **문의 라우팅**(2026-09-30 — `src/contact/routing.ts`) — inbound · contact-forwarder 환경 `ATMARK_CONTACT_ROUTING`. 기본 `agent_and_notify`(2026-10-04 굳힘 — 운영 배포값과 같다. 그 전 2026-09-30 ~ `agent_and_forward`).
 * `forward`(support@ 는 전달만, 발송 역할의 `SesDenySupportFromOutsideForwarder` 유지)는 `-c atmark:contactRouting=forward` 로 되돌린다. `forward` 가 아니면 support@ 가 지원 에이전트의 수신함으로도 가고,
 * 에이전트가 support@ 로 회신해야 하므로 **그 Deny 를 뺀다**. 전환 이력과 되돌리기는 런북 deploy §29-4. **틀린 값은 합성이 멈춘다**(런타임은 `forward` 로 읽는다).
 */
export const CONTACT_ROUTING_CONTEXT_KEY = 'atmark:contactRouting';
// 2026-10-04 굳힘(진윤겸 · deploy §29-4): `agent_and_forward`(2026-09-30~) → `agent_and_notify` — 운영자 메일함은 알림만(제목 + 보낸 사람 도메인).
export const CONTACT_ROUTING_DEFAULT: ContactRouting = 'agent_and_notify';

/** 컨텍스트(없으면 상수) → 문의 라우팅. 틀린 값은 던진다. */
export function contactRoutingOf(node: ContextNode, fallback: ContactRouting = CONTACT_ROUTING_DEFAULT): ContactRouting {
  const context: unknown = node.tryGetContext(CONTACT_ROUTING_CONTEXT_KEY);
  const raw = context === undefined ? fallback : String(context);
  if (!isContactRouting(raw)) throw new Error(`${CONTACT_ROUTING_CONTEXT_KEY} 은 ${CONTACT_ROUTING_MODES.join(' | ')} 중 하나여야 한다.`);
  return raw;
}

/**
 * **위험 보류 킬 스위치**(ADR-0016 운영 — `src/policy/risk-signals.ts`) — 공통 환경 `ATMARK_RISK_HOLD_ENFORCE` = `observe` | `enforce`. 기본 `enforce`
 * (진윤겸 2026-10-04 — 고객 트래픽 전이라 관찰 기간 없이 강제로 시작). 끄려면(관찰) `-c atmark:riskHoldEnforce=observe` 로 compute 를 배포한다 — 운영자만
 * 쥔 스위치다(소유자·에이전트 설정 없음). **틀린 값은 합성이 멈춘다**(런타임도 틀린 값은 `enforce` 로 읽는다).
 */
export const RISK_HOLD_ENFORCE_CONTEXT_KEY = 'atmark:riskHoldEnforce';
export const RISK_HOLD_ENFORCE_DEFAULT: RiskHoldMode = 'enforce';

/** 컨텍스트(없으면 상수) → 위험 보류 모드. 틀린 값은 던진다. */
export function riskHoldEnforceOf(node: ContextNode, fallback: RiskHoldMode = RISK_HOLD_ENFORCE_DEFAULT): RiskHoldMode {
  const context: unknown = node.tryGetContext(RISK_HOLD_ENFORCE_CONTEXT_KEY);
  const raw = context === undefined ? fallback : String(context);
  if (raw !== 'observe' && raw !== 'enforce') throw new Error(`${RISK_HOLD_ENFORCE_CONTEXT_KEY} 은 ${RISK_HOLD_MODES.join(' | ')} 중 하나여야 한다.`);
  return raw;
}

/**
 * **격리 알림 킬 스위치**(ADR-0016 2026-10-07 개정 — `src/notify/quarantine-notifier.ts`) — approval-notifier 함수의 환경 `ATMARK_QUARANTINE_NOTICE` =
 * `on` | `off`. 기본 `on`. 끄려면 `-c atmark:quarantineNotice=off` 로 compute 를 배포한다(운영자만). **틀린 값은 합성이 멈춘다.**
 */
export const QUARANTINE_NOTICE_CONTEXT_KEY = 'atmark:quarantineNotice';
export const QUARANTINE_NOTICE_DEFAULT = 'on';

/** 컨텍스트(없으면 상수) → 격리 알림 스위치. 틀린 값은 던진다. */
export function quarantineNoticeOf(node: ContextNode): 'on' | 'off' {
  const context: unknown = node.tryGetContext(QUARANTINE_NOTICE_CONTEXT_KEY);
  const raw = context === undefined ? QUARANTINE_NOTICE_DEFAULT : String(context);
  if (raw !== 'on' && raw !== 'off') throw new Error(`${QUARANTINE_NOTICE_CONTEXT_KEY} 은 on | off 중 하나여야 한다.`);
  return raw;
}

/** 발신 DLP 지문 키(ADR-0016 B) — **이 스택 소유**, 값은 CloudFormation 이 만든다(64자 영숫자 → 런타임이 kid `g1` 로 읽는다). 회전은 런북 deploy §. */
export const DLP_KEYS_SECRET_NAME = 'atmark/dlp-keys';

/**
 * 환영 메일 스위치(W2 — login-mailer 환경 `ATMARK_WELCOME_MAIL_ENABLED`, 런타임은 `readFeatureFlag`). **기본 끔.** 한 번 켜 보려면
 * `-c atmark:welcomeMailEnabled=true`, 굳히려면 상수를 커밋한다. 발신 주소 `onve@atmark.ai` 는 login-mailer 역할이 스위치와 무관하게 허락한다.
 */
// 2026-09-30 켬(진윤겸 · deploy §30-4): support@ · onve@ 답장 경로 스모크 초록 뒤.
export const WELCOME_MAIL_ENABLED_DEFAULT = true;
export const WELCOME_MAIL_ENABLED_CONTEXT_KEY = 'atmark:welcomeMailEnabled';

/** 컨텍스트 → 기능 플래그 문자열('true' 만 켬). */
export function featureFlagOf(node: ContextNode, key: string, fallback: boolean): 'true' | 'false' {
  return contextFlagOf(node, key, fallback) ? 'true' : 'false';
}

/**
 * Domain Connect(고객 도메인 DNS 자동 입력 — `src/domains/dc-url.ts` · ADR-0014 "Domain Connect") 서명 키. **이 스택 소유** · RSA_2048 ·
 * SIGN_VERIFY · RETAIN(키를 잃으면 `_dcpubkeyv2` 로 회전 — 런북 deploy §Domain Connect). `kms:Sign`·`GetPublicKey` 는 admin 역할 하나(IAM) ·
 * 키 정책 Deny 가 다른 주체의 Sign 을 막는다(넓은 IAM 으로도 뒤집히지 않게 — 투명성 로그 키와 같은 모양).
 */
export const DOMAIN_CONNECT_KEY_ALIAS = 'alias/atmark-domain-connect-signing';
export const DENY_SIGN_EXCEPT_ADMIN_SID = 'DenySignExceptConsoleAdminRole';
/**
 * Domain Connect 스위치(admin 환경 `ATMARK_DOMAIN_CONNECT_ENABLED`). **기본 끔** — Cloudflare 온보딩(템플릿 병합 · 공개키 TXT) 뒤
 * `-c atmark:domainConnectEnabled=true` 로 배포해 보고, 굳히려면 상수를 커밋한다. 꺼져 있으면 `GET /api/domains/{id}/connect` 는 `{supported:false}`.
 */
export const DOMAIN_CONNECT_ENABLED_DEFAULT = false;
export const DOMAIN_CONNECT_ENABLED_CONTEXT_KEY = 'atmark:domainConnectEnabled';

/** 결제 웹훅 HTTP API 의 라우트 — Paddle 알림 목적지 URL 의 경로(`BillingWebhookUrl` 출력). */
export const BILLING_WEBHOOK_ROUTE_PATH = '/paddle/webhook';

/** 결제 웹훅 HTTP API 스로틀 — Paddle 재시도(운영 첫 1시간 20회)와 여유. 넘으면 사건이다. */
export const BILLING_WEBHOOK_THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;

/**
 * 웹훅 λ 타임아웃(초) — Paddle 은 **5초 안의 200** 을 성공으로 본다(계획 §0 P5). 그보다 오래 걸린 응답은 어차피 실패로 재시도되므로
 * 더 기다리지 않는다.
 */
export const BILLING_WEBHOOK_TIMEOUT_SECONDS = 5;

/** reconcile 틱(분) — 커서를 이어 가는 하루 1회 대조(계획 §3-5). */
export const BILLING_RECONCILE_MINUTES = 15;

export const LAMBDA_LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/** API GW HTTP API 의 통합 한도는 30초다. Lambda 가 먼저 끝나야 자기 결말을 로그에 남긴다. */
export const API_TIMEOUT_SECONDS = 25;

/** `approve` 라우트 경로 — `src/api/routes/approval-link.ts`. */
export const APPROVAL_PAGE_PATH = '/approve';

type RoleKey =
  | 'billing-webhook'
  | 'billing-sync'
  | 'sender'
  | 'login-mailer'
  | 'inbound'
  | 'ses-events'
  | 'approval-expiry'
  | 'webhook-dispatcher'
  | 'migrate'
  | 'admin'
  | 'passport-signer'
  | 'ops'
  | 'domain-control'
  | 'domain-policy-audit'
  | 'ai-watch-result'
  | 'realtime';

interface HandlerSpec {
  readonly role: RoleKey;
  readonly memoryMb: number;
  readonly timeout: cdk.Duration;
  readonly description: string;
}

/**
 * 메모리·타임아웃 판단.
 * - `inbound` 1024MB/180s: 원문 최대 40 MiB — 버퍼 + MIME 파싱 사본 + base64 디코드가 겹친다. 큐 가시성 300s 보다 짧아야 한다.
 * - `api` 1024MB/25s: HTTP API 통합 한도 30s. 1024MB 인 이유는 첨부 PDF 읽기(`src/api/attachment-content.ts` ②) — 워커 스레드를 띄우고
 *   푸는 일이 CPU 에 묶이는데 λ 의 CPU 는 메모리에 비례한다(512MB 는 vCPU 의 1/3 쯤). 그리고 해석 중 RSS 천장(640MiB)과 그 위의 여유를
 *   둘 자리다(512MB 에서는 천장을 둘 수 없다).
 * - 1분 주기 워커 50s: 다음 틱 전에 끝난다(겹쳐도 DB 클레임이 중복을 막지만 겹치지 않는 편이 로그가 읽힌다).
 * - `ses-events` 30s: 큐 가시성(`ses-stack.ts` 180s)보다 짧아야 하고, 예약 동시성(1) < SQS 최대 동시성(2)이라 가시성 ≥ 6 × 이 값이어야 한다.
 * - `migrate` 300s: DDL + 롤 생성. 수동 invoke 다.
 */
/**
 * **핸들러별 예약 동시성 — RDS 연결 한도를 지키는 유일한 장치.**
 *
 * db.t4g.micro 의 `max_connections` 는 약 80 이다(메모리 기반 기본식). 각 Lambda 실행 환경은 풀 하나(`DB_POOL_MAX` = 3,
 * `src/runtime/composition.ts`)를 쥐고, migrate·login-mailer 는 1, admin 은 2 다. 예약 동시성이 없으면 트래픽이 몰리는 순간 실행 환경이
 * 무한히 늘어 연결이 고갈되고 **발송·수신·승인이 전부 동시에 멈춘다** — 그리고 워밍업 캡·승인 같은 제동장치가
 * 전부 DB 에 있으므로, 멈춘 동안 무엇도 판단되지 않는다.
 *
 * 풀 3 인 함수(api 7 + inbound 5 + ses-events·approval-release·approval-notifier·approval-expiry·webhook-dispatcher·scheduled-sender 1 씩)
 * 19 × 3 = 57 (+ migrate 1 × 1 + admin 3 × 2 + login-mailer 1 × 1 + passport-signer 1 × 1 + contact-forwarder 1 × 1 + **billing-sync 1 × 1** +
 * **billing-webhook 2 × 0** + **ops 2 × 1**) = **70**, 여기에 투명성 로그 두 함수(AtmarkTransparency — log 1 × 1 + anchor 1 × 1) = **72 ≤ 75** < 80 에서
 * 운영자 접속(SSM 포트 포워딩) 몇 개의 여유를 둔다(테스트가 고정한다 — `compute-stack.test.ts` 는 이 스택 70, `transparency-stack.test.ts` 는 합 72).
 * **남은 2 는 org-api 전용 Lambda 몫이다**(ADR-0010 L5 후속) — 다른 데 쓰지 않는다. **72 → 73(2026-10, ADR-0014 단계 4 · 리드 결정)**: admin λ 안의
 * 고객 도메인 확인 틱이 틱 롤 풀 하나(`DOMAIN_TICK_POOL_MAX` = 1 — 스케줄러만 부르고 이벤트마다 열고 닫는다)를 쓴다. `atmark_ops` 롤의 CONNECTION LIMIT 3
 * (= 예약 2 + 여유 1, `OPS_ROLE_CONNECTION_LIMIT`)이 설정이 어긋난 날의 여유 1 을 더해도 74 ≤ 75 다.
 * **api 7 · AI 감시 결과 1(2026-10-06, ADR-0017 초안 · 보안 리뷰 L10 · 리드 결정):** AI 의심 메일 감시 결과 λ(`ai-watch-result`, 예약 1 × 풀 1 —
 * `atmark_ai_watch` 롤 CONNECTION LIMIT 2 = 예약 1 + 재배포 여유 1, 풀 idle 5초)에 연결 1 을 내주면서 api 8 → 7(−3). 합: 이 스택 69(위 산식 − 3 + 틱 1 + 결과 1) + 투명성 2 = **71**,
 * `atmark_ops` 여유 1 을 더해 72/75 — 결과 롤의 재배포 여유 1 까지 겹쳐도 73 ≤ 75. org-api 몫 2 는 그대로 남는다. api 7 에서 모자라면 알람 #35(`atmark-api-throttles`)가 먼저 운다.
 * **실시간 1(2026-10-08, 묶음 E):** 실시간 WebSocket λ(`atmark-realtime`, 예약 1 × 풀 1 · 유휴 5초 — 앱 롤)에 연결 1 을 낸다 — **org-api 몫 2 → 1**
 *   (api 7 을 더 줄이면 3 이 빠진다 — 연결 하나를 위해 REST 처리량을 깎지 않았다). 합: 이 스택 70 + 투명성 2 = **72**, `atmark_ops` 여유 1 · 결과 롤 재배포 여유 1 을
 *   더해 74 ≤ 75. 대안(api λ 재사용)을 택하지 않은 까닭: WebSocket `$default` 홍수가 api 예약 7 을 먹어 REST 가 스로틀되고, 인터넷에 열린 연결 처리기가
 *   SES 발송 역할을 쥐게 된다. 이 λ 의 역할은 앱 DB 비밀 읽기 하나뿐이다(SES 0 · S3 0 · `@connections` 0).
 * **api 8 · ops 2(2026-09-28, 9 → 8 · 리드 결정 · ADR-0015):** 호스팅 운영자 콘솔 λ(`atmark-ops`, 2 × 풀 1)에 연결 2 를 내주고 org-api 몫 2 를
 *   남기려고 api 에서 3 을 뗐다(9 × 3 = 27 → 8 × 3 = 24). `atmark:opsLocked=true` 면 ops 는 0 이다(하드 킬 스위치 — 연결 68).
 *   api 8 에서 모자라면 스로틀이 먼저 나고 알람 #35(`atmark-api-throttles`)가 운다.
 * **api 9(2026-09-25, 10 → 9 · 진윤겸 결정 · WP-2):** 결제 sync 함수(`atmark_billing` 롤)에 연결 1 을 내주고 org-api 몫 2 를 남기려고 api 에서 3 을
 * 뗐다. api 는 에이전트 한 명당 요청이 드물고(발송·수신 조회) 스로틀(20 rps)이 먼저 막는다 — 9 에서 모자라면 503 이 난다(알람 없음 · 로그).
 * **admin 3(2026-09-25, 2 → 3):** 콘솔 v4 가 첫 화면에서 API 를 여러 개 한꺼번에 불러 예약 2 에서 `/api/me`·`/api/logs` 가
 * 503("Lambda function is being throttled")으로 떨어졌다(운영 실측). 클라이언트도 동시 요청을 2 로 줄이고 GET 503·429 를 재시도한다
 * (`src/admin/ui/console/script/core.ts` `api()`) — 3 은 그 위의 여유 하나다.
 * login-mailer 는 1분 틱 + admin 의 깨우기(비동기) — 1 이면 겹치지 않는다(겹쳐도 DB 클레임이 중복을 막는다). 도는 동안 온 깨우기는 스로틀되고
 * Lambda 비동기 큐가 1초부터 늘려 가며 다시 부른다(최대 이벤트 나이 1분 — 아래 `configureAsyncInvoke`).
 *
 * **`ses-events` 1(2026-09-24, 2 → 1 · 리드 결정 ①):** 투명성 로그의 앵커를 별도 함수·역할로 나누는 데 연결 1 이 필요했다(M5 — ADR-0008
 * §9.2 ①). 이 소비자는 SES 이벤트(배달·반송·신고)를 DB 에 적을 뿐이라 늦어져도 발송·수신·승인은 멈추지 않는다 — 큐가 잠시 쌓일 뿐이다.
 * 대가: SQS 이벤트 소스의 최대 동시성은 최소 2(`SQS_MAX_CONCURRENCY`)라 예약 1 보다 크다 — 두 번째 배치는 **스로틀**된다. Lambda 는
 * 스로틀된 배치를 가시성 창 안에서 다시 부르므로, 큐 가시성을 함수 타임아웃의 6배 이상(`ses-stack.ts` 180s ≥ 6 × 30s)으로 둬 재시도가
 * 수신 횟수(→ DLQ)로 새지 않게 한다(AWS Lambda 개발자 안내서 "SQS 이벤트 소스 — 가시성 제한 시간" · 테스트가 고정).
 * 이 값은 **끌 수 없다**(플래그 없음) — 계정 동시 실행 할당량이 부족하면 배포가 거부되며, 그때는 할당량을 올린다
 * (`docs/runbooks/deploy.md` 사전 점검). 보호 장치를 끌 수 있게 만들면 할당량이 부족한 날 누군가 끈다.
 */
export const RESERVED_CONCURRENCY: Readonly<Record<HandlerName, number>> = {
  // 3 × 풀 2(`ADMIN_POOL_MAX`) = 6 — 위 머리말 "admin 3". 연결 합은 72 / 75(남은 2 는 org-api 전용 λ 몫).
  admin: 3,
  // 7(2026-10-06, 8 → 7) — 위 머리말 "api 7 · AI 감시 결과 1". 결제 sync 연결 1 · ops 2 · AI 감시 결과 1 · org-api 몫 2.
  api: 7,
  'login-mailer': 1,
  inbound: 5,
  // 1 — 위 머리말 "ses-events 1". 처리 지연만 는다(큐 가시성 180s ≥ 6 × 타임아웃).
  'ses-events': 1,
  'approval-release': 1,
  'approval-notifier': 1,
  'approval-expiry': 1,
  'webhook-dispatcher': 1,
  'scheduled-sender': 1,
  migrate: 1,
  // 1 — 서명·게시는 에이전트당 처리 중 요청 1개(outbox)이고, 동시 실행이 둘이면 SKIP LOCKED 가 막아도 KMS·S3 호출만 늘어난다.
  'passport-signer': 1,
  // 1 × 풀 1(`CONTACT_FORWARDER_POOL_MAX`) — 1분 틱에 순차 처리. 문의 창구에 그 이상이 필요하지 않다.
  'contact-forwarder': 1,
  // 2 × 풀 0(`BILLING_WEBHOOK_POOL_MAX`) — DB 가 없다. 서명 검증 + SendMessage 한 번이라 호출 하나가 수십 ms 다. 상한은 비용·남용 차단용.
  'billing-webhook': 2,
  // 1 × 풀 1(`BILLING_SYNC_POOL_MAX`) — 조직 재계산이 겹치지 않게 직렬. SQS(최대 동시성 미지정 — 새 매핑은 예약보다 큰 상한을 거부한다)와 reconcile 틱이 이 1 을 나눈다(넘친 폴링은 스로틀 → 가시성 창 안에서 재시도).
  'billing-sync': 1,
  // 2 × 풀 1(`OPS_POOL_MAX`) — 운영자 콘솔(ADR-0015). 클라이언트는 동시 요청 2 · GET 429·503 재시도. `atmark:opsLocked=true` 면 0(생성자에서).
  ops: OPS_RESERVED_CONCURRENCY,
  // 2 × 풀 0 — 고객 도메인 제어면(ADR-0014 결정 3 · 계획 §3.5). DB 가 없다(연결 예산 그대로 72). 부르는 쪽은 틱 하나(10분)라 2 면 겹침까지 흡수한다.
  //   사고 대응의 봉쇄는 이 값을 0 으로(`put-function-concurrency` — 계획 §3.14).
  'domain-control': 2,
  // 1 × 풀 0 — 정책 이벤트마다 · 하루 한 번 전수. 읽기만 한다(겹쳐도 해가 없다 — 스로틀된 이벤트는 비동기 재시도가 잇는다).
  'domain-policy-audit': 1,
  // 1 × 풀 1(`AI_WATCH_RESULT_POOL_MAX`) — AI 의심 메일 감시 결과(ADR-0017 초안). 판정 하나 = DEFINER 호출 하나(수 ms)라 직렬로 충분하다.
  //   연결은 api 8 → 7 로 마련했다(위 머리말 — 합 71, ops 여유 포함 72 ≤ 73).
  [AI_WATCH_RESULT_HANDLER_NAME]: AI_WATCH_RESULT_RESERVED_CONCURRENCY,
  // 1 × 풀 1(`REALTIME_POOL_MAX`) — 실시간 WebSocket(묶음 E, 위 머리말 "실시간 1"). `$connect`·`$disconnect`·`$default` 는 수 ms 다(넘친 호출은 스로틀 —
  //   클라이언트가 백오프로 다시 연결한다). 연결 1 은 org-api 몫 2 에서 하나를 썼다(합 72/75).
  [REALTIME_HANDLER_NAME]: REALTIME_RESERVED_CONCURRENCY,
};

/**
 * 하드 킬 스위치의 배포 쪽 절반(계획 §5 · I-5) — `-c atmark:opsLocked=true` 면 ops λ 의 예약 동시성을 **0** 으로 고정한다(호출 전부 스로틀).
 * `ops_settings.hard_locked` + `ops-role-lock`(NOLOGIN)과 함께 쓴다. **값 = 컨텍스트 ?? `OPS_LOCKED_DEFAULT`**(`opsLive` 와 같은 규율) —
 * 잠금이 며칠 넘게 갈 것 같으면 이 상수를 `true` 로 커밋해 굳힌다(플래그를 빠뜨린 다음 배포가 동시성을 2 로 되살리지 못하게 · 런북 ops-console §3-2).
 */
export const OPS_LOCKED_DEFAULT = false;
export const OPS_LOCKED_CONTEXT_KEY = 'atmark:opsLocked';

/** 컨텍스트 → ops 잠금. 컨텍스트가 없으면 `OPS_LOCKED_DEFAULT`, 있으면 문자열 'true' 만 잠근다(오타는 잠그지 않는다 — 잠금의 본체는 `hard_locked`·NOLOGIN). */
export function opsLockedOf(node: ContextNode): boolean {
  return contextFlagOf(node, OPS_LOCKED_CONTEXT_KEY, OPS_LOCKED_DEFAULT);
}

/**
 * ops 커스텀 도메인(`ops.atmark.ai`)을 Compute 에 붙이는가(롤아웃 §5 6단계 — 인증서 `AtmarkOpsCertificate` 가 ISSUED 된 뒤).
 * **값 = 컨텍스트 `atmark:opsDomainReady` ?? `OPS_DOMAIN_READY_DEFAULT`.** 도메인을 붙인 배포가 끝나면 이 상수를 `true` 로 **커밋**한다(deploy §24-2 6′) —
 * 그 뒤로는 플래그를 빠뜨린 배포가 도메인·매핑을 템플릿에서 빼 **삭제하는** 일이 없다. 끄는 것은 `-c atmark:opsDomainReady=false` 로만(의도가 보인다).
 */
export const OPS_DOMAIN_READY_DEFAULT = true;
export const OPS_DOMAIN_READY_CONTEXT_KEY = 'atmark:opsDomainReady';

/** 컨텍스트 → ops 도메인 붙임(`app.ts` 가 쓴다). 컨텍스트가 없으면 `OPS_DOMAIN_READY_DEFAULT`, 있으면 문자열 'true' 만. */
export function opsDomainReadyOf(node: ContextNode): boolean {
  return contextFlagOf(node, OPS_DOMAIN_READY_CONTEXT_KEY, OPS_DOMAIN_READY_DEFAULT);
}

/**
 * 실시간 커스텀 도메인(`realtime.atmark.ai`, 묶음 E)을 붙이는가 — 인증서 `AtmarkRealtimeCertificate` 가 ISSUED 된 뒤(deploy §46). **값 = 컨텍스트
 * `atmark:realtimeDomainReady` ?? `REALTIME_DOMAIN_READY_DEFAULT`(2026-10-08 도메인 배포 뒤 true).** 도메인을 붙인 배포가 끝나면
 * 이 상수를 `true` 로 **커밋**한다(ops 와 같은 규율 — 플래그를 빠뜨린 다음 배포가 도메인 · 매핑을 지우지 않게).
 */
export const REALTIME_DOMAIN_READY_DEFAULT = true;
export const REALTIME_DOMAIN_READY_CONTEXT_KEY = 'atmark:realtimeDomainReady';

export function realtimeDomainReadyOf(node: ContextNode): boolean {
  return contextFlagOf(node, REALTIME_DOMAIN_READY_CONTEXT_KEY, REALTIME_DOMAIN_READY_DEFAULT);
}

/** 실시간 WebSocket 스테이지 이름(`wss://…/v1` · 콜백 `https://…/v1`). `$default` 는 WebSocket 에 없다. */
export const REALTIME_STAGE_NAME = 'v1';

/** 실시간 스테이지 스로틀 — 계정 전체(핑 · 메시지 · 끊김). 예약 1 λ(호출 ≈ 10ms)가 감당하는 폭 안. */
export const REALTIME_STAGE_THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;
/** `$connect` 만 따로 낮게(인증 전 라우트 — ops 인증 라우트와 같은 결). 연결은 2시간에 한 번 · 재연결 백오프라 3/10 이면 넉넉하다. */
export const REALTIME_ROUTE_THROTTLES: Readonly<Record<string, { readonly rateLimit: number; readonly burstLimit: number }>> = {
  $connect: { rateLimit: 3, burstLimit: 10 },
};

/** `PostToConnection` 을 받는 역할(만드는 λ) — 수신 소비자 · 발송 역할(api 승인 링크) · admin(콘솔 풀기) · AI 감시 결과. 실시간 λ 자신은 없다. */
export const REALTIME_PRODUCER_ROLES = ['sender', 'inbound', 'admin', 'ai-watch-result'] as const satisfies readonly RoleKey[];
/** 콜백 URL 환경을 받는 함수 — 위 역할 중 실제로 미는 함수만(릴리스 워커들은 역할을 공유하지만 밀지 않는다 — 환경이 없으면 꺼짐). */
export const REALTIME_PRODUCER_HANDLERS = ['api', 'inbound', 'admin', AI_WATCH_RESULT_HANDLER_NAME] as const satisfies readonly HandlerName[];

/** ops HTTP API `$default` 스로틀(세션 API·페이지). 인증 라우트는 아래에서 따로 낮게 — 로그인 홍수가 이 버킷을 비우지 못한다. */
export const OPS_DEFAULT_THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;

/**
 * ops 인증 라우트 넷(`OPS_ROUTES` — 요청·검증·step-up 요청·step-up 검증) — 라우트마다 **따로** 버킷.
 * **계정 전체 버킷이다(H12)** — 요청자별 상한은 DB(`ops_login_attempts`)가 건다. 홍수 대응은 런북 `docs/runbooks/ops-console.md` §H12.
 *   - 요청 둘(코드 메일을 만든다) 1 rps / 버스트 5 — 이 버킷이 곧 코드 메일 총량의 바닥이라 올리지 않는다.
 *   - 검증 둘 3 rps / 버스트 10(2026-09-28 재확인 H12 · 1/5 에서) — 메일이 없고 DB 가 요청자별로 싸게 거절한다. 올린 만큼 한 요청자가
 *     버킷을 비우려면 더 빨리 두드려야 한다(1 → 3 rps 지속). 비용: 6 rps × 호출 ≈ 30ms ≈ 동시 실행 0.2(예약 2 중) · 연결 예산 그대로(2 × 풀 1).
 *     근본 해법(요청자별 스로틀)은 CloudFront+WAF — HTTP API 에는 WAF 를 직접 붙일 수 없다(ADR-0015 재개방 조건 A2).
 */
export const OPS_ROUTE_THROTTLES: Readonly<Record<string, { readonly rateLimit: number; readonly burstLimit: number }>> = {
  [`POST ${OPS_ROUTES.request}`]: { rateLimit: 1, burstLimit: 5 },
  [`POST ${OPS_ROUTES.verify}`]: { rateLimit: 3, burstLimit: 10 },
  [`POST ${OPS_ROUTES.stepUp}`]: { rateLimit: 1, burstLimit: 5 },
  [`POST ${OPS_ROUTES.stepUpVerify}`]: { rateLimit: 3, burstLimit: 10 },
};

const HANDLER_SPECS: Record<HandlerName, HandlerSpec> = {
  admin: {
    role: 'admin',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(API_TIMEOUT_SECONDS),
    description: 'Owner console API + pages (console.atmark.ai) - atmark_admin DB role, no SES, login mail via outbox',
  },
  'login-mailer': {
    role: 'login-mailer',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - owner login link mail only (from login@atmark.ai), atmark_login_mailer DB role',
  },
  api: {
    role: 'sender',
    memoryMb: 1024,
    timeout: cdk.Duration.seconds(API_TIMEOUT_SECONDS),
    description: 'HTTP API (send/reply/forward/transition, approvals, inbound view, /approve page)',
  },
  inbound: {
    role: 'inbound',
    memoryMb: 1024,
    timeout: cdk.Duration.seconds(180),
    description: 'SQS atmark-inbound-mail consumer - raw MIME parse, attachments, scanner, DB',
  },
  'ses-events': {
    role: 'ses-events',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(30),
    description: 'SQS atmark-ses-events consumer - SES sending events to DB (ADR-0004)',
  },
  'approval-release': {
    role: 'sender',
    memoryMb: 512,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - release approved outbound mail',
  },
  'approval-notifier': {
    role: 'sender',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - owner approval notification mail (no login keys)',
  },
  'approval-expiry': {
    role: 'approval-expiry',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(60),
    description: 'Scheduler 5min - expire pending approval requests',
  },
  'webhook-dispatcher': {
    role: 'webhook-dispatcher',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - deliver signed webhooks',
  },
  'scheduled-sender': {
    role: 'sender',
    memoryMb: 512,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - send due scheduled messages',
  },
  migrate: {
    role: 'migrate',
    memoryMb: 512,
    timeout: cdk.Duration.seconds(300),
    description: 'Manual invoke - DB migrations, role bootstrap',
  },
  'contact-forwarder': {
    role: 'sender',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - forward support@atmark.ai inquiries to the operator mailbox (secret destination only, from support@)',
  },
  'passport-signer': {
    role: 'passport-signer',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(50),
    description: 'Scheduler 1min - sign and publish agent passports to id.atmark.ai (only agent-key decryptor), atmark_passport_signer DB role, no SES',
  },
  'billing-webhook': {
    role: 'billing-webhook',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(BILLING_WEBHOOK_TIMEOUT_SECONDS),
    description: 'HTTP API atmark-billing - Paddle webhook signature check, enqueue to billing FIFO. No VPC, no DB, one secret, SQS SendMessage only',
  },
  'billing-sync': {
    role: 'billing-sync',
    memoryMb: 512,
    timeout: cdk.Duration.seconds(BILLING_SYNC_TIMEOUT_SECONDS),
    description: 'SQS atmark-billing-events.fifo consumer + Scheduler 15min reconcile - re-fetch from Paddle, recompute org entitlements, atmark_billing DB role',
  },
  ops: {
    role: 'ops',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(10),
    description: 'HTTP API atmark-ops - hosted operator console (ops.atmark.ai, ADR-0015). atmark_ops DB role (no domain writes), no SES/S3/KMS, kicks login-mailer',
  },
  'domain-control': {
    role: 'domain-control',
    memoryMb: 256,
    // 계약 `DOMAIN_CONTROL_INVOKE_TIMEOUT_MS`(10초) 보다 길게 — 부르는 쪽이 먼저 끊는다.
    timeout: cdk.Duration.seconds(12),
    description: 'Customer domain control plane (ADR-0014): SES identity/policy, authoritative DNS, RDAP. No VPC, no DB, no secrets. Invoked by admin only. SES send denied.',
  },
  'domain-policy-audit': {
    role: 'domain-policy-audit',
    memoryMb: 256,
    // 전수 감사 시간 예산(`DOMAIN_POLICY_AUDIT_BUDGET_MS` 240초) + 여유. 예산을 넘긴 identity 는 `unreadable` 위반으로 센다(조용히 건너뛰지 않는다).
    timeout: cdk.Duration.seconds(300),
    description: 'Independent read-only audit of SES identity policies (ADR-0014). SES Get/List only, no VPC, no DB, no secrets. CloudTrail policy events + 12h scan.',
  },
  [REALTIME_HANDLER_NAME]: {
    role: 'realtime',
    memoryMb: 256,
    timeout: cdk.Duration.seconds(10),
    description: 'WebSocket API atmark-realtime (realtime.atmark.ai) - $connect agent-token auth, $disconnect, $default ping. atmark_app DB role via definer functions only. No SES, no S3, no @connections.',
  },
  [AI_WATCH_RESULT_HANDLER_NAME]: {
    role: 'ai-watch-result',
    memoryMb: 256,
    // 결과 큐 가시성(AtmarkAiWatch) = 이 값 × 6 — 예약 1 이라 스로틀된 배치가 가시성 안에서 다시 온다(ses-events 와 같은 산식).
    timeout: cdk.Duration.seconds(AI_WATCH_RESULT_TIMEOUT_SECONDS),
    description: 'SQS atmark-ai-watch-result consumer (ADR-0017 draft) - Mac worker verdicts/heartbeats to DB via definer functions only, atmark_ai_watch DB role. No SES, no S3.',
  },
};

/**
 * 콘솔 HTTP API 스로틀(검증 M3). HTTP API 의 스로틀은 **클라이언트별이 아니다**(버킷 하나를 모두가 나눠 쓴다 — 요청자별 상한은
 * 앱이 `owner_login_requests` 로 건다). 그래서 버킷을 **나눈다**: 로그인 요청·검증은 사람이 몇 분에 한 번 누르는 경로라 낮게,
 * 나머지 `$default`(세션 API·kill-switch·페이지)는 높게. 로그인 라우트를 두드려도 `$default` 버킷은 줄지 않는다.
 * 남는 틈: `$default` 자체를 두드리는 것은 여전히 가능하다 — HTTP API 에는 WAF 를 붙일 수 없고, 막으려면 CloudFront+WAF 가
 * 앞에 서야 한다(ADR-0006 "남은 위험").
 */
export const CONSOLE_DEFAULT_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;
export const CONSOLE_ROUTE_THROTTLES: Readonly<Record<string, { readonly rateLimit: number; readonly burstLimit: number }>> = {
  // 로그인·가입·초대 **요청**(메일을 만든다)은 1/5 그대로 — 이 버킷이 곧 로그인·가입 메일 총량의 바닥이다(IP 를 많이 가진 쪽의 메일 폭탄 · SES 평판).
  // **검증** 둘은 5/10(2026-09-28 로그인 보안 재확인 I-5, 1/5 에서) — 계정 전체 버킷이라 한 요청자가 1 rps 만 두드려도 모두의 코드 입력이 막혔다.
  //   검증은 메일을 만들지 않고, 남용자는 DB 원장(`login_code_attempts` — (IP, 브라우저)당 15분 30 · IP 당 300)이 문장 다섯 개로 싸게 거절한다.
  //   비용(두 라우트 천장 10 rps): 호출 ≈ 25ms(DB 왕복 6~9 · 로컬 실측 트랜잭션 ≈ 2ms) → 동시 실행 ≈ 0.25(예약 3 중) · DB ≤ 90 문장/초 ·
  //   연결 예산 그대로(3 × 풀 2 = 6, 합 72/75) · 원장 ≤ 864k 행/일 < 보존 함수 2.88M 행/일(10 000 × 5분 스윕 288). 근본 해법(요청자별
  //   스로틀)은 CloudFront+WAF 다 — HTTP API 에는 WAF 를 붙일 수 없다(ADR-0006 "콘솔 스로틀").
  'POST /api/login': { rateLimit: 1, burstLimit: 5 },
  'POST /api/login/verify': { rateLimit: 5, burstLimit: 10 },
  // 셀프 가입(보안 검증 L2) — 익명 요청이 가입 메일·조직 생성으로 이어지는 경로다. 로그인과 같은 낮은 버킷을 **따로** 준다:
  //   가입 남용이 `$default`(kill-switch 포함)도, 로그인 버킷도 비우지 못한다. 요청자별 상한은 앱(`signup_requests`)·DB 함수가 건다.
  'POST /api/signup': { rateLimit: 1, burstLimit: 5 },
  'POST /api/signup/verify': { rateLimit: 5, burstLimit: 10 },
  // 대기자 명단 등록(2026-09-30 대기자 명단) — 익명 요청이 확인 메일로 이어진다. 가입 요청과 같은 낮은 버킷을 **따로**(`$default`·가입 버킷을 비우지 못하게).
  'POST /api/waitlist': { rateLimit: 1, burstLimit: 5 },
  // 초대 수락 1단계(확장성 P1 R-1) — 세션 전 익명 요청이 로그인 메일로 이어진다. 로그인과 같은 낮은 버킷을 따로.
  'POST /api/invites/claim': { rateLimit: 1, burstLimit: 5 },
  // 결제 체크아웃·포털(WP-2 보안 M-1) — 한 번 누를 때마다 Paddle API 를 부른다(거래 생성 · 포털 세션 · 구독 목록). 버킷을 **따로** 준다:
  //   체크아웃 남용이 Paddle 레이트(키 단위)·admin 예약 동시성·`$default`(kill-switch) 를 비우지 못한다. 이 버킷은 전 조직이 나눠 쓰므로
  //   1/3 이면 한 조직의 남용이 다른 조직의 결제를 막았다(보안 검증 N-1) — 조직별 남용은 앱이 막는다(조직 try-lock · 하루 10 거래). 그래서 5/10.
  'POST /api/billing/checkout': { rateLimit: 5, burstLimit: 10 },
  'POST /api/billing/portal': { rateLimit: 5, burstLimit: 10 },
  // 조직 API 키 표면(확장성 P1 R-6, `/org-api/v1/*`) — CI 가 부른다. `$default`(콘솔·kill-switch) 버킷을 비우지 못하게 따로.
  //   이 버킷은 **전 조직 합의 천장**이다(ADR-0010 후속 L5) — 조직 공정성은 admin Lambda 의 DB 창 계수(키당 60 · 조직당 120/분,
  //   `admin/org-api/rate-limit.ts`)가 맡는다. 천장은 **콘솔을 지키는 유일한 장치**라 좁게 둔다: admin Lambda 는 콘솔과 `/org-api` 가
  //   예약 동시성 3(`RESERVED_CONCURRENCY.admin`)을 나눠 쓰고, DB 연결 예산의 남은 2(73/75 — 2026-09-25 api 10 → 9 로 비웠다)는 아직 org-api 전용 λ 에 쓰지 않았다.
  //   풀 대기 상한(`admin/org-api/pool-wait.ts`)은 **호출 하나 안의** 대기를 줄일 뿐 실행 환경 수를 나누지 못한다 — 동시성 3 을 CI 가
  //   다 쥐면 콘솔은 스로틀(429)을 받는다. 그래서 rate 는 `$default` 의 절반 이하 · burst 는 `$default` 보다 좁게(테스트가 불변식으로
  //   건다). 올바른 해법(org-api 전용 Lambda)은 연결 예산을 다시 나눈 뒤다 — ADR-0010 "L5 후속 — org-api 전용 Lambda".
  'ANY /org-api/{proxy+}': { rateLimit: 10, burstLimit: 20 },
  // 폰트 라우트는 없다(배포 전 리뷰 M4) — 콘솔은 폰트를 사이트 출처(`https://atmark.ai/_fonts/…`)에서 받는다. admin λ(예약 동시성 3)는
  //   폰트 바이트를 싣지도 내지도 않는다.
};

/**
 * admin λ 로 들어오는 **모든 버킷의 합** 상한(배포 전 리뷰 L-2) — `$default` + 위 라우트 버킷 전부. 라우트를 하나 더하면 λ 로 들어오는 문이
 * 조용히 넓어진다(HTTP API 버킷은 라우트마다 따로다). 합이 이 값을 넘으면 테스트가 빨개진다 — 넓히려면 예약 동시성(`RESERVED_CONCURRENCY.admin`)·
 * DB 연결 예산과 함께 이 값을 의식적으로 올린다. 지금 = 20/40 + 로그인·가입·초대·대기자 요청 4 × 1/5 + 로그인·가입 검증 2 × 5/10 + 결제 2 × 5/10 +
 * org-api 10/20 = 54/120(2026-09-30 53/115 → 54/120 — 대기자 명단 요청 1/5 · 2026-09-28 45/105 → 53/115 — 검증 둘을 1/5 → 5/10, 위 `CONSOLE_ROUTE_THROTTLES` 의 비용 계산. 예약 동시성·연결 예산은 그대로).
 */
export const ADMIN_LAMBDA_BUCKET_CEILING = { rateLimit: 54, burstLimit: 120 } as const;

/**
 * login-mailer 틱의 입력 — `src/runtime/config.ts` `LOGIN_MAILER_EVENT_SOURCE.tick` 과 같은 값(infra 테스트가 대조한다). 핸들러는 모르는 입력을
 * 던지므로 틱 입력을 **명시**한다(입력 없는 Scheduler 호출의 본문 모양에 기대지 않는다). 깨우기(`atmark.kick`)는 admin 이 보낸다.
 */
export const LOGIN_MAILER_TICK_INPUT = { source: 'atmark.schedule' } as const;

/** EventBridge Scheduler 주기 — gate-readiness "배포 시 스케줄이 필요한 워커" 표. */
export const SCHEDULES: readonly { readonly handler: HandlerName; readonly minutes: number }[] = [
  { handler: 'approval-release', minutes: 1 },
  { handler: 'approval-notifier', minutes: 1 },
  { handler: 'login-mailer', minutes: 1 },
  { handler: 'approval-expiry', minutes: 5 },
  { handler: 'webhook-dispatcher', minutes: 1 },
  { handler: 'scheduled-sender', minutes: 1 },
  { handler: 'passport-signer', minutes: 1 },
  { handler: 'contact-forwarder', minutes: 1 },
];

/** SQS 소비자 동시성 상한(최솟값 2). DB 커넥션 예산(t4g.micro)을 지키는 쪽이 처리량보다 먼저다. */
export const SQS_MAX_CONCURRENCY = 2;

export interface ComputeStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  readonly mailBucket: s3.IBucket;
  readonly sesEventQueue: sqs.IQueue;
  readonly inboundQueue: sqs.IQueue;
  readonly secrets: {
    readonly dbMaster: secretsmanager.ISecret;
    readonly dbOwner: secretsmanager.ISecret;
    readonly dbApp: secretsmanager.ISecret;
    /** `atmark/db/admin` — admin Lambda 의 DB 롤(ADR-0006). */
    readonly dbAdmin: secretsmanager.ISecret;
    /** `atmark/db/login-mailer` — login-mailer Lambda 의 DB 롤(ADR-0006). */
    readonly dbLoginMailer: secretsmanager.ISecret;
    readonly approvalLinkKeys: secretsmanager.ISecret;
    readonly webhookSecretKeys: secretsmanager.ISecret;
    /** `atmark/owner-login-keys` — admin(검증)·login-mailer(토큰 발급) 둘만. 발송 역할은 읽지 못한다(ADR-0006). */
    readonly ownerLoginKeys: secretsmanager.ISecret;
    /** `atmark/db/passport-signer` — passport-signer Lambda 의 DB 롤(계약 §3). */
    readonly dbPassportSigner: secretsmanager.ISecret;
    /** `atmark/contact-forward-to` — 문의 전달 주소(US-009). contact-forwarder 함수만 읽는다(함수 단위 조건). */
    readonly contactForwardTo: secretsmanager.ISecret;
    /** `atmark/db/tlog` · `atmark/db/tlog-anchor` — 투명성 로그 DB 롤(ADR-0008, AtmarkTransparency). migrate 는 **쓰기만**(bootstrap-roles). */
    readonly dbTlog: secretsmanager.ISecret;
    readonly dbTlogAnchor: secretsmanager.ISecret;
    /** `atmark/db/ops` — ops λ 의 DB 롤(`atmark_ops`, ADR-0015). ops 가 읽고 migrate 가 쓴다(bootstrap-roles). */
    readonly dbOps: secretsmanager.ISecret;
    /** `atmark/ops-keys` — ops λ 만(세션·CSRF·요청자 키 파생). */
    readonly opsKeys: secretsmanager.ISecret;
    /** `atmark/ops-login-keys` — login-mailer 만(운영자 코드 파생, 결정 C2). ops λ 는 읽지 못한다. */
    readonly opsLoginKeys: secretsmanager.ISecret;
  };
  readonly passportKey: kms.IKey;
  /** `/atmark/*` SecureString 의 고객 관리형 키(AtmarkSecretsKey — `secrets-key-stack.ts`). 지정 역할만 SSM 경유로 푼다. */
  readonly ssmSecretsKey: kms.IKey;
  /** `id.atmark.ai` 문서 버킷(AtmarkIdentityCdn) — 서명 Lambda 만 `agents/*` 에 쓴다. */
  readonly identityBucket: s3.IBucket;
  /** `id.atmark.ai` CloudFront 배포 — 서명 Lambda 만 무효화한다. */
  readonly identityDistribution: cloudfront.IDistribution;
  /** 없으면 execute-api 기본 엔드포인트만 쓴다(승인 링크도 그 URL 이 된다). */
  readonly apiDomain?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  /** 관리 호스트(`console.atmark.ai`). 없으면 콘솔 HTTP API 의 execute-api 기본 엔드포인트. */
  readonly consoleDomain?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  /**
   * 운영자 콘솔 호스트(`ops.atmark.ai`, ADR-0015). **선택** — 인증서(`AtmarkOpsCertificate`)가 발급된 뒤에만 넘긴다(롤아웃 §5 6단계).
   * 없으면 ops HTTP API 는 execute-api 기본 엔드포인트만 갖고(λ 가 Host ≠ ops.atmark.ai 를 421 로 거절), 있으면 그 엔드포인트를 끈다.
   */
  readonly opsDomain?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  /**
   * 실시간 WebSocket 호스트(`realtime.atmark.ai`, 묶음 E). **선택** — 인증서(`AtmarkRealtimeCertificate`)가 발급된 뒤에만 넘긴다(`app.ts` 의
   * `realtimeDomainReadyOf` — 컨텍스트 `atmark:realtimeDomainReady`, 기본 false). 없으면 execute-api `wss://` 주소만 있고 발견 문서가 그 주소를 알린다.
   */
  readonly realtimeDomain?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  /** 결제(WP-2) — AtmarkBilling 의 큐와 비밀 자리(`billing-stack.ts`). */
  readonly billing: {
    readonly queue: sqs.IQueue;
    /** `atmark/billing/paddle/webhook-secret` — billing-webhook 만. */
    readonly paddleWebhookSecret: secretsmanager.ISecret;
    /** `atmark/billing/paddle/sync-api-key` — billing-sync 만. */
    readonly paddleSyncApiKeySecret: secretsmanager.ISecret;
    /** `atmark/billing/paddle/admin-api-key` — admin 만. */
    readonly paddleAdminApiKeySecret: secretsmanager.ISecret;
    /** `atmark/db/billing` — billing-sync 가 읽고 migrate 가 쓴다. */
    readonly dbBillingSecret: secretsmanager.ISecret;
    /** `atmark/db/billing-operator` — migrate 가 쓴다(읽는 쪽은 운영자 CLI). */
    readonly dbBillingOperatorSecret: secretsmanager.ISecret;
  };
  readonly lambdaCode: LambdaCodeSource;
}

function pascal(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export class ComputeStack extends cdk.Stack {
  public readonly functions: Readonly<Record<HandlerName, lambda.Function>>;
  public readonly roles: Readonly<Record<RoleKey, iam.Role>>;
  public readonly httpApi: apigwv2.HttpApi;
  public readonly approvalPageUrl: string;
  public readonly consoleHttpApi: apigwv2.HttpApi;
  /** 관리 화면의 출처(`https://console.atmark.ai`) — 끝 슬래시 없음. */
  public readonly consoleUrl: string;
  /** 결제 웹훅 HTTP API(`atmark-billing`) — Paddle 알림 목적지. */
  public readonly billingHttpApi: apigwv2.HttpApi;
  /** 운영자 콘솔 HTTP API(`atmark-ops`) — 통합은 ops λ 하나. */
  public readonly opsHttpApi: apigwv2.HttpApi;
  /** 실시간 WebSocket API(`atmark-realtime`, 묶음 E) — 통합은 실시간 λ 하나. */
  public readonly realtimeApi: apigwv2.WebSocketApi;
  /** 에이전트에게 알리는 실시간 접속 주소(도메인 전에는 execute-api `wss://…/v1`). */
  public readonly realtimeUrl: string;

  public constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { mailBucket, secrets } = props;

    // ── 역할 ────────────────────────────────────────────────────────────────
    const makeRole = (key: RoleKey, description: string): iam.Role =>
      new iam.Role(this, `${pascal(key)}Role`, {
        roleName: `atmark-runtime-${key}`,
        description,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        ],
      });

    const roles: Record<RoleKey, iam.Role> = {
      sender: makeRole(
        'sender',
        'Runtime SES sender (Layer E). api, approval-release, approval-notifier, scheduled-sender, contact-forwarder. Not login@; support@ only from contact-forwarder.',
      ),
      'login-mailer': makeRole('login-mailer', 'Owner login link mail only (Layer E second principal, ADR-0006). SES from login@atmark.ai only.'),
      inbound: makeRole('inbound', 'Inbound mail consumer. No SES.'),
      'ses-events': makeRole('ses-events', 'SES event consumer. No SES.'),
      'approval-expiry': makeRole('approval-expiry', 'Approval expiry sweeper. No SES.'),
      'webhook-dispatcher': makeRole('webhook-dispatcher', 'Webhook dispatcher. No SES.'),
      migrate: makeRole('migrate', 'Migrations / DB role bootstrap. No SES.'),
      admin: makeRole(
        'admin',
        'Owner console (console.atmark.ai). atmark_admin DB role (not owner), agent key custody. No SES. S3 GetObject on outbound/content/* only.',
      ),
      'passport-signer': makeRole(
        'passport-signer',
        'Passport signer (id.atmark.ai). The ONLY principal that decrypts agent private keys. No SES, no other secrets.',
      ),
      'billing-sync': makeRole('billing-sync', 'Billing sync (Paddle re-fetch, org entitlements). atmark_billing DB role, Paddle sync key. No SES.'),
      ops: makeRole(
        'ops',
        'Hosted operator console (ops.atmark.ai, ADR-0015). atmark_ops DB role, ops keys, login-mailer kick. No SES, no S3, no KMS, no login keys.',
      ),
      // ★ `makeRole` 이 아니다 — AWS 관리형 정책 0(Basic·VPC 없음). 문장 셋은 아래 "결제" 절(로그 그룹은 함수와 함께 만든다).
      'billing-webhook': new iam.Role(this, 'BillingWebhookRole', {
        roleName: 'atmark-runtime-billing-webhook',
        description: 'Paddle webhook receiver. Own log group write, webhook secret read, billing queue SendMessage only. No VPC, no DB, no SES.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      }),
      // ★ `makeRole` 이 아니다 — 결제 웹훅과 같은 모양(관리형 정책 0). 문장은 아래 "고객 도메인" 절.
      'domain-control': new iam.Role(this, 'DomainControlRole', {
        roleName: DOMAIN_CONTROL_ROLE_NAME,
        description: 'Customer domain control plane (ADR-0014). SES identity control-plane only; atmark.ai identities and all SES sending denied. No VPC, no DB, no secrets.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      }),
      // AI 의심 메일 감시 결과(ADR-0017 초안) — VPC 안(DB) · 자기 DB 비밀 하나 · 결과 큐 소비. SES 0 · S3 0 · KMS 0.
      'ai-watch-result': makeRole(
        'ai-watch-result',
        'AI mail watch result consumer (ADR-0017 draft). atmark_ai_watch DB role (definer functions only), result queue consume. No SES, no S3, no KMS.',
      ),
      // 실시간 WebSocket(묶음 E) — VPC 안(DB) · 앱 DB 비밀 읽기 하나. SES 0 · S3 0 · KMS 0 · `@connections` 0(보내는 것은 만드는 λ 다).
      realtime: makeRole(
        'realtime',
        'Realtime WebSocket connection handler (realtime.atmark.ai). atmark_app DB role (definer functions only). No SES, no S3, no KMS, no @connections.',
      ),
      // ★ 같은 모양(관리형 정책 0). SES 읽기 둘뿐 — 정책을 쓰는 domain-control 과 **다른 주체**가 감사한다(보안 리뷰 M2).
      'domain-policy-audit': new iam.Role(this, 'DomainPolicyAuditRole', {
        roleName: DOMAIN_POLICY_AUDIT_ROLE_NAME,
        description: 'Read-only audit of SES identity policies (ADR-0014). ses:GetEmailIdentity and ses:ListEmailIdentities only. No VPC, no DB, no secrets.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      }),
    };
    (roles.sender.node.defaultChild as iam.CfnRole).overrideLogicalId(SENDER_ROLE_LOGICAL_ID);
    (roles['login-mailer'].node.defaultChild as iam.CfnRole).overrideLogicalId(LOGIN_MAILER_ROLE_LOGICAL_ID);
    this.roles = roles;

    // ── SES — 발송 역할 하나에만 ─────────────────────────────────────────────
    // I2+(ADR-0014 결정 4 · 스파이크 S1 ③) — 예전의 한 문장(`SesSendAsAtmarkOnly` — identity + 구성 세트, 조건 `*@atmark.ai`)을 둘로 나눈다.
    //   SES 는 발송 요청 하나에 identity 와 구성 세트 **둘 다**의 허락을 요구한다. identity 문장은 예전 조건 그대로라 atmark.ai 발송의 실효 권한은
    //   같다. 구성 세트 문장에는 조건이 없다 — 고객 identity 의 발신 주소는 그 identity 의 정책(StringEquals 발급 주소)이 묶는다. 고객 identity 는
    //   이 역할의 IAM 에 **없다**(인프라 테스트가 `identity/*` 부재를 단언).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesSendAsAtmarkIdentity',
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${SENDING_DOMAIN}`],
        conditions: { StringLike: { 'ses:FromAddress': SES_FROM_ADDRESS_PATTERN } },
      }),
    );
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesUseDefaultConfigurationSet',
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:configuration-set/${CONFIGURATION_SET_NAME}`],
      }),
    );
    // 로그인 발신 주소는 login-mailer 전용이다 — 발송 역할이 탈취돼도 `login@atmark.ai` 로 가짜 로그인 메일을 보내지 못한다.
    //   `StringEqualsIgnoreCase` — `StringEquals` 는 대소문자를 가려 `LOGIN@atmark.ai` 가 비켜 갔다(2026-09-24 검증 F1).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyLoginFromAddress',
        effect: iam.Effect.DENY,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
        conditions: { StringEqualsIgnoreCase: { 'ses:FromAddress': LOGIN_MAILER_FROM_ADDRESS } },
      }),
    );
    // 수신 전용 주소(`abuse@`·`postmaster@`, 202609301540) — 지원 에이전트의 별칭이어도 보내지 못한다(라우팅 모드와 무관).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyReceiveOnlyFromAddress',
        effect: iam.Effect.DENY,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
        conditions: { StringEqualsIgnoreCase: { 'ses:FromAddress': [...SES_RECEIVE_ONLY_FROM_ADDRESSES] } },
      }),
    );
    // 정규형 밖 발신 주소 전부 — 예약 주소(login@·support@)의 대소문자 변형·하위 주소(`+`)·인용/주석 형태를 한 문장으로 닫는다.
    //   `ses:FromAddress` 는 단일값 키라 `ForAnyValue:` 한정자가 아니라 맨 `StringLike`(값 목록은 OR)다.
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyNonCanonicalFromAddress',
        effect: iam.Effect.DENY,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
        conditions: { StringLike: { 'ses:FromAddress': [...SES_NON_CANONICAL_FROM_PATTERNS] } },
      }),
    );
    // 예약 주소 앞에 정규형이 아닌 글자가 붙은 발신 주소(M3a) — 정책에 적을 수 없는 제어문자(`\v`·`\f`…)가 앞에 붙은 형태를 닫는다.
    //   한 조건 블록 안의 연산자는 AND 다: "`*?login@atmark.ai` 꼴" 이고 "앞 글자가 `[a-z0-9._-]` 가 아니다".
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyReservedSuffixFromAddress',
        effect: iam.Effect.DENY,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
        conditions: {
          StringLike: { 'ses:FromAddress': [...SES_RESERVED_SUFFIX_PATTERNS] },
          StringNotLike: { 'ses:FromAddress': [...SES_RESERVED_SUFFIX_CANONICAL_EXCEPTIONS] },
        },
      }),
    );
    // ── 문의 전달(US-009) — 발송 역할 안에서 **함수 단위**로 가른다 ─────────────────────────────────
    // 함수 이름은 고정(`atmark-${name}`)이라 ARN 을 문자열로 만든다 — 함수 리소스를 참조하면 역할 정책 → 함수 → 역할의 순환이 생긴다.
    // `lambda:SourceFunctionArn` 은 Lambda 가 실행 역할 자격증명의 **모든** AWS 요청에 싣는다. 함수 밖으로 빼낸 자격증명에는 키가 없다 —
    //   `ArnNotEquals` 는 키가 없을 때 참이므로 그 경우도 Deny 다(닫힌 쪽).
    const contactForwarderArn = `arn:aws:lambda:${this.region}:${this.account}:function:atmark-${CONTACT_FORWARDER_HANDLER}`;
    // 문의 라우팅(위 `CONTACT_ROUTING_DEFAULT`) — `forward` 일 때만 support@ 발신을 이 함수 밖에서 막는다. 그 밖의 모드에서 support@ 는 지원 에이전트의
    //   대표 주소이고 api(관문)가 그 주소로 회신한다. 대소문자·하위 주소·앞 글자 변형 Deny(위 둘)는 모드와 무관하게 남는다.
    const contactRouting = contactRoutingOf(this.node);
    if (contactRouting === 'forward') {
      roles.sender.addToPolicy(
        new iam.PolicyStatement({
          sid: 'SesDenySupportFromOutsideForwarder',
          effect: iam.Effect.DENY,
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: ['*'],
          conditions: {
            StringEqualsIgnoreCase: { 'ses:FromAddress': CONTACT_FORWARD_FROM_ADDRESS },
            ArnNotEquals: { 'lambda:SourceFunctionArn': contactForwarderArn },
          },
        }),
      );
    }
    // 둘째 발송 주체 — 발신 주소 **둘**(StringEquals — 로그인 `login@` · 환영 `onve@`, ADR-0006 2026-09-30 개정). 같은 identity·configuration set.
    roles['login-mailer'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesSendAsLoginOnly',
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${SENDING_DOMAIN}`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${CONFIGURATION_SET_NAME}`,
        ],
        conditions: { StringEquals: { 'ses:FromAddress': [...LOGIN_MAILER_FROM_ADDRESSES] } },
      }),
    );

    // ── 고객 도메인 제어면(ADR-0014 단계 2) — domain-control 역할 ─────────────────────────────────
    // 허용은 **태그로 묶는다**(보안 리뷰 M1 — 이름 Deny 는 ARN 대소문자 변형으로 비켜 갈 여지가 있다). 우리 identity 는 만들 때부터
    //   `atmark:managed = customer-domain` 태그를 단다 — 변형 명령은 그 태그가 **이미 있는** identity 에만, 만들기는 그 태그를 **요청에 반드시**
    //   싣고, 태그 쓰기는 `atmark:row` 하나만(관리 표시를 지우거나 바꾸지 못한다). 태그 없는 identity(플랫폼 atmark.ai · 콘솔 수동 · 스파이크)는
    //   이름과 무관하게 바꿀 수 없다. 읽기(`GetEmailIdentity`)만 태그 조건이 없다 — 태그를 대조하려면 먼저 읽어야 한다.
    const sesIdentityArn = (name: string): string => `arn:aws:ses:${this.region}:${this.account}:identity/${name}`;
    const managedTag = { [`aws:ResourceTag/${IDENTITY_MANAGED_TAG}`]: IDENTITY_MANAGED_TAG_VALUE };
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({ sid: 'SesIdentityRead', effect: iam.Effect.ALLOW, actions: ['ses:GetEmailIdentity'], resources: [sesIdentityArn('*')] }),
    );
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesManagedIdentityMutate',
        effect: iam.Effect.ALLOW,
        actions: [
          'ses:DeleteEmailIdentity',
          'ses:PutEmailIdentityMailFromAttributes',
          'ses:PutEmailIdentityConfigurationSetAttributes',
          'ses:CreateEmailIdentityPolicy',
          'ses:UpdateEmailIdentityPolicy',
          'ses:DeleteEmailIdentityPolicy',
        ],
        resources: [sesIdentityArn('*')],
        conditions: { StringEquals: managedTag },
      }),
    );
    // 구성 세트 붙이기는 구성 세트 자원의 허락도 요구한다(그 자원에는 태그가 없다) — 그 명령 하나 · 그 구성 세트 하나.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesAttachDefaultConfigurationSet',
        effect: iam.Effect.ALLOW,
        actions: ['ses:PutEmailIdentityConfigurationSetAttributes'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:configuration-set/${CONFIGURATION_SET_NAME}`],
      }),
    );
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesManagedIdentityCreate',
        effect: iam.Effect.ALLOW,
        actions: ['ses:CreateEmailIdentity'],
        resources: [sesIdentityArn('*')],
        conditions: {
          StringEquals: { [`aws:RequestTag/${IDENTITY_MANAGED_TAG}`]: IDENTITY_MANAGED_TAG_VALUE },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [...DOMAIN_IDENTITY_TAG_KEYS] },
        },
      }),
    );
    // 태그 쓰기 — 양도 채택(옛 행 → 새 행)의 `atmark:row` 하나만, 이미 관리 표시가 있는 identity 에만. 관리 표시 자체는 만들 때만 붙는다.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesManagedIdentityRetag',
        effect: iam.Effect.ALLOW,
        actions: ['ses:TagResource'],
        resources: [sesIdentityArn('*')],
        conditions: { StringEquals: managedTag, 'ForAllValues:StringEquals': { 'aws:TagKeys': [IDENTITY_ROW_TAG] } },
      }),
    );
    // 명시 Deny ① — 플랫폼 identity(`atmark.ai` 와 그 하위)와 **주소 identity**(`a@b` — 만들면 SES 가 그 주소로 확인 메일을 보낸다 = 관문 밖 발송)에는
    //   어떤 SES 명령도. 리전·계정 와일드카드가 아니라 이 계정의 모든 리전.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyPlatformAndAddressIdentities',
        effect: iam.Effect.DENY,
        actions: ['ses:*'],
        resources: [
          `arn:aws:ses:*:${this.account}:identity/${SENDING_DOMAIN}`,
          `arn:aws:ses:*:${this.account}:identity/*.${SENDING_DOMAIN}`,
          `arn:aws:ses:*:${this.account}:identity/*@*`,
        ],
      }),
    );
    // 만들 때 태그 붙이기 — SES v2 는 `CreateEmailIdentity`(Tags 포함)를 `ses:TagResource` 로도 판정한다(2026-10-05 운영 e2e 에서 AccessDenied 로 확인).
    //   그래서 만들기 Allow 와 같은 요청 태그 조건으로 태그 쓰기를 허락한다. 남는 위험: 태그 없는 남의 identity 에 관리 표시를 붙일 수 있다 —
    //   플랫폼·주소 identity 는 Deny ① 이 막고, 그 밖의 손 identity 는 계정에 두지 않는다(스파이크는 지운다) · 태그 변경은 CloudTrail 규칙이 알린다.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesManagedIdentityTagOnCreate',
        effect: iam.Effect.ALLOW,
        actions: ['ses:TagResource'],
        resources: [sesIdentityArn('*')],
        conditions: {
          StringEquals: { [`aws:RequestTag/${IDENTITY_MANAGED_TAG}`]: IDENTITY_MANAGED_TAG_VALUE },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [...DOMAIN_IDENTITY_TAG_KEYS] },
        },
      }),
    );
    // 명시 Deny ①′ — 플랫폼 표시 태그가 있는 identity 에는 어떤 SES 명령도. Deny ① 의 이름 대조는 대소문자를 가리지만 SES 는 `ATMARK.AI` 를
    //   `atmark.ai` 로 푼다(2026-10-05 실측) — 위 만들 때 태그 Allow 가 태그 없는 identity 에 관리 표시를 붙일 수 있게 되면서 이 길을 태그로 닫는다.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyPlatformTagged',
        effect: iam.Effect.DENY,
        actions: ['ses:*'],
        resources: ['*'],
        conditions: { StringEquals: { [`aws:ResourceTag/${IDENTITY_PLATFORM_TAG}`]: IDENTITY_PLATFORM_TAG_VALUE } },
      }),
    );
    // 명시 Deny ②′ — 관리 표시 태그를 떼는 명령, 그리고 다른 값으로 바꾸는 태그 명령(Allow 가 이미 막지만 명시 — 다른 문장이 넓어져도).
    //   예전 문장(관리 표시 키가 든 태그 명령 전부 Deny)은 만들 때 태그 붙이기까지 막았다.
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyManagedTagRemove',
        effect: iam.Effect.DENY,
        actions: ['ses:UntagResource'],
        resources: ['*'],
        conditions: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': [IDENTITY_MANAGED_TAG] } },
      }),
    );
    roles['domain-control'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesDenyManagedTagRelabel',
        effect: iam.Effect.DENY,
        actions: ['ses:TagResource', 'ses:CreateEmailIdentity'],
        resources: ['*'],
        conditions: {
          Null: { [`aws:RequestTag/${IDENTITY_MANAGED_TAG}`]: 'false' },
          StringNotEquals: { [`aws:RequestTag/${IDENTITY_MANAGED_TAG}`]: IDENTITY_MANAGED_TAG_VALUE },
        },
      }),
    );
    // 명시 Deny ② — 발송 전부(`ses-send-deny.ts` — 아래 비발송 역할 루프가 이 역할에도 붙인다): 자기가 쓴 identity policy 로 자기에게 발송 권한을
    //   주는 길을 identity 기반 Deny 로 닫는다.

    // 독립 감사 역할 — SES 읽기 둘. `ListEmailIdentities` 는 자원 수준 권한이 없어 `*` 다.
    roles['domain-policy-audit'].addToPolicy(
      new iam.PolicyStatement({ sid: 'SesIdentityAuditRead', effect: iam.Effect.ALLOW, actions: ['ses:GetEmailIdentity'], resources: [sesIdentityArn('*')] }),
    );
    roles['domain-policy-audit'].addToPolicy(
      new iam.PolicyStatement({ sid: 'SesIdentityAuditList', effect: iam.Effect.ALLOW, actions: ['ses:ListEmailIdentities'], resources: ['*'] }),
    );

    // ── S3 — 접두사 단위. 삭제 권한은 누구에게도 없다 ────────────────────────
    const objects = (prefixes: readonly string[]): string[] => prefixes.map((p) => mailBucket.arnForObjects(`${p}*`));
    const grantS3 = (role: iam.Role, sid: string, access: { get: readonly string[]; put: readonly string[] }): void => {
      if (access.get.length > 0) {
        role.addToPolicy(new iam.PolicyStatement({ sid: `${sid}Get`, actions: ['s3:GetObject'], resources: objects(access.get) }));
        // ListBucket 이 없으면 없는 키의 GetObject 가 404 가 아니라 403 이 된다 — `s3-object-store.ts` 는 404 로만
        // `ObjectNotFoundError` 를 만든다. 키는 id 뿐이다(본문·파일명·주소 없음, `object-store.ts` 키 설계).
        role.addToPolicy(new iam.PolicyStatement({ sid: `${sid}List`, actions: ['s3:ListBucket'], resources: [mailBucket.bucketArn] }));
      }
      if (access.put.length > 0) {
        role.addToPolicy(new iam.PolicyStatement({ sid: `${sid}Put`, actions: ['s3:PutObject'], resources: objects(access.put) }));
      }
    };
    grantS3(roles.sender, 'MailStore', {
      // api: 발신 본문 put/get, 예약 본문 put, 수신 파생물 get(조회·전달·첨부 presigned GET)
      // approval-release: 발신 본문 get / scheduled-sender: 예약 본문 get + 발신 본문 put
      // 메일 기본기 2차 A2 — 발신 첨부: 스테이징(uploads) put(서명된 PUT 은 이 역할의 자격증명으로 서명된다) · get(머리·매직·text 검사,
      //   복사 원본) / 영구본(attachments) put(복사 목적지) · get(전송 직전 체크섬 대조 — api·approval-release).
      // 묶음 B — 초안 본문(drafts): api 가 put(판마다 새 객체) · get(조회 · 보내기).
      get: [OUTBOUND_CONTENT_PREFIX, OUTBOUND_SCHEDULED_PREFIX, INBOUND_PARSED_PREFIX, INBOUND_ATTACHMENTS_PREFIX, OUTBOUND_ATTACHMENTS_PREFIX, OUTBOUND_DRAFTS_PREFIX],
      put: [OUTBOUND_CONTENT_PREFIX, OUTBOUND_SCHEDULED_PREFIX, OUTBOUND_UPLOADS_PREFIX, OUTBOUND_ATTACHMENTS_PREFIX, OUTBOUND_DRAFTS_PREFIX],
    });
    // 스캔 판정 읽기 — GuardDuty 가 스테이징 객체에 붙인 태그(`GuardDutyMalwareScanStatus`). 태그 쓰기는 GuardDuty 역할만(Storage 스택).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({ sid: 'MailStoreAttachmentScanTagGet', actions: ['s3:GetObjectTagging'], resources: objects([OUTBOUND_UPLOADS_PREFIX]) }),
    );
    // 스테이징 **읽기**(머리 · 매직 · text 검사 · 복사 원본)는 GuardDuty 가 `NO_THREATS_FOUND` 로 태그한 객체만(보안 리뷰 L1) — 코드가 판정을
    // 건너뛰어도 검사 전·위협 객체의 바이트를 읽거나 옮기지 못한다. 태그 쓰기는 버킷 정책이 GuardDuty 역할 밖에서 Deny 한다(Storage 스택).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MailStoreAttachmentStagingGetScanned',
        actions: ['s3:GetObject'],
        resources: objects([OUTBOUND_UPLOADS_PREFIX]),
        conditions: { StringEquals: { 's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND' } },
      }),
    );
    // 수신 파생물을 **쓰는** 것은 inbound 하나다(T4). 원문은 SES 가 쓰고 inbound 는 읽기만.
    // US-009: 문의 전달 문서(`contact/forward/*`)도 inbound 가 쓴다(write-once — 읽기·나열 없음).
    grantS3(roles.inbound, 'MailStore', {
      get: [INBOUND_RAW_PREFIX],
      put: [INBOUND_PARSED_PREFIX, INBOUND_ATTACHMENTS_PREFIX, CONTACT_DOCUMENT_PREFIX],
    });
    // 문의 전달 문서 **읽기** — 발송 역할이지만 contact-forwarder 함수의 요청에서만. ListBucket 없음(키는 행의 id 에서 유도한다).
    roles.sender.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ContactDocumentGetForwarderOnly',
        actions: ['s3:GetObject'],
        resources: objects([CONTACT_DOCUMENT_PREFIX]),
        conditions: { ArnEquals: { 'lambda:SourceFunctionArn': contactForwarderArn } },
      }),
    );

    // ── 비밀 읽기 ────────────────────────────────────────────────────────────
    // 2026-10-12 비밀 → SSM 이전(배포 런북 §49): DB 롤 12 · 키링·API 키 8 은 SSM SecureString(`/atmark/…`, 이름 하나씩 GetParameter + SSM 경유 Decrypt —
    //   `ssm-secrets.ts`). Secrets Manager 에 남긴 것(마스터 · 웹훅 KEK · DLP 키 · 에이전트 키)만 `readSecret`. 옛 Secrets Manager 비밀 정의는 아직
    //   남아 있다(다음 PR 에서 지운다 — 되돌리기 가능하게).
    const readSecret = (role: iam.Role, sid: string, secret: Pick<secretsmanager.ISecret, 'secretArn'>): void => {
      role.addToPolicy(new iam.PolicyStatement({ sid, actions: ['secretsmanager:GetSecretValue'], resources: [secret.secretArn] }));
    };
    const readParam = (role: iam.Role, sid: string, secretName: string): void => grantSsmSecretRead(role, sid, [secretName], props.ssmSecretsKey);
    for (const key of ['sender', 'inbound', 'ses-events', 'approval-expiry', 'webhook-dispatcher', 'realtime'] as const) {
      readParam(roles[key], 'DbAppSecretRead', DB_APP_SECRET_NAME);
    }
    readParam(roles.sender, 'ApprovalLinkKeysRead', APPROVAL_LINK_KEYS_SECRET_NAME); // api(검증) · approval-notifier(발급)
    readSecret(roles.sender, 'WebhookSecretKeysRead', secrets.webhookSecretKeys); // api(엔드포인트 등록 시 암호화)
    // ★ 발송 역할은 로그인 키를 읽지 않는다(ADR-0006) — 로그인 메일 토큰은 login-mailer 가 만든다.
    readParam(roles['login-mailer'], 'OwnerLoginKeysRead', OWNER_LOGIN_KEYS_SECRET_NAME);
    readParam(roles['login-mailer'], 'DbLoginMailerSecretRead', DB_LOGIN_MAILER_SECRET_NAME);
    readSecret(roles['webhook-dispatcher'], 'WebhookSecretKeysRead', secrets.webhookSecretKeys);
    // 문의 전달 주소 — 발송 역할이지만 contact-forwarder 함수의 요청에서만(api·알림·릴리스·예약은 읽지 못한다). 복호 문장은 그 파라미터의 암호화 문맥으로만.
    grantSsmSecretRead(roles.sender, 'ContactForwardToReadForwarderOnly', [CONTACT_FORWARD_TO_SECRET_NAME], props.ssmSecretsKey, {
      conditions: { ArnEquals: { 'lambda:SourceFunctionArn': contactForwarderArn } },
    });

    // 운영자 콘솔(ADR-0015) — 코드 파생 키는 login-mailer 만(결정 C2). ops λ 는 자기 DB 비밀 + ops 키 둘뿐.
    readParam(roles['login-mailer'], 'OpsLoginKeysRead', OPS_SECRET_NAMES.loginKeys);
    readParam(roles.ops, 'DbOpsSecretRead', OPS_SECRET_NAMES.db);
    readParam(roles.ops, 'OpsKeysRead', OPS_SECRET_NAMES.opsKeys);

    // 고객 도메인 틱 DB 롤 비밀(ADR-0014 단계 2) — **이 스택 소유**(투명성 스택의 DB 비밀 둘과 같은 선례 — AtmarkData 를 손으로 다시 배포하지 않는다).
    //   자리표시로 만들고 migrate `bootstrap-roles` 가 채운다(RETAIN — 스택을 지워도 자격증명이 남는다).
    const dbDomainTick = new secretsmanager.Secret(this, 'DbDomainTickSecret', {
      secretName: DOMAIN_TICK_DB_SECRET_NAME,
      description: 'atmark_domain_tick DB role (customer domain check tick, ADR-0014). Filled by migrate bootstrap-roles. Read by admin tick pool (stage 4).',
      secretStringValue: cdk.SecretValue.unsafePlainText(SECRET_PLACEHOLDER_VALUE),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // AI 의심 메일 감시 결과 λ 의 DB 롤 비밀(ADR-0017 초안) — **이 스택 소유**(틱 비밀과 같은 선례). 자리표시 → migrate `bootstrap-roles` 가 채운다.
    //   읽기는 결과 역할 하나 · 쓰기는 migrate(아래 `DbRoleSecretsWrite`).
    const dbAiWatch = new secretsmanager.Secret(this, 'DbAiWatchSecret', {
      secretName: AI_WATCH_DB_SECRET_NAME,
      description: 'atmark_ai_watch DB role (AI mail watch result consumer, ADR-0017 draft). Filled by migrate bootstrap-roles. Read by the ai-watch-result role only.',
      secretStringValue: cdk.SecretValue.unsafePlainText(SECRET_PLACEHOLDER_VALUE),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    readParam(roles['ai-watch-result'], 'DbAiWatchSecretRead', AI_WATCH_DB_SECRET_NAME);

    // 발신 DLP 지문 키(ADR-0016 B) — **이 스택 소유**. 값은 CloudFormation 이 만든다(사람이 손으로 넣지 않는다 — 자리표시면 api·inbound 가 기동하지
    //   못한다). 64자 영숫자 = base64url 48바이트(≥ 32). 읽기: 발송 역할(api · 승인 릴리스 · 예약 발송 — 발신 DLP, api 읽기 라우트 — 코드 지문) ·
    //   수신 역할(복사 지문). RETAIN — 지문은 30일 산다, 스택을 지워도 키가 남아야 옛 지문을 비교한다.
    const dlpKeys = new secretsmanager.Secret(this, 'DlpKeysSecret', {
      secretName: DLP_KEYS_SECRET_NAME,
      description: 'HMAC key for outbound DLP fingerprints (ADR-0016). Generated by CloudFormation. Read by the sender and inbound roles only.',
      generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false, requireEachIncludedType: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    for (const key of ['sender', 'inbound'] as const) readSecret(roles[key], 'DlpKeysRead', dlpKeys);

    // migrate: 마스터로 DB 롤 12 를 만들고 그 자격증명을 SSM 자리(`/atmark/db/…`)에 쓴다(`DbRoleSecretsWrite` — GetParameter · PutParameter).
    readSecret(roles.migrate, 'DbMasterSecretRead', secrets.dbMaster);
    grantSsmSecretWrite(roles.migrate, 'DbRoleSecretsWrite', SSM_DB_ROLE_SECRET_NAMES, props.ssmSecretsKey);
    // 옛 Secrets Manager 자리는 **읽기만** — SSM 자리가 비었는데 옛 값이 남아 있으면 비밀번호를 새로 만들지 않고 실패한다(`composeRoleBootstrap`).
    //   옛 비밀 정의를 지우는 다음 PR 에서 이 문장도 지운다.
    roles.migrate.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DbRoleLegacySecretsRead',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          secrets.dbOwner.secretArn,
          secrets.dbApp.secretArn,
          secrets.dbAdmin.secretArn,
          secrets.dbLoginMailer.secretArn,
          secrets.dbPassportSigner.secretArn,
          secrets.dbTlog.secretArn,
          secrets.dbTlogAnchor.secretArn,
          // WP-2 — `atmark_billing`·`atmark_billing_operator`(AtmarkBilling 의 자리).
          props.billing.dbBillingSecret.secretArn,
          props.billing.dbBillingOperatorSecret.secretArn,
          // ADR-0015 — `atmark_ops`(bootstrap-roles 가 만들고 이 자리에 쓴다).
          secrets.dbOps.secretArn,
          // ADR-0014 단계 2 — `atmark_domain_tick`(이 스택 소유 비밀).
          dbDomainTick.secretArn,
          // ADR-0017 초안 — `atmark_ai_watch`(이 스택 소유 비밀).
          dbAiWatch.secretArn,
        ],
      }),
    );

    // admin: admin DB 롤 비밀 **읽기만**(쓰기는 migrate) · 로그인 키(검증). 소유자·앱 DB 비밀·승인 링크 키·웹훅 키는 없다 — 콘솔 웹훅 시크릿은
    //   api λ 를 불러 받는다(아래 `ApiWebhookSecretIssue`, 보안 M1).
    readParam(roles.admin, 'DbAdminSecretRead', DB_ADMIN_SECRET_NAME);
    readParam(roles.admin, 'OwnerLoginKeysRead', OWNER_LOGIN_KEYS_SECRET_NAME);
    // ADR-0014 단계 4 — 확인 틱(`{task:'domain-recheck'}`)의 틱 롤 비밀 **읽기만**(쓰기는 migrate bootstrap-roles). 틱 풀은 이벤트마다 열고 닫는다(크기 1 —
    //   연결 예산 72 → 73/75, `DOMAIN_TICK_POOL_MAX`).
    readParam(roles.admin, 'DbDomainTickSecretRead', DOMAIN_TICK_DB_SECRET_NAME);
    // WP-2 — 콘솔 결제(거래 생성·취소 · 포털 세션)의 Paddle admin 키. sync 키·웹훅 비밀은 읽지 못한다.
    readParam(roles.admin, 'PaddleAdminApiKeyRead', PADDLE_ADMIN_API_KEY_SECRET_NAME);

    // Domain Connect 서명 키(위 `DOMAIN_CONNECT_KEY_ALIAS`) — 비추출 RSA. Sign · GetPublicKey 는 admin 역할 하나, 키 정책 Deny 로 한 번 더.
    const domainConnectKey = new kms.Key(this, 'DomainConnectSigningKey', {
      alias: DOMAIN_CONNECT_KEY_ALIAS,
      description: 'Atmark Domain Connect apply-URL signing key (RSA 2048, RSASSA_PKCS1_V1_5_SHA_256). Non-exportable. Sign only by atmark-runtime-admin.',
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pendingWindow: cdk.Duration.days(30),
      enableKeyRotation: false,
    });
    domainConnectKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: DENY_SIGN_EXCEPT_ADMIN_SID,
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': `arn:${this.partition}:iam::${this.account}:role/atmark-runtime-admin` } },
      }),
    );
    roles.admin.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DomainConnectSign',
        actions: ['kms:Sign'],
        resources: [domainConnectKey.keyArn],
        conditions: { StringEquals: { 'kms:SigningAlgorithm': 'RSASSA_PKCS1_V1_5_SHA_256', 'kms:MessageType': 'RAW' } },
      }),
    );
    roles.admin.addToPolicy(
      new iam.PolicyStatement({ sid: 'DomainConnectPublicKey', actions: ['kms:GetPublicKey'], resources: [domainConnectKey.keyArn] }),
    );

    // ── 결제(WP-2) — sync: 자기 DB 비밀 + sync 키. 웹훅: 비밀 하나 + 큐 SendMessage(로그 그룹 쓰기는 함수와 함께) ─────────
    readParam(roles['billing-sync'], 'DbBillingSecretRead', DB_BILLING_SECRET_NAME);
    readParam(roles['billing-sync'], 'PaddleSyncApiKeyRead', PADDLE_SYNC_API_KEY_SECRET_NAME);
    readParam(roles['billing-webhook'], 'PaddleWebhookSecretRead', PADDLE_WEBHOOK_SECRET_NAME);
    roles['billing-webhook'].addToPolicy(
      new iam.PolicyStatement({ sid: 'BillingQueueSend', actions: ['sqs:SendMessage'], resources: [props.billing.queue.queueArn] }),
    );
    // admin: 발신 본문 **읽기 하나**(US-004 — 로그 상세). `grantS3` 를 쓰지 않는다 — 그 헬퍼는 GetObject 에 ListBucket(버킷 전체의
    // 키 나열)을 붙인다. admin 은 키를 행(조직 범위로 고른 `messages.body_storage_key`)에서만 얻는다. 없는 키는 404 가 아니라 403 이고,
    // 상세는 그것을 "읽지 못함" 으로 보인다. 쓰기·삭제·다른 접두사(수신 원문·파생물·예약 본문) 없음.
    roles.admin.addToPolicy(
      new iam.PolicyStatement({ sid: 'OutboundContentGet', actions: ['s3:GetObject'], resources: objects([OUTBOUND_CONTENT_PREFIX]) }),
    );

    // ── KMS — passport custody(PP-A)에 필요한 것만 ──────────────────────────
    // `custody-aws.ts`: GenerateDataKey + CreateSecret(KmsKeyId=CMK). Secrets Manager 는 CMK 로 시크릿을 만들 때
    // 호출자의 kms:Decrypt 도 요구한다 — **Secrets Manager 경유로만** 허용한다(ViaService). GetSecretValue 가 없으므로
    // 이 Decrypt 로 개인키 envelope 를 꺼낼 길은 없다(AC-e2 — 복호는 P6 signer).
    const custody = roles[HANDLER_SPECS[PASSPORT_CUSTODY_HANDLER].role];
    custody.addToPolicy(
      new iam.PolicyStatement({ sid: 'PassportGenerateDataKey', actions: ['kms:GenerateDataKey'], resources: [props.passportKey.keyArn] }),
    );
    custody.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassportDecryptViaSecretsManagerOnly',
        actions: ['kms:Decrypt'],
        resources: [props.passportKey.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } },
      }),
    );
    custody.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassportCreateKeypairSecret',
        // PutSecretValue 없음 — 덮어쓰기(= 키 회전)는 이 역할로 불가능하다(§4B.1).
        actions: ['secretsmanager:CreateSecret'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${AGENT_KEYPAIR_SECRET_PREFIX}/*`,
        ],
      }),
    );

    // ── passport 서명(PP-B) — 개인키 복호는 이 역할 하나. SES 0 · 다른 비밀 0 ──────────────────────────
    const signer = roles[HANDLER_SPECS[PASSPORT_SIGNER_HANDLER].role];
    readParam(signer, 'DbPassportSignerSecretRead', DB_PASSPORT_SIGNER_SECRET_NAME);
    signer.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentKeypairEnvelopeRead',
        // 읽기만 — CreateSecret·PutSecretValue(키 생성·회전) 없음. 생성은 admin 의 custody 가 한다.
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${AGENT_KEYPAIR_SECRET_PREFIX}/*`],
      }),
    );
    signer.addToPolicy(
      new iam.PolicyStatement({
        // 조건 없음: ① Secrets Manager 가 envelope 시크릿을 풀 때(ViaService) ② envelope 의 DEK 를 직접 풀 때 — 둘 다 필요하다.
        //   이 문장이 **런타임 전체에서 유일한 무조건 Decrypt** 다(compute-stack.test.ts 가 단언).
        sid: 'AgentKeypairEnvelopeDecrypt',
        actions: ['kms:Decrypt'],
        resources: [props.passportKey.keyArn],
      }),
    );
    signer.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IdentityDocumentsPut',
        // 덮어쓰기 — 같은 URL 이 최신 버전을 서빙한다. 삭제 없음(버킷 버저닝이 이전 버전을 보관한다).
        actions: ['s3:PutObject'],
        resources: [props.identityBucket.arnForObjects(`${IDENTITY_OBJECT_PREFIX}*`)],
      }),
    );
    signer.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IdentityCacheInvalidate',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.identityDistribution.distributionId}`],
      }),
    );

    // ── HTTP API (승인 페이지 URL 이 함수 환경에 들어가므로 먼저 만든다) ─────────
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'atmark-api',
      description: 'Atmark agent API + owner approval page',
      createDefaultStage: false,
    });
    const domain =
      props.apiDomain === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'ApiDomainName', {
            domainName: props.apiDomain.domainName,
            certificate: props.apiDomain.certificate,
          });
    this.approvalPageUrl =
      props.apiDomain === undefined
        ? `${this.httpApi.apiEndpoint}${APPROVAL_PAGE_PATH}`
        : `https://${props.apiDomain.domainName}${APPROVAL_PAGE_PATH}`;

    // ── 관리 HTTP API (console.atmark.ai) — api 와 **다른 API**. 모든 경로가 admin Lambda 로 간다. ────────
    this.consoleHttpApi = new apigwv2.HttpApi(this, 'ConsoleHttpApi', {
      apiName: 'atmark-console',
      description: 'Atmark owner console (admin Lambda only)',
      createDefaultStage: false,
      // 커스텀 도메인이 있으면 execute-api 기본 엔드포인트를 끈다 — 콘솔의 입구는 `console.atmark.ai` 하나(쿠키 `__Host-`·
      //   Origin 검사가 그 출처를 전제한다). api 의 HTTP API 는 기본 엔드포인트를 **남긴다** — 배포 스모크(`ApiEndpoint`)가 쓴다.
      disableExecuteApiEndpoint: props.consoleDomain !== undefined,
    });
    const consoleDomain =
      props.consoleDomain === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'ConsoleDomainName', {
            domainName: props.consoleDomain.domainName,
            certificate: props.consoleDomain.certificate,
          });
    this.consoleUrl =
      props.consoleDomain === undefined ? this.consoleHttpApi.apiEndpoint : `https://${props.consoleDomain.domainName}`;

    // ── 함수 ────────────────────────────────────────────────────────────────
    const commonEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_DB_SECRET_ARN: ssmParameterNameOf(DB_APP_SECRET_NAME),
      ATMARK_MAIL_BUCKET: mailBucket.bucketName,
      ATMARK_SES_CONFIGURATION_SET: CONFIGURATION_SET_NAME,
      ATMARK_APPROVAL_LINK_KEYS_SECRET_ARN: ssmParameterNameOf(APPROVAL_LINK_KEYS_SECRET_NAME),
      ATMARK_WEBHOOK_SECRET_KEYS_SECRET_ARN: secrets.webhookSecretKeys.secretArn,
      ATMARK_PASSPORT_KMS_KEY_ID: props.passportKey.keyArn,
      ATMARK_APPROVAL_PAGE_URL: this.approvalPageUrl,
      // ADR-0016 — 발신 DLP 지문 키의 위치(값은 실행 시 읽는다 — 읽기 권한은 발송·수신 역할만) · 위험 보류 킬 스위치(운영자 컨텍스트).
      ATMARK_DLP_KEYS_SECRET_ARN: dlpKeys.secretArn,
      ATMARK_RISK_HOLD_ENFORCE: riskHoldEnforceOf(this.node),
      // RDS 는 force_ssl. `src/db/client.ts` 는 PGSSLMODE=require 일 때만 TLS(rejectUnauthorized: true)를 켠다.
      PGSSLMODE: 'require',
      // Node 20+ Lambda 런타임은 RDS CA 를 기본으로 싣지 않는다 — 이 번들을 지정해야 검증이 통과한다.
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    const migrateEnv: Record<string, string> = {
      ATMARK_DB_MIGRATION_SECRET_ARN: ssmParameterNameOf(DB_OWNER_SECRET_NAME),
      ATMARK_DB_MASTER_SECRET_ARN: secrets.dbMaster.secretArn,
      ATMARK_DB_ADMIN_SECRET_ARN: ssmParameterNameOf(DB_ADMIN_SECRET_NAME),
      ATMARK_DB_LOGIN_MAILER_SECRET_ARN: ssmParameterNameOf(DB_LOGIN_MAILER_SECRET_NAME),
      ATMARK_DB_PASSPORT_SIGNER_SECRET_ARN: ssmParameterNameOf(DB_PASSPORT_SIGNER_SECRET_NAME),
      ATMARK_DB_TLOG_SECRET_ARN: ssmParameterNameOf(TLOG_DB_SECRET_NAME),
      ATMARK_DB_TLOG_ANCHOR_SECRET_ARN: ssmParameterNameOf(TLOG_ANCHOR_DB_SECRET_NAME),
      ATMARK_DB_BILLING_SECRET_ARN: ssmParameterNameOf(DB_BILLING_SECRET_NAME),
      ATMARK_DB_BILLING_OPERATOR_SECRET_ARN: ssmParameterNameOf(DB_BILLING_OPERATOR_SECRET_NAME),
      [OPS_ENV.dbSecretArn]: ssmParameterNameOf(OPS_SECRET_NAMES.db),
      ATMARK_DB_DOMAIN_TICK_SECRET_ARN: ssmParameterNameOf(DOMAIN_TICK_DB_SECRET_NAME),
      [AI_WATCH_ENV.dbSecretArn]: ssmParameterNameOf(AI_WATCH_DB_SECRET_NAME),
    };
    // admin 은 공통 환경을 **받지 않는다** — 앱 DB 비밀·승인 링크 키가 이 함수에 있을 이유가 없다
    // (`src/runtime/admin-composition.ts` 가 읽는 것만). 메일 버킷 이름은 발신 본문 읽기(US-004)에 쓴다. 웹훅 키도 없다 — 콘솔 웹훅 시크릿은
    // api λ 내부 이벤트로 받는다(보안 M1 — api 함수 ARN 은 함수가 만들어진 뒤 붙인다).
    const authOnSite = contextFlagOf(this.node, AUTH_ON_SITE_CONTEXT_KEY, CONSOLE_AUTH_ON_SITE_DEFAULT);
    const siteCors = contextFlagOf(this.node, SITE_CORS_CONTEXT_KEY, CONSOLE_SITE_CORS_DEFAULT);
    // WP-2 결제 스위치(위 `BILLING_ENABLED_DEFAULT`)와 Paddle 환경(코드 상수 — 운영 전환은 한 커밋, 런북 deploy §21-7).
    const billingEnabled = billingEnabledOf(this.node) ? 'true' : 'false';
    const paddleEnvironment: string = PADDLE_ENVIRONMENT_DEFAULT;
    const adminEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_DB_ADMIN_SECRET_ARN: ssmParameterNameOf(DB_ADMIN_SECRET_NAME),
      ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN: ssmParameterNameOf(OWNER_LOGIN_KEYS_SECRET_NAME),
      ATMARK_PASSPORT_KMS_KEY_ID: props.passportKey.keyArn,
      ATMARK_MAIL_BUCKET: mailBucket.bucketName,
      // US-003 운영 스위치(위 `CONSOLE_AUTH_ON_SITE_DEFAULT`). 문자열 'true'|'false'.
      ATMARK_AUTH_ON_SITE: authOnSite ? 'true' : 'false',
      // 검증 F2 운영 스위치(위 `CONSOLE_SITE_CORS_DEFAULT`) — 홈 출처 CORS. 리다이렉트 스위치와 독립.
      ATMARK_SITE_CORS: siteCors ? 'true' : 'false',
      // WP-2 — 콘솔 결제(`/api/billing*`). 스위치가 꺼지면 체크아웃·포털이 잠긴다.
      ATMARK_PADDLE_ENV: paddleEnvironment,
      ATMARK_BILLING_ENABLED: billingEnabled,
      ATMARK_PADDLE_ADMIN_API_KEY_SECRET_ARN: ssmParameterNameOf(PADDLE_ADMIN_API_KEY_SECRET_NAME),
      // 메일 기본기 2차 A6 — 콘솔 별칭 API(기본 끔 → 404).
      ATMARK_ADDRESS_ALIASES_ENABLED: featureRolloutOf(this.node, ADDRESS_ALIASES_ENABLED_CONTEXT_KEY, ADDRESS_ALIASES_ENABLED_DEFAULT),
      ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN: featureFlagOf(this.node, POLICY_ATTACHMENT_FOLLOW_PLAN_CONTEXT_KEY, POLICY_ATTACHMENT_FOLLOW_PLAN_DEFAULT),
      // ADR-0014 — 틱 롤 비밀의 위치(읽기 권한 `DbDomainTickSecretRead` · 틱 풀은 단계 4). domain-control 함수 ARN 은 함수가 만들어진 뒤 붙인다.
      ATMARK_DB_DOMAIN_TICK_SECRET_ARN: ssmParameterNameOf(DOMAIN_TICK_DB_SECRET_NAME),
      // Domain Connect(위 `DOMAIN_CONNECT_ENABLED_DEFAULT` — 기본 끔) · 서명 키 ARN.
      ATMARK_DOMAIN_CONNECT_ENABLED: featureFlagOf(this.node, DOMAIN_CONNECT_ENABLED_CONTEXT_KEY, DOMAIN_CONNECT_ENABLED_DEFAULT),
      ATMARK_DOMAIN_CONNECT_KEY_ARN: domainConnectKey.keyArn,
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // login-mailer 도 공통 환경을 받지 않는다(`src/runtime/login-mailer-composition.ts` 가 읽는 것만).
    const loginMailerEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_DB_LOGIN_MAILER_SECRET_ARN: ssmParameterNameOf(DB_LOGIN_MAILER_SECRET_NAME),
      ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN: ssmParameterNameOf(OWNER_LOGIN_KEYS_SECRET_NAME),
      // 운영자 코드 키링(ADR-0015) — 운영 워커가 필요할 때 처음 읽는다. 없거나 자리표시면 건너뛰고 메트릭만(소유자 메일은 그대로).
      [OPS_ENV.opsLoginKeysSecretArn]: ssmParameterNameOf(OPS_SECRET_NAMES.loginKeys),
      ATMARK_SES_CONFIGURATION_SET: CONFIGURATION_SET_NAME,
      // 환영 메일 스위치(위 `WELCOME_MAIL_ENABLED_DEFAULT`) — 문자열 'true'|'false'.
      ATMARK_WELCOME_MAIL_ENABLED: featureFlagOf(this.node, WELCOME_MAIL_ENABLED_CONTEXT_KEY, WELCOME_MAIL_ENABLED_DEFAULT),
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // passport-signer 도 공통 환경을 받지 않는다(`src/runtime/passport-signer-composition.ts` 가 읽는 것만).
    const passportSignerEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_DB_PASSPORT_SIGNER_SECRET_ARN: ssmParameterNameOf(DB_PASSPORT_SIGNER_SECRET_NAME),
      ATMARK_PASSPORT_KMS_KEY_ID: props.passportKey.keyArn,
      ATMARK_IDENTITY_BUCKET: props.identityBucket.bucketName,
      ATMARK_IDENTITY_DISTRIBUTION_ID: props.identityDistribution.distributionId,
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // contact-forwarder 만 전달 주소 비밀의 ARN 을 받는다(값이 아니라 위치 — 값은 실행 시 읽는다).
    // 격리 알림(ADR-0016 2026-10-07) — 배출은 approval-notifier 틱에서만. 킬 스위치는 이 함수의 환경에만 둔다(다른 함수 설정을 바꾸지 않는다).
    const approvalNotifierEnv: Record<string, string> = { ...commonEnv, ATMARK_QUARANTINE_NOTICE: quarantineNoticeOf(this.node) };
    const contactForwarderEnv: Record<string, string> = {
      ...commonEnv,
      ATMARK_CONTACT_FORWARD_TO_SECRET_ARN: ssmParameterNameOf(CONTACT_FORWARD_TO_SECRET_NAME),
      // 문의 라우팅 — `agent_and_notify` 면 알림만 보낸다(inbound 와 같은 값).
      [CONTACT_ROUTING_ENV]: contactRouting,
    };
    // inbound — 공통 환경 + 문의 라우팅(`forward` 가 아니면 support@ 도 에이전트 수신자).
    //   + AI 의심 메일 감시(ADR-0017 초안): 킬 스위치(`atmark:aiWatch`, 기본 off) · 요청 큐 URL(AtmarkAiWatch — 이름으로 맞춘다, 참조 0).
    const inboundEnv: Record<string, string> = {
      ...commonEnv,
      [CONTACT_ROUTING_ENV]: contactRouting,
      [AI_WATCH_ENV.mode]: aiWatchModeOf(this.node),
      [AI_WATCH_ENV.requestQueueUrl]: aiWatchQueueUrl(this.account, this.region, AI_WATCH_QUEUES.request),
    };
    // AI 감시 결과 λ — 공통 환경을 받지 않는다(앱 DB 비밀·버킷·키 없음). 자기 DB 비밀 위치뿐(큐 URL 은 이벤트 소스 매핑이 넣어 준다).
    const aiWatchResultEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      [AI_WATCH_ENV.dbSecretArn]: ssmParameterNameOf(AI_WATCH_DB_SECRET_NAME),
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // 실시간 WebSocket λ(묶음 E) — 공통 환경을 받지 않는다(버킷 · 승인/웹훅 키 · DLP 키 없음). 앱 DB 비밀 위치뿐.
    const realtimeEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_DB_SECRET_ARN: ssmParameterNameOf(DB_APP_SECRET_NAME),
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // 결제 웹훅 — **DB 없음**: DB 비밀·PGSSLMODE·CA 번들이 없다. 결제 스위치도 없다(꺼도 수신은 계속).
    const billingWebhookEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_PADDLE_ENV: paddleEnvironment,
      ATMARK_BILLING_QUEUE_URL: props.billing.queue.queueUrl,
      ATMARK_PADDLE_WEBHOOK_SECRET_ARN: ssmParameterNameOf(PADDLE_WEBHOOK_SECRET_NAME),
    };
    // 결제 sync — 공통 환경을 받지 않는다(앱 DB 비밀·버킷·승인 키 없음). 큐 URL 도 없다(이벤트 소스 매핑이 넣어 준다).
    const billingSyncEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      ATMARK_PADDLE_ENV: paddleEnvironment,
      ATMARK_BILLING_ENABLED: billingEnabled,
      ATMARK_DB_BILLING_SECRET_ARN: ssmParameterNameOf(DB_BILLING_SECRET_NAME),
      ATMARK_PADDLE_SYNC_API_KEY_SECRET_ARN: ssmParameterNameOf(PADDLE_SYNC_API_KEY_SECRET_NAME),
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // 메일 기본기 2차 A2 — 발신 첨부 스위치는 api 만(업로드 생성 404 · 발송의 `attachments` 400). 릴리스는 스위치와 무관하다.
    const apiEnv: Record<string, string> = {
      ...commonEnv,
      ATMARK_OUTBOUND_ATTACHMENTS_ENABLED: featureRolloutOf(this.node, OUTBOUND_ATTACHMENTS_ENABLED_CONTEXT_KEY, OUTBOUND_ATTACHMENTS_ENABLED_DEFAULT),
    };
    // ops(ADR-0015) — 공통 환경을 받지 않는다. login-mailer 함수 ARN 은 함수가 만들어진 뒤 붙인다(아래).
    const opsEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      [OPS_ENV.dbSecretArn]: ssmParameterNameOf(OPS_SECRET_NAMES.db),
      [OPS_ENV.opsKeysSecretArn]: ssmParameterNameOf(OPS_SECRET_NAMES.opsKeys),
      PGSSLMODE: 'require',
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };
    // domain-control — DB·비밀·버킷 없음. Principal(발송 역할 ARN)과 구성 세트 이름뿐(`src/runtime/handlers/domain-control.ts`).
    const domainControlEnv: Record<string, string> = {
      ATMARK_ENV: 'production',
      SENDER_ROLE_ARN: roles.sender.roleArn,
      ATMARK_SES_CONFIGURATION_SET: CONFIGURATION_SET_NAME,
    };
    const domainPolicyAuditEnv: Record<string, string> = { ATMARK_ENV: 'production', SENDER_ROLE_ARN: roles.sender.roleArn };
    const environmentOf = (name: HandlerName): Record<string, string> => {
      if (name === 'admin') return adminEnv;
      if (name === DOMAIN_POLICY_AUDIT_HANDLER) return domainPolicyAuditEnv;
      if (name === DOMAIN_CONTROL_HANDLER) return domainControlEnv;
      if (name === 'ops') return opsEnv;
      if (name === 'api') return apiEnv;
      if (name === 'billing-webhook') return billingWebhookEnv;
      if (name === 'billing-sync') return billingSyncEnv;
      if (name === CONTACT_FORWARDER_HANDLER) return contactForwarderEnv;
      if (name === 'passport-signer') return passportSignerEnv;
      if (name === 'login-mailer') return loginMailerEnv;
      if (name === 'inbound') return inboundEnv;
      if (name === AI_WATCH_RESULT_HANDLER_NAME) return aiWatchResultEnv;
      if (name === REALTIME_HANDLER_NAME) return realtimeEnv;
      if (name === 'migrate') return { ...commonEnv, ...migrateEnv };
      if (name === 'approval-notifier') return approvalNotifierEnv;
      return commonEnv;
    };

    const code = (name: HandlerName): lambda.Code => lambdaCodeOf(props.lambdaCode, name);

    const functions = {} as Record<HandlerName, lambda.Function>;
    const logGroups = {} as Record<HandlerName, logs.LogGroup>;
    // 하드 킬 스위치(위 `OPS_LOCKED_CONTEXT_KEY`) — 잠겨 있으면 ops 의 예약은 0 이다(호출 전부 스로틀).
    const reservedOf = (name: HandlerName): number => (name === 'ops' && opsLockedOf(this.node) ? 0 : RESERVED_CONCURRENCY[name]);
    for (const name of LAMBDA_HANDLERS) {
      const spec = HANDLER_SPECS[name];
      const functionName = `atmark-${name}`;
      const logGroup = new logs.LogGroup(this, `${pascal(name)}Logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: LAMBDA_LOG_RETENTION,
      });
      logGroups[name] = logGroup;
      // ★ VPC 밖은 둘 — 결제 웹훅(머리말 "결제")과 domain-control(DB 없음 · 권한 NS·RDAP·SES 로 바로 나간다 — NAT 장애가 확인 오류로 번지지 않게).
      //   이름으로 고정한다 — 예외가 늘면 테스트가 빨개진다.
      const network =
        name === 'billing-webhook' || name === DOMAIN_CONTROL_HANDLER || name === DOMAIN_POLICY_AUDIT_HANDLER
          ? {}
          : { vpc: props.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, securityGroups: [props.lambdaSecurityGroup] };
      functions[name] = new lambda.Function(this, `${pascal(name)}Function`, {
        functionName,
        description: spec.description,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: code(name),
        memorySize: spec.memoryMb,
        timeout: spec.timeout,
        reservedConcurrentExecutions: reservedOf(name),
        role: roles[spec.role],
        ...network,
        environment: environmentOf(name),
        // 로그 형식은 Text(기본)로 둔다. EMF(`src/observability/metrics.ts`)는 stdout 에 JSON 한 줄을 그대로 쓰고,
        // CloudWatch 는 그 줄을 메트릭으로 승격한다 — JSON 로그 형식으로 바꾸면 알람 6종의 입력이 바뀐다.
        logGroup,
      });
    }
    this.functions = functions;

    // admin → login-mailer 깨우기(메일 지연 1분 → 수 초). 함수 ARN 은 함수가 만들어진 뒤에야 있으므로 여기서 붙인다.
    //   IAM: `lambda:InvokeFunction` on 그 ARN **하나**(`grantInvoke` 는 `:*` 를 붙인다 — 쓰지 않는다). admin 은 VPC 안이고 Lambda API 는
    //   NAT 인스턴스로 나간다(Lambda SG 443 — Secrets Manager·KMS 와 같은 길. 엔드포인트를 따로 두지 않는다).
    functions.admin.addEnvironment('ATMARK_LOGIN_MAILER_FUNCTION_ARN', functions['login-mailer'].functionArn);
    roles.admin.addToPolicy(
      new iam.PolicyStatement({ sid: 'LoginMailerKick', actions: ['lambda:InvokeFunction'], resources: [functions['login-mailer'].functionArn] }),
    );
    // admin → api 콘솔 웹훅 시크릿 받기(보안 M1, 2026-09-30). admin 은 웹훅 키링이 없다 — 등록·회전을 커밋한 뒤 api λ 를 내부 이벤트
    //   (`src/runtime/internal-api-event.ts` — 정확한 키 집합, HTTP 이벤트와 겹치지 않는다)로 동기 호출하고, api λ 가 "60초 안의 콘솔 행" 을 DB 에서
    //   확인한 뒤에만 파생한다. IAM: `lambda:InvokeFunction` on api 함수 ARN **하나**(한정자·와일드카드 없음). DB 연결 예산은 그대로(새 함수 없음).
    functions.admin.addEnvironment('ATMARK_API_FUNCTION_ARN', functions.api.functionArn);
    roles.admin.addToPolicy(
      new iam.PolicyStatement({ sid: 'ApiWebhookSecretIssue', actions: ['lambda:InvokeFunction'], resources: [functions.api.functionArn] }),
    );
    // api → admin 자가 등록(ADR-0016 2026-10-08 · `src/runtime/enroll-event.ts`). 키 보관(KMS · SM)과 프로비저닝 쓰기는 admin 에만 있다 — api 에 넓히지 않고
    //   admin 을 내부 이벤트(정확한 모양 하나 · 동작 하나)로 RequestResponse 호출한다. admin 은 토큰 원문으로 DB 에서 처음부터 다시 판정한다.
    //   IAM: `lambda:InvokeFunction` on admin 함수 ARN **하나**(한정자 · 와일드카드 없음). ARN 은 **이름으로 만든다**(`formatArn`) — admin 환경이 이미 api
    //   ARN(GetAtt)을 갖고 있어 GetAtt 를 쓰면 두 함수가 서로를 참조하는 순환이 된다. 이름은 이 스택이 고정한다(`atmark-${name}`).
    //   역할은 발송 역할(`sender` — api · 승인 릴리스 · 승인 알림 · 예약 발송 · 문의 전달이 함께 쓴다)이라 그 함수들도 이 권한을 갖는다. 환경 변수는 api 에만 둔다 —
    //   다른 함수의 코드는 admin 을 부르지 않고, 불러도 admin 은 유효한 `agents:enroll` 토큰 원문 없이는 아무것도 만들지 않는다(리드 조건 1).
    //   **별칭으로 좁힌다(배포 전 보안 리뷰 M — 2026-10-08):** 발송 역할은 admin 의 **`enroll` 별칭 ARN 만** 부를 수 있다(한정자 없는 함수 ARN 은 아니다).
    //   admin 핸들러는 `context.invokedFunctionArn` 이 `:enroll` 로 끝나면 자가 등록 이벤트 **만** 받고, 그 밖의 호출에서는 자가 등록 이벤트를 거부한다 —
    //   그래서 발송 역할 하나가 탈취돼도 콘솔 HTTP 모양 이벤트(위조 apiId · sourceIp)를 admin 에 넣을 길이 없다. 콘솔(API Gateway)과 스케줄러는 한정자 없는
    //   함수를 부른다. 별칭은 `currentVersion`(코드 · 설정이 바뀌면 새 버전) — 예약 동시성은 함수와 공유한다(3).
    //   ARN 은 이름으로 만든다(별칭 Ref 를 쓰면 api → 별칭 → 버전 → admin → api 순환).
    const adminEnrollAlias = new lambda.Alias(this, 'AdminEnrollAlias', { aliasName: 'enroll', version: functions.admin.currentVersion as lambda.IVersion });
    const adminEnrollArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `atmark-admin:${adminEnrollAlias.aliasName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    functions.api.addEnvironment('ATMARK_ADMIN_FUNCTION_ARN', adminEnrollArn);
    // admin 은 HTTP 모양 이벤트를 **콘솔 HTTP API 에서 온 것만** 받는다(적대 검증 D2-U048 — 발송 역할이 admin 을 부를 수 있게 된 뒤, 위조한
    //   `requestContext`(sourceIp 등)로 콘솔 요청을 흉내 내지 못하게). 값은 콘솔 API 의 id 토큰(Ref) — 함수 → API 한 방향이라 순환이 없다(통합 · 권한이
    //   함수를 가리키고, API 자원은 함수를 가리키지 않는다).
    functions.admin.addEnvironment('ATMARK_CONSOLE_API_ID', this.consoleHttpApi.apiId);
    roles.sender.addToPolicy(new iam.PolicyStatement({ sid: 'AdminAgentEnroll', actions: ['lambda:InvokeFunction'], resources: [adminEnrollArn] }));
    // ops → login-mailer 깨우기(운영자 코드 메일 — 계획 §3.4 3). admin 과 같은 모양: ARN 하나 · 한정자·와일드카드 없음 · 입력은 고정 kick.
    functions.ops.addEnvironment(OPS_ENV.loginMailerFunctionArn, functions['login-mailer'].functionArn);
    roles.ops.addToPolicy(
      new iam.PolicyStatement({ sid: 'LoginMailerKick', actions: ['lambda:InvokeFunction'], resources: [functions['login-mailer'].functionArn] }),
    );
    // login-mailer 의 비동기 호출(틱·깨우기 모두): 함수 오류 재시도 0(다음 틱·다음 깨우기가 잇는다 — 깨우기가 몰릴 때 실패를 세 배로 불리지
    //   않는다) · 최대 이벤트 나이 1분(예약 1 에 스로틀된 깨우기는 1분 안에서만 다시 불린다 — 그 뒤는 틱이 맡는다).
    functions['login-mailer'].configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(1) });

    // 결제 웹훅 역할 — 자기 로그 그룹 쓰기만(사이트 역할과 같은 모양). CreateLogGroup 없음(그룹은 이 스택이 만든다).
    roles['billing-webhook'].addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnLogGroupWrite',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroups['billing-webhook'].logGroupArn],
      }),
    );
    // domain-control · 독립 감사 역할 — 같은 모양(자기 로그 그룹 쓰기).
    for (const handler of [DOMAIN_CONTROL_HANDLER, DOMAIN_POLICY_AUDIT_HANDLER] as const) {
      roles[handler].addToPolicy(
        new iam.PolicyStatement({ sid: 'OwnLogGroupWrite', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroups[handler].logGroupArn] }),
      );
    }
    // admin → domain-control(확인 틱 — ADR-0014 결정 3). 함수 ARN **하나**(한정자·와일드카드 없음, `grantInvoke` 를 쓰지 않는다). admin 은 VPC 안이고
    //   Lambda API 는 NAT 로 나간다(login-mailer 깨우기와 같은 길). 부르는 코드(`runtime/domain-control-invoker.ts`)의 배선은 단계 4.
    functions.admin.addEnvironment('ATMARK_DOMAIN_CONTROL_FUNCTION_ARN', functions[DOMAIN_CONTROL_HANDLER].functionArn);
    roles.admin.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DomainControlInvoke',
        actions: ['lambda:InvokeFunction'],
        resources: [functions[DOMAIN_CONTROL_HANDLER].functionArn],
      }),
    );
    // domain-control 은 동기로만 불린다 — 비동기 재시도가 SES 변형을 겹쳐 부르지 않게 0.
    functions[DOMAIN_CONTROL_HANDLER].configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(1) });

    // ── 비발송 역할의 SES 발송 명시 Deny(ADR-0014 단계 2 · `ses-send-deny.ts`) — 발송 주체 둘을 뺀 **스택의 모든 역할**(Scheduler 대상 역할 포함) ─────────
    exemptFromSesSendDeny(roles.sender);
    exemptFromSesSendDeny(roles['login-mailer']);
    denySesSendingInStack(this);
    // ── SSM 파라미터 삭제 명시 Deny(비밀 → SSM 이전 · `ssm-secrets.ts`) — 스택의 모든 역할. SSM 에는 삭제 복구 창이 없다 ─────────
    denySsmDeleteInStack(this);

    // ── HTTP API 라우트·스테이지 ────────────────────────────────────────────
    // `$default` 하나 — 라우팅은 api 핸들러가 한다(`src/api/http.ts`). `/` 도 여기로 온다.
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', functions.api, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    const apiRoutes = [
      new apigwv2.HttpRoute(this, 'DefaultRoute', {
        httpApi: this.httpApi,
        routeKey: apigwv2.HttpRouteKey.DEFAULT,
        integration: apiIntegration,
      }),
      // 공개 신원 조회 — 같은 Lambda, **다른 스로틀 버킷**(`API_ROUTE_THROTTLES`).
      ...Object.keys(API_ROUTE_THROTTLES).map((routeKey) => {
        const [method, path] = routeKey.split(' ') as [string, string];
        return new apigwv2.HttpRoute(this, `ApiRoute${pascal(path.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, ''))}`, {
          httpApi: this.httpApi,
          routeKey: apigwv2.HttpRouteKey.with(path, method as apigwv2.HttpMethod),
          integration: apiIntegration,
        });
      }),
    ];
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/atmark/api-access',
      retention: LAMBDA_LOG_RETENTION,
    });
    const apiStage = this.httpApi.addStage('DefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      // 비용·남용 상한. GATE 는 사용자 하나다 — 이 값에 닿는 것 자체가 사건이다.
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // 경로만(`$context.path`) — 쿼리 문자열(매직링크 토큰)은 남기지 않는다.
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.integrationLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        ),
      },
      ...(domain === undefined ? {} : { domainMapping: { domainName: domain } }),
    });

    (apiStage.node.defaultChild as apigwv2.CfnStage).routeSettings = Object.fromEntries(
      Object.entries(API_ROUTE_THROTTLES).map(([routeKey, limit]) => [
        routeKey,
        { ThrottlingRateLimit: limit.rateLimit, ThrottlingBurstLimit: limit.burstLimit },
      ]),
    );
    for (const route of apiRoutes) apiStage.node.addDependency(route);

    // ── 관리 HTTP API 라우트·스테이지 — 전부 admin 하나. 라우팅은 `src/admin/router.ts` 가 한다. ──────────────
    // 로그인 둘은 **라우트를 따로 둔다** — 스로틀 버킷을 나누기 위해서다(`CONSOLE_ROUTE_THROTTLES`). 통합은 같은 Lambda.
    // CORS(US-003): HTTP API 의 `corsPreflight` 를 **쓰지 않는다** — 쓰면 API Gateway 가 모든 경로의 OPTIONS 에 스스로 답하고
    //   응답 헤더를 덮는다. 대신 `OPTIONS /api/login`·`/api/signup` 은 명시 라우트가 없으므로(명시 라우트는 POST 뿐) `$default` 로
    //   admin Lambda 에 닿고, 라우터가 정확히 `https://atmark.ai` 에만 204 로 답한다. 프리플라이트는 `$default` 버킷을 쓴다(DB 0).
    const consoleIntegration = new HttpLambdaIntegration('ConsoleIntegration', functions.admin, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    const consoleRoutes = [
      new apigwv2.HttpRoute(this, 'ConsoleDefaultRoute', {
        httpApi: this.consoleHttpApi,
        routeKey: apigwv2.HttpRouteKey.DEFAULT,
        integration: consoleIntegration,
      }),
      ...Object.keys(CONSOLE_ROUTE_THROTTLES).map((routeKey) => {
        const [method, path] = routeKey.split(' ') as [string, string];
        return new apigwv2.HttpRoute(this, `ConsoleRoute${pascal(path.replace(/[^a-z]+/g, '-'))}`, {
          httpApi: this.consoleHttpApi,
          routeKey: apigwv2.HttpRouteKey.with(path, method as apigwv2.HttpMethod),
          integration: consoleIntegration,
        });
      }),
    ];
    const consoleAccessLogs = new logs.LogGroup(this, 'ConsoleAccessLogs', {
      logGroupName: '/atmark/console-access',
      retention: LAMBDA_LOG_RETENTION,
    });
    const consoleStage = this.consoleHttpApi.addStage('ConsoleDefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      // `$default`(세션 API·kill-switch·페이지)의 버킷. 로그인 라우트는 아래에서 따로 낮게 건다 — 로그인 남용이 이 버킷을
      //   비우지 못한다(검증 M3: 예전에는 5 rps 하나라 아무나 콘솔 전체를, kill-switch 까지 429 로 막을 수 있었다).
      throttle: CONSOLE_DEFAULT_THROTTLE,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(consoleAccessLogs),
        // 경로만 — 로그인 토큰은 fragment 라 어차피 서버에 오지 않는다. 쿠키·본문은 싣지 않는다.
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.integrationLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        ),
      },
      ...(consoleDomain === undefined ? {} : { domainMapping: { domainName: consoleDomain } }),
    });
    // 라우트 단위 스로틀(CloudFormation `RouteSettings` — CDK 의 HttpStage 에 속성이 없어 L1 로 건다). 라우트가 먼저 있어야 한다.
    (consoleStage.node.defaultChild as apigwv2.CfnStage).routeSettings = Object.fromEntries(
      Object.entries(CONSOLE_ROUTE_THROTTLES).map(([routeKey, limit]) => [
        routeKey,
        { ThrottlingRateLimit: limit.rateLimit, ThrottlingBurstLimit: limit.burstLimit },
      ]),
    );
    for (const route of consoleRoutes) consoleStage.node.addDependency(route);

    // ── 결제 웹훅 HTTP API(atmark-billing) — 라우트 하나 · `$default` 없음 · 통합은 billing-webhook 하나 ─────────────────
    // 커스텀 도메인을 두지 않는다: 알림 목적지 URL 은 Paddle 대시보드에만 적히고 사람이 방문하지 않는다(인증서·DNS 하나를 덜 운영한다).
    //   execute-api 기본 엔드포인트가 입구다(출력 `BillingWebhookUrl`). 다른 경로·메서드는 API Gateway 가 404 로 끝낸다(Lambda 호출 0).
    this.billingHttpApi = new apigwv2.HttpApi(this, 'BillingHttpApi', {
      apiName: 'atmark-billing',
      description: 'Atmark billing webhooks (Paddle) - billing-webhook Lambda only',
      createDefaultStage: false,
    });
    const billingRoute = new apigwv2.HttpRoute(this, 'BillingWebhookRoute', {
      httpApi: this.billingHttpApi,
      routeKey: apigwv2.HttpRouteKey.with(BILLING_WEBHOOK_ROUTE_PATH, apigwv2.HttpMethod.POST),
      integration: new HttpLambdaIntegration('BillingWebhookIntegration', functions['billing-webhook'], {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });
    const billingAccessLogs = new logs.LogGroup(this, 'BillingAccessLogs', {
      logGroupName: '/atmark/billing-access',
      retention: LAMBDA_LOG_RETENTION,
    });
    const billingStage = this.billingHttpApi.addStage('BillingDefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: BILLING_WEBHOOK_THROTTLE,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(billingAccessLogs),
        // 경로·상태만 — 헤더(서명)·바디·쿼리는 남기지 않는다. 발신 IP 는 D-6(기록) 대조용으로 남긴다.
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.integrationLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        ),
      },
    });
    billingStage.node.addDependency(billingRoute);

    // ── 운영자 콘솔 HTTP API(atmark-ops, ADR-0015) — 통합은 ops λ 하나 · 인증 넷은 라우트를 따로(스로틀 버킷 분리) ─────────────
    // 입구: `opsDomain` 이 있으면 `ops.atmark.ai` 하나(execute-api 끔). 없으면(롤아웃 §5 2단계) execute-api 호스트 — λ 가 Host ≠ ops.atmark.ai 를
    //   421 로 거절하므로 쿠키(`__Host-`)·Origin 검사가 전제하는 출처 밖에서는 아무 것도 되지 않는다. CORS 는 0(`corsPreflight` 없음).
    this.opsHttpApi = new apigwv2.HttpApi(this, 'OpsHttpApi', {
      apiName: 'atmark-ops',
      description: 'Atmark hosted operator console (ops Lambda only, ADR-0015)',
      createDefaultStage: false,
      disableExecuteApiEndpoint: props.opsDomain !== undefined,
    });
    const opsDomain =
      props.opsDomain === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'OpsDomainName', {
            domainName: props.opsDomain.domainName,
            certificate: props.opsDomain.certificate,
          });
    const opsIntegration = new HttpLambdaIntegration('OpsIntegration', functions.ops, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    const opsRoutes = [
      new apigwv2.HttpRoute(this, 'OpsDefaultRoute', {
        httpApi: this.opsHttpApi,
        routeKey: apigwv2.HttpRouteKey.DEFAULT,
        integration: opsIntegration,
      }),
      ...Object.keys(OPS_ROUTE_THROTTLES).map((routeKey) => {
        const [method, path] = routeKey.split(' ') as [string, string];
        return new apigwv2.HttpRoute(this, `OpsRoute${pascal(path.replace(/[^a-z]+/g, '-'))}`, {
          httpApi: this.opsHttpApi,
          routeKey: apigwv2.HttpRouteKey.with(path, method as apigwv2.HttpMethod),
          integration: opsIntegration,
        });
      }),
    ];
    const opsAccessLogs = new logs.LogGroup(this, 'OpsAccessLogs', {
      logGroupName: '/atmark/ops-access',
      retention: LAMBDA_LOG_RETENTION,
    });
    const opsStage = this.opsHttpApi.addStage('OpsDefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: OPS_DEFAULT_THROTTLE,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(opsAccessLogs),
        // 경로·상태만 — **IP 없음**(운영자 위치는 PII, 계획 §3.1). 쿠키·본문·쿼리·UA 도 싣지 않는다.
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.integrationLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        ),
      },
      ...(opsDomain === undefined ? {} : { domainMapping: { domainName: opsDomain } }),
    });
    (opsStage.node.defaultChild as apigwv2.CfnStage).routeSettings = Object.fromEntries(
      Object.entries(OPS_ROUTE_THROTTLES).map(([routeKey, limit]) => [
        routeKey,
        { ThrottlingRateLimit: limit.rateLimit, ThrottlingBurstLimit: limit.burstLimit },
      ]),
    );
    for (const route of opsRoutes) opsStage.node.addDependency(route);
    // 합성 가드(CR-M3) — 도메인 없이 합성하면 경고를 남긴다. `ops.atmark.ai` 가 이미 붙은 계정에 이 템플릿을 배포하면 도메인·매핑이 **삭제된다**.
    //   롤아웃 §5 2단계(도메인 전)에서는 정상이다. 계정 상태를 synth 가 조회하지 않으므로(lookup 0 — CI 가 자격증명 없이 합성) 경고로 둔다.
    if (props.opsDomain === undefined) {
      cdk.Annotations.of(this).addWarningV2(
        'atmark:ops-domain-absent',
        `ops HTTP API 를 커스텀 도메인 없이 합성했다 — ${OPS_DOMAIN_READY_CONTEXT_KEY} 가 거짓이다. ops.atmark.ai 가 이미 붙어 있다면 이 배포는 도메인을 지운다 ` +
          '(OPS_DOMAIN_READY_DEFAULT 를 true 로 커밋했는지 · 컨텍스트를 빠뜨렸는지 확인 — docs/runbooks/deploy.md §24).',
      );
    }

    // ══ 실시간 WebSocket(묶음 E — `wss://realtime.atmark.ai`) ══════════════════════════════════════════════════════════════════════
    //   (이 블록은 묶음 E 의 것이다 — 다른 묶음의 IAM 변경과 섞지 않는다.)
    // 라우트 셋($connect · $disconnect · $default)의 통합은 실시간 λ 하나. `$default` 는 응답을 돌려준다(핑 → 퐁). 인증은 λ 가 한다(라우트 authorizer 없음 —
    //   토큰 판정을 REST 와 같은 함수 하나로 두려고). 접근 로그: 연결 id · 라우트 · 상태 · IP(남용 조사) — 머리 · 쿼리 · 본문 없음(토큰이 실릴 자리를 남기지 않는다).
    const realtimeIntegration = (id: string): WebSocketLambdaIntegration => new WebSocketLambdaIntegration(id, functions[REALTIME_HANDLER_NAME]);
    this.realtimeApi = new apigwv2.WebSocketApi(this, 'RealtimeApi', {
      apiName: 'atmark-realtime',
      description: 'Atmark realtime WebSocket (agent hints: message.received, approval.resolved) - realtime Lambda only',
      connectRouteOptions: { integration: realtimeIntegration('RealtimeConnectIntegration') },
      disconnectRouteOptions: { integration: realtimeIntegration('RealtimeDisconnectIntegration') },
      defaultRouteOptions: { integration: realtimeIntegration('RealtimeDefaultIntegration'), returnResponse: true },
    });
    const realtimeDomain =
      props.realtimeDomain === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'RealtimeDomainName', {
            domainName: props.realtimeDomain.domainName,
            certificate: props.realtimeDomain.certificate,
          });
    const realtimeStage = new apigwv2.WebSocketStage(this, 'RealtimeStage', {
      webSocketApi: this.realtimeApi,
      stageName: REALTIME_STAGE_NAME,
      autoDeploy: true,
      // 계정 전체 버킷(연결 · 메시지 합) — 예약 1 λ 앞에서 넘친 요청을 API Gateway 가 먼저 429 로 끊는다.
      throttle: REALTIME_STAGE_THROTTLE,
      // 접근 로그는 두지 않는다(2026-10-08 첫 배포 실패) — WebSocket 스테이지의 로그는 계정 단위 API Gateway CloudWatch 역할(계정 설정)을 요구한다.
      //   계정 설정을 바꾸지 않고, 연결 · 해제 · 메시지는 실시간 λ 의 구조화 로그와 메트릭으로 본다.
      ...(realtimeDomain === undefined ? {} : { domainMapping: { domainName: realtimeDomain } }),
    });
    // `$connect` 는 버킷을 따로(적대 검증 E1-G-012) — 무인증 연결 폭주가 스테이지 버킷(핑 · 메시지)을 비우지 못하게. WebSocket 스테이지도 라우트별
    //   스로틀(RouteSettings)을 받는다(라우트가 먼저 있어야 한다 — API 에 의존).
    (realtimeStage.node.defaultChild as apigwv2.CfnStage).routeSettings = Object.fromEntries(
      Object.entries(REALTIME_ROUTE_THROTTLES).map(([routeKey, limit]) => [
        routeKey,
        { ThrottlingRateLimit: limit.rateLimit, ThrottlingBurstLimit: limit.burstLimit },
      ]),
    );
    realtimeStage.node.addDependency(this.realtimeApi);
    this.realtimeUrl = realtimeDomain === undefined ? realtimeStage.url : REALTIME_PUBLIC_URL;
    // 만드는 λ(수신 · 승인 링크 · 콘솔 풀기 · AI 감시 결과)만 `PostToConnection` — 이 API · 이 스테이지 · POST @connections 하나(GET·DELETE 없음).
    //   발송 역할은 api 와 릴리스 워커들이 함께 쓴다(머리말 "합집합") — 연결에 쓸 수 있는 프레임은 DB 가 정한 대상에게만 간다(`realtime/push.ts`).
    const realtimePostArn = `arn:${this.partition}:execute-api:${this.region}:${this.account}:${this.realtimeApi.apiId}/${REALTIME_STAGE_NAME}/POST/@connections/*`;
    for (const key of REALTIME_PRODUCER_ROLES) {
      roles[key].addToPolicy(
        new iam.PolicyStatement({ sid: 'RealtimePostToConnection', actions: ['execute-api:ManageConnections'], resources: [realtimePostArn] }),
      );
    }
    for (const name of REALTIME_PRODUCER_HANDLERS) functions[name].addEnvironment(REALTIME_ENV.callbackUrl, realtimeStage.callbackUrl);
    // 에이전트에게 알리는 접속 주소(발견 문서 · MCP `get_realtime_connection`) — 도메인 전에는 execute-api `wss://` 주소.
    functions.api.addEnvironment(REALTIME_ENV.publicUrl, this.realtimeUrl);
    new cdk.CfnOutput(this, 'RealtimeUrl', {
      value: this.realtimeUrl,
      description: '실시간 WebSocket 접속 주소(묶음 E) — 도메인 전에는 execute-api 주소. 스모크: pnpm tsx scripts/realtime-smoke.ts',
    });
    if (realtimeDomain !== undefined) {
      new cdk.CfnOutput(this, 'RealtimeCustomDomainCnameTarget', {
        value: realtimeDomain.regionalDomainName,
        description: `${props.realtimeDomain?.domainName ?? ''} 의 CNAME 값 — Cloudflare 에 **프록시 OFF** 로 넣는다(진윤겸 승인 뒤 리드가 · deploy §46)`,
      });
    }
    // ══ 실시간 WebSocket 끝 ═══════════════════════════════════════════════════════════════════════════════════════════════

    // ── SQS 이벤트 소스 — 부분 실패 보고 ────────────────────────────────────
    functions.inbound.addEventSource(
      new SqsEventSource(props.inboundQueue, {
        batchSize: 1, // 원문 최대 40 MiB — 한 번에 하나.
        reportBatchItemFailures: true,
        maxConcurrency: SQS_MAX_CONCURRENCY,
      }),
    );
    functions['ses-events'].addEventSource(
      new SqsEventSource(props.sesEventQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxConcurrency: SQS_MAX_CONCURRENCY,
      }),
    );
    // 결제 이벤트 — 한 번에 하나(FIFO 그룹 순서 · 조직 재계산 직렬). **최대 동시성을 걸지 않는다**: Lambda 는 새 매핑을 만들 때
    // `MaximumConcurrency > 함수 예약 동시성` 을 400 으로 거부한다(2026-09-25 운영 배포 실측 — 기존 ses-events 매핑은 그 검사 전에 만들어져
    // 남아 있다). 예약 1 이 실제 상한이고(sync 와 reconcile 이 겹치지 않는 근거), 넘친 폴링은 스로틀 → 가시성 360s ≥ 6 × 60s(billing-stack)
    // 뒤 다시 받는다 — 수신 10회(`BILLING_DLQ_MAX_RECEIVE_COUNT`) 예산이 그 재시도를 흡수한다.
    functions['billing-sync'].addEventSource(
      new SqsEventSource(props.billing.queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ── AI 의심 메일 감시(ADR-0017 초안) — 큐·CMK 는 AtmarkAiWatch(손 배포, 참조 0 — 이름·ARN 을 계약에서 조립한다) ─────────────────────
    // inbound: 요청 큐 SendMessage 하나. KMS(GenerateDataKey·Decrypt)는 **CMK 키 정책**이 이 역할을 이름으로 준다(조건 ViaService · 큐 ARN) —
    //   여기 IAM 에 KMS 문장을 두지 않는다(키 ARN 을 모르니 와일드카드가 된다). 모드가 off 면 코드가 보내지 않는다.
    roles.inbound.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AiWatchRequestSend',
        actions: [...AI_WATCH_IAM_ACTIONS.inboundRequestQueue],
        resources: [aiWatchQueueArn(this.account, this.region, AI_WATCH_QUEUES.request)],
      }),
    );
    // 결과 큐 → 결과 λ. 큐가 이미 있어야 매핑을 만들 수 있다 — `atmark:aiWatchQueuesReady`(위 상수) 전에는 매핑도 소비 권한도 없다.
    //   batch 10 · 부분 실패 보고 · 최대 동시성 없음(예약 1 < SQS 최소 2 — 새 매핑은 거부된다, 결제 sync 와 같은 이유).
    if (aiWatchQueuesReadyOf(this.node)) {
      const resultQueue = sqs.Queue.fromQueueArn(this, 'AiWatchResultQueue', aiWatchQueueArn(this.account, this.region, AI_WATCH_QUEUES.result));
      functions[AI_WATCH_RESULT_HANDLER_NAME].addEventSource(
        new SqsEventSource(resultQueue, {
          batchSize: AI_WATCH_RESULT_BATCH_SIZE,
          reportBatchItemFailures: true,
        }),
      );
    } else {
      cdk.Annotations.of(this).addWarningV2(
        'atmark:ai-watch-queues-absent',
        `AI 감시 결과 큐 매핑 없이 합성했다 — ${AI_WATCH_QUEUES_READY_CONTEXT_KEY} 가 거짓이다(AtmarkAiWatch 배포 전 정상 · docs/runbooks/ai-watch.md §7).`,
      );
    }

    // ── EventBridge Scheduler ───────────────────────────────────────────────
    for (const { handler, minutes } of SCHEDULES) {
      new scheduler.Schedule(this, `${pascal(handler)}Schedule`, {
        scheduleName: `atmark-${handler}`,
        description: `${handler} every ${String(minutes)} min`,
        schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(minutes)),
        // 재시도 없음 · 1분 넘은 호출 버림 — 다음 틱이 같은 일을 한다(워커는 DB 에서 집는다).
        target: new schedulerTargets.LambdaInvoke(functions[handler], {
          ...(handler === 'login-mailer' ? { input: scheduler.ScheduleTargetInput.fromObject(LOGIN_MAILER_TICK_INPUT) } : {}),
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(1),
        }),
      });
    }

    // 결제 reconcile — 같은 sync 함수를 입력 `{"action":"reconcile"}` 로. 커서가 DB 에 있어 다음 틱이 잇는다(재시도 0 · 1분 넘은 호출 버림).
    // Scheduler 는 **비동기**로 부른다 — Scheduler 의 재시도 0 과 별개로 Lambda 비동기 호출은 실패 시 기본 2회 다시 부른다. 던진 reconcile 을
    //   Lambda 가 다시 부르면 예약 동시성 1 을 붙잡아 SQS 소비를 굶기고, 같은 실패를 세 번 센다(`sync_failed` 알람). 다음 틱(15분)이 잇는다.
    functions['billing-sync'].configureAsyncInvoke({ retryAttempts: 0 });
    new scheduler.Schedule(this, 'BillingReconcileSchedule', {
      scheduleName: 'atmark-billing-reconcile',
      description: `billing-sync reconcile every ${String(BILLING_RECONCILE_MINUTES)} min`,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(BILLING_RECONCILE_MINUTES)),
      target: new schedulerTargets.LambdaInvoke(functions['billing-sync'], {
        input: scheduler.ScheduleTargetInput.fromObject({ action: 'reconcile' }),
        retryAttempts: 0,
        maxEventAge: cdk.Duration.minutes(1),
      }),
    });

    // 고객 도메인 확인 틱(ADR-0014 · 계획 §3.4) — admin λ 를 과제 이벤트로. **기본 ENABLED**(위 `DOMAIN_RECHECK_ENABLED_DEFAULT` — M5) — 리소스는 늘
    //   있고 컨텍스트로 끌 수 있다. Scheduler 는 비동기로 부르므로 admin 의 비동기 재시도도 0(다음 틱이 잇는다 — 겹친 틱이 같은 행을 두 번 보지 않게).
    functions.admin.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(1) });
    new scheduler.Schedule(this, 'DomainRecheckSchedule', {
      scheduleName: DOMAIN_RECHECK_SCHEDULE_NAME,
      description: `customer domain check tick every ${String(DOMAIN_RECHECK_MINUTES)} min (ADR-0014) - admin {"task":"domain-recheck"}`,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(DOMAIN_RECHECK_MINUTES)),
      enabled: domainRecheckEnabledOf(this.node),
      target: new schedulerTargets.LambdaInvoke(functions.admin, {
        input: scheduler.ScheduleTargetInput.fromObject(DOMAIN_RECHECK_INPUT),
        retryAttempts: 0,
        maxEventAge: cdk.Duration.minutes(1),
      }),
    });

    // 자원 정책 독립 감사(보안 리뷰 M2 · 재검증 MEDIUM-1) — ① 정책을 쓰거나 지우는 CloudTrail 이벤트마다(누가 했든 — 쓰기면 요청 원문도 본다) ② 12시간마다 전수. 읽기 전용이라 처음부터 켜 둔다
    //   (고객 identity 가 0 인 동안은 atmark.ai 의 "정책 0" 만 본다). 비동기 재시도 0 — 다음 이벤트·다음 날이 잇는다.
    functions[DOMAIN_POLICY_AUDIT_HANDLER].configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.hours(1) });
    new events.Rule(this, 'DomainPolicyAuditTrigger', {
      ruleName: DOMAIN_POLICY_AUDIT_RULE_NAME,
      description: 'SES identity policy written or deleted (CloudTrail) - check the request document and re-read with a read-only role (ADR-0014)',
      eventPattern: {
        source: ['aws.ses'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: { eventSource: ['ses.amazonaws.com'], eventName: [...DOMAIN_POLICY_AUDIT_TRIGGER_EVENTS] },
      },
      targets: [new eventTargets.LambdaFunction(functions[DOMAIN_POLICY_AUDIT_HANDLER], { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1) })],
    });
    new scheduler.Schedule(this, 'DomainPolicyAuditSchedule', {
      scheduleName: DOMAIN_POLICY_AUDIT_SCHEDULE_NAME,
      description: `full scan of SES identity policies every ${String(DOMAIN_POLICY_AUDIT_SCAN_HOURS)}h (ADR-0014, read-only) - heartbeat metric`,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.hours(DOMAIN_POLICY_AUDIT_SCAN_HOURS)),
      target: new schedulerTargets.LambdaInvoke(functions[DOMAIN_POLICY_AUDIT_HANDLER], {
        input: scheduler.ScheduleTargetInput.fromObject(DOMAIN_POLICY_AUDIT_SCHEDULE_INPUT),
        retryAttempts: 0,
        maxEventAge: cdk.Duration.minutes(1),
      }),
    });

    // ── 스텁 코드는 배포할 수 없다 ──────────────────────────────────────────
    refuseStubDeployment(this, props.lambdaCode, { warn: true });

    // ── 출력 ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'execute-api 기본 엔드포인트(스모크용)',
    });
    new cdk.CfnOutput(this, 'ApprovalPageUrl', {
      value: this.approvalPageUrl,
      description: 'ATMARK_APPROVAL_PAGE_URL — 매직링크 착지점',
    });
    if (domain !== undefined) {
      new cdk.CfnOutput(this, 'ApiCustomDomainCnameTarget', {
        value: domain.regionalDomainName,
        description: `${props.apiDomain?.domainName ?? ''} 의 CNAME 값 — Cloudflare 에 **프록시 OFF** 로 넣는다`,
      });
    }
    new cdk.CfnOutput(this, 'SenderRoleName', {
      value: roles.sender.roleName,
      description: 'SES 발송 권한을 가진 유일한 런타임 역할 — docs/ops/ses-principals-allowlist.json runtimeRoles',
    });
    new cdk.CfnOutput(this, 'LoginMailerRoleName', {
      value: roles['login-mailer'].roleName,
      description: `둘째 SES 발송 역할 — ${LOGIN_MAILER_FROM_ADDRESSES.join(' · ')} 로만(ADR-0006). docs/ops/ses-principals-allowlist.json runtimeRoles`,
    });
    new cdk.CfnOutput(this, 'PassportSignerRoleName', {
      value: roles['passport-signer'].roleName,
      description: '에이전트 개인키를 복호하는 유일한 런타임 역할(계약 §3). SES 0 — check-ses-principals 의 발송 주체 수(2)에 들지 않는다',
    });
    new cdk.CfnOutput(this, 'ConsoleUrl', {
      value: this.consoleUrl,
      description: '관리 화면(소유자 로그인). 로그인 링크 착지점은 이 값 + /login (OWNER_LOGIN_PAGE_URL 과 같아야 한다)',
    });
    if (consoleDomain !== undefined) {
      new cdk.CfnOutput(this, 'ConsoleCustomDomainCnameTarget', {
        value: consoleDomain.regionalDomainName,
        description: `${props.consoleDomain?.domainName ?? ''} 의 CNAME 값 — Cloudflare 에 **프록시 OFF** 로 넣는다`,
      });
    }
    new cdk.CfnOutput(this, 'OpsUrl', {
      value: props.opsDomain === undefined ? this.opsHttpApi.apiEndpoint : `https://${props.opsDomain.domainName}`,
      description: '운영자 콘솔 입구(ADR-0015). 도메인 전에는 execute-api 호스트 — λ 가 421 로 거절한다(런북 docs/runbooks/ops-console.md)',
    });
    if (opsDomain !== undefined) {
      new cdk.CfnOutput(this, 'OpsCustomDomainCnameTarget', {
        value: opsDomain.regionalDomainName,
        description: `${props.opsDomain?.domainName ?? ''} 의 CNAME 값 — Cloudflare 에 **프록시 OFF** 로 넣는다(진윤겸 승인 뒤 리드가)`,
      });
    }
    new cdk.CfnOutput(this, 'BillingWebhookUrl', {
      value: `${this.billingHttpApi.apiEndpoint}${BILLING_WEBHOOK_ROUTE_PATH}`,
      description: 'Paddle 알림 목적지 URL(docs/runbooks/billing.md) — 이벤트 11종만 구독한다',
    });
    new cdk.CfnOutput(this, 'DomainControlRoleName', {
      value: roles['domain-control'].roleName,
      description: '고객 도메인 identity 를 바꾸는 유일한 런타임 역할(ADR-0014) — SES 발송 Deny. 이 역할 밖의 identity 변경은 알림(observability)',
    });
    new cdk.CfnOutput(this, 'DbDomainTickSecretArn', {
      value: dbDomainTick.secretArn,
      description: `${DOMAIN_TICK_DB_SECRET_NAME} — migrate bootstrap-roles 가 채운다(ADR-0014 단계 2)`,
    });
    new cdk.CfnOutput(this, 'DbAiWatchSecretArn', {
      value: dbAiWatch.secretArn,
      description: `${AI_WATCH_DB_SECRET_NAME} — migrate bootstrap-roles 가 채운다(ADR-0017 초안)`,
    });
    new cdk.CfnOutput(this, 'MigrateFunctionName', {
      value: functions.migrate.functionName,
      description: 'aws lambda invoke --function-name <이 값> — 마이그레이션·롤 부트스트랩',
    });
  }
}
