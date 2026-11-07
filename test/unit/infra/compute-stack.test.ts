/**
 * `AtmarkCompute` — 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * Layer E 의 본체가 여기서 스택 단위로 한 번 더 선다: SES 발송 권한은 역할 **둘**(ADR-0006) — 발송 역할은 `*@atmark.ai`
 * (단 `login@` 은 명시 Deny), 로그인 메일 역할은 `login@atmark.ai` 하나로만. 발송하지 않는 핸들러의 역할엔 SES 가 0. 그 밖에: S3 는 접두사 단위·삭제 없음, SQS 부분 실패 보고, 로그 보존,
 * 스케줄 주기, 스텁 코드는 배포 거부, 빌드 산출물 없는 운영 synth 는 실패.
 */

import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it, vi } from 'vitest';

import {
  API_TIMEOUT_SECONDS,
  BILLING_ENABLED_DEFAULT,
  billingEnabledOf,
  BILLING_RECONCILE_MINUTES,
  BILLING_WEBHOOK_THROTTLE,
  BILLING_WEBHOOK_TIMEOUT_SECONDS,
  CONSOLE_DEFAULT_THROTTLE,
  CONSOLE_ROUTE_THROTTLES,
  ADMIN_LAMBDA_BUCKET_CEILING,
  DOMAIN_CONTROL_HANDLER,
  DOMAIN_CONTROL_ROLE_NAME,
  DOMAIN_IDENTITY_TAG_KEYS,
  DOMAIN_RECHECK_ENABLED_CONTEXT_KEY,
  DOMAIN_RECHECK_ENABLED_DEFAULT,
  DOMAIN_RECHECK_MINUTES,
  DOMAIN_RECHECK_SCHEDULE_NAME,
  DOMAIN_POLICY_AUDIT_ROLE_NAME,
  DOMAIN_POLICY_AUDIT_RULE_NAME,
  DOMAIN_POLICY_AUDIT_SCHEDULE_NAME,
  DOMAIN_TICK_DB_SECRET_NAME,
  domainRecheckEnabledOf,
  LAMBDA_HANDLERS,
  LOGIN_MAILER_FROM_ADDRESS,
  LOGIN_MAILER_FROM_ADDRESSES,
  LOGIN_MAILER_ROLE_LOGICAL_ID,
  LOGIN_MAILER_ROLE_NAME,
  LOGIN_MAILER_TICK_INPUT,
  OPS_DEFAULT_THROTTLE,
  OPS_DOMAIN_READY_CONTEXT_KEY,
  OPS_DOMAIN_READY_DEFAULT,
  OPS_LOCKED_CONTEXT_KEY,
  OPS_LOCKED_DEFAULT,
  opsDomainReadyOf,
  opsLockedOf,
  OPS_ROUTE_THROTTLES,
  OUTBOUND_SCHEDULED_PREFIX as STACK_OUTBOUND_SCHEDULED_PREFIX,
  SCHEDULES,
  SENDER_ROLE_LOGICAL_ID,
  SENDER_ROLE_NAME,
  SES_NON_CANONICAL_FROM_PATTERNS,
  SES_RESERVED_SUFFIX_CANONICAL_EXCEPTIONS,
  SES_RESERVED_SUFFIX_PATTERNS,
  SES_SENDING_HANDLERS,
  CONTACT_ROUTING_CONTEXT_KEY,
  CONTACT_ROUTING_DEFAULT,
  contactRoutingOf,
  DENY_SIGN_EXCEPT_ADMIN_SID,
  DLP_KEYS_SECRET_NAME,
  DOMAIN_CONNECT_ENABLED_CONTEXT_KEY,
  DOMAIN_CONNECT_ENABLED_DEFAULT,
  DOMAIN_CONNECT_KEY_ALIAS,
  QUARANTINE_NOTICE_CONTEXT_KEY,
  QUARANTINE_NOTICE_DEFAULT,
  quarantineNoticeOf,
  RISK_HOLD_ENFORCE_CONTEXT_KEY,
  RISK_HOLD_ENFORCE_DEFAULT,
  riskHoldEnforceOf,
  SES_RECEIVE_ONLY_FROM_ADDRESSES,
  SES_RESERVED_LOCAL_PARTS,
  WELCOME_MAIL_ENABLED_CONTEXT_KEY,
  WELCOME_MAIL_ENABLED_DEFAULT,
  WELCOME_MAIL_FROM_ADDRESS,
  REALTIME_DOMAIN_READY_DEFAULT,
  REALTIME_PRODUCER_HANDLERS,
  REALTIME_PRODUCER_ROLES,
  REALTIME_STAGE_NAME,
  REALTIME_STAGE_THROTTLE,
  realtimeDomainReadyOf,
} from '../../../infra/cdk/stacks/compute-stack';
import { CONTACT_ROUTING_ENV } from '../../../src/contact/routing';
import { AI_WATCH_RESULT_FUNCTION_NAME, AI_WATCH_RESULT_POOL_MAX } from '../../../src/inbound/ai-watch/contract';
import {
  REALTIME_DOMAIN_NAME,
  REALTIME_ENV,
  REALTIME_FUNCTION_NAME,
  REALTIME_HANDLER_NAME,
  REALTIME_POOL_MAX,
  REALTIME_PUBLIC_URL,
} from '../../../src/realtime/contract';
import { RESERVED_FROM_ADDRESSES } from '../../../src/mail/events/from-alignment';
import { ORG_API_ORG_REQUESTS_PER_MINUTE } from '../../../src/admin/org-api/rate-limit';
import { CONTACT_ADDRESS } from '../../../src/contact/intake';
import { AGENT_LOCAL_PART_PATTERN, RECEIVE_ONLY_ADDRESSES } from '../../../src/identity/address';
import { APPROVAL_NOTIFY_FROM_ADDRESS } from '../../../src/notify/approval-notifier';
import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';
import { INBOUND_VISIBILITY_TIMEOUT_SECONDS } from '../../../infra/cdk/stacks/inbound-stack';
import { SES_EVENT_QUEUE_VISIBILITY_SECONDS, SesStack } from '../../../infra/cdk/stacks/ses-stack';
import { OUTBOUND_CONTENT_PREFIX, OUTBOUND_SCHEDULED_PREFIX } from '../../../src/storage/object-store';
import {
  BILLING_QUEUE_NAME,
  BILLING_QUEUE_VISIBILITY_SECONDS,
  BILLING_SYNC_TIMEOUT_SECONDS,
  DB_BILLING_OPERATOR_SECRET_NAME,
  DB_BILLING_SECRET_NAME,
  PADDLE_ADMIN_API_KEY_SECRET_NAME,
  PADDLE_SYNC_API_KEY_SECRET_NAME,
  PADDLE_WEBHOOK_SECRET_NAME,
} from '../../../infra/cdk/stacks/billing-stack';
import { PADDLE_ENVIRONMENT_DEFAULT } from '../../../src/billing/constants';
import { LOGIN_MAILER_EVENT_SOURCE, RUNTIME_ENV } from '../../../src/runtime/config';
import {
  OPS_DOMAIN_NAME,
  OPS_ENV,
  OPS_FUNCTION_NAME,
  OPS_POOL_MAX,
  OPS_RESERVED_CONCURRENCY,
  OPS_ROLE_CONNECTION_LIMIT,
  OPS_ROUTES,
  OPS_SECRET_NAMES,
} from '../../../src/ops/contract';
import {
  APPROVAL_LINK_KEYS_SECRET_NAME,
  DB_ADMIN_SECRET_NAME,
  DB_APP_SECRET_NAME,
  DB_LOGIN_MAILER_SECRET_NAME,
  OWNER_LOGIN_KEYS_SECRET_NAME,
  SECRET_PLACEHOLDER_VALUE,
} from '../../../infra/cdk/stacks/data-stack';
import { SES_SEND_DENY_ACTIONS, SES_SEND_DENY_SID } from '../../../infra/cdk/stacks/ses-send-deny';
import { SSM_DELETE_DENY_ACTIONS, SSM_DELETE_DENY_SID } from '../../../infra/cdk/stacks/ssm-secrets';
import { SSM_DB_ROLE_SECRET_NAMES, SSM_SECRET_NAMES, SSM_SECRETS_KEY_ALIAS } from '../../../src/runtime/ssm-secret-names';
import { NAT_SSM_PARAMETER_DENY_SID } from '../../../infra/cdk/stacks/network-stack';
import {
  actionsOf,
  allStatementsByRole,
  buildRuntimeApp,
  forwardRoutingCompute,
  readsSsmSecret,
  runtimeStackTemplate,
  runtimeTemplates,
  statementsByRole,
  writesSsmSecret,
  type IamStatement,
} from './runtime-app';

/** `ses-stack.ts` 의 큐 가시성(60s). 상수로 export 되어 있지 않아 값으로 적는다. */

const SES_SEND = /^(\*|ses:\*|ses:Send.*)$/;

interface FunctionResource {
  readonly Properties: {
    readonly FunctionName: string;
    readonly Runtime: string;
    readonly Architectures: string[];
    readonly Handler: string;
    readonly Timeout: number;
    readonly MemorySize: number;
    readonly Role: { 'Fn::GetAtt': [string, string] };
    readonly VpcConfig?: unknown;
    readonly LoggingConfig?: { LogFormat?: string; LogGroup?: unknown };
    readonly Environment: { Variables: Record<string, unknown> };
  };
}

/** VPC 밖 · DB 없는 함수 — 이름으로 고정한다(예외가 늘면 빨개진다). */
const NO_VPC_NO_DB: readonly string[] = ['atmark-billing-webhook', 'atmark-domain-control', 'atmark-domain-policy-audit'];

function functionsByName(template: Template): Map<string, FunctionResource['Properties']> {
  const functions = template.findResources('AWS::Lambda::Function') as Record<string, FunctionResource>;
  return new Map(Object.values(functions).map((f) => [f.Properties.FunctionName, f.Properties]));
}

function sesStatements(statements: readonly IamStatement[]): IamStatement[] {
  return statements.filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => SES_SEND.test(a)));
}

describe('AtmarkCompute — Lambda 20개', () => {
  it('D1 계약의 이름 20개(admin·login-mailer·결제 둘·ops·domain-control·domain-policy-audit·ai-watch-result·realtime 포함) · Node 22 · arm64 · index.handler · VPC 안 — 예외는 결제 웹훅·domain-control·독립 감사 셋(이름으로)', () => {
    const functions = functionsByName(runtimeTemplates().compute);
    expect([...functions.keys()].sort()).toEqual(LAMBDA_HANDLERS.map((n) => `atmark-${n}`).sort());
    expect(functions.size).toBe(20);
    expect(functions.has(OPS_FUNCTION_NAME)).toBe(true);
    for (const [name, fn] of functions) {
      expect(fn.Runtime, name).toBe('nodejs22.x');
      expect(fn.Architectures, name).toEqual(['arm64']);
      expect(fn.Handler, name).toBe('index.handler');
      // ★ VPC 밖은 둘 — 인터넷에 열린 결제 웹훅(DB 0 — 계획 원칙 1)과 고객 도메인 제어면(DB 0 — ADR-0014 결정 3). 예외가 늘면 여기서 빨개진다.
      if (NO_VPC_NO_DB.includes(name)) expect(fn.VpcConfig, name).toBeUndefined();
      else expect(fn.VpcConfig, name).toBeDefined();
    }
  });

  it('api 타임아웃은 HTTP API 통합 한도(30s) 안이다', () => {
    const api = functionsByName(runtimeTemplates().compute).get('atmark-api');
    expect(api?.Timeout).toBe(API_TIMEOUT_SECONDS);
    expect(API_TIMEOUT_SECONDS).toBeLessThan(30);
  });

  it('api 메모리는 1024MB — PDF 워커(CPU 는 메모리에 비례) · 해석 중 RSS 천장 640MiB 위의 여유(`attachment-content.ts` ②)', () => {
    expect(functionsByName(runtimeTemplates().compute).get('atmark-api')?.MemorySize).toBe(1024);
  });

  it('SQS 소비자 타임아웃 < 큐 가시성 타임아웃 (그렇지 않으면 처리 중인 건이 다시 보인다)', () => {
    const functions = functionsByName(runtimeTemplates().compute);
    expect(functions.get('atmark-inbound')?.Timeout).toBeLessThan(INBOUND_VISIBILITY_TIMEOUT_SECONDS);
    expect(functions.get('atmark-ses-events')?.Timeout).toBeLessThan(SES_EVENT_QUEUE_VISIBILITY_SECONDS);
  });

  it('ses-events: 예약 동시성(1) < SQS 최대 동시성(2) — 스로틀 재시도가 DLQ 로 새지 않게 큐 가시성 ≥ 6 × 타임아웃(합성된 큐로 본다)', async () => {
    const { RESERVED_CONCURRENCY, SQS_MAX_CONCURRENCY } = await import('../../../infra/cdk/stacks/compute-stack');
    const timeout = functionsByName(runtimeTemplates().compute).get('atmark-ses-events')?.Timeout ?? Number.POSITIVE_INFINITY;
    const queues = Template.fromStack(new SesStack(new cdk.App(), 'AtmarkSes', { env: { account: '123456789012', region: 'ap-northeast-2' } })).findResources(
      'AWS::SQS::Queue',
    ) as Record<string, { Properties: { QueueName: string; VisibilityTimeout?: number } }>;
    const visibility = Object.values(queues).find((queue) => queue.Properties.QueueName === 'atmark-ses-events')?.Properties.VisibilityTimeout;
    expect(visibility).toBe(SES_EVENT_QUEUE_VISIBILITY_SECONDS);
    // 2026-09-24 리드 결정 ① — 투명성 로그 앵커 분리에 연결 1 을 내주려고 2 → 1. 예약이 SQS 동시성보다 작으면 가시성이 재시도 창이다.
    expect(RESERVED_CONCURRENCY['ses-events']).toBe(1);
    expect(RESERVED_CONCURRENCY['ses-events']).toBeLessThan(SQS_MAX_CONCURRENCY);
    expect(visibility ?? 0).toBeGreaterThanOrEqual(6 * timeout);
  });

  it('로그 형식은 Text — EMF 줄(stdout JSON 한 줄)이 그대로 메트릭으로 승격된다', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      expect(fn.LoggingConfig?.LogFormat, name).toBeUndefined();
      expect(fn.LoggingConfig?.LogGroup, name).toBeDefined();
    }
  });

  it('함수마다 /aws/lambda/atmark-<name> 로그 그룹 · 보존 90일', () => {
    const groups = runtimeTemplates().compute.findResources('AWS::Logs::LogGroup') as Record<
      string,
      { Properties: { LogGroupName: string; RetentionInDays?: number } }
    >;
    const byName = new Map(Object.values(groups).map((g) => [g.Properties.LogGroupName, g.Properties.RetentionInDays]));
    for (const name of LAMBDA_HANDLERS) expect(byName.get(`/aws/lambda/atmark-${name}`), name).toBe(90);
  });

  it('RDS TLS 짝: DB 를 쓰는 모든 함수에 PGSSLMODE=require · NODE_EXTRA_CA_CERTS (DB 없는 결제 웹훅·domain-control 만 둘 다 없다)', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      expect(fn.Environment.Variables['ATMARK_ENV'], name).toBe('production');
      if (NO_VPC_NO_DB.includes(name)) {
        expect(fn.Environment.Variables['PGSSLMODE'], name).toBeUndefined();
        expect(fn.Environment.Variables['NODE_EXTRA_CA_CERTS'], name).toBeUndefined();
        continue;
      }
      expect(fn.Environment.Variables['PGSSLMODE'], name).toBe('require');
      expect(fn.Environment.Variables['NODE_EXTRA_CA_CERTS'], name).toBe('/var/runtime/ca-cert.pem');
    }
  });

  it('소유자 롤 비밀 ARN · 마스터 비밀 ARN 은 migrate 환경에만 있다 (admin 은 소유자 롤이 아니다 — ADR-0006)', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      const hasMigration = 'ATMARK_DB_MIGRATION_SECRET_ARN' in fn.Environment.Variables;
      const hasMaster = 'ATMARK_DB_MASTER_SECRET_ARN' in fn.Environment.Variables;
      expect(hasMigration, name).toBe(name === 'atmark-migrate');
      expect(hasMaster, name).toBe(name === 'atmark-migrate');
    }
  });

  it('admin·login-mailer DB 비밀 ARN 은 자기 함수와 migrate(부트스트랩이 쓴다)에만 있다', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      expect('ATMARK_DB_ADMIN_SECRET_ARN' in fn.Environment.Variables, name).toBe(name === 'atmark-admin' || name === 'atmark-migrate');
      expect('ATMARK_DB_LOGIN_MAILER_SECRET_ARN' in fn.Environment.Variables, name).toBe(
        name === 'atmark-login-mailer' || name === 'atmark-migrate',
      );
      // ADR-0015 — `atmark/db/ops` 는 ops 와 migrate(bootstrap-roles 가 쓴다)에만.
      expect(OPS_ENV.dbSecretArn in fn.Environment.Variables, name).toBe(name === OPS_FUNCTION_NAME || name === 'atmark-migrate');
    }
  });

  it('admin 환경에는 앱·소유자 DB 비밀·승인 링크 키·웹훅 키가 없다 — 로그인 키·admin DB 비밀·CMK·메일 버킷 이름(US-004 본문 읽기)·US-003 스위치·결제(WP-2)·login-mailer 함수 ARN(깨우기)·api 함수 ARN(콘솔 웹훅 시크릿, 보안 M1)만', () => {
    const admin = functionsByName(runtimeTemplates().compute).get('atmark-admin');
    expect(Object.keys(admin?.Environment.Variables ?? {}).sort()).toEqual([
      'ATMARK_ADDRESS_ALIASES_ENABLED',
      'ATMARK_API_FUNCTION_ARN',
      'ATMARK_AUTH_ON_SITE',
      'ATMARK_BILLING_ENABLED',
      // 적대 검증 D2-U048 — HTTP 모양 이벤트는 콘솔 HTTP API id 와 같을 때만(직접 invoke 위조 거부).
      'ATMARK_CONSOLE_API_ID',
      'ATMARK_DB_ADMIN_SECRET_ARN',
      // ADR-0014 단계 2 — 틱 롤 비밀의 위치(읽기 권한은 단계 4) · domain-control 함수 ARN(Invoke 하나).
      'ATMARK_DB_DOMAIN_TICK_SECRET_ARN',
      // Domain Connect — 스위치(기본 끔) · 서명 키 ARN(Sign 은 이 역할 하나).
      'ATMARK_DOMAIN_CONNECT_ENABLED',
      'ATMARK_DOMAIN_CONNECT_KEY_ARN',
      'ATMARK_DOMAIN_CONTROL_FUNCTION_ARN',
      'ATMARK_ENV',
      'ATMARK_LOGIN_MAILER_FUNCTION_ARN',
      'ATMARK_MAIL_BUCKET',
      'ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN',
      'ATMARK_PADDLE_ADMIN_API_KEY_SECRET_ARN',
      'ATMARK_PADDLE_ENV',
      'ATMARK_PASSPORT_KMS_KEY_ID',
      'ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN',
      // 묶음 E — 콘솔 풀기 뒤 실시간 힌트의 `@connections` 엔드포인트(위치만 — 권한은 POST @connections/* 하나).
      'ATMARK_REALTIME_CALLBACK_URL',
      'ATMARK_SITE_CORS',
      'NODE_EXTRA_CA_CERTS',
      'PGSSLMODE',
    ]);
    // 결제 스위치 기본값은 꺼짐(fail-closed) · Paddle 환경은 코드 상수.
    expect(admin?.Environment.Variables['ATMARK_BILLING_ENABLED']).toBe('false');
    expect(admin?.Environment.Variables['ATMARK_PADDLE_ENV']).toBe(PADDLE_ENVIRONMENT_DEFAULT);
    // 메일 기본기 2차 A6 — 별칭 스위치 기본 꺼짐.
    expect(admin?.Environment.Variables['ATMARK_ADDRESS_ALIASES_ENABLED']).toBe('true'); // 전체 공개 2026-09-29
    // 정책 첨부 기본값 = 요금제를 따른다 — 운영 전환(런북 §23-2 5′) 뒤 2026-09-28 진윤겸 승인으로 켰다.
    expect(admin?.Environment.Variables['ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN']).toBe('true');
  });

  it('login-mailer 환경: 로그인 키·운영자 코드 키(ADR-0015)·자기 DB 비밀·Configuration Set 대조값·환영 메일 스위치뿐 — 앱 DB·승인 키·웹훅 키·버킷·CMK 없음', () => {
    const mailer = functionsByName(runtimeTemplates().compute).get('atmark-login-mailer');
    expect(Object.keys(mailer?.Environment.Variables ?? {}).sort()).toEqual([
      'ATMARK_DB_LOGIN_MAILER_SECRET_ARN',
      'ATMARK_ENV',
      OPS_ENV.opsLoginKeysSecretArn,
      'ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN',
      'ATMARK_SES_CONFIGURATION_SET',
      'ATMARK_WELCOME_MAIL_ENABLED',
      'NODE_EXTRA_CA_CERTS',
      'PGSSLMODE',
    ]);
  });

  it('로그인 키 ARN 은 admin·login-mailer 환경에만 있다 (H1: approval-notifier·api 에는 없다)', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      const has = 'ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN' in fn.Environment.Variables;
      expect(has, name).toBe(name === 'atmark-admin' || name === 'atmark-login-mailer');
    }
  });
});

describe('AtmarkCompute — IAM: SES 발송 주체는 정확히 둘 (ADR-0006)', () => {
  it('SES 발송 문장을 가진 역할은 발송 역할과 로그인 메일 역할 둘뿐이다', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    const senders = [...byRole].filter(([, statements]) => sesStatements(statements).length > 0).map(([role]) => role);
    expect(senders.sort()).toEqual([LOGIN_MAILER_ROLE_LOGICAL_ID, SENDER_ROLE_LOGICAL_ID].sort());
    // 인라인 정책(Role.Policies)으로 우회한 발송도 없다.
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<
      string,
      { Properties: { Policies?: { PolicyDocument: { Statement: IamStatement[] } }[] } }
    >;
    for (const [id, role] of Object.entries(roles)) {
      const inline = (role.Properties.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement);
      expect(sesStatements(inline), id).toEqual([]);
    }
  });

  it('발송 역할 이름은 allowlist 의 이름이다 (check-ses-principals.sh 가 실계정에서 보는 이름)', () => {
    runtimeTemplates().compute.hasResourceProperties('AWS::IAM::Role', { RoleName: SENDER_ROLE_NAME });
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(roles[SENDER_ROLE_LOGICAL_ID]?.Properties.RoleName).toBe(SENDER_ROLE_NAME);
    expect(roles[LOGIN_MAILER_ROLE_LOGICAL_ID]?.Properties.RoleName).toBe(LOGIN_MAILER_ROLE_NAME);
  });

  it('로그인 메일 역할의 발송 문장: ses:FromAddress = 정확히 login@·onve@atmark.ai(StringEquals) · 같은 identity·설정 세트 · 런타임 상수와 같다', () => {
    expect(LOGIN_MAILER_FROM_ADDRESS).toBe(OWNER_LOGIN_FROM_ADDRESS);
    expect(LOGIN_MAILER_FROM_ADDRESS).toBe('login@atmark.ai');
    // 환영 메일(ADR-0006 2026-09-30 개정) — 지원 에이전트 별칭 onve@. 예약 발신 주소 목록(`from-alignment.ts`)에도 있다.
    expect(WELCOME_MAIL_FROM_ADDRESS).toBe('onve@atmark.ai');
    expect(RESERVED_FROM_ADDRESSES).toContain(WELCOME_MAIL_FROM_ADDRESS);
    expect([...LOGIN_MAILER_FROM_ADDRESSES]).toEqual(['login@atmark.ai', 'onve@atmark.ai']);
    const statements = sesStatements(statementsByRole(runtimeTemplates().compute).get(LOGIN_MAILER_ROLE_LOGICAL_ID) ?? []);
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement?.Condition).toEqual({ StringEquals: { 'ses:FromAddress': ['login@atmark.ai', 'onve@atmark.ai'] } });
    expect([...(statement?.Resource as string[])].sort()).toEqual([
      'arn:aws:ses:ap-northeast-2:123456789012:configuration-set/atmark-default',
      'arn:aws:ses:ap-northeast-2:123456789012:identity/atmark.ai',
    ]);
    expect(actionsOf(statement as IamStatement).sort()).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
  });

  it('로그인 메일 역할의 액션 전부: SES 발송 둘 + 비밀 읽기(로그인 키 · 운영자 코드 키 · 자기 DB 비밀 — SSM) — 그 밖엔 없다', () => {
    const statements = statementsByRole(runtimeTemplates().compute).get(LOGIN_MAILER_ROLE_LOGICAL_ID) ?? [];
    expect([...new Set(statements.flatMap(actionsOf))].sort()).toEqual(['kms:Decrypt', 'ses:SendEmail', 'ses:SendRawEmail', 'ssm:GetParameter']);
    const reads = statements.filter((s) => actionsOf(s).includes('ssm:GetParameter'));
    expect(reads).toHaveLength(3);
    for (const name of [OWNER_LOGIN_KEYS_SECRET_NAME, OPS_SECRET_NAMES.loginKeys, DB_LOGIN_MAILER_SECRET_NAME]) {
      expect(reads.some((s) => readsSsmSecret(s, name)), name).toBe(true);
    }
  });

  // 기본 라우팅(agent_and_notify — 2026-10-04 굳힘)에서 발송 역할의 Deny 는 셋이고, 명시 `forward` 에서는 support@ Deny(US-009)가 넷째로 붙는다.
  const senderDenies = (template: Template): IamStatement[] =>
    (statementsByRole(template).get(SENDER_ROLE_LOGICAL_ID) ?? []).filter((s) => s.Effect === 'Deny');
  const baseSenderDenies = (): unknown[] => [
    // 2026-09-24 검증 F1: 예약 주소 Deny 는 대소문자 무시(StringEqualsIgnoreCase) — StringEquals 는 `LOGIN@` 을 놓친다.
    expect.objectContaining({
      Effect: 'Deny',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: '*',
      Condition: { StringEqualsIgnoreCase: { 'ses:FromAddress': 'login@atmark.ai' } },
    }),
    // 202609301540 — 수신 전용 abuse@·postmaster@(지원 에이전트의 별칭이어도 보내지 못한다 · 라우팅과 무관).
    expect.objectContaining({
      Sid: 'SesDenyReceiveOnlyFromAddress',
      Effect: 'Deny',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: '*',
      Condition: { StringEqualsIgnoreCase: { 'ses:FromAddress': ['abuse@atmark.ai', 'postmaster@atmark.ai'] } },
    }),
    expect.objectContaining({
      Sid: 'SesDenyNonCanonicalFromAddress',
      Effect: 'Deny',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: '*',
      Condition: { StringLike: { 'ses:FromAddress': [...SES_NON_CANONICAL_FROM_PATTERNS] } },
    }),
    expect.objectContaining({
      Sid: 'SesDenyReservedSuffixFromAddress',
      Effect: 'Deny',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: '*',
      Condition: {
        StringLike: { 'ses:FromAddress': [...SES_RESERVED_SUFFIX_PATTERNS] },
        StringNotLike: { 'ses:FromAddress': [...SES_RESERVED_SUFFIX_CANONICAL_EXCEPTIONS] },
      },
    }),
  ];

  it('발송 역할은 login@atmark.ai 로 보낼 수 없다 — 명시 Deny (두 주체의 발신 주소가 겹치지 않는다) · 기본 라우팅에는 support@ Deny 가 없다', () => {
    expect(senderDenies(runtimeTemplates().compute)).toEqual(baseSenderDenies());
  });

  it('forward 라우팅(명시) — 넷째 Deny: support@ 발신은 contact-forwarder 함수 밖에서 거부(`contact-forward-stack.test.ts` 가 자세히 본다)', () => {
    expect(senderDenies(forwardRoutingCompute())).toEqual([
      ...baseSenderDenies(),
      expect.objectContaining({
        Effect: 'Deny',
        Action: ['ses:SendEmail', 'ses:SendRawEmail'],
        Resource: '*',
        Condition: {
          StringEqualsIgnoreCase: { 'ses:FromAddress': 'support@atmark.ai' },
          ArnNotEquals: { 'lambda:SourceFunctionArn': 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-contact-forwarder' },
        },
      }),
    ]);
  });

  it('F1: 정규형 밖 발신 주소 Deny — 대문자 전부·+·인용/주석 문자를 덮고, 런타임이 실제로 쓰는 발신 주소는 하나도 걸지 않는다', () => {
    // IAM StringLike 흉내(대소문자 구분, `*` 만 — 목록에 `?` 는 없다).
    const like = (pattern: string, value: string): boolean =>
      new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
    const denied = (from: string): boolean => SES_NON_CANONICAL_FROM_PATTERNS.some((pattern) => like(pattern, from));
    expect(SES_NON_CANONICAL_FROM_PATTERNS.some((pattern) => pattern.includes('?'))).toBe(false);
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(SES_NON_CANONICAL_FROM_PATTERNS).toContain(`*${letter}*`);
    for (const from of ['LOGIN@atmark.ai', 'Login@atmark.ai', 'lOgIn@atmark.ai', 'login+x@atmark.ai', 'LOGIN+x@atmark.ai', 'Support@atmark.ai', 'support+x@atmark.ai', ' login@atmark.ai', '"login"@atmark.ai', '(c)login@atmark.ai', 'login@ATMARK.AI', '"a@b"@atmark.ai']) {
      expect(denied(from), from).toBe(true);
    }
    // 정당한 발신 주소 — 이 Deny 가 걸면 발송이 멈춘다.
    for (const from of [APPROVAL_NOTIFY_FROM_ADDRESS, CONTACT_ADDRESS, 'agent-probe@atmark.ai', 'a.b_c-d9@atmark.ai', 'x@atmark.ai']) {
      expect(denied(from), from).toBe(false);
    }
    // 에이전트 로컬파트 문법이 넓어지면(예: `+` 허용) 이 목록과 함께 다시 봐야 한다.
    expect(AGENT_LOCAL_PART_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$');
  });

  it('M3a: 접힘 공백·제어문자 — 발송 역할의 Deny 전체(IAM StringLike/StringNotLike 흉내)가 예약 주소 앞뒤·사이의 제어문자를 막고 정당한 주소는 통과시킨다', () => {
    // IAM StringLike 흉내 — `*` 여러 글자 · `?` 한 글자 · 대소문자 구분. `.` 는 `s` 플래그로 개행에도 맞는다(IAM 은 줄을 가리지 않는다).
    const like = (pattern: string, value: string): boolean =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.split('?').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.'))
          .join('.*')}$`,
        's',
      ).test(value);
    // support@ 자신이 Deny 인 것까지 보려고 `forward` 를 명시해 합성한 템플릿을 쓴다(기본 라우팅은 support@ 를 허락한다).
    const statements = statementsByRole(forwardRoutingCompute()).get(SENDER_ROLE_LOGICAL_ID) ?? [];
    const holds = (condition: Record<string, Record<string, unknown>> | undefined, from: string): boolean =>
      Object.entries(condition ?? {}).every(([operator, entries]) =>
        Object.entries(entries).every(([key, expected]) => {
          if (key === 'lambda:SourceFunctionArn') return operator === 'ArnNotEquals';
          const values = (Array.isArray(expected) ? expected : [expected]) as string[];
          if (operator === 'StringEqualsIgnoreCase') return values.some((v) => v.toLowerCase() === from.toLowerCase());
          if (operator === 'StringLike') return values.some((v) => like(v, from));
          if (operator === 'StringNotLike') return !values.some((v) => like(v, from));
          throw new Error(`흉내 밖 연산자: ${operator}`);
        }),
      );
    const denied = (from: string): boolean =>
      statements.some((s) => s.Effect === 'Deny' && holds(s.Condition as Record<string, Record<string, unknown>> | undefined, from));
    const allowed = (from: string): boolean =>
      !denied(from) && statements.some((s) => s.Effect === 'Allow' && actionsOf(s).includes('ses:SendEmail') && holds(s.Condition as Record<string, Record<string, unknown>> | undefined, from));
    for (const from of [
      '\tlogin@atmark.ai',
      '\r\n\tlogin@atmark.ai',
      '\u000blogin@atmark.ai',
      '\u000clogin@atmark.ai',
      '\u0000login@atmark.ai',
      '\u001blogin@atmark.ai',
      '\u007flogin@atmark.ai',
      ' \u000blogin@atmark.ai',
      '\tsupport@atmark.ai',
      '\u000bsupport@atmark.ai',
      '\u000csupport@atmark.ai',
      '\tonve@atmark.ai',
      '\u000bonve@atmark.ai',
      '\u000conve@atmark.ai',
      'ONVE@atmark.ai',
      'onve+x@atmark.ai',
      '*login@atmark.ai',
      '?support@atmark.ai',
      '$login@atmark.ai',
    ]) {
      expect(allowed(from), JSON.stringify(from)).toBe(false);
      expect(denied(from), JSON.stringify(from)).toBe(true);
    }
    // 예약 주소 **사이**에 낀 제어문자는 IAM 이 막지 못한다 — 정책 문서는 인쇄 가능 ASCII 만 받는다(2026-09-24 운영 배포 거부 실측).
    // 런타임 `assertHeaderSafe`(HEADER_UNSAFE — C0·DEL·C1 전부)와 알람 10 의 몫이다(ADR-0006 M3 잔여, test/unit/mail 에서 단언).
    for (const from of ['lo\tgin@atmark.ai', 'login\t@atmark.ai', 'sup\u007fport@atmark.ai']) {
      expect(denied(from), JSON.stringify(from)).toBe(false);
    }
    // 정당한 발신 주소 — 예약 로컬파트로 **끝나는** 에이전트 주소 포함.
    for (const from of [APPROVAL_NOTIFY_FROM_ADDRESS, 'agent-probe@atmark.ai', 'a.b_c-d9@atmark.ai', 'x@atmark.ai', 'xlogin@atmark.ai', 'my.login@atmark.ai', 'a-support@atmark.ai', '9support@atmark.ai', 'blogin_login@atmark.ai', 'xonve@atmark.ai', 'my.onve@atmark.ai']) {
      expect(allowed(from), from).toBe(true);
    }
    // onve@ 자신 — 지원 에이전트의 별칭이라 발송 역할도 보낸다(login-mailer 와 공유 — ADR-0006 2026-09-30 개정).
    expect(allowed(WELCOME_MAIL_FROM_ADDRESS)).toBe(true);
    expect(SES_RESERVED_LOCAL_PARTS).toEqual(['login', 'support', 'onve']);
    // 수신 전용(202609301540) — 정확한 주소 · 대소문자 · 하위 주소 전부 거부. 런타임 목록과 같은 값이다.
    expect([...SES_RECEIVE_ONLY_FROM_ADDRESSES]).toEqual([...RECEIVE_ONLY_ADDRESSES]);
    for (const from of ['abuse@atmark.ai', 'postmaster@atmark.ai', 'ABUSE@atmark.ai', 'Postmaster@atmark.ai', 'abuse+x@atmark.ai', 'postmaster+x@atmark.ai']) {
      expect(allowed(from), from).toBe(false);
      expect(denied(from), from).toBe(true);
    }
    // 앞에 에이전트 로컬파트 글자가 붙은 주소는 에이전트 주소다 — 걸지 않는다.
    for (const from of ['xabuse@atmark.ai', 'my.postmaster@atmark.ai']) expect(allowed(from), from).toBe(true);
    // 예약 주소 자신 — 발송 역할은 login@ 을 못 쓰고(명시 Deny), support@ 는 함수 문맥 밖이라 못 쓴다.
    expect(denied('login@atmark.ai')).toBe(true);
    expect(denied(CONTACT_ADDRESS)).toBe(true);
    // 정책 문서가 담을 수 없는 문자(U+000B 등)를 패턴에 적지 않았다 — IAM 정책 문법 `[\u0009\u000A\u000D\u0020-\u00FF]`.
    for (const text of [...SES_NON_CANONICAL_FROM_PATTERNS, ...SES_RESERVED_SUFFIX_PATTERNS, ...SES_RESERVED_SUFFIX_CANONICAL_EXCEPTIONS]) {
      expect(/^[\u0009\u000a\u000d\u0020-\u00ff]+$/u.test(text), JSON.stringify(text)).toBe(true);
    }
  });

  it('발송 문장 둘(I2+ — ADR-0014 결정 4): identity atmark.ai 하나 + ses:FromAddress *@atmark.ai · 구성 세트 하나(조건 없음) — identity/* · 고객 도메인 없음', () => {
    const statements = sesStatements(statementsByRole(runtimeTemplates().compute).get(SENDER_ROLE_LOGICAL_ID) ?? []);
    expect(statements.map((s) => s.Sid).sort()).toEqual(['SesSendAsAtmarkIdentity', 'SesUseDefaultConfigurationSet']);
    const identity = statements.find((s) => s.Sid === 'SesSendAsAtmarkIdentity');
    const configurationSet = statements.find((s) => s.Sid === 'SesUseDefaultConfigurationSet');
    // atmark.ai 쪽 실효 권한은 예전 한 문장(`SesSendAsAtmarkOnly`)과 같다 — 같은 조건이 identity 자원에 걸린다.
    expect(identity?.Condition).toEqual({ StringLike: { 'ses:FromAddress': '*@atmark.ai' } });
    expect(identity?.Resource).toEqual('arn:aws:ses:ap-northeast-2:123456789012:identity/atmark.ai');
    // 구성 세트 권한은 identity policy 로 줄 수 없다(스파이크 S1 ③) — 이 문장이 고객 identity 발송의 IAM 쪽 절반이다.
    expect(configurationSet?.Condition).toBeUndefined();
    expect(configurationSet?.Resource).toEqual('arn:aws:ses:ap-northeast-2:123456789012:configuration-set/atmark-default');
    for (const statement of statements) expect(actionsOf(statement).sort()).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
    // ★ 고객 identity 는 IAM Allow 에 없다 — `identity/*` 와일드카드도, 다른 identity 도.
    const resources = statements.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])).map((r) => JSON.stringify(r));
    expect(resources.filter((r) => r.includes(':identity/'))).toEqual(['"arn:aws:ses:ap-northeast-2:123456789012:identity/atmark.ai"']);
    expect(resources.join(' ')).not.toMatch(/identity\/\*/);
  });

  it('발송 4핸들러는 발송 역할을, login-mailer 는 로그인 메일 역할을, 나머지 6(admin 포함)은 다른 역할을 쓴다', () => {
    for (const [name, fn] of functionsByName(runtimeTemplates().compute)) {
      const handler = name.replace(/^atmark-/, '');
      const usesSender = fn.Role['Fn::GetAtt'][0] === SENDER_ROLE_LOGICAL_ID;
      const usesLoginMailer = fn.Role['Fn::GetAtt'][0] === LOGIN_MAILER_ROLE_LOGICAL_ID;
      expect(usesSender, name).toBe(SES_SENDING_HANDLERS.includes(handler as (typeof SES_SENDING_HANDLERS)[number]));
      expect(usesLoginMailer, name).toBe(handler === 'login-mailer');
    }
  });

  it('관리형 정책은 Lambda 기본 실행·VPC 접근 둘뿐이다 (SES 를 싣는 AWS 관리형 정책이 끼어들 틈이 없다)', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<
      string,
      { Properties: { ManagedPolicyArns?: unknown[] } }
    >;
    const arns = new Set(
      Object.values(roles).flatMap((r) => (r.Properties.ManagedPolicyArns ?? []).map((arn) => JSON.stringify(arn))),
    );
    const names = [...arns].map((arn) => /policy\/([^"]+)"/.exec(arn)?.[1]);
    expect(names.sort()).toEqual(['service-role/AWSLambdaBasicExecutionRole', 'service-role/AWSLambdaVPCAccessExecutionRole']);
  });
});

describe('AtmarkCompute · AtmarkTransparency — SSM 비밀(2026-10-12 비밀 → SSM 이전 · 배포 런북 §49)', () => {
  const templates = (): [string, Template][] => [
    ['compute', runtimeTemplates().compute],
    ['transparency', runtimeStackTemplate('transparency')],
  ];

  it('★ 두 스택의 **모든 역할**에 ssm:DeleteParameter·DeleteParameters 명시 Deny', () => {
    for (const [stack, template] of templates()) {
      const roles = Object.keys(template.findResources('AWS::IAM::Role'));
      expect(roles.length, stack).toBeGreaterThan(0);
      const byRole = allStatementsByRole(template);
      for (const role of roles) {
        const deny = (byRole.get(role) ?? []).find((s) => s.Sid === SSM_DELETE_DENY_SID);
        expect(deny, `${stack}/${role}`).toMatchObject({ Effect: 'Deny', Resource: '*' });
        expect(actionsOf(deny as IamStatement).sort(), `${stack}/${role}`).toEqual([...SSM_DELETE_DENY_ACTIONS].sort());
      }
    }
  });

  it('SSM 허용은 GetParameter·PutParameter 뿐 · 리소스는 /atmark/ 파라미터 이름 하나하나(와일드카드 없음) · 쓰기는 migrate 하나 · DB 롤 12 자리만', () => {
    for (const [stack, template] of templates()) {
      for (const [role, statements] of statementsByRole(template)) {
        for (const statement of statements.filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => a.startsWith('ssm:')))) {
          for (const action of actionsOf(statement)) expect(action, `${stack}/${role}`).toMatch(/^ssm:(GetParameter|PutParameter)$/);
          const resources = JSON.stringify(statement.Resource);
          expect(resources, `${stack}/${role}`).not.toMatch(/\*/);
          expect(resources, `${stack}/${role}`).toMatch(/:parameter\/atmark\//);
          if (actionsOf(statement).includes('ssm:PutParameter')) {
            expect(role, stack).toMatch(/^MigrateRole/);
            for (const name of SSM_DB_ROLE_SECRET_NAMES) expect(writesSsmSecret(statement, name), name).toBe(true);
            for (const name of SSM_SECRET_NAMES.slice(SSM_DB_ROLE_SECRET_NAMES.length)) expect(writesSsmSecret(statement, name), name).toBe(false);
          }
        }
      }
    }
  });

  it('옮긴 20 의 위치 변수는 전부 SSM 이름(`/atmark/…`) · 남긴 셋(마스터 · 웹훅 KEK · DLP 키)은 Secrets Manager ARN 그대로', () => {
    const moved: string[] = [
      RUNTIME_ENV.dbSecretArn,
      RUNTIME_ENV.dbMigrationSecretArn,
      RUNTIME_ENV.dbAdminSecretArn,
      RUNTIME_ENV.dbLoginMailerSecretArn,
      RUNTIME_ENV.dbPassportSignerSecretArn,
      RUNTIME_ENV.dbTlogSecretArn,
      RUNTIME_ENV.dbTlogAnchorSecretArn,
      RUNTIME_ENV.dbBillingSecretArn,
      RUNTIME_ENV.dbBillingOperatorSecretArn,
      RUNTIME_ENV.dbOpsSecretArn,
      RUNTIME_ENV.dbDomainTickSecretArn,
      RUNTIME_ENV.dbAiWatchSecretArn,
      RUNTIME_ENV.approvalLinkKeysSecretArn,
      RUNTIME_ENV.ownerLoginKeysSecretArn,
      RUNTIME_ENV.opsKeysSecretArn,
      RUNTIME_ENV.opsLoginKeysSecretArn,
      RUNTIME_ENV.contactForwardToSecretArn,
      RUNTIME_ENV.paddleAdminApiKeySecretArn,
      RUNTIME_ENV.paddleSyncApiKeySecretArn,
      RUNTIME_ENV.paddleWebhookSecretArn,
    ];
    const kept: string[] = [RUNTIME_ENV.dbMasterSecretArn, RUNTIME_ENV.webhookSecretKeysSecretArn, RUNTIME_ENV.dlpKeysSecretArn];
    const seen = new Set<string>();
    for (const [stack, template] of templates()) {
      for (const [name, fn] of functionsByName(template)) {
        for (const [variable, value] of Object.entries(fn.Environment.Variables)) {
          if (moved.includes(variable)) {
            seen.add(variable);
            expect(value, `${stack}/${name}/${variable}`).toEqual(expect.stringMatching(/^\/atmark\/[a-z0-9/-]+$/));
            expect(SSM_SECRET_NAMES.map((n) => `/${n}`)).toContain(value);
          }
          if (kept.includes(variable)) expect(JSON.stringify(value), `${stack}/${name}/${variable}`).not.toMatch(/"\/atmark\//);
        }
      }
    }
    expect([...seen].sort()).toEqual([...moved].sort());
  });

  it('★ 고객 관리형 키 alias/atmark-ssm-secrets(AtmarkSecretsKey): 연 회전 · RETAIN · 키 정책은 기본(계정 root → IAM 위임) 하나뿐 — AWS 관리형 alias/aws/ssm 을 쓰지 않는다', () => {
    const template = runtimeStackTemplate('secretsKey');
    const keys = template.findResources('AWS::KMS::Key') as Record<
      string,
      { DeletionPolicy?: string; Properties: { EnableKeyRotation?: boolean; KeyPolicy: { Statement: { Principal?: unknown; Action: unknown }[] } } }
    >;
    expect(Object.keys(keys)).toHaveLength(1);
    const [key] = Object.values(keys);
    expect(key?.DeletionPolicy).toBe('Retain');
    expect(key?.Properties.EnableKeyRotation).toBe(true);
    const statements = key?.Properties.KeyPolicy.Statement ?? [];
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]?.Principal)).toMatch(/:root"/);
    const aliases = template.findResources('AWS::KMS::Alias') as Record<string, { Properties: { AliasName: string } }>;
    expect(Object.values(aliases).map((a) => a.Properties.AliasName)).toEqual([SSM_SECRETS_KEY_ALIAS]);
    // SSM 문장 어디에도 AWS 관리형 키가 없다.
    for (const [, t] of templates()) expect(JSON.stringify(t.toJSON())).not.toContain('alias/aws/ssm');
  });

  it('★ 이 키의 kms:Decrypt 를 받는 역할은 정확히 이 열여섯(Compute 14 · Transparency 2) · 모두 SSM 경유 + 그 파라미터 문맥 · 키 와일드카드·Resource * 의 kms 허용은 어디에도 없다', () => {
    const decrypters: string[] = [];
    for (const [stack, template] of templates()) {
      const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
      for (const [role, statements] of statementsByRole(template)) {
        for (const s of statements.filter((x) => x.Effect === 'Allow' && actionsOf(x).some((a) => a.startsWith('kms:') || a === '*'))) {
          expect(JSON.stringify(s.Resource), `${stack}/${role}`).not.toMatch(/"\*"|key\/\*/);
          if (actionsOf(s).includes('kms:Decrypt') && JSON.stringify(s.Resource).includes('SsmSecretsKey')) {
            decrypters.push(roles[role]?.Properties.RoleName ?? role);
            const equals = s.Condition?.['StringEquals'] ?? {};
            expect(equals['kms:ViaService'], `${stack}/${role}`).toBe('ssm.ap-northeast-2.amazonaws.com');
            expect(JSON.stringify(equals['kms:EncryptionContext:PARAMETER_ARN']), `${stack}/${role}`).toMatch(/:parameter\/atmark\//);
          }
        }
      }
    }
    expect([...new Set(decrypters)].sort()).toEqual(
      [
        'atmark-runtime-admin',
        'atmark-runtime-ai-watch-result',
        'atmark-runtime-approval-expiry',
        'atmark-runtime-billing-sync',
        'atmark-runtime-billing-webhook',
        'atmark-runtime-inbound',
        'atmark-runtime-login-mailer',
        'atmark-runtime-migrate',
        'atmark-runtime-ops',
        'atmark-runtime-passport-signer',
        'atmark-runtime-realtime',
        'atmark-runtime-sender',
        'atmark-runtime-ses-events',
        'atmark-runtime-transparency-anchor',
        'atmark-runtime-transparency-log',
        'atmark-runtime-webhook-dispatcher',
      ].sort(),
    );
  });

  it('★ 모든 런타임 스택 템플릿에서 SSM 읽기 허용(ssm:Get* · ssm:* · *)은 지정 역할의 `/atmark/<이름>` 하나하나뿐 · NAT 역할은 /atmark/* 읽기 명시 Deny', () => {
    const all: [string, Template][] = [
      ['network', runtimeTemplates().network],
      ['data', runtimeTemplates().data],
      ['compute', runtimeTemplates().compute],
      ['transparency', runtimeStackTemplate('transparency')],
      ['identityCdn', runtimeStackTemplate('identityCdn')],
      ['billing', runtimeStackTemplate('billing')],
      ['secretsKey', runtimeStackTemplate('secretsKey')],
    ];
    const readers: string[] = [];
    for (const [stack, template] of all) {
      const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
      for (const [role, statements] of allStatementsByRole(template)) {
        for (const s of statements.filter((x) => x.Effect === 'Allow')) {
          const reads = actionsOf(s).filter((a) => /^ssm:(Get|\*)|^ssm:\*$|^\*$/.test(a));
          if (reads.length === 0) continue;
          expect(reads, `${stack}/${role}`).toEqual(['ssm:GetParameter']);
          const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          for (const r of resources) expect(JSON.stringify(r), `${stack}/${role}`).toMatch(/:parameter\/atmark\/[a-z0-9/-]+"\]\]\}$/);
          readers.push(roles[role]?.Properties.RoleName ?? role);
        }
      }
    }
    // 읽는 역할 = 위 키를 푸는 역할과 같은 열여섯(쓰기 · 옛 값 확인의 migrate 포함).
    expect([...new Set(readers)]).toHaveLength(16);
    expect(readers.every((name) => name.startsWith('atmark-runtime-'))).toBe(true);
    // NAT 역할(관리형 AmazonSSMManagedInstanceCore — ssm:GetParameter *)은 /atmark/* 읽기를 명시 Deny 로 막는다.
    const network = runtimeTemplates().network;
    const natDeny = [...allStatementsByRole(network).values()].flat().find((s) => s.Sid === NAT_SSM_PARAMETER_DENY_SID);
    expect(natDeny?.Effect).toBe('Deny');
    expect(actionsOf(natDeny as IamStatement)).toEqual(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory']);
  });

  it('승인 링크 키(SSM)를 읽는 역할은 발송 역할 하나 · 옛 Secrets Manager 자리는 migrate 의 DB 롤 12 확인 읽기 말고는 아무도 읽지 않는다', () => {
    const compute = runtimeTemplates().compute;
    const byRole = statementsByRole(compute);
    expect([...byRole].filter(([, st]) => st.some((s) => readsSsmSecret(s, APPROVAL_LINK_KEYS_SECRET_NAME))).map(([role]) => role)).toEqual([
      SENDER_ROLE_LOGICAL_ID,
    ]);
    const legacy = [...byRole.values()].flat().filter((s) => s.Sid === 'DbRoleLegacySecretsRead');
    expect(legacy).toHaveLength(1);
    expect(actionsOf(legacy[0] as IamStatement)).toEqual(['secretsmanager:GetSecretValue']);
    // 옮긴 키링·API 키 8 의 옛 자리를 읽는 문장은 0.
    const all = JSON.stringify([...byRole.values()].flat().filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue')).map((s) => s.Resource));
    expect(all).not.toMatch(/ApprovalLinkKeysSecret|OwnerLoginKeysSecret|ContactForwardToSecret|OpsKeysSecret|OpsLoginKeysSecret|Paddle/);
    expect(DB_APP_SECRET_NAME).toBe('atmark/db/app');
  });
});

describe('AtmarkCompute — S3 · KMS · 비밀', () => {
  const allStatements = (): IamStatement[] => [...statementsByRole(runtimeTemplates().compute).values()].flat();
  const resourcesOf = (statement: IamStatement): string => JSON.stringify(statement.Resource);

  it('모든 IAM 정책 문서는 인쇄 가능 ASCII 뿐이다 — IAM API 가 나머지를 거부한다(2026-09-24 AtmarkCompute 배포 거부·롤백 실측)', () => {
    const template = runtimeTemplates().compute.toJSON() as { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : value !== null && typeof value === 'object'
            ? Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)])
            : [];
    const documents = Object.entries(template.Resources)
      .filter(([, r]) => r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::ManagedPolicy')
      .map(([id, r]) => [id, strings([r.Properties?.['PolicyDocument'], r.Properties?.['Policies'], r.Properties?.['AssumeRolePolicyDocument']])] as const);
    expect(documents.length).toBeGreaterThan(0);
    for (const [id, values] of documents) {
      for (const value of values) expect(/[^\x20-\x7e]/.test(value), `${id}: ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('삭제 권한은 어느 역할에도 없다', () => {
    for (const statement of allStatements()) {
      for (const action of actionsOf(statement)) expect(action).not.toMatch(/^s3:(Delete|\*)|^\*$/);
    }
  });

  it('inbound/parsed·inbound/attachments 에 쓰는 것은 inbound 역할 하나 · inbound/raw 에 쓰는 역할은 없다', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    for (const [role, statements] of byRole) {
      const puts = statements.filter((s) => actionsOf(s).includes('s3:PutObject')).map(resourcesOf).join(' ');
      expect(puts, role).not.toMatch(/inbound\/raw\//);
      if (!role.startsWith('InboundRole')) expect(puts, role).not.toMatch(/inbound\/(parsed|attachments)\//);
    }
  });

  it('예약 본문 접두사는 런타임 상수와 같다', () => {
    expect(STACK_OUTBOUND_SCHEDULED_PREFIX).toBe(OUTBOUND_SCHEDULED_PREFIX);
  });

  it('KMS Decrypt 는 Secrets Manager 경유 또는 SSM 경유(그 파라미터의 암호화 문맥)로만 · GetSecretValue 는 에이전트 키 시크릿에 없다 (AC-e2) — 서명 역할 하나만 예외', () => {
    // ★ 예외는 **정확히 하나**: passport-signer 역할의 무조건 Decrypt(envelope DEK)와 에이전트 키 시크릿 읽기(계약 §3 · §3.5 AC-e2).
    const signerRole = functionsByName(runtimeTemplates().compute).get('atmark-passport-signer')?.Role['Fn::GetAtt'][0];
    expect(signerRole).toBeDefined();
    const unconditionalDecrypt: string[] = [];
    const keypairReaders: string[] = [];
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      for (const statement of statements) {
        if (actionsOf(statement).includes('kms:Decrypt') && statement.Condition === undefined) unconditionalDecrypt.push(role);
        if (actionsOf(statement).includes('secretsmanager:GetSecretValue') && /agent-keypairs/.test(resourcesOf(statement))) {
          keypairReaders.push(role);
        }
      }
    }
    expect(unconditionalDecrypt).toEqual([signerRole]);
    expect(keypairReaders).toEqual([signerRole]);
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      if (role === signerRole) continue;
      for (const statement of statements) {
        if (actionsOf(statement).includes('kms:Decrypt')) {
          const equals = statement.Condition?.['StringEquals'] ?? {};
          if (equals['kms:ViaService'] === 'ssm.ap-northeast-2.amazonaws.com') {
            // SSM 비밀(2026-10-12 이전) — 문맥 PARAMETER_ARN 이 `/atmark/…` 파라미터일 때만. 그 밖의 조건은 없다.
            expect(Object.keys(statement.Condition ?? {})).toEqual(['StringEquals']);
            expect(Object.keys(equals).sort()).toEqual(['kms:EncryptionContext:PARAMETER_ARN', 'kms:ViaService']);
            const contexts = JSON.stringify(equals['kms:EncryptionContext:PARAMETER_ARN']);
            expect(contexts).toMatch(/:ssm:ap-northeast-2:123456789012:parameter\/atmark\//);
            expect(contexts).not.toMatch(/\*/);
          } else {
            expect(statement.Condition).toEqual({
              StringEquals: { 'kms:ViaService': 'secretsmanager.ap-northeast-2.amazonaws.com' },
            });
          }
        }
      }
    }
    for (const statement of allStatements()) {
      if (actionsOf(statement).includes('secretsmanager:CreateSecret')) {
        expect(statement.Resource).toBe('arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/agent-keypairs/*');
      }
      // 덮어쓰기(= 키 회전) 불가 — §4B.1.
      if (actionsOf(statement).includes('secretsmanager:PutSecretValue')) {
        expect(resourcesOf(statement)).not.toMatch(/agent-keypairs/);
      }
    }
  });
});

describe('AtmarkCompute — 트리거', () => {
  it('SQS 이벤트 소스 넷(inbound · ses-events · billing-sync · ai-watch-result) 모두 부분 실패 보고 · 동시성 상한은 예약 동시성을 넘지 않게', async () => {
    const { RESERVED_CONCURRENCY } = await import('../../../infra/cdk/stacks/compute-stack');
    const compute = runtimeTemplates().compute;
    const mappings = compute.findResources('AWS::Lambda::EventSourceMapping') as Record<
      string,
      { Properties: { FunctionName: unknown; FunctionResponseTypes?: string[]; ScalingConfig?: { MaximumConcurrency: number } } }
    >;
    expect(Object.keys(mappings)).toHaveLength(4);
    const functions = Object.entries(compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>);
    const syncLogicalId = functions.find(([, fn]) => fn.Properties.FunctionName === 'atmark-billing-sync')?.[0];
    const aiWatchResultLogicalId = functions.find(([, fn]) => fn.Properties.FunctionName === 'atmark-ai-watch-result')?.[0];
    for (const mapping of Object.values(mappings)) {
      expect(mapping.Properties.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
      const target = JSON.stringify(mapping.Properties.FunctionName);
      if (target.includes(`"${String(aiWatchResultLogicalId)}"`)) {
        // AI 감시 결과 λ(예약 1) — 결제 sync 와 같은 이유로 상한 없음.
        expect(mapping.Properties.ScalingConfig).toBeUndefined();
      } else if (target.includes(`"${String(syncLogicalId)}"`)) {
        // 새 매핑은 MaximumConcurrency > 예약 동시성이면 Lambda 가 400 으로 거부한다(운영 실측) — 결제 sync(예약 1)는 상한을 걸지 않는다.
        expect(mapping.Properties.ScalingConfig).toBeUndefined();
        expect(RESERVED_CONCURRENCY['billing-sync']).toBe(1);
      } else {
        expect(mapping.Properties.ScalingConfig?.MaximumConcurrency).toBe(2);
      }
    }
  });

  it('스케줄 6개: 릴리스·알림·로그인 메일·웹훅·예약 1분, 만료 5분 · 재시도 0', () => {
    const schedules = runtimeTemplates().compute.findResources('AWS::Scheduler::Schedule') as Record<
      string,
      { Properties: { Name: string; ScheduleExpression: string; Target: { RetryPolicy: { MaximumRetryAttempts: number } } } }
    >;
    const byName = new Map(Object.values(schedules).map((s) => [s.Properties.Name, s.Properties]));
    // + 결제 reconcile 하나(아래 결제 절이 따로 본다) + 고객 도메인 확인 틱 하나(DISABLED — 아래 절). 입력이 있는 스케줄은 reconcile·login-mailer 틱·도메인 틱 셋.
    expect(byName.size).toBe(SCHEDULES.length + 3);
    for (const { handler, minutes } of SCHEDULES) {
      const schedule = byName.get(`atmark-${handler}`);
      expect(schedule?.ScheduleExpression, handler).toBe(minutes === 1 ? 'rate(1 minute)' : `rate(${String(minutes)} minutes)`);
      expect(schedule?.Target.RetryPolicy.MaximumRetryAttempts, handler).toBe(0);
    }
    expect(SCHEDULES.find((s) => s.handler === 'approval-expiry')?.minutes).toBe(5);
    expect(SCHEDULES.find((s) => s.handler === 'login-mailer')?.minutes).toBe(1);
  });

  it('HTTP API 넷: api(api.atmark.ai) $default → api Lambda · console(console.atmark.ai) $default·로그인 둘 → admin Lambda · billing POST /paddle/webhook → billing-webhook · ops $default·인증 넷 → ops Lambda · 액세스 로그', () => {
    const compute = runtimeTemplates().compute;
    // HTTP API 넷 + 실시간 WebSocket API 하나(묶음 E — 아래 "실시간 WebSocket" 절이 따로 본다).
    compute.resourceCountIs('AWS::ApiGatewayV2::Api', 5);
    compute.resourceCountIs('AWS::ApiGatewayV2::Route', 21); // 콘솔 폰트 라우트 제거(배포 전 리뷰 M4)로 13 → 12 · ops 5(ADR-0015) → 17 · 대기자 명단(2026-09-30) → 18 · 실시간 3(묶음 E) → 21
    // 라우트 → API · 통합 → 함수를 따라간다.
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string } }>;
    const routes = compute.findResources('AWS::ApiGatewayV2::Route') as Record<string, { Properties: { ApiId: unknown; RouteKey: string; Target: unknown } }>;
    const integrations = compute.findResources('AWS::ApiGatewayV2::Integration') as Record<string, { Properties: { IntegrationUri: unknown } }>;
    const functionsById = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const routing = Object.values(routes).map((route) => {
      const apiId = /"Ref":"([^"]+)"/.exec(JSON.stringify(route.Properties.ApiId))?.[1] ?? '';
      const integrationId = /"Ref":"([^"]+)"/.exec(JSON.stringify(route.Properties.Target))?.[1] ?? '';
      const fnId = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(JSON.stringify(integrations[integrationId]?.Properties.IntegrationUri))?.[1] ?? '';
      return `${apis[apiId]?.Properties.Name ?? '?'} ${route.Properties.RouteKey} -> ${functionsById[fnId]?.Properties.FunctionName ?? '?'}`;
    });
    expect(routing.sort()).toEqual([
      'atmark-api $default -> atmark-api',
      'atmark-api GET /v1/identity/{address} -> atmark-api',
      'atmark-billing POST /paddle/webhook -> atmark-billing-webhook',
      'atmark-console $default -> atmark-admin',
      'atmark-console ANY /org-api/{proxy+} -> atmark-admin',
      'atmark-console POST /api/billing/checkout -> atmark-admin',
      'atmark-console POST /api/billing/portal -> atmark-admin',
      'atmark-console POST /api/invites/claim -> atmark-admin',
      'atmark-console POST /api/login -> atmark-admin',
      'atmark-console POST /api/login/verify -> atmark-admin',
      'atmark-console POST /api/signup -> atmark-admin',
      'atmark-console POST /api/signup/verify -> atmark-admin',
      'atmark-console POST /api/waitlist -> atmark-admin',
      'atmark-ops $default -> atmark-ops',
      'atmark-ops POST /api/auth/request -> atmark-ops',
      'atmark-ops POST /api/auth/step-up -> atmark-ops',
      'atmark-ops POST /api/auth/step-up/verify -> atmark-ops',
      'atmark-ops POST /api/auth/verify -> atmark-ops',
      'atmark-realtime $connect -> atmark-realtime',
      'atmark-realtime $default -> atmark-realtime',
      'atmark-realtime $disconnect -> atmark-realtime',
    ]);
    compute.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'console.atmark.ai' });
    compute.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'api.atmark.ai' });
    compute.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 2);
    compute.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('\\$context\\.path') },
    });
    const url = functionsByName(compute).get('atmark-api')?.Environment.Variables['ATMARK_APPROVAL_PAGE_URL'];
    expect(url).toBe('https://api.atmark.ai/approve');
  });
});

describe('AtmarkCompute — 코드 출처', () => {
  it('스텁 synth 에는 배포를 거부하는 CloudFormation Rule 이 붙는다', () => {
    const rules = runtimeTemplates().compute.toJSON()['Rules'] as Record<string, unknown>;
    expect(rules).toHaveProperty('StubLambdaCodeIsNotDeployable');
  });

  it('운영 synth 는 dist/lambda/<name>/index.js 가 없으면 실패한다', () => {
    expect(() => buildRuntimeApp({ kind: 'assets', root: '/nonexistent/atmark/dist/lambda' })).toThrow(/pnpm build:lambda/);
  });
});


// ---------------------------------------------------------------------------
// 예약 동시성 — RDS 연결 한도(리드 추가, 2026-09-23)
// ---------------------------------------------------------------------------

describe('예약 동시성이 RDS 연결 한도를 지킨다', () => {
  it('모든 Lambda 에 예약 동시성이 있고, 합 × 풀 크기가 t4g.micro 연결 한도(≈80)에서 여유를 남긴다', async () => {
    const { DB_POOL_MAX, MIGRATION_POOL_MAX } = await import('../../../src/runtime/composition');
    const { ADMIN_POOL_MAX, DOMAIN_TICK_POOL_MAX } = await import('../../../src/runtime/admin-composition');
    const { LOGIN_MAILER_POOL_MAX } = await import('../../../src/runtime/login-mailer-composition');
    const { PASSPORT_SIGNER_POOL_MAX } = await import('../../../src/runtime/passport-signer-composition');
    const { CONTACT_FORWARDER_POOL_MAX } = await import('../../../src/runtime/composition');
    const { BILLING_SYNC_POOL_MAX } = await import('../../../src/runtime/billing-composition');
    const { BILLING_WEBHOOK_POOL_MAX } = await import('../../../src/runtime/billing-webhook-composition');
    const { RESERVED_CONCURRENCY } = await import('../../../infra/cdk/stacks/compute-stack');
    const { DOMAIN_CONTROL_POOL_MAX } = await import('../../../src/runtime/handlers/domain-control');
    const { DOMAIN_POLICY_AUDIT_POOL_MAX } = await import('../../../src/runtime/handlers/domain-policy-audit');
    const template = runtimeTemplates().compute;
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; ReservedConcurrentExecutions?: number } }[];
    expect(fns.length).toBe(Object.keys(RESERVED_CONCURRENCY).length);
    let connections = 0;
    for (const fn of fns) {
      const reserved = fn.Properties.ReservedConcurrentExecutions;
      expect(reserved, `${fn.Properties.FunctionName} 에 예약 동시성이 없다`).toBeTypeOf('number');
      const pools: Readonly<Record<string, number>> = {
        'atmark-migrate': MIGRATION_POOL_MAX,
        'atmark-admin': ADMIN_POOL_MAX,
        'atmark-login-mailer': LOGIN_MAILER_POOL_MAX,
        'atmark-passport-signer': PASSPORT_SIGNER_POOL_MAX,
        'atmark-contact-forwarder': CONTACT_FORWARDER_POOL_MAX,
        // WP-2 — sync 1 × 1 · 웹훅 2 × 0(DB 없음).
        'atmark-billing-sync': BILLING_SYNC_POOL_MAX,
        'atmark-billing-webhook': BILLING_WEBHOOK_POOL_MAX,
        // ADR-0015 — 운영자 콘솔 2 × 1.
        [OPS_FUNCTION_NAME]: OPS_POOL_MAX,
        // ADR-0014 단계 2 — 고객 도메인 제어면 2 × 0(DB 없음). 합은 그대로 70.
        'atmark-domain-control': DOMAIN_CONTROL_POOL_MAX,
        'atmark-domain-policy-audit': DOMAIN_POLICY_AUDIT_POOL_MAX,
        // ADR-0017 초안 — AI 감시 결과 1 × 1(`atmark_ai_watch`).
        [AI_WATCH_RESULT_FUNCTION_NAME]: AI_WATCH_RESULT_POOL_MAX,
        // 묶음 E — 실시간 WebSocket 1 × 1(앱 롤 · 유휴 5초).
        [REALTIME_FUNCTION_NAME]: REALTIME_POOL_MAX,
      };
      const pool = pools[fn.Properties.FunctionName] ?? DB_POOL_MAX;
      connections += (reserved as number) * pool;
    }
    // ADR-0014 단계 4 — admin λ 안의 확인 틱 풀(틱 롤, 크기 1). 스케줄러(10분 · 틱 ≤ 20초)만 부르므로 한 번에 하나 — 예약 동시성과 곱하지 않고 1 을
    //   더한다(리드 결정 72 → 73/75). 틱은 이벤트마다 풀을 열고 `end()` 한다(`runDomainRecheckTask`).
    expect(DOMAIN_TICK_POOL_MAX).toBe(1);
    connections += DOMAIN_TICK_POOL_MAX;
    // 80 에서 운영자 접속·RDS 내부 예약분 여유 5 이상. 이 스택은 70(api 7 · 틱 1 · AI 감시 결과 1 — 2026-10-06 · 실시간 1 — 2026-10-08 묶음 E, org-api 몫 2 → 1)
    //   — 투명성 로그 2 를 더한 72 는 transparency-stack.test.ts.
    expect(connections).toBeLessThanOrEqual(75);
    expect(connections).toBe(70);
    expect(RESERVED_CONCURRENCY[REALTIME_HANDLER_NAME]).toBe(1);
    expect(REALTIME_POOL_MAX).toBe(1);
    expect(RESERVED_CONCURRENCY['ai-watch-result']).toBe(1);
    expect(AI_WATCH_RESULT_POOL_MAX).toBe(1);
    // 2026-09-25 진윤겸 결정(WP-2): api 10 → 9. 2026-09-28 리드 결정(ADR-0015): 9 → 8 · ops 2 × 1. sync 는 1 × 1, 웹훅은 풀 0.
    expect(RESERVED_CONCURRENCY.api).toBe(7);
    expect(OPS_POOL_MAX).toBe(1);
    expect(RESERVED_CONCURRENCY.ops).toBe(OPS_RESERVED_CONCURRENCY);
    expect(OPS_RESERVED_CONCURRENCY).toBe(2);
    // `atmark_ops` 롤의 CONNECTION LIMIT(= 예약 + 여유 1)은 남은 여유(75 − 72 = 3) 안이다.
    expect(OPS_ROLE_CONNECTION_LIMIT).toBe(OPS_RESERVED_CONCURRENCY * OPS_POOL_MAX + 1);
    expect(BILLING_SYNC_POOL_MAX).toBe(1);
    expect(RESERVED_CONCURRENCY['billing-sync']).toBe(1);
    expect(BILLING_WEBHOOK_POOL_MAX).toBe(0);
    // login-mailer 는 1 × 1 — 풀 하나로 순차 처리한다(`login-mailer-composition.ts`).
    expect(LOGIN_MAILER_POOL_MAX).toBe(1);
    expect(RESERVED_CONCURRENCY['login-mailer']).toBe(1);
    // domain-control 은 예약 2 × 풀 0(계획 §3.5) — 연결 예산에 0 을 더한다.
    expect(RESERVED_CONCURRENCY['domain-control']).toBe(2);
    expect(DOMAIN_CONTROL_POOL_MAX).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// admin 역할 — 권한 분리(관리 백엔드, 2026-09-23)
// ---------------------------------------------------------------------------

describe('admin 역할 — SES 0 · S3 는 발신 본문 GetObject 하나 · 앱·소유자 DB 비밀 0 · admin DB 비밀 읽기만 · custody', () => {
  const adminRoleId = (): string => {
    const fn = functionsByName(runtimeTemplates().compute).get('atmark-admin');
    const id = fn?.Role['Fn::GetAtt'][0];
    if (id === undefined) throw new Error('admin 함수의 역할이 없다');
    return id;
  };
  const adminStatements = (): IamStatement[] => statementsByRole(runtimeTemplates().compute).get(adminRoleId()) ?? [];

  it('admin 은 자기 역할(atmark-runtime-admin)을 쓴다 — 발송 역할이 아니다', () => {
    expect(adminRoleId()).not.toBe(SENDER_ROLE_LOGICAL_ID);
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(roles[adminRoleId()]?.Properties.RoleName).toBe('atmark-runtime-admin');
  });

  it('admin 역할의 액션은 허용 집합 안이다 — SES·PutSecretValue 없음 · S3 는 GetObject 하나', () => {
    const actions = new Set(adminStatements().flatMap(actionsOf));
    expect([...actions].sort()).toEqual(
      [
        // 묶음 E — 콘솔 풀기 뒤 실시간 힌트(실시간 API 의 POST @connections/* 하나 — 아래 "실시간 WebSocket" 절).
        'execute-api:ManageConnections',
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GetPublicKey',
        'kms:Sign',
        'lambda:InvokeFunction',
        's3:GetObject',
        'secretsmanager:CreateSecret',
        // 2026-10-12 비밀 → SSM 이전 — admin 의 비밀 넷은 SSM 에서(Secrets Manager 읽기는 이제 0).
        'ssm:GetParameter',
      ].sort(),
    );
    for (const action of actions) expect(action).not.toMatch(/^(ses|sesv2):|^\*$/);
    for (const action of actions) if (action.startsWith('s3:')) expect(action).toBe('s3:GetObject');
  });

  it('★ admin 의 S3 는 GetObject 하나 · 리소스는 메일 버킷 outbound/content/* 하나뿐(US-004 — ListBucket·Put·다른 접두사 없음)', () => {
    const s3 = adminStatements().filter((s) => actionsOf(s).some((action) => action.startsWith('s3:')));
    expect(s3).toHaveLength(1);
    const statement = s3[0] as IamStatement;
    expect(actionsOf(statement)).toEqual(['s3:GetObject']);
    expect(statement.Effect).toBe('Allow');
    expect(statement.Condition).toBeUndefined();
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    expect(resources).toHaveLength(1);
    const resource = JSON.stringify(resources[0]);
    expect(resource).toMatch(/MailStoreBucket/);
    expect(resource).toContain(`/${OUTBOUND_CONTENT_PREFIX}*`);
    expect(resource).not.toMatch(/inbound\/|outbound\/scheduled\//);
  });

  it('admin 이 읽는 비밀은 admin DB 비밀 · 로그인 키 · Paddle admin 키 · 틱 롤 비밀(확인 틱 — ADR-0014 단계 4) 넷뿐이다(소유자·앱 DB·승인 키·웹훅 키·결제 sync 키·웹훅 서명 비밀 없음 — H2 · 보안 M1)', () => {
    expect(adminStatements().filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'))).toEqual([]);
    const reads = adminStatements().filter((s) => actionsOf(s).includes('ssm:GetParameter'));
    const allowed = [DB_ADMIN_SECRET_NAME, OWNER_LOGIN_KEYS_SECRET_NAME, PADDLE_ADMIN_API_KEY_SECRET_NAME, DOMAIN_TICK_DB_SECRET_NAME];
    for (const name of allowed) expect(reads.some((s) => readsSsmSecret(s, name)), name).toBe(true);
    // 그 밖의 SSM 비밀은 0 — 콘솔 웹훅 시크릿은 api λ 를 불러 받는다(보안 M1) · 웹훅 KEK·마스터는 Secrets Manager 에 남았고 admin 은 못 읽는다.
    for (const name of SSM_SECRET_NAMES.filter((n) => !allowed.includes(n))) {
      expect(reads.some((s) => readsSsmSecret(s, name)), name).toBe(false);
    }
    expect(reads.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))).toHaveLength(4);
  });

  it('소유자 DB 비밀을 읽는 역할은 migrate 하나뿐이다(SSM 자리 · 옛 Secrets Manager 자리 모두)', () => {
    const readers = [...statementsByRole(runtimeTemplates().compute)]
      .filter(([, statements]) =>
        statements.some(
          (s) =>
            readsSsmSecret(s, 'atmark/db/owner') ||
            (actionsOf(s).includes('secretsmanager:GetSecretValue') && JSON.stringify(s.Resource).includes('DbOwnerSecret')),
        ),
      )
      .map(([role]) => role);
    expect(readers).toHaveLength(1);
    expect(readers[0]).toMatch(/^MigrateRole/);
  });

  it('passport custody 권한은 admin 에만 있다(migrate 에서 옮겼다)', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    const holders = [...byRole]
      .filter(([, statements]) =>
        statements.some(
          (s) =>
            // SSM 비밀 키(AtmarkSecretsKey)의 SSM 경유 GenerateDataKey 는 migrate 의 쓰기 — custody 가 아니다(아래 "SSM 비밀" 절이 따로 본다).
            (actionsOf(s).includes('kms:GenerateDataKey') && !JSON.stringify(s.Condition ?? {}).includes('ssm.ap-northeast-2.amazonaws.com')) ||
            actionsOf(s).includes('secretsmanager:CreateSecret'),
        ),
      )
      .map(([role]) => role);
    expect(holders).toEqual([adminRoleId()]);
  });

  it('로그인 키를 읽는 역할은 admin 과 로그인 메일 역할 둘뿐이다 — 발송 역할(api)은 아니다(H1)', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    const readers = [...byRole]
      .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, OWNER_LOGIN_KEYS_SECRET_NAME)))
      .map(([role]) => role)
      .sort();
    expect(readers).toEqual([adminRoleId(), LOGIN_MAILER_ROLE_LOGICAL_ID].sort());
    // 옛 Secrets Manager 자리는 아무도 읽지 않는다.
    const everyone = [...byRole.values()].flat();
    expect(everyone.some((s) => actionsOf(s).includes('secretsmanager:GetSecretValue') && JSON.stringify(s.Resource).includes('OwnerLoginKeysSecret'))).toBe(false);
  });

  it('★ admin 의 lambda:InvokeFunction 은 문장 셋 · 리소스는 login-mailer(깨우기)·api(콘솔 웹훅 시크릿 — 보안 M1)·domain-control(확인 틱 — ADR-0014) 함수 ARN 정확히 하나씩(한정자·와일드카드 없음) · 조건 없음', () => {
    const functions = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const idOf = (name: string): string | undefined => Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === name)?.[0];
    const mailerId = idOf('atmark-login-mailer');
    const apiId = idOf('atmark-api');
    const domainControlId = idOf('atmark-domain-control');
    expect(mailerId).toBeDefined();
    expect(apiId).toBeDefined();
    expect(domainControlId).toBeDefined();
    const invoke = adminStatements().filter((s) => actionsOf(s).some((action) => action.startsWith('lambda:')));
    expect(invoke).toHaveLength(3);
    const targets: unknown[] = [];
    for (const statement of invoke) {
      expect(statement.Effect).toBe('Allow');
      expect(actionsOf(statement)).toEqual(['lambda:InvokeFunction']);
      expect(statement.Condition).toBeUndefined();
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      expect(resources).toHaveLength(1);
      targets.push(resources[0]);
    }
    expect(targets).toEqual(
      expect.arrayContaining([{ 'Fn::GetAtt': [mailerId, 'Arn'] }, { 'Fn::GetAtt': [apiId, 'Arn'] }, { 'Fn::GetAtt': [domainControlId, 'Arn'] }]),
    );
  });

  it('★ admin 환경의 ATMARK_API_FUNCTION_ARN 은 api 함수의 ARN 이고 다른 함수는 이 변수를 받지 않는다(보안 M1)', () => {
    const compute = runtimeTemplates().compute;
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const apiId = Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === 'atmark-api')?.[0];
    expect(RUNTIME_ENV.apiFunctionArn).toBe('ATMARK_API_FUNCTION_ARN');
    for (const [name, fn] of functionsByName(compute)) {
      expect(RUNTIME_ENV.apiFunctionArn in fn.Environment.Variables, name).toBe(name === 'atmark-admin');
    }
    expect(functionsByName(compute).get('atmark-admin')?.Environment.Variables[RUNTIME_ENV.apiFunctionArn]).toEqual({ 'Fn::GetAtt': [apiId, 'Arn'] });
  });

  it('★ admin 환경의 ATMARK_LOGIN_MAILER_FUNCTION_ARN 은 login-mailer 함수의 ARN 이다(IAM 리소스와 같은 값)', () => {
    const compute = runtimeTemplates().compute;
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const mailerId = Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === 'atmark-login-mailer')?.[0];
    const admin = functionsByName(compute).get('atmark-admin');
    expect(RUNTIME_ENV.loginMailerFunctionArn).toBe('ATMARK_LOGIN_MAILER_FUNCTION_ARN');
    expect(admin?.Environment.Variables[RUNTIME_ENV.loginMailerFunctionArn]).toEqual({ 'Fn::GetAtt': [mailerId, 'Arn'] });
    // ops(ADR-0015)도 같은 값으로 깨운다 — 다른 함수는 이 변수를 받지 않는다.
    expect(OPS_ENV.loginMailerFunctionArn).toBe(RUNTIME_ENV.loginMailerFunctionArn);
    expect(functionsByName(compute).get(OPS_FUNCTION_NAME)?.Environment.Variables[OPS_ENV.loginMailerFunctionArn]).toEqual({ 'Fn::GetAtt': [mailerId, 'Arn'] });
    for (const [name, fn] of functionsByName(compute)) {
      expect(RUNTIME_ENV.loginMailerFunctionArn in fn.Environment.Variables, name).toBe(name === 'atmark-admin' || name === OPS_FUNCTION_NAME);
    }
  });

  it('★ login-mailer 를 부를 수 있는 런타임 역할은 admin 과 ops(ADR-0015) 둘이다(Scheduler 역할 밖) — 발송 역할·login-mailer 자신·다른 λ 는 없다', () => {
    const functions = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string; Role: { 'Fn::GetAtt': [string, string] } } }>;
    const runtimeRoles = new Set(Object.values(functions).map((fn) => fn.Properties.Role['Fn::GetAtt'][0]));
    const invokers = [...statementsByRole(runtimeTemplates().compute)]
      .filter(([role]) => runtimeRoles.has(role))
      .filter(([, statements]) => statements.some((s) => actionsOf(s).some((action) => /^lambda:(InvokeFunction|\*)$|^\*$/.test(action))))
      .map(([role]) => role);
    const opsRoleId = functionsByName(runtimeTemplates().compute).get(OPS_FUNCTION_NAME)?.Role['Fn::GetAtt'][0];
    // 발송 역할(api 가 쓴다)의 Invoke 하나는 admin 자가 등록이다(아래 ★ 테스트 — login-mailer 가 아니다). 그래서 Invoke 를 가진 역할은 셋이다.
    const senderRoleId = functionsByName(runtimeTemplates().compute).get('atmark-api')?.Role['Fn::GetAtt'][0];
    expect(invokers.sort()).toEqual([adminRoleId(), opsRoleId, senderRoleId].sort());
    const senderInvoke = (statementsByRole(runtimeTemplates().compute).get(senderRoleId ?? '') ?? []).filter((s) => actionsOf(s).includes('lambda:InvokeFunction'));
    expect(JSON.stringify(senderInvoke)).not.toContain('atmark-login-mailer');
  });

  it('★ admin 의 ATMARK_CONSOLE_API_ID 는 콘솔 HTTP API 의 Ref(토큰) — 다른 함수는 받지 않고 콘솔 API 자원은 admin 함수를 참조하지 않는다(순환 없음)', () => {
    const compute = runtimeTemplates().compute;
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string } }>;
    const consoleId = Object.entries(apis).find(([, api]) => api.Properties.Name === 'atmark-console')?.[0];
    expect(consoleId).toBeDefined();
    expect(functionsByName(compute).get('atmark-admin')?.Environment.Variables['ATMARK_CONSOLE_API_ID']).toEqual({ Ref: consoleId });
    for (const [name, fn] of functionsByName(compute)) {
      expect('ATMARK_CONSOLE_API_ID' in fn.Environment.Variables, name).toBe(name === 'atmark-admin');
    }
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const adminId = Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === 'atmark-admin')?.[0] ?? '';
    expect(JSON.stringify(apis[consoleId ?? ''])).not.toContain(adminId);
  });

  it('★ api → admin 자가 등록(ADR-0016 2026-10-08) — 발송 역할의 lambda:InvokeFunction 은 admin 함수 ARN 정확히 하나 · ATMARK_ADMIN_FUNCTION_ARN 은 api 에만', () => {
    const compute = runtimeTemplates().compute;
    const api = functionsByName(compute).get('atmark-api');
    const senderRoleId = api?.Role['Fn::GetAtt'][0] ?? '';
    const invoke = (statementsByRole(compute).get(senderRoleId) ?? []).filter((s) => actionsOf(s).some((action) => /^lambda:/.test(action) || action === '*'));
    expect(invoke).toHaveLength(1);
    const statement = invoke[0];
    if (statement === undefined) throw new Error('발송 역할에 Invoke 문장이 없다');
    expect(actionsOf(statement)).toEqual(['lambda:InvokeFunction']);
    expect(statement.Condition).toBeUndefined();
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    expect(resources).toHaveLength(1);
    const arn = JSON.stringify(resources[0]);
    // 배포 전 보안 리뷰(2026-10-08): **enroll 별칭만** — 한정자 없는 함수 ARN 이면 발송 역할이 콘솔 HTTP 모양 이벤트를 admin 에 넣을 수 있다.
    expect(arn).toContain(':function:atmark-admin:enroll');
    expect(arn).not.toMatch(/atmark-admin"|atmark-admin\]/);
    expect(arn).not.toContain('*');
    const aliases = compute.findResources('AWS::Lambda::Alias') as Record<string, { Properties: { Name: string; FunctionName: unknown } }>;
    const enrollAlias = Object.values(aliases).filter((alias) => alias.Properties.Name === 'enroll');
    expect(enrollAlias).toHaveLength(1);
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const adminId = Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === 'atmark-admin')?.[0] ?? '';
    expect(JSON.stringify(enrollAlias[0]?.Properties.FunctionName)).toContain(adminId);
    expect(JSON.stringify(api?.Environment.Variables['ATMARK_ADMIN_FUNCTION_ARN'])).toBe(arn);
    for (const [name, fn] of functionsByName(compute)) {
      expect('ATMARK_ADMIN_FUNCTION_ARN' in fn.Environment.Variables, name).toBe(name === 'atmark-api');
    }
  });
});

describe('관리 호스트 분리 — api.atmark.ai 에는 관리 경로가 없다', () => {
  it('api HTTP API 의 라우트는 $default + 공개 신원 조회(스로틀 분리용) · 관리 경로(로그인 둘)는 콘솔 API 에만 · api HTTP API 의 통합은 api Lambda 하나뿐이다', () => {
    const compute = runtimeTemplates().compute;
    const routes = compute.findResources('AWS::ApiGatewayV2::Route') as Record<string, { Properties: { RouteKey: string; ApiId: unknown } }>;
    const apiNames = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string } }>;
    const keysByApi = new Map<string, string[]>();
    for (const route of Object.values(routes)) {
      const api = apiNames[/"Ref":"([^"]+)"/.exec(JSON.stringify(route.Properties.ApiId))?.[1] ?? '']?.Properties.Name ?? '?';
      keysByApi.set(api, [...(keysByApi.get(api) ?? []), route.Properties.RouteKey].sort());
    }
    // 신원 조회 라우트는 **같은 api Lambda** 로 간다 — 따로 둔 이유는 스로틀 버킷 분리뿐이다(`API_ROUTE_THROTTLES`).
    expect(keysByApi.get('atmark-api')).toEqual(['$default', 'GET /v1/identity/{address}']);
    expect(keysByApi.get('atmark-console')).toEqual([
      '$default',
      'ANY /org-api/{proxy+}',
      'POST /api/billing/checkout',
      'POST /api/billing/portal',
      'POST /api/invites/claim',
      'POST /api/login',
      'POST /api/login/verify',
      'POST /api/signup',
      'POST /api/signup/verify',
      'POST /api/waitlist',
    ]);
    const integrations = compute.findResources('AWS::ApiGatewayV2::Integration') as Record<string, { Properties: { ApiId: unknown; IntegrationUri: unknown } }>;
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string } }>;
    const functionsById = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const byApi = new Map<string, string[]>();
    for (const integration of Object.values(integrations)) {
      const apiId = /"Ref":"([^"]+)"/.exec(JSON.stringify(integration.Properties.ApiId))?.[1] ?? '';
      const fnId = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(JSON.stringify(integration.Properties.IntegrationUri))?.[1] ?? '';
      const api = apis[apiId]?.Properties.Name ?? '?';
      byApi.set(api, [...(byApi.get(api) ?? []), functionsById[fnId]?.Properties.FunctionName ?? '?']);
    }
    expect(byApi.get('atmark-api')).toEqual(['atmark-api']);
    expect(byApi.get('atmark-console')).toEqual(['atmark-admin']);
    // 결제 웹훅 HTTP API(WP-2)도 라우트 하나 · 통합 하나 — `$default` 가 없어 다른 경로는 Lambda 에 닿지 않는다.
    expect(keysByApi.get('atmark-billing')).toEqual(['POST /paddle/webhook']);
    expect(byApi.get('atmark-billing')).toEqual(['atmark-billing-webhook']);
    // 운영자 콘솔 HTTP API(ADR-0015) — 통합은 ops λ 하나. api·console API 에는 ops 경로가 없다.
    expect(byApi.get('atmark-ops')).toEqual([OPS_FUNCTION_NAME]);
    expect(keysByApi.get('atmark-ops')).toEqual(['$default', ...Object.values(OPS_ROUTES).map((path) => `POST ${path}`)].sort());
  });

  it('출력: ConsoleUrl = https://console.atmark.ai · ConsoleCustomDomainCnameTarget 이 있다', () => {
    const outputs = runtimeTemplates().compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs['ConsoleUrl']?.Value).toBe('https://console.atmark.ai');
    expect(outputs['ConsoleCustomDomainCnameTarget']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 콘솔 HTTP API — 입구 하나 · 스로틀 버킷 분리 (검증 L2·M3, 2026-09-23)
// ---------------------------------------------------------------------------

describe('콘솔 HTTP API — execute-api 기본 엔드포인트 끔 · 로그인 라우트 스로틀 분리', () => {
  const apis = (): Record<string, { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }> =>
    runtimeTemplates().compute.findResources('AWS::ApiGatewayV2::Api') as Record<
      string,
      { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }
    >;

  it('L2: 콘솔 API 는 execute-api 기본 엔드포인트를 끈다 · api 는 켜 둔다(배포 스모크가 ApiEndpoint 를 쓴다)', () => {
    const byName = new Map(Object.values(apis()).map((api) => [api.Properties.Name, api.Properties.DisableExecuteApiEndpoint]));
    expect(byName.get('atmark-console')).toBe(true);
    expect(byName.get('atmark-api')).not.toBe(true);
  });

  it('M3: 로그인 요청·검증 라우트는 낮은 라우트 스로틀 · $default 는 높은 기본 스로틀 — 로그인 남용이 kill-switch 버킷을 비우지 못한다', () => {
    const stages = runtimeTemplates().compute.findResources('AWS::ApiGatewayV2::Stage') as Record<
      string,
      {
        DependsOn?: string[];
        Properties: {
          ApiId: unknown;
          DefaultRouteSettings?: { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number };
          RouteSettings?: Record<string, { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number }>;
        };
      }
    >;
    const consoleApiId = Object.entries(apis()).find(([, api]) => api.Properties.Name === 'atmark-console')?.[0];
    const consoleStage = Object.values(stages).find((stage) => JSON.stringify(stage.Properties.ApiId).includes(`"${String(consoleApiId)}"`));
    expect(consoleStage).toBeDefined();
    expect(consoleStage?.Properties.DefaultRouteSettings).toMatchObject({
      ThrottlingRateLimit: CONSOLE_DEFAULT_THROTTLE.rateLimit,
      ThrottlingBurstLimit: CONSOLE_DEFAULT_THROTTLE.burstLimit,
    });
    expect(consoleStage?.Properties.RouteSettings).toEqual({
      // 요청(메일을 만든다)은 1/5 — 메일 총량의 바닥. 검증은 5/10(로그인 보안 재확인 I-5 — 요청자별 거절은 DB 원장이 싸게 한다).
      'POST /api/login': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      'POST /api/login/verify': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      // 셀프 가입(보안 검증 L2) — 익명 가입 요청·검증도 따로 둔 라우트 버킷.
      'POST /api/signup': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      'POST /api/signup/verify': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      // 대기자 명단 등록(2026-09-30) — 익명 요청이 확인 메일로 이어진다. 가입 요청과 같은 1/5 를 따로.
      'POST /api/waitlist': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      // 초대 수락 1단계(확장성 P1) — 익명 요청이 로그인 메일로 이어진다 · 조직 API 키 표면(CI)은 따로 좁은 버킷.
      'POST /api/invites/claim': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      // 결제 체크아웃·포털(WP-2 보안 M-1) — 누를 때마다 Paddle API 를 부른다. 가장 낮은 버킷을 따로.
      'POST /api/billing/checkout': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      'POST /api/billing/portal': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      // 조직 API 키 표면은 전 조직 합의 천장(ADR-0010 L5) — 조직 공정성은 admin Lambda 의 DB 창 계수(키 60 · 조직 120/분)가 맡는다.
      'ANY /org-api/{proxy+}': { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
    // 모든 라우트 버킷(org-api 포함 — 예외 없음)은 기본 버킷보다 좁고, 기본 버킷은 예전(5 rps 하나)보다 넓다.
    for (const [routeKey, limit] of Object.entries(CONSOLE_ROUTE_THROTTLES)) {
      expect(limit.rateLimit, routeKey).toBeLessThan(CONSOLE_DEFAULT_THROTTLE.rateLimit);
      expect(limit.burstLimit, routeKey).toBeLessThan(CONSOLE_DEFAULT_THROTTLE.burstLimit);
    }
    expect(CONSOLE_DEFAULT_THROTTLE.rateLimit).toBeGreaterThan(5);
    // 라우트 설정은 라우트가 먼저 있어야 한다(스테이지가 라우트에 의존).
    const routes = runtimeTemplates().compute.findResources('AWS::ApiGatewayV2::Route') as Record<string, { Properties: { ApiId: unknown } }>;
    const consoleRouteIds = Object.entries(routes)
      .filter(([, route]) => JSON.stringify(route.Properties.ApiId).includes(`"${String(consoleApiId)}"`))
      .map(([id]) => id);
    expect(consoleRouteIds).toHaveLength(1 + Object.keys(CONSOLE_ROUTE_THROTTLES).length);
    expect(consoleRouteIds).toHaveLength(10);
    // 콘솔에는 폰트 라우트가 없다(배포 전 리뷰 M4 — 폰트는 사이트 출처가 낸다).
    expect(Object.keys(CONSOLE_ROUTE_THROTTLES).some((key) => key.includes('_fonts'))).toBe(false);
    // admin λ 로 들어오는 버킷의 합(스테이지 기본 + 라우트 설정 전부)이 상한 안이다(L-2).
    const buckets = [consoleStage?.Properties.DefaultRouteSettings, ...Object.values(consoleStage?.Properties.RouteSettings ?? {})];
    const sumRate = buckets.reduce((sum, b) => sum + (b?.ThrottlingRateLimit ?? 0), 0);
    const sumBurst = buckets.reduce((sum, b) => sum + (b?.ThrottlingBurstLimit ?? 0), 0);
    expect(sumRate).toBeLessThanOrEqual(ADMIN_LAMBDA_BUCKET_CEILING.rateLimit);
    expect(sumBurst).toBeLessThanOrEqual(ADMIN_LAMBDA_BUCKET_CEILING.burstLimit);
    expect(ADMIN_LAMBDA_BUCKET_CEILING).toEqual({ rateLimit: 54, burstLimit: 120 });
    // 메일을 만드는 요청 라우트는 가장 낮은 버킷 그대로 — 검증을 올려도 로그인·가입 메일 총량은 넓어지지 않는다(I-5).
    for (const routeKey of ['POST /api/login', 'POST /api/signup', 'POST /api/invites/claim']) {
      expect(CONSOLE_ROUTE_THROTTLES[routeKey], routeKey).toEqual({ rateLimit: 1, burstLimit: 5 });
    }
    expect(consoleStage?.DependsOn ?? []).toEqual(expect.arrayContaining(consoleRouteIds));
  });

  it('org-api 천장은 콘솔 몫을 남긴다(ADR-0010 L5 적대적 검토 H1) — 같은 admin Lambda·예약 동시성을 나눠 쓰는 동안', async () => {
    const { RESERVED_CONCURRENCY } = await import('../../../infra/cdk/stacks/compute-stack');
    // admin Lambda 하나가 콘솔과 `/org-api` 를 함께 받는다(DB 연결 예산 75/75 — 전용 Lambda 는 예산을 다시 나눈 뒤). 풀 대기 상한은
    //   호출 하나 안의 대기만 줄인다 — 실행 환경(예약 동시성)을 나누는 것은 이 천장뿐이다. 그래서 org-api 는 `$default` 의 **절반 이하**.
    const orgApi = CONSOLE_ROUTE_THROTTLES['ANY /org-api/{proxy+}'];
    expect(orgApi).toBeDefined();
    if (orgApi === undefined) return;
    expect(orgApi.rateLimit * 2).toBeLessThanOrEqual(CONSOLE_DEFAULT_THROTTLE.rateLimit);
    expect(orgApi.burstLimit * 2).toBeLessThanOrEqual(CONSOLE_DEFAULT_THROTTLE.burstLimit);
    // 그래도 조직 하나가 제 몫(분당 120 = 2 rps)을 다 쓸 수는 있다 — 천장이 조직 상한보다 좁으면 DB 창 계수가 뜻이 없다.
    expect(orgApi.rateLimit).toBeGreaterThanOrEqual(ORG_API_ORG_REQUESTS_PER_MINUTE / 60);
    // 예약 동시성이 그대로인 동안만 이 천장이 말이 된다 — 늘리면 연결 예산(ADMIN_POOL_MAX × 동시성)을 다시 본다.
    expect(RESERVED_CONCURRENCY.admin).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 결제(WP-2, Paddle) — 웹훅 λ 는 DB·VPC 밖 · 역할 문장 셋 · sync 소비 · reconcile 틱 (계획 §3-1 · 수용 기준 B-3·B-4)
// ---------------------------------------------------------------------------

describe('결제 — 웹훅 λ 역할은 문장 셋뿐 · 관리형 정책 0 · VPC 0', () => {
  const roleIdOf = (fnName: string): string => {
    const id = functionsByName(runtimeTemplates().compute).get(fnName)?.Role['Fn::GetAtt'][0];
    if (id === undefined) throw new Error(`${fnName} 의 역할이 없다`);
    return id;
  };

  it('웹훅 역할(atmark-runtime-billing-webhook)에는 AWS 관리형 정책이 없다 — Basic·VPC 도 없다(BL-3)', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<
      string,
      { Properties: { RoleName?: string; ManagedPolicyArns?: unknown[]; Policies?: unknown[] } }
    >;
    const role = roles[roleIdOf('atmark-billing-webhook')];
    expect(role?.Properties.RoleName).toBe('atmark-runtime-billing-webhook');
    expect(role?.Properties.ManagedPolicyArns ?? []).toEqual([]);
    expect(role?.Properties.Policies ?? []).toEqual([]);
  });

  it('웹훅 역할의 문장은 정확히 넷: 자기 로그 그룹 쓰기 · 웹훅 비밀 하나 읽기(SSM GetParameter + 그 파라미터 Decrypt) · 결제 큐 SendMessage', () => {
    const statements = statementsByRole(runtimeTemplates().compute).get(roleIdOf('atmark-billing-webhook')) ?? [];
    const shape = statements.map((s) => ({ sid: s.Sid, effect: s.Effect, actions: actionsOf(s).sort(), resource: JSON.stringify(s.Resource) }));
    expect(shape.map(({ sid, effect, actions }) => ({ sid, effect, actions })).sort((a, b) => String(a.sid).localeCompare(String(b.sid)))).toEqual([
      { sid: 'BillingQueueSend', effect: 'Allow', actions: ['sqs:SendMessage'] },
      { sid: 'OwnLogGroupWrite', effect: 'Allow', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'] },
      { sid: 'PaddleWebhookSecretRead', effect: 'Allow', actions: ['ssm:GetParameter'] },
      { sid: 'PaddleWebhookSecretReadDecrypt', effect: 'Allow', actions: ['kms:Decrypt'] },
    ]);
    const byId = new Map(shape.map((s) => [s.sid, s.resource]));
    expect(byId.get('PaddleWebhookSecretRead')).toMatch(/:parameter\/atmark\/billing\/paddle\/webhook-secret"/);
    expect(byId.get('PaddleWebhookSecretRead')).not.toMatch(/db\/|sync|admin|\*/);
    const decrypt = statements.find((s) => s.Sid === 'PaddleWebhookSecretReadDecrypt');
    expect(JSON.stringify(decrypt?.Condition)).toMatch(/ssm\.ap-northeast-2\.amazonaws\.com/);
    expect(JSON.stringify(decrypt?.Condition)).toMatch(/:parameter\/atmark\/billing\/paddle\/webhook-secret"/);
    expect(JSON.stringify(decrypt?.Condition)).not.toMatch(/db\/|sync-api|admin-api/);
    expect(byId.get('BillingQueueSend')).toMatch(/BillingEventsQueue/);
    expect(byId.get('BillingQueueSend')).not.toMatch(/Dlq/);
    expect(byId.get('OwnLogGroupWrite')).toMatch(/BillingWebhookLogs/);
    for (const s of statements) if (s.Sid !== 'PaddleWebhookSecretReadDecrypt') expect(s.Condition, s.Sid).toBeUndefined();
  });

  it('웹훅 환경: 운영 가드 · Paddle 환경 · 큐 URL · 웹훅 비밀 ARN 넷뿐 — DB 비밀·결제 스위치·API 키 없음', () => {
    const webhook = functionsByName(runtimeTemplates().compute).get('atmark-billing-webhook');
    expect(Object.keys(webhook?.Environment.Variables ?? {}).sort()).toEqual(
      [RUNTIME_ENV.environment, RUNTIME_ENV.paddleEnvironment, RUNTIME_ENV.billingQueueUrl, RUNTIME_ENV.paddleWebhookSecretArn].sort(),
    );
    expect(webhook?.Environment.Variables[RUNTIME_ENV.paddleEnvironment]).toBe(PADDLE_ENVIRONMENT_DEFAULT);
    expect(webhook?.Timeout).toBe(BILLING_WEBHOOK_TIMEOUT_SECONDS);
    expect(BILLING_WEBHOOK_TIMEOUT_SECONDS).toBeLessThanOrEqual(5);
  });

  it('DB 비밀을 읽거나 환경에 가진 역할·함수 중에 웹훅은 없다', () => {
    const webhookRole = roleIdOf('atmark-billing-webhook');
    const reads = (statementsByRole(runtimeTemplates().compute).get(webhookRole) ?? []).map((s) => JSON.stringify(s.Resource)).join(' ');
    expect(reads).not.toMatch(/Db[A-Za-z]*Secret|MasterSecret/);
    const env = functionsByName(runtimeTemplates().compute).get('atmark-billing-webhook')?.Environment.Variables ?? {};
    expect(Object.keys(env).filter((key) => /DB_|DATABASE|PG/.test(key))).toEqual([]);
  });

  it('결제 비밀마다 읽는 역할은 하나다: 웹훅 비밀 = 웹훅 · sync 키 = sync · admin 키 = admin · DB billing = sync(+ migrate 쓰기)', () => {
    const readersOf = (name: string): string[] =>
      [...statementsByRole(runtimeTemplates().compute)]
        .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, name)))
        .map(([role]) => role)
        .sort();
    expect(readersOf(PADDLE_WEBHOOK_SECRET_NAME)).toEqual([roleIdOf('atmark-billing-webhook')]);
    expect(readersOf(PADDLE_SYNC_API_KEY_SECRET_NAME)).toEqual([roleIdOf('atmark-billing-sync')]);
    expect(readersOf(PADDLE_ADMIN_API_KEY_SECRET_NAME)).toEqual([roleIdOf('atmark-admin')]);
    expect(readersOf(DB_BILLING_SECRET_NAME)).toEqual([roleIdOf('atmark-billing-sync'), roleIdOf('atmark-migrate')].sort());
    // 운영자 롤 비밀은 migrate 가 **쓰기만**(bootstrap-roles). 읽는 쪽은 운영자 CLI(터널)다.
    expect(readersOf(DB_BILLING_OPERATOR_SECRET_NAME)).toEqual([roleIdOf('atmark-migrate')]);
    // 옛 Secrets Manager 자리 — Paddle 셋은 아무도 읽지 않는다(DB 롤 둘은 migrate 의 옛 자리 확인 읽기만).
    const legacyReaders = (pattern: RegExp): number =>
      [...statementsByRole(runtimeTemplates().compute).values()]
        .flat()
        .filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue') && pattern.test(JSON.stringify(s.Resource))).length;
    expect(legacyReaders(/Paddle(Webhook|SyncApiKey|AdminApiKey)Secret/)).toBe(0);
  });
});

describe('결제 — sync λ · 큐 · reconcile', () => {
  it('sync: VPC 안 · 자기 역할(atmark-runtime-billing-sync) · SES 0 · 환경은 결제 DB 비밀·sync 키·스위치·Paddle 환경뿐', () => {
    const sync = functionsByName(runtimeTemplates().compute).get('atmark-billing-sync');
    expect(sync?.VpcConfig).toBeDefined();
    expect(sync?.Timeout).toBe(BILLING_SYNC_TIMEOUT_SECONDS);
    expect(Object.keys(sync?.Environment.Variables ?? {}).sort()).toEqual(
      [
        RUNTIME_ENV.environment,
        RUNTIME_ENV.paddleEnvironment,
        RUNTIME_ENV.billingEnabled,
        RUNTIME_ENV.dbBillingSecretArn,
        RUNTIME_ENV.paddleSyncApiKeySecretArn,
        'PGSSLMODE',
        RUNTIME_ENV.extraCaCerts,
      ].sort(),
    );
    expect(sync?.Environment.Variables[RUNTIME_ENV.billingEnabled]).toBe(BILLING_ENABLED_DEFAULT ? 'true' : 'false');
    expect(BILLING_ENABLED_DEFAULT).toBe(false);
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(roles[sync?.Role['Fn::GetAtt'][0] ?? '']?.Properties.RoleName).toBe('atmark-runtime-billing-sync');
    const actions = new Set((statementsByRole(runtimeTemplates().compute).get(sync?.Role['Fn::GetAtt'][0] ?? '') ?? []).flatMap(actionsOf));
    for (const action of actions) expect(action).toMatch(/^(ssm:GetParameter|kms:Decrypt|sqs:(ReceiveMessage|ChangeMessageVisibility|GetQueueUrl|DeleteMessage|GetQueueAttributes))$/);
  });

  it('sync 는 결제 FIFO 를 batch 1 · 부분 실패 보고로 소비한다 · 가시성 ≥ 6 × sync 타임아웃(예약 1 — 넘친 폴링은 스로틀)', async () => {
    const { RESERVED_CONCURRENCY } = await import('../../../infra/cdk/stacks/compute-stack');
    const compute = runtimeTemplates().compute;
    const mappings = compute.findResources('AWS::Lambda::EventSourceMapping') as Record<
      string,
      { Properties: { FunctionName: unknown; BatchSize?: number; EventSourceArn: unknown } }
    >;
    const syncLogicalId = Object.entries(compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>).find(
      ([, fn]) => fn.Properties.FunctionName === 'atmark-billing-sync',
    )?.[0];
    const mapping = Object.values(mappings).find((m) => JSON.stringify(m.Properties.FunctionName).includes(`"${String(syncLogicalId)}"`));
    expect(mapping?.Properties.BatchSize).toBe(1);
    expect(JSON.stringify(mapping?.Properties.EventSourceArn)).toMatch(/BillingEventsQueue/);
    expect(RESERVED_CONCURRENCY['billing-sync']).toBe(1);
    const queues = runtimeStackTemplate('billing').findResources('AWS::SQS::Queue') as Record<
      string,
      { Properties: { QueueName: string; VisibilityTimeout?: number; FifoQueue?: boolean } }
    >;
    const queue = Object.values(queues).find((q) => q.Properties.QueueName === BILLING_QUEUE_NAME);
    expect(queue?.Properties.FifoQueue).toBe(true);
    expect(queue?.Properties.VisibilityTimeout).toBe(BILLING_QUEUE_VISIBILITY_SECONDS);
    expect(BILLING_QUEUE_VISIBILITY_SECONDS).toBeGreaterThanOrEqual(6 * BILLING_SYNC_TIMEOUT_SECONDS);
  });

  it('reconcile: Scheduler 15분 · 입력 {"action":"reconcile"} · 재시도 0 · 표적 = billing-sync', () => {
    const schedules = runtimeTemplates().compute.findResources('AWS::Scheduler::Schedule') as Record<
      string,
      { Properties: { Name: string; ScheduleExpression: string; Target: { Arn: unknown; Input?: string; RetryPolicy: { MaximumRetryAttempts: number } } } }
    >;
    const reconcile = Object.values(schedules).find((s) => s.Properties.Name === 'atmark-billing-reconcile');
    expect(reconcile?.Properties.ScheduleExpression).toBe(`rate(${String(BILLING_RECONCILE_MINUTES)} minutes)`);
    expect(BILLING_RECONCILE_MINUTES).toBe(15);
    expect(JSON.parse(reconcile?.Properties.Target.Input ?? '{}')).toEqual({ action: 'reconcile' });
    expect(reconcile?.Properties.Target.RetryPolicy.MaximumRetryAttempts).toBe(0);
    expect(JSON.stringify(reconcile?.Properties.Target.Arn)).toMatch(/BillingSyncFunction/);
  });

  it('billing-sync 의 Lambda 비동기 재시도는 0 이다(코드 L-6) — 던진 reconcile 을 Lambda 가 다시 부르지 않는다 · 다음 틱이 잇는다', () => {
    const compute = runtimeTemplates().compute;
    const configs = Object.values(
      compute.findResources('AWS::Lambda::EventInvokeConfig') as Record<string, { Properties: { FunctionName: unknown; MaximumRetryAttempts?: number } }>,
    );
    const syncLogicalId = Object.entries(compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>).find(
      ([, fn]) => fn.Properties.FunctionName === 'atmark-billing-sync',
    )?.[0];
    const sync = configs.filter((c) => JSON.stringify(c.Properties.FunctionName).includes(`"${String(syncLogicalId)}"`));
    expect(sync).toHaveLength(1);
    expect(sync[0]?.Properties.MaximumRetryAttempts).toBe(0);
  });

  it('login-mailer 틱은 입력 {"source":"atmark.schedule"}(런타임 상수와 같은 값) · 재시도 0 — 핸들러는 모르는 입력을 던진다', () => {
    const schedules = runtimeTemplates().compute.findResources('AWS::Scheduler::Schedule') as Record<
      string,
      { Properties: { Name: string; Target: { Arn: unknown; Input?: string; RetryPolicy: { MaximumRetryAttempts: number } } } }
    >;
    const tick = Object.values(schedules).find((s) => s.Properties.Name === 'atmark-login-mailer');
    expect(LOGIN_MAILER_TICK_INPUT).toEqual({ source: LOGIN_MAILER_EVENT_SOURCE.tick });
    expect(JSON.parse(tick?.Properties.Target.Input ?? 'null')).toEqual({ source: LOGIN_MAILER_EVENT_SOURCE.tick });
    expect(tick?.Properties.Target.RetryPolicy.MaximumRetryAttempts).toBe(0);
    expect(JSON.stringify(tick?.Properties.Target.Arn)).toMatch(/LoginMailerFunction/);
  });

  it('login-mailer 의 Lambda 비동기 호출(틱·깨우기): 함수 오류 재시도 0 · 최대 이벤트 나이 60초(스로틀된 깨우기는 1분 안에서만)', () => {
    const compute = runtimeTemplates().compute;
    const configs = Object.values(
      compute.findResources('AWS::Lambda::EventInvokeConfig') as Record<
        string,
        { Properties: { FunctionName: unknown; MaximumRetryAttempts?: number; MaximumEventAgeInSeconds?: number } }
      >,
    );
    const mailerId = Object.entries(compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>).find(
      ([, fn]) => fn.Properties.FunctionName === 'atmark-login-mailer',
    )?.[0];
    const mailer = configs.filter((c) => JSON.stringify(c.Properties.FunctionName).includes(`"${String(mailerId)}"`));
    expect(mailer).toHaveLength(1);
    expect(mailer[0]?.Properties.MaximumRetryAttempts).toBe(0);
    expect(mailer[0]?.Properties.MaximumEventAgeInSeconds).toBe(60);
  });

  it('결제 웹훅 HTTP API: 스로틀 10/20 · execute-api 엔드포인트가 입구(BillingWebhookUrl 출력) · 액세스 로그는 경로만', () => {
    const compute = runtimeTemplates().compute;
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }>;
    const [billingApiId, billingApi] = Object.entries(apis).find(([, api]) => api.Properties.Name === 'atmark-billing') ?? [];
    expect(billingApi?.Properties.DisableExecuteApiEndpoint).not.toBe(true);
    const stages = compute.findResources('AWS::ApiGatewayV2::Stage') as Record<
      string,
      { Properties: { ApiId: unknown; DefaultRouteSettings?: Record<string, number>; AccessLogSettings?: { Format: string } } }
    >;
    const stage = Object.values(stages).find((s) => JSON.stringify(s.Properties.ApiId).includes(`"${String(billingApiId)}"`));
    expect(stage?.Properties.DefaultRouteSettings).toMatchObject({
      ThrottlingRateLimit: BILLING_WEBHOOK_THROTTLE.rateLimit,
      ThrottlingBurstLimit: BILLING_WEBHOOK_THROTTLE.burstLimit,
    });
    const format = stage?.Properties.AccessLogSettings?.Format ?? '';
    expect(format).toMatch(/\$context\.path/);
    expect(format).not.toMatch(/header|requestOverride|body|querystring/i);
    const outputs = compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['BillingWebhookUrl']?.Value)).toContain('/paddle/webhook');
  });

  it('migrate 는 결제 DB 비밀 둘의 위치(SSM 이름)를 받고 쓸 수 있다(bootstrap-roles)', () => {
    const migrate = functionsByName(runtimeTemplates().compute).get('atmark-migrate');
    expect(migrate?.Environment.Variables[RUNTIME_ENV.dbBillingSecretArn]).toBe(`/${DB_BILLING_SECRET_NAME}`);
    expect(migrate?.Environment.Variables[RUNTIME_ENV.dbBillingOperatorSecretArn]).toBe(`/${DB_BILLING_OPERATOR_SECRET_NAME}`);
    const statements = [...statementsByRole(runtimeTemplates().compute).values()].flat();
    expect(statements.some((s) => writesSsmSecret(s, DB_BILLING_SECRET_NAME))).toBe(true);
    expect(statements.some((s) => writesSsmSecret(s, DB_BILLING_OPERATOR_SECRET_NAME))).toBe(true);
    // 옛 Secrets Manager 자리에는 아무도 쓰지 않는다.
    expect(statements.some((s) => actionsOf(s).includes('secretsmanager:PutSecretValue'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 운영자 콘솔 ops.atmark.ai(ADR-0015 · `.omc/plans/ops-console.md` §3.1) — λ · 역할 · HTTP API · 스로틀 · 입구 · 하드 잠금
// ---------------------------------------------------------------------------

describe('운영자 콘솔 — ops λ · 역할 atmark-runtime-ops(SES·S3·KMS 0)', () => {
  const opsFn = (): FunctionResource['Properties'] => {
    const fn = functionsByName(runtimeTemplates().compute).get(OPS_FUNCTION_NAME);
    if (fn === undefined) throw new Error(`${OPS_FUNCTION_NAME} 가 없다`);
    return fn;
  };
  const opsRoleId = (): string => opsFn().Role['Fn::GetAtt'][0];
  const opsStatements = (): IamStatement[] => statementsByRole(runtimeTemplates().compute).get(opsRoleId()) ?? [];
  const resourcesOf = (statement: IamStatement): string => JSON.stringify(statement.Resource);

  it('함수: 이름 = 계약 · VPC 안 · 256MB · 10초 · 예약 = OPS_RESERVED_CONCURRENCY', () => {
    const fn = opsFn();
    expect(fn.VpcConfig).toBeDefined();
    expect(fn.MemorySize).toBe(256);
    expect(fn.Timeout).toBe(10);
    const raw = Object.values(runtimeTemplates().compute.findResources('AWS::Lambda::Function')) as {
      Properties: { FunctionName: string; ReservedConcurrentExecutions: number };
    }[];
    expect(raw.find((f) => f.Properties.FunctionName === OPS_FUNCTION_NAME)?.Properties.ReservedConcurrentExecutions).toBe(OPS_RESERVED_CONCURRENCY);
  });

  it('환경은 정확히 여섯: 운영 가드 · 자기 DB 비밀 · ops 키 · login-mailer 깨우기 · TLS 둘 — 앱·소유자 DB·로그인 키·버킷·CMK 없음', () => {
    expect(Object.keys(opsFn().Environment.Variables).sort()).toEqual(
      ['ATMARK_ENV', OPS_ENV.dbSecretArn, OPS_ENV.opsKeysSecretArn, OPS_ENV.loginMailerFunctionArn, 'NODE_EXTRA_CA_CERTS', 'PGSSLMODE'].sort(),
    );
    expect(OPS_ENV.opsLoginKeysSecretArn in opsFn().Environment.Variables).toBe(false);
  });

  it('역할 이름은 atmark-runtime-ops · 발송 역할·로그인 메일 역할이 아니다 · 관리형은 Basic·VPC 둘(로그·ENI)', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string; ManagedPolicyArns?: unknown[] } }>;
    expect(roles[opsRoleId()]?.Properties.RoleName).toBe('atmark-runtime-ops');
    expect(opsRoleId()).not.toBe(SENDER_ROLE_LOGICAL_ID);
    expect(opsRoleId()).not.toBe(LOGIN_MAILER_ROLE_LOGICAL_ID);
    const managed = (roles[opsRoleId()]?.Properties.ManagedPolicyArns ?? []).map((arn) => /policy\/([^"]+)"/.exec(JSON.stringify(arn))?.[1]).sort();
    expect(managed).toEqual(['service-role/AWSLambdaBasicExecutionRole', 'service-role/AWSLambdaVPCAccessExecutionRole']);
  });

  it('★ 역할의 액션 전부: SSM GetParameter(자기 DB 비밀 · ops 키 둘) + 그 둘의 SSM 경유 Decrypt + login-mailer InvokeFunction(ARN 하나) — SES·S3·로그인 키 0', () => {
    const statements = opsStatements();
    expect([...new Set(statements.flatMap(actionsOf))].sort()).toEqual(['kms:Decrypt', 'lambda:InvokeFunction', 'ssm:GetParameter']);
    const reads = statements.filter((s) => actionsOf(s).includes('ssm:GetParameter'));
    expect(reads).toHaveLength(2);
    expect(reads.some((s) => readsSsmSecret(s, OPS_SECRET_NAMES.db))).toBe(true);
    expect(reads.some((s) => readsSsmSecret(s, OPS_SECRET_NAMES.opsKeys))).toBe(true);
    for (const name of SSM_SECRET_NAMES.filter((n) => n !== OPS_SECRET_NAMES.db && n !== OPS_SECRET_NAMES.opsKeys)) {
      expect(reads.some((s) => readsSsmSecret(s, name)), name).toBe(false);
    }
    // KMS 는 SSM 경유 Decrypt 뿐(그 두 파라미터의 문맥) — 서명·키 생성 0.
    for (const s of statements.filter((x) => actionsOf(x).some((a) => a.startsWith('kms:')))) {
      expect(actionsOf(s)).toEqual(['kms:Decrypt']);
      expect(JSON.stringify(s.Condition)).toMatch(/ssm\.ap-northeast-2\.amazonaws\.com/);
    }
    const functions = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    const mailerId = Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === 'atmark-login-mailer')?.[0];
    const invoke = statements.filter((s) => actionsOf(s).includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    expect(invoke[0]?.Condition).toBeUndefined();
    expect(invoke[0]?.Resource).toEqual({ 'Fn::GetAtt': [mailerId, 'Arn'] });
    for (const action of statements.flatMap(actionsOf)) expect(action).not.toMatch(/^(ses|sesv2|s3|secretsmanager):|^\*$/);
  });

  it('비밀마다 읽는 역할: ops 키 = ops 하나 · 운영자 코드 키 = login-mailer 하나(결정 C2) · ops DB 비밀 = ops(+ migrate 쓰기)', () => {
    const byRole = statementsByRole(runtimeTemplates().compute);
    const readers = (name: string): string[] =>
      [...byRole]
        .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, name)))
        .map(([role]) => role)
        .sort();
    const migrateRole = functionsByName(runtimeTemplates().compute).get('atmark-migrate')?.Role['Fn::GetAtt'][0];
    expect(readers(OPS_SECRET_NAMES.opsKeys)).toEqual([opsRoleId()]);
    expect(readers(OPS_SECRET_NAMES.loginKeys)).toEqual([LOGIN_MAILER_ROLE_LOGICAL_ID]);
    expect(readers(OPS_SECRET_NAMES.db)).toEqual([opsRoleId(), migrateRole].sort());
    expect((byRole.get(migrateRole ?? '') ?? []).some((s) => writesSsmSecret(s, OPS_SECRET_NAMES.db))).toBe(true);
    expect(OPS_SECRET_NAMES.db).toBe('atmark/db/ops');
  });
});

describe('운영자 콘솔 — HTTP API atmark-ops · 스로틀 · 입구', () => {
  interface StageResource {
    DependsOn?: string[];
    Properties: {
      ApiId: unknown;
      DefaultRouteSettings?: { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number };
      RouteSettings?: Record<string, { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number }>;
      AccessLogSettings?: { Format?: string };
    };
  }
  const opsApi = (template: Template): [string, { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }] => {
    const apis = template.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }>;
    const found = Object.entries(apis).find(([, api]) => api.Properties.Name === 'atmark-ops');
    if (found === undefined) throw new Error('atmark-ops API 가 없다');
    return found;
  };
  const opsStage = (template: Template): StageResource => {
    const [apiId] = opsApi(template);
    const stages = template.findResources('AWS::ApiGatewayV2::Stage') as Record<string, StageResource>;
    const stage = Object.values(stages).find((candidate) => JSON.stringify(candidate.Properties.ApiId).includes(`"${apiId}"`));
    if (stage === undefined) throw new Error('atmark-ops 스테이지가 없다');
    return stage;
  };

  it('스로틀: $default 10/20 · 인증 라우트 넷(OPS_ROUTES) 버킷 따로(요청 1/5 · 검증 3/10 — H12) — 라우트가 스테이지보다 먼저', () => {
    const compute = runtimeTemplates().compute;
    const stage = opsStage(compute);
    expect(OPS_DEFAULT_THROTTLE).toEqual({ rateLimit: 10, burstLimit: 20 });
    expect(stage.Properties.DefaultRouteSettings).toMatchObject({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 });
    expect(stage.Properties.RouteSettings).toEqual({
      // 코드 메일을 만드는 요청 둘은 1/5(메일 총량의 바닥) · 검증 둘은 3/10(H12 — 요청자별 거절은 DB `ops_login_attempts`).
      'POST /api/auth/request': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      'POST /api/auth/verify': { ThrottlingRateLimit: 3, ThrottlingBurstLimit: 10 },
      'POST /api/auth/step-up': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      'POST /api/auth/step-up/verify': { ThrottlingRateLimit: 3, ThrottlingBurstLimit: 10 },
    });
    // 인증 라우트는 모두 $default 보다 좁다 — 로그인 홍수가 세션 API 버킷을 넘보지 못한다.
    for (const [routeKey, limit] of Object.entries(OPS_ROUTE_THROTTLES)) {
      expect(limit.rateLimit, routeKey).toBeLessThan(OPS_DEFAULT_THROTTLE.rateLimit);
      expect(limit.burstLimit, routeKey).toBeLessThan(OPS_DEFAULT_THROTTLE.burstLimit);
    }
    expect(Object.keys(OPS_ROUTE_THROTTLES).sort()).toEqual(Object.values(OPS_ROUTES).map((path) => `POST ${path}`).sort());
    const [apiId] = opsApi(compute);
    const routes = compute.findResources('AWS::ApiGatewayV2::Route') as Record<string, { Properties: { ApiId: unknown } }>;
    const routeIds = Object.entries(routes)
      .filter(([, route]) => JSON.stringify(route.Properties.ApiId).includes(`"${apiId}"`))
      .map(([id]) => id);
    expect(routeIds).toHaveLength(5);
    expect(stage.DependsOn ?? []).toEqual(expect.arrayContaining(routeIds));
  });

  it('접근 로그: 경로·상태만 — IP·쿼리·UA 없음(운영자 위치는 PII)', () => {
    const format = opsStage(runtimeTemplates().compute).Properties.AccessLogSettings?.Format ?? '';
    expect(format).toMatch(/\$context\.path/);
    expect(format).not.toMatch(/sourceIp|userAgent|querystring|\bip\b/i);
    runtimeTemplates().compute.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/atmark/ops-access', RetentionInDays: 90 });
  });

  it('도메인 없이(기본 · 롤아웃 §5 2단계) 합성된다: execute-api 기본 엔드포인트가 입구 · ops 도메인·CNAME 출력 없음 · OpsUrl = execute-api', () => {
    const compute = runtimeTemplates().compute;
    const [, api] = opsApi(compute);
    expect(api.Properties.DisableExecuteApiEndpoint).not.toBe(true);
    const domains = compute.findResources('AWS::ApiGatewayV2::DomainName') as Record<string, { Properties: { DomainName: string } }>;
    expect(Object.values(domains).map((d) => d.Properties.DomainName)).not.toContain(OPS_DOMAIN_NAME);
    const outputs = compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs['OpsCustomDomainCnameTarget']).toBeUndefined();
    expect(JSON.stringify(outputs['OpsUrl']?.Value)).toMatch(/OpsHttpApi[^"]*","ApiEndpoint/);
  });

  it('opsDomain(인증서 발급 뒤 · atmark:opsDomainReady) 이면 ops.atmark.ai 커스텀 도메인 + execute-api 끔 + CNAME 출력 · 다른 API 는 그대로', () => {
    const compute = Template.fromStack(buildRuntimeApp({ kind: 'stub' }, { opsDomain: true }).compute);
    const [apiId, api] = opsApi(compute);
    expect(api.Properties.DisableExecuteApiEndpoint).toBe(true);
    compute.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: OPS_DOMAIN_NAME });
    compute.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 3);
    const mappings = compute.findResources('AWS::ApiGatewayV2::ApiMapping') as Record<string, { Properties: { ApiId: unknown } }>;
    expect(Object.values(mappings).some((m) => JSON.stringify(m.Properties.ApiId).includes(`"${apiId}"`))).toBe(true);
    const outputs = compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs['OpsUrl']?.Value).toBe(`https://${OPS_DOMAIN_NAME}`);
    expect(outputs['OpsCustomDomainCnameTarget']).toBeDefined();
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Record<string, { Properties: { Name: string; DisableExecuteApiEndpoint?: boolean } }>;
    const byName = new Map(Object.values(apis).map((a) => [a.Properties.Name, a.Properties.DisableExecuteApiEndpoint]));
    expect(byName.get('atmark-api')).not.toBe(true);
    expect(byName.get('atmark-console')).toBe(true);
  });
});

describe('운영자 콘솔 — 하드 킬 스위치 atmark:opsLocked', () => {
  it('opsLocked=true 로 합성하면 ops 의 예약 동시성은 0 · 다른 함수는 그대로(연결 70 − 2 = 68)', () => {
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [OPS_LOCKED_CONTEXT_KEY]: 'true' }));
    try {
      expect(OPS_LOCKED_CONTEXT_KEY).toBe('atmark:opsLocked');
      const locked = Template.fromStack(buildRuntimeApp().compute);
      const reserved = (template: Template): Map<string, number> =>
        new Map(
          (Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; ReservedConcurrentExecutions: number } }[]).map(
            (fn) => [fn.Properties.FunctionName, fn.Properties.ReservedConcurrentExecutions],
          ),
        );
      const lockedReserved = reserved(locked);
      const normal = reserved(runtimeTemplates().compute);
      expect(lockedReserved.get(OPS_FUNCTION_NAME)).toBe(0);
      expect(normal.get(OPS_FUNCTION_NAME)).toBe(OPS_RESERVED_CONCURRENCY);
      for (const [name, value] of normal) if (name !== OPS_FUNCTION_NAME) expect(lockedReserved.get(name), name).toBe(value);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('opsLocked 가 "true" 가 아니면(오타·거짓) 잠그지 않는다 — 잠금의 본체는 hard_locked·NOLOGIN 이다', () => {
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [OPS_LOCKED_CONTEXT_KEY]: 'yes' }));
    try {
      const template = Template.fromStack(buildRuntimeApp().compute);
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; ReservedConcurrentExecutions: number } }[];
      expect(fns.find((fn) => fn.Properties.FunctionName === OPS_FUNCTION_NAME)?.Properties.ReservedConcurrentExecutions).toBe(OPS_RESERVED_CONCURRENCY);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('운영자 콘솔 — 플래그는 컨텍스트 ?? 기본 상수 (CR-M3: 플래그를 빠뜨린 배포가 도메인을 지우거나 잠금을 풀지 않게)', () => {
  const node = (value: unknown): { tryGetContext(key: string): unknown } => ({ tryGetContext: () => value });

  it('기본 상수: 지금은 둘 다 거짓 — 도메인을 붙인 배포 뒤 OPS_DOMAIN_READY_DEFAULT 를 true 로 커밋하면 이 단언도 함께 고친다(deploy §24-2 6′)', () => {
    expect(OPS_DOMAIN_READY_CONTEXT_KEY).toBe('atmark:opsDomainReady');
    expect(OPS_DOMAIN_READY_DEFAULT).toBe(true);
    expect(OPS_LOCKED_DEFAULT).toBe(false);
  });

  it('컨텍스트가 없으면 기본 상수 · 있으면 문자열 "true" 만 켠다(오타는 켜지 않는다) · "false" 는 기본을 덮는다', () => {
    // 같은 규칙의 다른 스위치(결제 · 도메인 확인 틱 · 실시간 도메인)도 여기서 함께 본다.
    for (const [read, fallback] of [
      [opsDomainReadyOf, OPS_DOMAIN_READY_DEFAULT],
      [opsLockedOf, OPS_LOCKED_DEFAULT],
      [billingEnabledOf, BILLING_ENABLED_DEFAULT],
      [domainRecheckEnabledOf, DOMAIN_RECHECK_ENABLED_DEFAULT],
      [realtimeDomainReadyOf, REALTIME_DOMAIN_READY_DEFAULT],
    ] as const) {
      expect(read(node(undefined))).toBe(fallback);
      expect(read(node('true'))).toBe(true);
      expect(read(node(true))).toBe(true);
      expect(read(node('false'))).toBe(false);
      expect(read(node('yes'))).toBe(false);
    }
  });

  it('합성 가드: 도메인 없이 합성하면 경고 atmark:ops-domain-absent · 도메인이 있으면 경고 없음', () => {
    const without = Annotations.fromStack(buildRuntimeApp().compute);
    without.hasWarning('*', Match.stringLikeRegexp('ops\\.atmark\\.ai 가 이미 붙어 있다면'));
    const withDomain = Annotations.fromStack(buildRuntimeApp({ kind: 'stub' }, { opsDomain: true }).compute);
    withDomain.hasNoWarning('*', Match.stringLikeRegexp('ops\\.atmark\\.ai 가 이미 붙어 있다면'));
  });
});

// ---------------------------------------------------------------------------
// 문의 라우팅 · 환영 메일 스위치 · 발송 역할 정책 크기 (2026-09-30)
// ---------------------------------------------------------------------------

/** 발송 역할 인라인 정책 합계(공백 없는 JSON) — 내재 함수(`Ref`·`Fn::*`)는 ARN 길이(90자)로 친다(ADR-0006 M3 "크기" 와 같은 근사). */
function senderPolicyChars(template: Template): number {
  const policies = template.findResources('AWS::IAM::Policy') as Record<string, { Properties: { Roles: { Ref: string }[]; PolicyDocument: unknown } }>;
  const approximate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(approximate);
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value);
      if (keys.length === 1 && (keys[0] === 'Ref' || keys[0]?.startsWith('Fn::') === true)) return 'x'.repeat(90);
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, approximate(inner)]));
    }
    return value;
  };
  return Object.values(policies)
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === SENDER_ROLE_LOGICAL_ID))
    .reduce((sum, policy) => sum + JSON.stringify(approximate(policy.Properties.PolicyDocument)).length, 0);
}

function envOf(template: Template, functionName: string): Record<string, unknown> {
  return functionsByName(template).get(functionName)?.Environment.Variables ?? {};
}

describe('문의 라우팅 atmark:contactRouting (2026-09-30)', () => {
  it('기본 agent_and_notify(2026-10-04 굳힘 — 운영 배포값) — inbound·contact-forwarder 환경이 그 값 · 발송 역할에 support@ Deny 가 없다 · 다른 함수는 이 변수를 모른다', () => {
    expect(CONTACT_ROUTING_CONTEXT_KEY).toBe('atmark:contactRouting');
    expect(CONTACT_ROUTING_DEFAULT).toBe('agent_and_notify');
    const compute = runtimeTemplates().compute;
    expect(envOf(compute, 'atmark-inbound')[CONTACT_ROUTING_ENV]).toBe('agent_and_notify');
    expect(envOf(compute, 'atmark-contact-forwarder')[CONTACT_ROUTING_ENV]).toBe('agent_and_notify');
    for (const [name, props] of functionsByName(compute)) {
      if (name === 'atmark-inbound' || name === 'atmark-contact-forwarder') continue;
      expect(props.Environment.Variables[CONTACT_ROUTING_ENV], name).toBeUndefined();
    }
    const sids = (statementsByRole(compute).get(SENDER_ROLE_LOGICAL_ID) ?? []).map((statement) => statement.Sid);
    expect(sids).not.toContain('SesDenySupportFromOutsideForwarder');
  });

  it('forward(명시) — inbound·contact-forwarder 환경 forward · 발송 역할에 support@ Deny 가 있다 · 다른 함수는 이 변수를 모른다', () => {
    const compute = forwardRoutingCompute();
    expect(envOf(compute, 'atmark-inbound')[CONTACT_ROUTING_ENV]).toBe('forward');
    expect(envOf(compute, 'atmark-contact-forwarder')[CONTACT_ROUTING_ENV]).toBe('forward');
    for (const [name, props] of functionsByName(compute)) {
      if (name === 'atmark-inbound' || name === 'atmark-contact-forwarder') continue;
      expect(props.Environment.Variables[CONTACT_ROUTING_ENV], name).toBeUndefined();
    }
    const sids = (statementsByRole(compute).get(SENDER_ROLE_LOGICAL_ID) ?? []).map((statement) => statement.Sid);
    expect(sids).toContain('SesDenySupportFromOutsideForwarder');
  });

  it.each(['agent_and_forward', 'agent_and_notify', 'agent'] as const)('%s — support@ Deny 가 없다 · 나머지 Deny(login@·정규형 밖·예약 접미사)는 그대로 · 두 함수 환경이 그 값', (mode) => {
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [CONTACT_ROUTING_CONTEXT_KEY]: mode }));
    try {
      const compute = Template.fromStack(buildRuntimeApp().compute);
      const statements = statementsByRole(compute).get(SENDER_ROLE_LOGICAL_ID) ?? [];
      const denies = statements.filter((statement) => statement.Effect === 'Deny').map((statement) => statement.Sid ?? '(sid 없음)');
      expect(denies).toEqual(['SesDenyLoginFromAddress', 'SesDenyReceiveOnlyFromAddress', 'SesDenyNonCanonicalFromAddress', 'SesDenyReservedSuffixFromAddress']);
      // support@ 정확 일치 Deny 가 어디에도 없다(예약 접미사 Deny 의 `*?support@` — 앞 글자 변형 — 는 남는다).
      expect(statements.filter((statement) => JSON.stringify(statement.Condition ?? {}).includes('"support@atmark.ai"'))).toEqual([]);
      expect(envOf(compute, 'atmark-inbound')[CONTACT_ROUTING_ENV]).toBe(mode);
      expect(envOf(compute, 'atmark-contact-forwarder')[CONTACT_ROUTING_ENV]).toBe(mode);
      // 발송 역할 인라인 정책 합계는 상한(10,240) 아래 — Deny 하나가 빠지므로 `forward` 보다 작다.
      expect(senderPolicyChars(compute)).toBeLessThan(senderPolicyChars(forwardRoutingCompute()));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it('틀린 값은 합성을 멈춘다(런타임은 forward 로 읽지만 배포 전에 잡는다)', () => {
    const nodeWith = (context: Record<string, unknown>): cdk.App['node'] => new cdk.App({ context }).node;
    expect(contactRoutingOf(nodeWith({}))).toBe('agent_and_notify');
    expect(contactRoutingOf(nodeWith({ [CONTACT_ROUTING_CONTEXT_KEY]: 'forward' }))).toBe('forward');
    expect(contactRoutingOf(nodeWith({ [CONTACT_ROUTING_CONTEXT_KEY]: 'agent' }))).toBe('agent');
    for (const bad of ['AGENT', 'agent-and-forward', 'true', '']) {
      expect(() => contactRoutingOf(nodeWith({ [CONTACT_ROUTING_CONTEXT_KEY]: bad })), bad).toThrow(/atmark:contactRouting/);
    }
  });
});

describe('환영 메일 스위치 atmark:welcomeMailEnabled (W2 — login-mailer 만)', () => {
  it("기본 'true'(2026-09-30 켬 — deploy §30-4) · login-mailer 환경에만 있다", () => {
    expect(WELCOME_MAIL_ENABLED_CONTEXT_KEY).toBe('atmark:welcomeMailEnabled');
    expect(WELCOME_MAIL_ENABLED_DEFAULT).toBe(true);
    const compute = runtimeTemplates().compute;
    for (const [name, props] of functionsByName(compute)) {
      expect(props.Environment.Variables['ATMARK_WELCOME_MAIL_ENABLED'], name).toBe(name === 'atmark-login-mailer' ? 'true' : undefined);
    }
  });

  it("컨텍스트 true 면 'true' · 다른 값이면 'false'", () => {
    try {
      vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [WELCOME_MAIL_ENABLED_CONTEXT_KEY]: 'true' }));
      expect(envOf(Template.fromStack(buildRuntimeApp().compute), 'atmark-login-mailer')['ATMARK_WELCOME_MAIL_ENABLED']).toBe('true');
      vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [WELCOME_MAIL_ENABLED_CONTEXT_KEY]: 'yes' }));
      expect(envOf(Template.fromStack(buildRuntimeApp().compute), 'atmark-login-mailer')['ATMARK_WELCOME_MAIL_ENABLED']).toBe('false');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});

describe('발송 역할 인라인 정책 크기 (ADR-0006 M3 — 예약 주소 셋)', () => {
  it('기본(forward) 합성의 발송 역할 인라인 정책 합계가 10,240자(역할 인라인 정책 합계 상한) 아래다', () => {
    const chars = senderPolicyChars(runtimeTemplates().compute);
    expect(chars).toBeGreaterThan(1000);
    expect(chars).toBeLessThan(10_240);
  });
});

// ---------------------------------------------------------------------------
// 고객 도메인(ADR-0014 단계 2) — domain-control λ · 역할 · 비발송 Deny · 틱 롤 비밀 · 확인 틱 스케줄(DISABLED)
// ---------------------------------------------------------------------------

describe('고객 도메인 — domain-control λ · 역할(ADR-0014 결정 3·4 · 계획 §3.5)', () => {
  const compute = (): Template => runtimeTemplates().compute;
  const roleIdByName = (roleName: string): string => {
    const roles = compute().findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    return Object.entries(roles).find(([, role]) => role.Properties.RoleName === roleName)?.[0] ?? '';
  };
  const functionIdOf = (name: string): string => {
    const functions = compute().findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>;
    return Object.entries(functions).find(([, fn]) => fn.Properties.FunctionName === name)?.[0] ?? '';
  };

  it('λ: VPC 밖 · 256MB · 12초(호출 상한 10초보다 길게) · 예약 2 · 환경은 운영 가드 · 발송 역할 ARN · 구성 세트뿐(DB·비밀·버킷 없음)', () => {
    const fn = functionsByName(compute()).get('atmark-domain-control');
    expect(fn?.VpcConfig).toBeUndefined();
    expect(fn?.MemorySize).toBe(256);
    expect(fn?.Timeout).toBe(12);
    expect(Object.keys(fn?.Environment.Variables ?? {}).sort()).toEqual([RUNTIME_ENV.sesConfigurationSet, RUNTIME_ENV.environment, RUNTIME_ENV.senderRoleArn].sort());
    // Principal 은 배포 환경변수 — 발송 역할의 ARN 그 자체(입력에서 오지 않는다).
    expect(fn?.Environment.Variables[RUNTIME_ENV.senderRoleArn]).toEqual({ 'Fn::GetAtt': [SENDER_ROLE_LOGICAL_ID, 'Arn'] });
    expect(fn?.Environment.Variables[RUNTIME_ENV.sesConfigurationSet]).toBe('atmark-default');
    expect(fn?.Role['Fn::GetAtt'][0]).toBe(roleIdByName(DOMAIN_CONTROL_ROLE_NAME));
    const reserved = (compute().findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string; ReservedConcurrentExecutions?: number } }>)[
      functionIdOf('atmark-domain-control')
    ]?.Properties.ReservedConcurrentExecutions;
    expect(reserved).toBe(2);
    expect(DOMAIN_CONTROL_HANDLER).toBe('domain-control');
    expect(LAMBDA_HANDLERS).toContain(DOMAIN_CONTROL_HANDLER);
  });

  it('역할: 관리형 정책 0 · 변형은 관리 태그로 묶인다(보안 리뷰 M1) — 읽기 · 관리 identity 변형 · 구성 세트 붙이기 · 만들기(요청 태그 필수) · 재태그(atmark:row 하나) · Deny 셋', () => {
    const roleId = roleIdByName(DOMAIN_CONTROL_ROLE_NAME);
    const roles = compute().findResources('AWS::IAM::Role') as Record<string, { Properties: { ManagedPolicyArns?: unknown[] } }>;
    expect(roles[roleId]?.Properties.ManagedPolicyArns ?? []).toEqual([]);
    const statements = allStatementsByRole(compute()).get(roleId) ?? [];
    const bySid = new Map(statements.map((s) => [s.Sid, s]));
    expect([...bySid.keys()].sort()).toEqual(
      [
        'OwnLogGroupWrite',
        'SesAttachDefaultConfigurationSet',
        'SesDenyManagedTagRelabel',
        'SesDenyManagedTagRemove',
        'SesDenyPlatformAndAddressIdentities',
        'SesDenyPlatformTagged',
        'SesIdentityRead',
        'SesManagedIdentityCreate',
        'SesManagedIdentityMutate',
        'SesManagedIdentityRetag',
        'SesManagedIdentityTagOnCreate',
        'SesSendDenyNonSendingRole',
        // 2026-10-12 — 스택의 모든 역할에 SSM 파라미터 삭제 Deny(`ssm-secrets.ts`).
        'SsmParameterDeleteDeny',
      ].sort(),
    );
    const managed = { 'aws:ResourceTag/atmark:managed': 'customer-domain' };
    // 읽기만 태그 조건이 없다(태그를 대조하려면 먼저 읽는다).
    expect(bySid.get('SesIdentityRead')).toMatchObject({ Effect: 'Allow', Action: 'ses:GetEmailIdentity', Resource: 'arn:aws:ses:ap-northeast-2:123456789012:identity/*' });
    expect(bySid.get('SesIdentityRead')?.Condition).toBeUndefined();
    const mutate = bySid.get('SesManagedIdentityMutate');
    expect(actionsOf(mutate as IamStatement).sort()).toEqual(
      [
        'ses:CreateEmailIdentityPolicy',
        'ses:DeleteEmailIdentity',
        'ses:DeleteEmailIdentityPolicy',
        'ses:PutEmailIdentityConfigurationSetAttributes',
        'ses:PutEmailIdentityMailFromAttributes',
        'ses:UpdateEmailIdentityPolicy',
      ].sort(),
    );
    expect(mutate?.Resource).toBe('arn:aws:ses:ap-northeast-2:123456789012:identity/*');
    // ★ 태그 없는 identity(플랫폼 atmark.ai · 수동 · 스파이크)는 이름·대소문자와 무관하게 바꿀 수 없다.
    expect(mutate?.Condition).toEqual({ StringEquals: managed });
    expect(bySid.get('SesAttachDefaultConfigurationSet')).toMatchObject({
      Action: 'ses:PutEmailIdentityConfigurationSetAttributes',
      Resource: 'arn:aws:ses:ap-northeast-2:123456789012:configuration-set/atmark-default',
    });
    expect(bySid.get('SesManagedIdentityCreate')).toMatchObject({
      Action: 'ses:CreateEmailIdentity',
      Condition: {
        StringEquals: { 'aws:RequestTag/atmark:managed': 'customer-domain' },
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['atmark:row', 'atmark:managed'] },
      },
    });
    expect(bySid.get('SesManagedIdentityRetag')).toMatchObject({
      Action: 'ses:TagResource',
      Condition: { StringEquals: managed, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['atmark:row'] } },
    });
    // ★ 만들 때 태그 붙이기(SES 는 Tags 가 든 CreateEmailIdentity 를 TagResource 로도 판정 — 2026-10-05 운영 AccessDenied) — 만들기와 같은 요청 태그 조건.
    expect(bySid.get('SesManagedIdentityTagOnCreate')).toMatchObject({
      Effect: 'Allow',
      Action: 'ses:TagResource',
      Condition: {
        StringEquals: { 'aws:RequestTag/atmark:managed': 'customer-domain' },
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['atmark:row', 'atmark:managed'] },
      },
    });
    expect(bySid.get('SesDenyManagedTagRemove')).toMatchObject({
      Effect: 'Deny',
      Action: 'ses:UntagResource',
      Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['atmark:managed'] } },
    });
    expect(bySid.get('SesDenyManagedTagRelabel')).toMatchObject({
      Effect: 'Deny',
      Action: ['ses:TagResource', 'ses:CreateEmailIdentity'],
      Condition: {
        Null: { 'aws:RequestTag/atmark:managed': 'false' },
        StringNotEquals: { 'aws:RequestTag/atmark:managed': 'customer-domain' },
      },
    });
    // ★ 플랫폼 표시 태그 Deny — 이름 Deny 를 대소문자로 비켜 가도(SES 는 ATMARK.AI 를 atmark.ai 로 푼다) 태그로 막힌다.
    expect(bySid.get('SesDenyPlatformTagged')).toMatchObject({
      Effect: 'Deny',
      Action: 'ses:*',
      Resource: '*',
      Condition: { StringEquals: { 'aws:ResourceTag/atmark:platform': 'true' } },
    });
    // ★ 관리 표시 키가 든 태그 쓰기를 통째로 막는 Deny 가 돌아오면 만들기가 다시 AccessDenied 다.
    for (const s of statements.filter((x) => x.Effect === 'Deny' && actionsOf(x).includes('ses:TagResource'))) {
      expect(JSON.stringify(s.Condition), s.Sid).toContain('aws:RequestTag/atmark:managed');
    }
    expect([...DOMAIN_IDENTITY_TAG_KEYS]).toEqual(['atmark:row', 'atmark:managed']);
    // ★ 모든 변형·태그 Allow 는 관리 태그(요청 또는 자원) 조건을 갖는다 — 조건 없는 변형 문장이 끼면 빨개진다.
    for (const statement of statements.filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => a.startsWith('ses:') && a !== 'ses:GetEmailIdentity'))) {
      if (statement.Sid === 'SesAttachDefaultConfigurationSet') continue;
      expect(JSON.stringify(statement.Condition), statement.Sid).toMatch(/aws:(Resource|Request)Tag\/atmark:managed/);
    }
    const platform = bySid.get('SesDenyPlatformAndAddressIdentities');
    expect(platform?.Effect).toBe('Deny');
    expect(platform?.Action).toBe('ses:*');
    expect(platform?.Resource).toEqual([
      'arn:aws:ses:*:123456789012:identity/atmark.ai',
      'arn:aws:ses:*:123456789012:identity/*.atmark.ai',
      'arn:aws:ses:*:123456789012:identity/*@*',
    ]);
    expect(bySid.get('SesSendDenyNonSendingRole')).toMatchObject({ Effect: 'Deny', Action: 'ses:Send*', Resource: '*' });
    expect(JSON.stringify(bySid.get('OwnLogGroupWrite')?.Resource)).toMatch(/DomainControlLogs/);
    for (const statement of statements.filter((s) => s.Effect === 'Allow')) {
      for (const action of actionsOf(statement)) expect(action).toMatch(/^(ses:(Get|Create|Delete|Put|Update|Tag)[A-Za-z]+|logs:(CreateLogStream|PutLogEvents))$/);
      for (const action of actionsOf(statement)) expect(action).not.toMatch(/^ses:Send/);
    }
  });

  it('★ 독립 감사 λ(atmark-domain-policy-audit — 보안 리뷰 M2): VPC 밖 · 예약 1 · 환경은 운영 가드·발송 역할 ARN 뿐 · 역할은 SES Get·List 둘 + 로그 + 발송 Deny · 정책 이벤트 규칙(쓰기·지우기) + 12시간 전수', () => {
    const fn = functionsByName(compute()).get('atmark-domain-policy-audit');
    expect(fn?.VpcConfig).toBeUndefined();
    expect(Object.keys(fn?.Environment.Variables ?? {}).sort()).toEqual([RUNTIME_ENV.environment, RUNTIME_ENV.senderRoleArn].sort());
    const roleId = roleIdByName(DOMAIN_POLICY_AUDIT_ROLE_NAME);
    expect(fn?.Role['Fn::GetAtt'][0]).toBe(roleId);
    const statements = allStatementsByRole(compute()).get(roleId) ?? [];
    expect(statements.map((s) => s.Sid).sort()).toEqual([
      'OwnLogGroupWrite',
      'SesIdentityAuditList',
      'SesIdentityAuditRead',
      'SesSendDenyNonSendingRole',
      'SsmParameterDeleteDeny',
    ]);
    const allowed = statements.filter((s) => s.Effect === 'Allow').flatMap(actionsOf).sort();
    expect(allowed).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents', 'ses:GetEmailIdentity', 'ses:ListEmailIdentities']);
    const rules = compute().findResources('AWS::Events::Rule') as Record<string, { Properties: { Name: string; EventPattern: { detail: Record<string, unknown> }; Targets: { Arn: unknown }[] } }>;
    const rule = Object.values(rules).find((r) => r.Properties.Name === DOMAIN_POLICY_AUDIT_RULE_NAME)?.Properties;
    // 쓰기 셋(원문도 본다) + 지우기 둘(재검증 MEDIUM-1 — 만들고 보내고 지우는 짝의 마지막 단계).
    expect(rule?.EventPattern.detail['eventName']).toEqual([
      'CreateEmailIdentityPolicy',
      'UpdateEmailIdentityPolicy',
      'PutIdentityPolicy',
      'DeleteEmailIdentityPolicy',
      'DeleteIdentityPolicy',
    ]);
    expect(JSON.stringify(rule?.Targets[0]?.Arn)).toMatch(/DomainPolicyAuditFunction/);
    const schedules = compute().findResources('AWS::Scheduler::Schedule') as Record<string, { Properties: { Name: string; State?: string; ScheduleExpression: string; Target: { Input?: string } } }>;
    const daily = Object.values(schedules).find((x) => x.Properties.Name === DOMAIN_POLICY_AUDIT_SCHEDULE_NAME)?.Properties;
    expect(daily?.ScheduleExpression).toBe('rate(12 hours)');
    expect(functionsByName(compute()).get('atmark-domain-policy-audit')?.Timeout).toBe(300);
    expect(daily?.State ?? 'ENABLED').toBe('ENABLED');
    expect(JSON.parse(daily?.Target.Input ?? '{}')).toEqual({ source: 'atmark.schedule' });
  });

  it('SES identity 제어면 명령을 가진 역할은 domain-control 하나뿐이다', () => {
    const control = /^ses:(Create|Delete|Put|Update)EmailIdentity|^ses:TagResource$|^ses:UntagResource$|^ses:\*$|^\*$/;
    const holders = [...allStatementsByRole(compute())]
      .filter(([, statements]) => statements.some((s) => s.Effect === 'Allow' && actionsOf(s).some((action) => control.test(action))))
      .map(([role]) => role);
    expect(holders).toEqual([roleIdByName(DOMAIN_CONTROL_ROLE_NAME)]);
  });

  it('★ domain-control 을 부를 수 있는 역할은 admin 하나 — 그 함수 ARN 하나(한정자·와일드카드 없음) · 어떤 역할도 lambda:InvokeFunction 을 * 로 갖지 않는다', () => {
    const target = { 'Fn::GetAtt': [functionIdOf('atmark-domain-control'), 'Arn'] };
    const invokers: string[] = [];
    for (const [role, statements] of allStatementsByRole(compute())) {
      for (const statement of statements.filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => a === 'lambda:InvokeFunction' || a === 'lambda:*' || a === '*'))) {
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        for (const resource of resources) expect(resource, role).not.toBe('*');
        if (resources.some((resource) => JSON.stringify(resource).includes(functionIdOf('atmark-domain-control')))) invokers.push(role);
      }
    }
    expect(invokers).toEqual([roleIdByName('atmark-runtime-admin')]);
    const admin = allStatementsByRole(compute()).get(roleIdByName('atmark-runtime-admin')) ?? [];
    expect(admin.find((s) => s.Sid === 'DomainControlInvoke')?.Resource).toEqual(target);
    expect(envOf(compute(), 'atmark-admin')[RUNTIME_ENV.domainControlFunctionArn]).toEqual(target);
    for (const [name, fn] of functionsByName(compute())) {
      expect(RUNTIME_ENV.domainControlFunctionArn in fn.Environment.Variables, name).toBe(name === 'atmark-admin');
      expect(RUNTIME_ENV.senderRoleArn in fn.Environment.Variables, name).toBe(name === 'atmark-domain-control' || name === 'atmark-domain-policy-audit');
    }
  });
});

describe('고객 도메인 — 비발송 역할 SES 발송 Deny(ADR-0014 결정 4)', () => {
  it('Lambda 가 맡는 역할 중 발송 주체 둘을 뺀 전부에 ses:Send* 명시 Deny(자원 *) — 발송 주체 둘에는 없다', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { AssumeRolePolicyDocument: unknown } }>;
    const lambdaRoles = Object.entries(roles)
      .filter(([, role]) => JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes('lambda.amazonaws.com'))
      .map(([id]) => id);
    // 비공허: 런타임 역할 16개(발송 둘 · domain-control · 독립 감사 · AI 감시 결과 · 실시간 포함)가 실제로 보인다.
    expect(lambdaRoles.length).toBe(16);
    const byRole = allStatementsByRole(runtimeTemplates().compute);
    for (const id of lambdaRoles) {
      const deny = (byRole.get(id) ?? []).find((s) => s.Sid === SES_SEND_DENY_SID);
      if (id === SENDER_ROLE_LOGICAL_ID || id === LOGIN_MAILER_ROLE_LOGICAL_ID) {
        expect(deny, id).toBeUndefined();
        continue;
      }
      expect(deny, id).toMatchObject({ Effect: 'Deny', Action: 'ses:Send*', Resource: '*' });
      expect(deny?.Condition, id).toBeUndefined();
    }
    expect([...SES_SEND_DENY_ACTIONS]).toEqual(['ses:Send*']);
  });
});

describe('고객 도메인 — 틱 롤 비밀(AtmarkCompute 소유) · 확인 틱 스케줄(DISABLED)', () => {
  it('비밀 atmark/db/domain-tick: 이 스택이 자리표시로 만들고(RETAIN) migrate 가 쓴다 · admin·migrate 환경에 위치 · 읽기는 migrate 와 admin(확인 틱 — 단계 4)뿐', () => {
    const compute = runtimeTemplates().compute;
    const secrets = compute.findResources('AWS::SecretsManager::Secret') as Record<string, { Properties: { Name: string; SecretString?: string }; DeletionPolicy?: string }>;
    const entry = Object.entries(secrets).find(([, secret]) => secret.Properties.Name === DOMAIN_TICK_DB_SECRET_NAME);
    expect(entry).toBeDefined();
    const [secretId, secret] = entry ?? ['', undefined];
    expect(secret?.DeletionPolicy).toBe('Retain');
    expect(secret?.Properties.SecretString).toBe(SECRET_PLACEHOLDER_VALUE);
    // 2026-10-12 비밀 → SSM 이전 — 옛 Secrets Manager 자리는 남아 있고(다음 PR 에서 지운다) 읽기·쓰기는 SSM `/atmark/db/domain-tick`.
    const ref = { Ref: secretId };
    const write = [...statementsByRole(compute).values()].flat().find((s) => s.Sid === 'DbRoleSecretsWrite');
    expect(write === undefined ? false : writesSsmSecret(write, DOMAIN_TICK_DB_SECRET_NAME)).toBe(true);
    // migrate 의 옛 자리 읽기(SSM 이 비었는데 옛 값이 있으면 재생성하지 않고 실패) — Get 하나.
    const legacy = [...statementsByRole(compute).values()].flat().find((s) => s.Sid === 'DbRoleLegacySecretsRead');
    expect(legacy === undefined ? [] : actionsOf(legacy)).toEqual(['secretsmanager:GetSecretValue']);
    expect(legacy?.Resource).toEqual(expect.arrayContaining([ref]));
    expect(envOf(compute, 'atmark-migrate')[RUNTIME_ENV.dbDomainTickSecretArn]).toBe(`/${DOMAIN_TICK_DB_SECRET_NAME}`);
    expect(envOf(compute, 'atmark-admin')[RUNTIME_ENV.dbDomainTickSecretArn]).toBe(`/${DOMAIN_TICK_DB_SECRET_NAME}`);
    for (const [name, fn] of functionsByName(compute)) {
      expect(RUNTIME_ENV.dbDomainTickSecretArn in fn.Environment.Variables, name).toBe(name === 'atmark-admin' || name === 'atmark-migrate');
    }
    const readers = [...statementsByRole(compute)]
      .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, DOMAIN_TICK_DB_SECRET_NAME)))
      .map(([role]) => role);
    // migrate(DbRoleSecretsWrite 는 Get+Put — 부트스트랩이 채워졌는지 본다) · admin(틱 풀 — `DbDomainTickSecretRead`, Get 하나).
    expect(readers.sort()).toEqual([expect.stringMatching(/^AdminRole/), expect.stringMatching(/^MigrateRole/)]);
    const adminRead = [...statementsByRole(compute)].find(([role]) => /^AdminRole/.test(role))?.[1].find((s) => s.Sid === 'DbDomainTickSecretRead');
    expect(adminRead === undefined ? [] : actionsOf(adminRead)).toEqual(['ssm:GetParameter']);
    expect(adminRead === undefined ? false : readsSsmSecret(adminRead, DOMAIN_TICK_DB_SECRET_NAME)).toBe(true);
  });

  it(`스케줄 ${DOMAIN_RECHECK_SCHEDULE_NAME}: ${String(DOMAIN_RECHECK_MINUTES)}분 · admin 에 {"task":"domain-recheck"} · 재시도 0 · 기본 ENABLED(M5)`, () => {
    const schedules = runtimeTemplates().compute.findResources('AWS::Scheduler::Schedule') as Record<
      string,
      { Properties: { Name: string; ScheduleExpression: string; State?: string; Target: { Arn: unknown; Input?: string; RetryPolicy: { MaximumRetryAttempts: number } } } }
    >;
    const schedule = Object.values(schedules).find((s) => s.Properties.Name === DOMAIN_RECHECK_SCHEDULE_NAME)?.Properties;
    expect(schedule?.ScheduleExpression).toBe('rate(10 minutes)');
    expect(DOMAIN_RECHECK_MINUTES).toBe(10);
    expect(schedule?.State).toBe('ENABLED');
    expect(DOMAIN_RECHECK_ENABLED_DEFAULT).toBe(true);
    expect(DOMAIN_RECHECK_ENABLED_CONTEXT_KEY).toBe('atmark:domainRecheckEnabled');
    expect(JSON.parse(schedule?.Target.Input ?? '{}')).toEqual({ task: 'domain-recheck' });
    expect(schedule?.Target.RetryPolicy.MaximumRetryAttempts).toBe(0);
    expect(JSON.stringify(schedule?.Target.Arn)).toMatch(/AdminFunction/);
  });

  it('atmark:domainRecheckEnabled=false(비상 정지)면 DISABLED — 값 해석은 "운영자 콘솔 — 플래그" 묶음', () => {
    try {
      vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [DOMAIN_RECHECK_ENABLED_CONTEXT_KEY]: 'false' }));
      const schedules = Template.fromStack(buildRuntimeApp().compute).findResources('AWS::Scheduler::Schedule') as Record<string, { Properties: { Name: string; State?: string } }>;
      expect(Object.values(schedules).find((s) => s.Properties.Name === DOMAIN_RECHECK_SCHEDULE_NAME)?.Properties.State).toBe('DISABLED');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it('admin 함수를 부를 수 있는 런타임 역할은 없다 — Scheduler 의 역할(scheduler.amazonaws.com)뿐이다(계획 §3.4 L1)', () => {
    const compute = runtimeTemplates().compute;
    const roles = compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { AssumeRolePolicyDocument: unknown } }>;
    const adminId = (compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string } }>);
    const adminFunctionId = Object.entries(adminId).find(([, fn]) => fn.Properties.FunctionName === 'atmark-admin')?.[0] ?? '';
    const invokers = [...allStatementsByRole(compute)]
      .filter(([, statements]) =>
        statements.some(
          (s) => s.Effect === 'Allow' && actionsOf(s).some((a) => a === 'lambda:InvokeFunction' || a === 'lambda:*' || a === '*') && JSON.stringify(s.Resource).includes(`"${adminFunctionId}"`),
        ),
      )
      .map(([role]) => role);
    expect(invokers.length).toBeGreaterThan(0);
    for (const role of invokers) expect(JSON.stringify(roles[role]?.Properties.AssumeRolePolicyDocument), role).toContain('scheduler.amazonaws.com');
  });
});

describe('인젝션 구조 방어(ADR-0016) — 킬 스위치 atmark:riskHoldEnforce · DLP 지문 키 atmark/dlp-keys', () => {
  it('기본 enforce(진윤겸 2026-10-04) · 발송·수신 함수 환경에 킬 스위치와 키 위치 · 공통 환경을 받지 않는 함수에는 없다 · 틀린 값은 합성을 멈춘다', () => {
    expect(RISK_HOLD_ENFORCE_CONTEXT_KEY).toBe('atmark:riskHoldEnforce');
    expect(RISK_HOLD_ENFORCE_DEFAULT).toBe('enforce');
    const compute = runtimeTemplates().compute;
    for (const name of ['atmark-api', 'atmark-inbound', 'atmark-approval-release', 'atmark-scheduled-sender']) {
      expect(envOf(compute, name)['ATMARK_RISK_HOLD_ENFORCE'], name).toBe('enforce');
      expect(envOf(compute, name)['ATMARK_DLP_KEYS_SECRET_ARN'], name).toBeDefined();
    }
    for (const name of ['atmark-admin', 'atmark-login-mailer', 'atmark-ops', 'atmark-passport-signer']) {
      expect(envOf(compute, name)['ATMARK_DLP_KEYS_SECRET_ARN'], name).toBeUndefined();
    }
    const nodeWith = (context: Record<string, unknown>): cdk.App['node'] => new cdk.App({ context }).node;
    expect(riskHoldEnforceOf(nodeWith({}))).toBe('enforce');
    expect(riskHoldEnforceOf(nodeWith({ [RISK_HOLD_ENFORCE_CONTEXT_KEY]: 'observe' }))).toBe('observe');
    for (const bad of ['OBSERVE', 'off', 'false', '']) {
      expect(() => riskHoldEnforceOf(nodeWith({ [RISK_HOLD_ENFORCE_CONTEXT_KEY]: bad })), bad).toThrow(/atmark:riskHoldEnforce/);
    }
  });

  it('격리 알림 킬 스위치(2026-10-07) — 기본 on · approval-notifier 함수 환경에만 · 틀린 값은 합성을 멈춘다', () => {
    expect(QUARANTINE_NOTICE_CONTEXT_KEY).toBe('atmark:quarantineNotice');
    expect(QUARANTINE_NOTICE_DEFAULT).toBe('on');
    const compute = runtimeTemplates().compute;
    expect(envOf(compute, 'atmark-approval-notifier')['ATMARK_QUARANTINE_NOTICE']).toBe('on');
    for (const name of ['atmark-api', 'atmark-inbound', 'atmark-approval-release', 'atmark-scheduled-sender', 'atmark-login-mailer']) {
      expect(envOf(compute, name)['ATMARK_QUARANTINE_NOTICE'], name).toBeUndefined();
    }
    const nodeWith = (context: Record<string, unknown>): cdk.App['node'] => new cdk.App({ context }).node;
    expect(quarantineNoticeOf(nodeWith({}))).toBe('on');
    expect(quarantineNoticeOf(nodeWith({ [QUARANTINE_NOTICE_CONTEXT_KEY]: 'off' }))).toBe('off');
    for (const bad of ['OFF', 'false', '0', '']) {
      expect(() => quarantineNoticeOf(nodeWith({ [QUARANTINE_NOTICE_CONTEXT_KEY]: bad })), bad).toThrow(/atmark:quarantineNotice/);
    }
  });

  it('DLP 키 비밀은 이 스택 소유 · 값은 CloudFormation 생성(64자 영숫자) · RETAIN · 읽기는 발송·수신 역할 둘뿐', () => {
    const compute = runtimeTemplates().compute;
    const secrets = compute.findResources('AWS::SecretsManager::Secret') as Record<
      string,
      { Properties: { Name?: string; GenerateSecretString?: Record<string, unknown> }; DeletionPolicy?: string }
    >;
    const [logicalId, secret] = Object.entries(secrets).find(([, resource]) => resource.Properties.Name === DLP_KEYS_SECRET_NAME) ?? [];
    expect(secret?.Properties.GenerateSecretString).toMatchObject({ PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false });
    expect(secret?.DeletionPolicy).toBe('Retain');
    const roles = compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    const readers = [...statementsByRole(compute)]
      .filter(([, statements]) => statements.some((statement) => JSON.stringify(statement.Resource ?? '').includes(logicalId ?? '-')))
      .map(([role]) => roles[role]?.Properties.RoleName)
      .sort();
    expect(readers).toEqual(['atmark-runtime-inbound', SENDER_ROLE_NAME].sort());
  });
});

describe('Domain Connect 서명 키(ADR-0014 · src/domains/dc-kms-signer.ts) — RSA_2048 SIGN_VERIFY · RETAIN · Sign 은 admin 역할 하나', () => {
  const keyEntry = (): [string, { Properties: Record<string, unknown>; DeletionPolicy?: string }] => {
    const keys = runtimeTemplates().compute.findResources('AWS::KMS::Key') as Record<string, { Properties: Record<string, unknown>; DeletionPolicy?: string }>;
    const entry = Object.entries(keys).find(([id]) => id.startsWith('DomainConnectSigningKey'));
    if (entry === undefined) throw new Error('Domain Connect 키가 없다');
    return entry;
  };

  it('키 모양 — RSA_2048 · SIGN_VERIFY · 회전 없음 · RETAIN · 별칭', () => {
    const [id, key] = keyEntry();
    expect(key.Properties['KeySpec']).toBe('RSA_2048');
    expect(key.Properties['KeyUsage']).toBe('SIGN_VERIFY');
    expect(key.Properties['EnableKeyRotation']).toBe(false);
    expect(key.DeletionPolicy).toBe('Retain');
    const aliases = Object.values(runtimeTemplates().compute.findResources('AWS::KMS::Alias')) as { Properties: { AliasName: string; TargetKeyId: unknown } }[];
    const alias = aliases.find((entry) => entry.Properties.AliasName === DOMAIN_CONNECT_KEY_ALIAS);
    expect(JSON.stringify(alias?.Properties.TargetKeyId)).toContain(id);
  });

  it('키 정책: kms:Sign 명시 Deny — admin 역할 ARN 하나만 예외', () => {
    const [, key] = keyEntry();
    const statements = (key.Properties['KeyPolicy'] as { Statement: (IamStatement & { Principal?: unknown })[] }).Statement;
    const deny = statements.find((statement) => statement.Sid === DENY_SIGN_EXCEPT_ADMIN_SID);
    expect(deny?.Effect).toBe('Deny');
    expect(actionsOf(deny as IamStatement)).toEqual(['kms:Sign']);
    expect(JSON.stringify(deny?.Condition)).toContain(':role/atmark-runtime-admin');
    expect(Object.keys(deny?.Condition ?? {})).toEqual(['ArnNotEquals']);
  });

  it('IAM: 이 키의 kms:Sign 을 가진 역할 = admin 하나 · 알고리즘 RSASSA_PKCS1_V1_5_SHA_256 + RAW 조건 · GetPublicKey 도 admin 하나', () => {
    const [id] = keyEntry();
    const byRole = statementsByRole(runtimeTemplates().compute);
    const holders = (action: string): string[] =>
      [...byRole].filter(([, statements]) => statements.some((s) => actionsOf(s).includes(action) && JSON.stringify(s.Resource).includes(id))).map(([role]) => role);
    const adminRole = functionsByName(runtimeTemplates().compute).get('atmark-admin')?.Role['Fn::GetAtt'][0];
    expect(holders('kms:Sign')).toEqual([adminRole]);
    expect(holders('kms:GetPublicKey')).toEqual([adminRole]);
    const sign = (byRole.get(adminRole ?? '') ?? []).find((s) => actionsOf(s).includes('kms:Sign'));
    expect(actionsOf(sign as IamStatement)).toEqual(['kms:Sign']);
    expect(sign?.Condition).toEqual({ StringEquals: { 'kms:SigningAlgorithm': 'RSASSA_PKCS1_V1_5_SHA_256', 'kms:MessageType': 'RAW' } });
  });

  it('admin 환경: 스위치 기본 끔 · 키 ARN · 다른 함수에는 없다', () => {
    expect(DOMAIN_CONNECT_ENABLED_DEFAULT).toBe(false);
    expect(DOMAIN_CONNECT_ENABLED_CONTEXT_KEY).toBe('atmark:domainConnectEnabled');
    const compute = runtimeTemplates().compute;
    expect(envOf(compute, 'atmark-admin')[RUNTIME_ENV.domainConnectEnabled]).toBe('false');
    expect(JSON.stringify(envOf(compute, 'atmark-admin')[RUNTIME_ENV.domainConnectKeyArn])).toMatch(/DomainConnectSigningKey/);
    for (const name of ['atmark-api', 'atmark-inbound', 'atmark-login-mailer', 'atmark-ops', 'atmark-domain-control']) {
      expect(envOf(compute, name)[RUNTIME_ENV.domainConnectKeyArn], name).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 실시간 WebSocket(묶음 E — `wss://realtime.atmark.ai`)
// ---------------------------------------------------------------------------

describe('실시간 WebSocket(묶음 E)', () => {
  interface WsApi {
    readonly Properties: { readonly Name: string; readonly ProtocolType: string; readonly RouteSelectionExpression?: string };
  }
  const realtimeApi = (template: Template): [string, WsApi] => {
    const apis = template.findResources('AWS::ApiGatewayV2::Api') as Record<string, WsApi>;
    const found = Object.entries(apis).find(([, api]) => api.Properties.Name === 'atmark-realtime');
    if (found === undefined) throw new Error('atmark-realtime API 가 없다');
    return found;
  };
  const roleIdByName = (template: Template, roleName: string): string => {
    const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    const found = Object.entries(roles).find(([, role]) => role.Properties.RoleName === roleName);
    if (found === undefined) throw new Error(`${roleName} 역할이 없다`);
    return found[0];
  };

  it('WebSocket API 하나 · 라우트 셋($connect · $disconnect · $default) → 실시간 λ 하나 · $default 는 응답을 돌려준다 · authorizer 없음(λ 가 토큰을 본다)', () => {
    const compute = runtimeTemplates().compute;
    const [apiId, api] = realtimeApi(compute);
    expect(api.Properties.ProtocolType).toBe('WEBSOCKET');
    const routes = Object.values(
      compute.findResources('AWS::ApiGatewayV2::Route') as Record<
        string,
        { Properties: { ApiId: unknown; RouteKey: string; Target: unknown; AuthorizationType?: string; RouteResponseSelectionExpression?: string } }
      >,
    ).filter((route) => JSON.stringify(route.Properties.ApiId).includes(`"${apiId}"`));
    expect(routes.map((route) => route.Properties.RouteKey).sort()).toEqual(['$connect', '$default', '$disconnect']);
    for (const route of routes) expect(route.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
    expect(routes.find((route) => route.Properties.RouteKey === '$default')?.Properties.RouteResponseSelectionExpression).toBe('$default');
    const integrations = Object.values(
      compute.findResources('AWS::ApiGatewayV2::Integration') as Record<string, { Properties: { ApiId: unknown; IntegrationUri: unknown } }>,
    ).filter((integration) => JSON.stringify(integration.Properties.ApiId).includes(`"${apiId}"`));
    expect(integrations.length).toBe(3);
    const realtimeFnId = Object.entries(compute.findResources('AWS::Lambda::Function') as Record<string, FunctionResource>).find(
      ([, fn]) => fn.Properties.FunctionName === REALTIME_FUNCTION_NAME,
    )?.[0];
    expect(realtimeFnId).toBeDefined();
    for (const integration of integrations) expect(JSON.stringify(integration.Properties.IntegrationUri)).toContain(`"${String(realtimeFnId)}"`);
  });

  it('스테이지 v1 · 스로틀(계정 전체 10/20) · 접근 로그 없음(계정 단위 CloudWatch 역할을 요구한다 — 2026-10-08 첫 배포 실패) · 실행 로그도 없음', () => {
    const compute = runtimeTemplates().compute;
    const [apiId] = realtimeApi(compute);
    const stages = Object.values(
      compute.findResources('AWS::ApiGatewayV2::Stage') as Record<
        string,
        { Properties: { ApiId: unknown; StageName: string; DefaultRouteSettings?: Record<string, unknown>; AccessLogSettings?: { Format: string } } }
      >,
    ).filter((stage) => JSON.stringify(stage.Properties.ApiId).includes(`"${apiId}"`));
    expect(stages.length).toBe(1);
    const stage = stages[0];
    expect(stage?.Properties.StageName).toBe(REALTIME_STAGE_NAME);
    expect(stage?.Properties.DefaultRouteSettings).toMatchObject({
      ThrottlingRateLimit: REALTIME_STAGE_THROTTLE.rateLimit,
      ThrottlingBurstLimit: REALTIME_STAGE_THROTTLE.burstLimit,
    });
    expect(stage?.Properties.AccessLogSettings).toBeUndefined();
    expect(JSON.stringify(stage?.Properties.DefaultRouteSettings ?? {})).not.toMatch(/LoggingLevel|DataTraceEnabled/);
  });

  it('실시간 λ: VPC 안 · 예약 1 · 앱 DB 비밀 위치만(버킷 · 키 없음) · 역할은 앱 DB 비밀 읽기 하나 — SES · S3 · KMS · @connections 0', () => {
    const compute = runtimeTemplates().compute;
    const fn = functionsByName(compute).get(REALTIME_FUNCTION_NAME);
    expect(fn?.VpcConfig).toBeDefined();
    expect(Object.keys(fn?.Environment.Variables ?? {}).sort()).toEqual(['ATMARK_DB_SECRET_ARN', 'ATMARK_ENV', 'NODE_EXTRA_CA_CERTS', 'PGSSLMODE']);
    const statements = statementsByRole(compute).get(roleIdByName(compute, 'atmark-runtime-realtime')) ?? [];
    expect([...new Set(statements.flatMap(actionsOf))].sort()).toEqual(['kms:Decrypt', 'ssm:GetParameter']);
    expect(statements.filter((s) => actionsOf(s).includes('ssm:GetParameter')).every((s) => readsSsmSecret(s, DB_APP_SECRET_NAME))).toBe(true);
    // SES 발송 명시 Deny 는 있다(비발송 역할 전부).
    expect((allStatementsByRole(compute).get(roleIdByName(compute, 'atmark-runtime-realtime')) ?? []).some((s) => s.Sid === SES_SEND_DENY_SID)).toBe(true);
  });

  it('★ PostToConnection: 만드는 역할 넷(발송 · 수신 · admin · AI 감시 결과)만 · 리소스는 이 API 의 v1/POST/@connections/* 하나 · 와일드카드 API 없음', () => {
    const compute = runtimeTemplates().compute;
    const [apiId] = realtimeApi(compute);
    const byRole = statementsByRole(compute);
    const holders: string[] = [];
    for (const [roleId, statements] of byRole) {
      const manage = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('execute-api:')));
      if (manage.length === 0) continue;
      holders.push(roleId);
      for (const statement of manage) {
        expect(statement.Effect).toBe('Allow');
        expect(actionsOf(statement)).toEqual(['execute-api:ManageConnections']);
        const resource = JSON.stringify(statement.Resource);
        expect(resource).toContain(`{"Ref":"${apiId}"}`);
        expect(resource).toContain(`/${REALTIME_STAGE_NAME}/POST/@connections/*`);
        expect(resource).not.toMatch(/execute-api:[^"]*:\*\//);
      }
    }
    const expected = REALTIME_PRODUCER_ROLES.map((key) =>
      roleIdByName(compute, key === 'sender' ? 'atmark-runtime-sender' : `atmark-runtime-${key}`),
    ).sort();
    expect(holders.sort()).toEqual(expected);
  });

  it('콜백 URL 은 미는 함수 넷에만 · 접속 주소는 api 에만 · 도메인 전에는 execute-api wss 주소', () => {
    const compute = runtimeTemplates().compute;
    const functions = functionsByName(compute);
    const withCallback = [...functions].filter(([, fn]) => RUNTIME_ENV_KEYS_OF(fn).includes(REALTIME_ENV.callbackUrl)).map(([name]) => name).sort();
    expect(withCallback).toEqual(REALTIME_PRODUCER_HANDLERS.map((name) => `atmark-${name}`).sort());
    const withPublic = [...functions].filter(([, fn]) => RUNTIME_ENV_KEYS_OF(fn).includes(REALTIME_ENV.publicUrl)).map(([name]) => name);
    expect(withPublic).toEqual(['atmark-api']);
    const url = JSON.stringify(functions.get('atmark-api')?.Environment.Variables[REALTIME_ENV.publicUrl]);
    expect(url).toContain('wss://');
    expect(url).toContain('execute-api');
    compute.resourcePropertiesCountIs('AWS::ApiGatewayV2::DomainName', { DomainName: REALTIME_DOMAIN_NAME }, 0);
  });

  it('realtimeDomain(인증서 발급 뒤 · atmark:realtimeDomainReady) 이면 realtime.atmark.ai 도메인 + 매핑 + CNAME 출력 · 접속 주소는 wss://realtime.atmark.ai', () => {
    const compute = Template.fromStack(buildRuntimeApp({ kind: 'stub' }, { realtimeDomain: true }).compute);
    const [apiId] = realtimeApi(compute);
    compute.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: REALTIME_DOMAIN_NAME });
    const mappings = compute.findResources('AWS::ApiGatewayV2::ApiMapping') as Record<string, { Properties: { ApiId: unknown } }>;
    expect(Object.values(mappings).some((m) => JSON.stringify(m.Properties.ApiId).includes(`"${apiId}"`))).toBe(true);
    const outputs = compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs['RealtimeUrl']?.Value).toBe(REALTIME_PUBLIC_URL);
    expect(outputs['RealtimeCustomDomainCnameTarget']).toBeDefined();
    expect(functionsByName(compute).get('atmark-api')?.Environment.Variables[REALTIME_ENV.publicUrl]).toBe(REALTIME_PUBLIC_URL);
  });

  it('도메인 컨텍스트는 문자열 true/false · 기본 true(2026-10-08 도메인 배포 뒤 굳힘 — 컨텍스트를 빠뜨린 배포가 도메인 · 매핑을 지우지 않게)', () => {
    expect(REALTIME_DOMAIN_READY_DEFAULT).toBe(true);
    expect(realtimeDomainReadyOf({ tryGetContext: () => undefined })).toBe(true);
  });
});

function RUNTIME_ENV_KEYS_OF(fn: FunctionResource['Properties']): string[] {
  return Object.keys(fn.Environment.Variables);
}
