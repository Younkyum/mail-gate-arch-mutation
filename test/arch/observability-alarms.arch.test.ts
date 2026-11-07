/**
 * observability — **알람 63종이 synth 산출물에 실제로 존재한다**(62·63번은 2026-10-13 공유 도메인 조직 평판 — 경고·동결 · 판정 실패, 54~61번은 2026-10-06 AI 의심 메일 감시 ADR-0017 초안 — 큐 나이 · 하트비트 침묵 · 자기 시험 · 판정 지연 p95 · fail-skip 률(식) · 송신 실패 · 결과 거부 · 결과 DLQ, 38~44번은 2026-10 고객 도메인 ADR-0014 단계 2 — 확인 오류(식) · 확인 틱 정지
 * (결측 = 위반 · `atmark:domainRecheckEnabled` 게이트) · 평판 · 시끄러운 수신 · MX 충돌 · 정책 drift · 정책 크기 — 와 CloudTrail 트레일 · identity 변경 규칙,
 * 29~37번은 2026-09-28 호스팅 운영자 콘솔 ADR-0015 — 접근 요청 · 승인·폐기 ·
 * 활성 운영자 증가(DIFF · 결측 = 위반 · 게이트) · 로그인 남용 · 특권 행위(차원 action) · ops λ 오류·스로틀 · api λ 스로틀 · 코드 메일 건너뜀
 * (차원 reason · `atmark:opsLive` 게이트)(8·9번은 2026-09-24 검증 F6 — 문의 전달, 10~13번은 2026-09-24
 * 최종 검증 M3b·L2·L6 — 헤더 From 불일치·스니펫 스윕 막힘·DLQ 깊이 둘, 14번은 2026-09-25 ADR-0010 L7 적대적 검토 M1 — 초대 대상 주소
 * 지우기 밀림, 15~23번은 2026-09-25 WP-2 결제 — DLQ 깊이 · 차원 없는 EMF 여덟, 24~27번은 2026-09-26 메일 기본기 1차 — 웹훅 dead 비율(식) ·
 * ses-events 지연(3기간) · 에이전트별 두 알람(Contributor Insights 규칙 식 — 27번은 거부만), 28번은 같은 날 재검토 N5 — reconcile 정지
 * (완료 나이 · 결측 = 위반 · 액션 게이트)).
 *
 * `test/arch/iam-single-principal.arch.test.ts`(Layer E)와 같은 종류의 층이다:
 * TypeScript 는 CloudFormation 템플릿을 보지 못하므로, 스택 코드가 컴파일된다는
 * 사실은 **리소스가 산출됐다는 증거가 아니다.** 그래서 JSON 을 파싱한다.
 *
 * **왜 `cdk.out/` 이 아니라 여기서 synth 하는가.** 리포 루트의 `cdk.out` 은
 * `infra/cdk/app.ts` 가 등록한 스택만 담는다. 이 층이 그 파일에 의존하면 배선 순서가
 * 곧 검증 순서가 되고, 등록되기 전까지는 "산출물이 없으니 skip" 이 된다 —
 * Layer E 주석이 *"조용히 통과하면 이 층은 공허해진다"* 고 적은 상태다.
 * 스택을 여기서 직접 synth 하면 **배선과 무관하게** 항상 검사된다.
 *
 * 검사하는 것은 존재 여부만이 아니다. **임계값·비교 연산자·기간·결측 처리**까지
 * 동결한다 — 임계값이 조용히 완화되는 것이 알람이 죽는 가장 흔한 방식이고,
 * 그 완화는 코드 리뷰에서 한 글자로 지나간다(`0.04` → `0.4`).
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import {
  ALARM_EMAIL_SSM_PARAMETER,
  ALARM_TOPIC_NAME,
  API_LOG_GROUP_NAME,
  BILLING_WEBHOOK_REJECTED_THRESHOLD,
  BOUNCE_ALARM_RATE,
  COMPLAINT_ALARM_RATE,
  INSIGHT_RULE_NAMES,
  ObservabilityStack,
  RECONCILE_STALE_SECONDS,
  RISK_HOLDS_AGENT_HOURLY_THRESHOLD,
  SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD,
  SERIALIZATION_FAILURE_THRESHOLD,
  SES_BOUNCE_REVIEW_RATE,
  SES_EVENTS_LAG_SECONDS,
  VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD,
  WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS,
  WEBHOOK_DEAD_RATIO_THRESHOLD,
  API_LAMBDA_THROTTLES_THRESHOLD,
  OPS_CODE_INVALID_THRESHOLD,
  OPS_FAILING_ADDRESSES_THRESHOLD,
  OPS_LAMBDA_ERRORS_THRESHOLD,
  OPS_LAMBDA_THROTTLES_THRESHOLD,
  OPS_LIVE_CONTEXT_KEY,
  OPS_LIVE_DEFAULT,
  OPS_MAILER_SKIP_ALARM_REASONS,
  OPS_PRIVILEGED_ALARM_ACTION,
  OPS_TICKET_VIOLATION_CODE,
  DOMAIN_CHECK_ERRORS_THRESHOLD,
  MANAGEMENT_TRAIL_NAME,
  MANAGEMENT_TRAIL_RETENTION_DAYS,
  SES_IDENTITY_CHANGE_EVENT_NAMES,
  SES_IDENTITY_CHANGE_EVENT_PREFIXES,
  SES_IDENTITY_CHANGE_NON_ROLE_RULE_NAME,
  SES_IDENTITY_CHANGE_RULE_NAME,
  SES_IDENTITY_TAG_RULE_NAME,
  AI_WATCH_ALARMS_LIVE_CONTEXT_KEY,
  AI_WATCH_ALARMS_LIVE_DEFAULT,
  AI_WATCH_FAIL_SKIP_MIN_ENQUEUED,
  AI_WATCH_FAIL_SKIP_RATE,
  AI_WATCH_QUEUE_AGE_SECONDS,
  AI_WATCH_USER_ERROR_RULE_NAME,
  AI_WATCH_USER_EXPECTED_EVENT_SOURCES,
  AI_WATCH_USER_UNEXPECTED_RULE_NAME,
  AI_WATCH_VERDICT_LATENCY_P95_MS,
} from '../../infra/cdk/stacks/observability-stack';
import { AI_WATCH_IAM_USER, AI_WATCH_QUEUES } from '../../src/inbound/ai-watch/contract';
import { OPS_FUNCTION_NAME } from '../../src/ops/contract';
import { OPS_MAILER_SKIP_REASONS, OPS_METRIC_NAMES, OPS_WRITE_FAILURE_CODES } from '../../src/ops/metrics';
import { BILLING_DLQ_NAME } from '../../infra/cdk/stacks/billing-stack';
import { DOMAIN_RECHECK_ENABLED_CONTEXT_KEY, DOMAIN_RECHECK_ENABLED_DEFAULT, LAMBDA_HANDLERS } from '../../infra/cdk/stacks/compute-stack';
import { INBOUND_DLQ_NAME } from '../../infra/cdk/stacks/inbound-stack';
import { SES_EVENT_DLQ_NAME, SES_EVENT_QUEUE_NAME } from '../../infra/cdk/stacks/ses-stack';
import { RECONCILE_INTERVAL_MS, RECONCILE_STALE_AFTER_MS } from '../../src/billing/reconcile';
import { IDENTITIES_HELD_ALARM_THRESHOLD } from '../../src/domains/contract';
import { DOMAIN_METRIC_NAMES } from '../../src/domains/metrics';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT } from '../../src/db/schema';
import { ALARM_LOG_EVENTS, METRIC_NAMES, METRIC_NAMESPACE } from '../../src/observability/metrics';
import { WARMUP_STEADY_STATE_DAILY_CAP } from '../../src/policy/rules/limits';

const STACK_ID = 'AtmarkObservability';

interface CfnResource {
  readonly Type?: string;
  readonly Properties?: Record<string, unknown>;
}

interface CfnTemplate {
  readonly Resources?: Record<string, CfnResource>;
}

/** 스택을 실제로 synth 해 템플릿 JSON 을 **디스크에서 읽는다**(메모리 단언이 아니다). */
function synthTemplate(productionTrafficExpected: boolean, context: Record<string, unknown> = {}): CfnTemplate {
  const outdir = mkdtempSync(join(tmpdir(), 'atmark-obs-synth-'));
  const app = new cdk.App({ outdir, context });
  new ObservabilityStack(app, STACK_ID, {
    env: { account: '000000000000', region: 'ap-northeast-2' },
    productionTrafficExpected,
  });
  const assembly = app.synth();
  return JSON.parse(readFileSync(join(assembly.directory, `${STACK_ID}.template.json`), 'utf8')) as CfnTemplate;
}

function alarms(template: CfnTemplate): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
    const properties = resource.Properties ?? {};
    const name = properties['AlarmName'];
    out[typeof name === 'string' ? name : logicalId] = properties;
  }
  return out;
}

/**
 * 알람 하나가 지켜야 하는 것 전부.
 *
 * `treatMissingData` 가 여기 있는 이유: 카운터 알람의 결측을 `breaching` 으로 두면
 * 야간마다 울리고(알람 피로), `notBreaching` 으로 둔 다섯 개는 방출이 멈추는 순간
 * **동시에 조용히 거짓이 된다.** 그 둘의 배분이 설계이며, 따라서 동결 대상이다.
 */
interface MetricAlarmSpec {
  readonly namespace: string;
  readonly metricName: string;
  readonly statistic: string;
  readonly periodSeconds: number;
  readonly threshold: number;
  readonly comparison: string;
  readonly missingData: string;
  readonly actionsEnabled: boolean;
  /** `AWS/SQS` 알람(12·13·15·25)만 — 큐 이름 차원 하나. 우리 EMF 메트릭 알람은 차원이 없어야 한다(빈 집합 롤업). */
  readonly dimensions?: readonly { readonly Name: string; readonly Value: string }[];
  /** 기본 1. 25번(ses-events 지연)만 3기간 연속이다. */
  readonly evaluationPeriods?: number;
}

/**
 * **식 알람**(24·26·27, 메일 기본기 1차) — 메트릭 하나가 아니라 metric math 식을 본다. 템플릿에는 `MetricName` 이 없고 `Metrics` 배열에
 * 반환 식 하나(`ReturnData: true`)와 그 식이 쓰는 메트릭들이 있다. 식 문자열·기간·임계값·비교·결측을 동결하고, 식이 쓰는 메트릭(`inputs`,
 * id → 이름)도 동결한다 — 식은 그대로인데 분모 메트릭 이름만 바뀌면 알람은 영원히 0 을 본다.
 */
interface ExpressionAlarmSpec {
  readonly expression: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly periodSeconds: number;
  readonly threshold: number;
  readonly comparison: string;
  readonly missingData: string;
  readonly actionsEnabled: boolean;
}

type AlarmSpec = MetricAlarmSpec | ExpressionAlarmSpec;

function isExpression(spec: AlarmSpec): spec is ExpressionAlarmSpec {
  return 'expression' in spec;
}

const EXPECTED: Readonly<Record<string, AlarmSpec>> = {
  // ① 법적 기록의 구멍. §4.3 은 등식이므로 임계값이 1이다.
  'atmark-audit-resolve-failure': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.auditResolveFailed,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ② R22 의 마지막 제동장치. 임계값은 추정이 아니라 **코드 상수**다.
  'atmark-warmup-cap-breached': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.recipients,
    statistic: 'Sum',
    periodSeconds: 86_400,
    threshold: WARMUP_STEADY_STATE_DAILY_CAP,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ③ fail-closed 전건 차단. 1건은 경합, 3건은 경로 사망.
  'atmark-dispatch-serialization-unavailable': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.serializationUnavailable,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: SERIALIZATION_FAILURE_THRESHOLD,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ④ AWS 가 정한 수치의 80%.
  'atmark-ses-bounce-rate': {
    namespace: 'AWS/SES',
    metricName: 'Reputation.BounceRate',
    statistic: 'Average',
    periodSeconds: 900,
    threshold: BOUNCE_ALARM_RATE,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑤ AWS 가 정한 수치 그대로.
  'atmark-ses-complaint-rate': {
    namespace: 'AWS/SES',
    metricName: 'Reputation.ComplaintRate',
    statistic: 'Average',
    periodSeconds: 900,
    threshold: COMPLAINT_ALARM_RATE,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑥ 알람 스위트 자신의 생사 신호. **여기만 결측이 위반이다.**
  'atmark-gate-silence': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.attempts,
    statistic: 'Sum',
    periodSeconds: 86_400,
    threshold: 1,
    comparison: 'LessThanThreshold',
    missingData: 'breaching',
    actionsEnabled: true,
  },
  // ⑦ §4.3 보조 불변식 위반(허용 폭 30분을 넘긴 행). 두 워커가 서로를 재고, 둘 다 멈추면 결측 = 위반.
  'atmark-approval-pending-overdue': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.approvalPendingOverdue,
    statistic: 'Maximum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'breaching',
    actionsEnabled: true,
  },
  // ⑧ 문의가 전역 시간당 상한에 걸려 전달되지 않았다(검증 F6). 1건이 곧 신호.
  // ㊾ 한 에이전트의 1시간 위험 보류(ADR-0016 — 강제 held · 관찰 observed 합산) 10번 이상.
  'atmark-risk-holds-agent-hourly': {
    expression: `INSIGHT_RULE_METRIC('${INSIGHT_RULE_NAMES.riskHoldsByAgent}', 'MaxContributorValue')`,
    inputs: {},
    periodSeconds: 3_600,
    threshold: RISK_HOLDS_AGENT_HOURLY_THRESHOLD,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㊿ 발신 DLP — Atmark 자격 증명 적중 1건(ADR-0016 B). 차원 reason 하나(`outbound-service.ts` 가 그 집합으로만 낸다).
  'atmark-dlp-atmark-credential': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.dlpFindings,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'reason', Value: 'dlp_atmark_credential' }],
  },
  // 51 노출 기록 실패(ADR-0016 A — 읽기 라우트 503).
  'atmark-exposure-write-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.exposureWriteFailed,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // 53 고객 도메인 SES identity(활성 관리자 행)가 1,000 을 넘었다(2026-10 one-shot — 증명 전에도 identity 를 만든다 · 할당량 10,000 의 10%). 결측 = 틱 정지(39 가 본다).
  'atmark-domain-identities-held': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.identitiesHeld,
    statistic: 'Maximum',
    periodSeconds: 3_600,
    threshold: IDENTITIES_HELD_ALARM_THRESHOLD,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // 52 DLP 지문 키를 일찍 뺐다(리뷰 L1) — 비교하지 못한 지문 ≥ 1 / 1시간.
  'atmark-dlp-dropped-fingerprints': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.dlpDroppedFingerprints,
    statistic: 'Sum',
    periodSeconds: 3_600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-contact-rate-global': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.contactRateGlobal,
    statistic: 'Sum',
    periodSeconds: 3_600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑨ 문의 전달이 막혔다 — 전달 주소 비밀 없음·시도 소진(검증 F6).
  'atmark-contact-forward-blocked': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.contactForwardBlocked,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑩ 헤더 From 불일치·예약 주소 사칭(최종 검증 M3b). 1건이 곧 사고.
  'atmark-ses-from-mismatch': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.sesFromMismatch,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑪ 스니펫 보존 스윕이 비우지 못한 행(최종 검증 L2). 매 스윕 값을 내므로 Maximum.
  'atmark-snippet-retention-stuck': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.snippetRetentionStuck,
    statistic: 'Maximum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑫ SES 이벤트 DLQ 깊이(최종 검증 L6).
  'atmark-ses-events-dlq-depth': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    statistic: 'Maximum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'QueueName', Value: SES_EVENT_DLQ_NAME }],
  },
  // ⑬ 수신 메일 DLQ 깊이(최종 검증 L6).
  'atmark-inbound-mail-dlq-depth': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    statistic: 'Maximum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'QueueName', Value: INBOUND_DLQ_NAME }],
  },
  // ⑭ 초대만 받은 사람의 주소 지우기가 약속(30일)을 7일 넘겼다(ADR-0010 L7 M1). 하루 한 번 나오는 값 — 기간 하루, Maximum.
  'atmark-privacy-erasure-backlog': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.privacyErasureBacklog,
    statistic: 'Maximum',
    periodSeconds: 86_400,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑮ 결제 이벤트 DLQ 깊이(WP-2). FIFO 는 그룹이 막히므로 1건이 곧 사람이 볼 일.
  'atmark-billing-dlq-depth': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    statistic: 'Maximum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'QueueName', Value: BILLING_DLQ_NAME }],
  },
  // ⑯ 결제 웹훅 거부 — 열린 엔드포인트라 한두 건은 스캐너, 5분 5건이면 비밀 오입력·두드림.
  'atmark-billing-webhook-rejected': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingWebhookRejected,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: BILLING_WEBHOOK_REJECTED_THRESHOLD,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ⑰~㉓ 결제 noop·실패 — 1건이 곧 신호(결제는 드물다). 전부 15분 Sum · 차원 없음 · 결측은 위반 아님.
  'atmark-billing-sync-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingSyncFailed,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-billing-provider-auth-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingProviderAuthFailed,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-billing-unknown-price': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingUnknownPrice,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-billing-unbound-subscription': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingUnboundSubscription,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-billing-entitlement-held': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingEntitlementHeld,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-billing-webhook-missed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingWebhookMissed,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉓ reconcile 이 한 조직만 건너뛰었다 — 틱은 성공으로 끝나 Lambda Errors·sync_failed 가 없는 조용한 실패(WP-2 수정).
  'atmark-billing-reconcile-org-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingReconcileOrgFailed,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉔ 웹훅 dead 비율(메일 기본기 A4) — 분모 하한 아래는 0.
  'atmark-webhook-dead-ratio': {
    expression:
      `IF((FILL(delivered, 0) + FILL(dead, 0)) >= ${String(WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS)}, ` +
      'FILL(dead, 0) / (FILL(delivered, 0) + FILL(dead, 0)), 0)',
    inputs: { delivered: METRIC_NAMES.webhookDelivered, dead: METRIC_NAMES.webhookDead },
    periodSeconds: 3_600,
    threshold: WEBHOOK_DEAD_RATIO_THRESHOLD,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉕ ses-events 지연 — 15분 내내(5분 × 3) 가장 오래된 메시지가 10분을 넘는다.
  'atmark-ses-events-lag': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateAgeOfOldestMessage',
    statistic: 'Maximum',
    periodSeconds: 300,
    threshold: SES_EVENTS_LAG_SECONDS,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'QueueName', Value: SES_EVENT_QUEUE_NAME }],
    evaluationPeriods: 3,
  },
  // ㉖ 한 에이전트의 하루 인증코드 조회(D10 — 관측만).
  'atmark-verification-lookups-agent-daily': {
    expression: `INSIGHT_RULE_METRIC('${INSIGHT_RULE_NAMES.verificationLookupsByAgent}', 'MaxContributorValue')`,
    inputs: {},
    periodSeconds: 86_400,
    threshold: VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉗ 한 에이전트의 1시간 예약 취소 **거부**(http·mcp 합산, 진윤겸 결정 2026-09-26) — 성공은 세지 않는다. 3번 이상.
  'atmark-scheduled-cancels-agent-hourly': {
    expression: `INSIGHT_RULE_METRIC('${INSIGHT_RULE_NAMES.scheduledCancelsByAgent}', 'MaxContributorValue')`,
    inputs: {},
    periodSeconds: 3_600,
    threshold: SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉘ reconcile 정지(재검토 N5) — 마지막 완료 나이 > 26시간 · 1시간 방출이 없으면(틱 정지) 위반. 액션은 6·7번과 같은 게이트.
  'atmark-billing-reconcile-stale': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.billingReconcileCompletedAgeSeconds,
    statistic: 'Maximum',
    periodSeconds: 3_600,
    threshold: RECONCILE_STALE_SECONDS,
    comparison: 'GreaterThanThreshold',
    missingData: 'breaching',
    actionsEnabled: true,
  },
  // ㉙ 운영자 콘솔 접근 요청(ADR-0015) — 코드 검증을 통과한 requested 만(I-9). 1건이 곧 사람이 볼 일.
  'atmark-ops-access-requested': {
    namespace: METRIC_NAMESPACE,
    metricName: OPS_METRIC_NAMES.accessRequested,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉚ 운영자 승인·거절·폐기 — 두 카운터 합.
  'atmark-ops-operator-changed': {
    expression: 'FILL(decided, 0) + FILL(revoked, 0)',
    inputs: { decided: OPS_METRIC_NAMES.operatorDecided, revoked: OPS_METRIC_NAMES.operatorRevoked },
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㉝ 콘솔 특권 행위(조직 거절) — 닫힌 차원 action 하나(ops 메트릭은 빈 집합 롤업과 차원 집합을 함께 낸다).
  'atmark-ops-privileged-action': {
    namespace: METRIC_NAMESPACE,
    metricName: OPS_METRIC_NAMES.privilegedAction,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'action', Value: 'org.reject' }],
  },
  // ㊲ 콘솔 쓰기가 티켓 가드에 걸렸다(ticket_violation — 코드 결함 신호). 닫힌 차원 code 하나 · 게이트 없음(33 과 같다).
  'atmark-ops-ticket-violation': {
    namespace: METRIC_NAMESPACE,
    metricName: OPS_METRIC_NAMES.writeFailed,
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'code', Value: 'ticket_violation' }],
  },
  // ㉟ api λ 스로틀(예약 9 → 8, ADR-0015) — AWS/Lambda · 함수 이름 차원.
  'atmark-api-throttles': {
    namespace: 'AWS/Lambda',
    metricName: 'Throttles',
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 5,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'FunctionName', Value: 'atmark-api' }],
  },
  // ㊳~㊹ 고객 도메인(ADR-0014 단계 2) — 차원 없는 EMF(`DOMAIN_METRIC_NAMES`). 방출은 확인 틱(단계 4).
  // ㊳ 확인 인프라 오류 누적(30분 5건) 또는 사가가 다른 행의 identity 를 만났다(1건).
  'atmark-domain-check-errors': {
    expression: `IF(FILL(errors, 0) >= ${String(DOMAIN_CHECK_ERRORS_THRESHOLD)} OR FILL(elsewhere, 0) >= 1, 1, 0)`,
    inputs: { errors: DOMAIN_METRIC_NAMES.checkError, elsewhere: DOMAIN_METRIC_NAMES.identityOwnedElsewhere },
    periodSeconds: 1800,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㊴ 밀린 확인이 1시간 내내 > 0 · 결측(틱 정지) = 위반. 액션은 확인 틱 스케줄과 같은 값(`atmark:domainRecheckEnabled`)에 묶인다.
  'atmark-domain-check-stale': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.dueBacklog,
    statistic: 'Minimum',
    periodSeconds: 3600,
    threshold: 0,
    comparison: 'GreaterThanThreshold',
    missingData: 'breaching',
    actionsEnabled: true,
  },
  'atmark-domain-reputation-freeze': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.reputationFlagged,
    statistic: 'Sum',
    periodSeconds: 3600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // 62·63 — 공유 도메인(atmark.ai) 조직 평판(2026-10-13 보안 후속). 경고 · 동결 · 운영자 조직 예외 / 판정 실패.
  'atmark-platform-reputation-freeze': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.platformReputationFlagged,
    statistic: 'Sum',
    periodSeconds: 3600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-platform-reputation-check-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.platformReputationCheckFailed,
    statistic: 'Sum',
    periodSeconds: 3600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㊶ 고객 도메인 모르는 수신자 — 수신 소비자가 건마다(도메인 합) · 시간당 500(계획 §3.6).
  'atmark-domain-inbound-noisy': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.inboundUnknownCustomDomain,
    statistic: 'Sum',
    periodSeconds: 3600,
    threshold: 500,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-domain-mx-conflict': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.mxConflict,
    statistic: 'Sum',
    periodSeconds: 3600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-domain-policy-drift': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.policyDrift,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㊺ 독립 감사(읽기 전용 λ — 보안 리뷰 M2)가 계약 모양이 아닌 자원 정책을 찾았다.
  'atmark-domain-policy-shape': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.policyShapeViolation,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // ㊻·㊼ 고객 도메인 λ 둘의 오류(재검증 MEDIUM-2) — AWS/Lambda · 함수 이름 차원.
  'atmark-domain-control-errors': {
    namespace: 'AWS/Lambda',
    metricName: 'Errors',
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'FunctionName', Value: 'atmark-domain-control' }],
  },
  'atmark-domain-policy-audit-errors': {
    namespace: 'AWS/Lambda',
    metricName: 'Errors',
    statistic: 'Sum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'FunctionName', Value: 'atmark-domain-policy-audit' }],
  },
  // ㊽ 독립 감사 하트비트 결측(12시간마다 전수 · 하루 창 — CloudWatch 경보 평가 상한) — 결측 = 위반, 게이트 없음(감사는 배포부터 켜져 있다).
  'atmark-domain-policy-audit-silence': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.policyAuditAudited,
    statistic: 'SampleCount',
    periodSeconds: 86400,
    threshold: 1,
    comparison: 'LessThanThreshold',
    missingData: 'breaching',
    actionsEnabled: true,
  },
  'atmark-domain-policy-too-large': {
    namespace: METRIC_NAMESPACE,
    metricName: DOMAIN_METRIC_NAMES.policyTooLarge,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  // 54~61 — AI 의심 메일 감시(ADR-0017 초안 · 설계 §2.4). 54·55·58 의 액션은 `atmark:aiWatchAlarmsLive`(아래 절) — 57(p95)·58(식)은 아래 따로.
  'atmark-ai-watch-queue-age': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateAgeOfOldestMessage',
    statistic: 'Maximum',
    periodSeconds: 60,
    threshold: AI_WATCH_QUEUE_AGE_SECONDS,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
    actionsEnabled: false,
    dimensions: [{ Name: 'QueueName', Value: AI_WATCH_QUEUES.request }],
    evaluationPeriods: 5,
  },
  'atmark-ai-watch-heartbeat-silence': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.aiWatchHeartbeat,
    statistic: 'Sum',
    periodSeconds: 600,
    threshold: 1,
    comparison: 'LessThanThreshold',
    missingData: 'breaching',
    actionsEnabled: false,
  },
  'atmark-ai-watch-self-test-fail': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.aiWatchSelfTestFail,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-ai-watch-enqueue-failed': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.aiWatchEnqueueFailed,
    statistic: 'Sum',
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-ai-watch-result-rejected': {
    namespace: METRIC_NAMESPACE,
    metricName: METRIC_NAMES.aiWatchResultRejected,
    statistic: 'Sum',
    periodSeconds: 3_600,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
  },
  'atmark-ai-watch-result-dlq-depth': {
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    statistic: 'Maximum',
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
    actionsEnabled: true,
    dimensions: [{ Name: 'QueueName', Value: AI_WATCH_QUEUES.resultDlq }],
  },
};

/**
 * **운영자 콘솔 식 알람(31·32·34·36)** — 입력 메트릭이 차원·통계·네임스페이스가 섞여 위 식 알람 규칙(차원 없는 EMF `Sum`)에 들지 않는다.
 * 입력마다 네임스페이스·이름·통계·차원을 동결한다 — 식은 그대로인데 입력 하나의 이름·차원이 어긋나면 그 항은 영원히 0(FILL)이다.
 */
interface OpsInputSpec {
  readonly namespace: string;
  readonly metricName: string;
  readonly stat: 'Sum' | 'Maximum';
  readonly dimensions?: readonly { readonly Name: string; readonly Value: string }[];
}
interface OpsExpressionAlarmSpec {
  readonly expression: string;
  readonly inputs: Readonly<Record<string, OpsInputSpec>>;
  readonly periodSeconds: number;
  readonly threshold: number;
  readonly comparison: string;
  readonly missingData: string;
  /** 기본 1. 31번만 2기간 중 1(DIFF 의 앞 점 — 한 기간 창이면 DIFF 가 늘 비어 영구 ALARM 이다). */
  readonly evaluationPeriods?: number;
  readonly datapointsToAlarm?: number;
}
const OPS_EXPRESSION_ALARMS: Readonly<Record<string, OpsExpressionAlarmSpec>> = {
  // ㉛ 활성 운영자 증가 — census(스위퍼 5분) 게이지의 DIFF. 결측 = 위반(식이 1 로 · 6·7·28 과 같은 게이트). 2기간 창 · 1점이면 ALARM.
  'atmark-ops-active-operators-increased': {
    expression: 'IF(FILL(active, -1) < 0, 1, FILL(DIFF(active), 0))',
    inputs: { active: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.censusActive, stat: 'Maximum' } },
    periodSeconds: 300,
    threshold: 0,
    comparison: 'GreaterThanThreshold',
    missingData: 'breaching',
    evaluationPeriods: 2,
    datapointsToAlarm: 1,
  },
  // ㉜ 로그인 남용 — 코드 불일치 ≥ 20/15분 · 잠긴 주소 ≥ 1 · 오늘 실패 주소 ≥ 3(1 이면 오타 한 번에 하루 내내 울린다).
  'atmark-ops-login-abuse': {
    expression: 'IF(FILL(invalid, 0) >= 20 OR FILL(locked, 0) >= 1 OR FILL(failing, 0) >= 3, 1, 0)',
    inputs: {
      invalid: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.codeInvalid, stat: 'Sum' },
      locked: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.censusAddressesLocked, stat: 'Maximum' },
      failing: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.censusAddressesFailingToday, stat: 'Maximum' },
    },
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
  },
  // ㉞ ops λ 오류 ≥ 5 또는 스로틀 ≥ 10 / 5분.
  'atmark-ops-lambda-health': {
    expression: 'IF(FILL(errors, 0) >= 5 OR FILL(throttles, 0) >= 10, 1, 0)',
    inputs: {
      errors: { namespace: 'AWS/Lambda', metricName: 'Errors', stat: 'Sum', dimensions: [{ Name: 'FunctionName', Value: 'atmark-ops' }] },
      throttles: { namespace: 'AWS/Lambda', metricName: 'Throttles', stat: 'Sum', dimensions: [{ Name: 'FunctionName', Value: 'atmark-ops' }] },
    },
    periodSeconds: 300,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
  },
  // ㊱ 코드 메일 건너뜀(사람이 고칠 사유 셋) — 차원 reason 셋의 합. 액션은 `atmark:opsLive`.
  'atmark-ops-mailer-skipped': {
    expression: 'FILL(placeholder, 0) + FILL(keyinvalid, 0) + FILL(permission, 0)',
    inputs: {
      placeholder: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.mailerSkipped, stat: 'Sum', dimensions: [{ Name: 'reason', Value: 'placeholder' }] },
      keyinvalid: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.mailerSkipped, stat: 'Sum', dimensions: [{ Name: 'reason', Value: 'key_invalid' }] },
      permission: { namespace: METRIC_NAMESPACE, metricName: OPS_METRIC_NAMES.mailerSkipped, stat: 'Sum', dimensions: [{ Name: 'reason', Value: 'permission' }] },
    },
    periodSeconds: 900,
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    missingData: 'notBreaching',
  },
  // 58 — AI 감시 fail-skip 률(1시간) — 분자는 차원 outcome=ontime 인 판정, 분모는 차원 없는 송신. 작업이 적은 시간은 0.
  'atmark-ai-watch-fail-skip-rate': {
    expression: `IF(FILL(enqueued, 0) >= ${String(AI_WATCH_FAIL_SKIP_MIN_ENQUEUED)}, 1 - FILL(ontime, 0) / enqueued, 0)`,
    inputs: {
      enqueued: { namespace: METRIC_NAMESPACE, metricName: METRIC_NAMES.aiWatchEnqueued, stat: 'Sum' },
      ontime: { namespace: METRIC_NAMESPACE, metricName: METRIC_NAMES.aiWatchVerdicts, stat: 'Sum', dimensions: [{ Name: 'outcome', Value: 'ontime' }] },
    },
    periodSeconds: 3_600,
    threshold: AI_WATCH_FAIL_SKIP_RATE,
    comparison: 'GreaterThanThreshold',
    missingData: 'notBreaching',
  },
};

/** 표 밖 하나 — 백분위 통계(ExtendedStatistic)라 위 단언 모양에 들지 않는다. 아래 절이 따로 동결한다. */
const PERCENTILE_ALARMS = ['atmark-ai-watch-verdict-latency'] as const;

describe('observability — 알람 63종이 synth 산출물에 존재한다', () => {
  const template = synthTemplate(true);
  const found = alarms(template);

  it('알람이 정확히 63개다 — 늘리거나 줄이는 것은 이 표를 함께 고치는 일이다', () => {
    expect(Object.keys(found).sort()).toEqual([...Object.keys(EXPECTED), ...Object.keys(OPS_EXPRESSION_ALARMS), ...PERCENTILE_ALARMS].sort());
    expect(Object.keys(EXPECTED)).toHaveLength(57);
    expect(Object.keys(OPS_EXPRESSION_ALARMS)).toHaveLength(5);
  });

  it('57 atmark-ai-watch-verdict-latency — p95(ExtendedStatistic) > 10초 · 5분 · 5기간 중 3 · 차원 없음 · 결측 notBreaching', () => {
    const properties = found['atmark-ai-watch-verdict-latency'];
    expect(properties?.['Namespace']).toBe(METRIC_NAMESPACE);
    expect(properties?.['MetricName']).toBe(METRIC_NAMES.aiWatchVerdictLatencyMs);
    expect(properties?.['ExtendedStatistic']).toBe('p95');
    expect(properties?.['Statistic']).toBeUndefined();
    expect(properties?.['Period']).toBe(300);
    expect(properties?.['Threshold']).toBe(AI_WATCH_VERDICT_LATENCY_P95_MS);
    expect(AI_WATCH_VERDICT_LATENCY_P95_MS).toBe(10_000);
    expect(properties?.['ComparisonOperator']).toBe('GreaterThanThreshold');
    expect(properties?.['EvaluationPeriods']).toBe(5);
    expect(properties?.['DatapointsToAlarm']).toBe(3);
    expect(properties?.['TreatMissingData']).toBe('notBreaching');
    expect(properties?.['Dimensions']).toBeUndefined();
  });

  for (const [name, spec] of Object.entries(OPS_EXPRESSION_ALARMS)) {
    it(`${name} — 운영자 콘솔 식 알람: 식·입력(네임스페이스·이름·통계·차원)·기간·임계값·결측이 동결값과 같다`, () => {
      const properties = found[name];
      expect(properties, `${name} 알람이 템플릿에 없다`).toBeDefined();
      if (properties === undefined) return;
      expect(properties['MetricName']).toBeUndefined();
      expect(properties['Threshold']).toBe(spec.threshold);
      expect(properties['ComparisonOperator']).toBe(spec.comparison);
      expect(properties['TreatMissingData']).toBe(spec.missingData);
      expect(properties['EvaluationPeriods']).toBe(spec.evaluationPeriods ?? 1);
      expect(properties['DatapointsToAlarm']).toBe(spec.datapointsToAlarm);
      const metrics = (properties['Metrics'] ?? []) as readonly Record<string, unknown>[];
      const returned = metrics.filter((metric) => metric['ReturnData'] !== false);
      expect(returned).toHaveLength(1);
      expect(returned[0]?.['Expression']).toBe(spec.expression);
      const inputs: Record<string, OpsInputSpec> = {};
      for (const metric of metrics.filter((candidate) => candidate['ReturnData'] === false)) {
        const stat = metric['MetricStat'] as { Metric: Record<string, unknown>; Period: number; Stat: 'Sum' | 'Maximum' };
        expect(stat.Period, String(metric['Id'])).toBe(spec.periodSeconds);
        const dimensions = stat.Metric['Dimensions'] as OpsInputSpec['dimensions'];
        inputs[String(metric['Id'])] = {
          namespace: String(stat.Metric['Namespace']),
          metricName: String(stat.Metric['MetricName']),
          stat: stat.Stat,
          ...(dimensions === undefined ? {} : { dimensions }),
        };
      }
      expect(inputs).toEqual(spec.inputs);
    });
  }

  it('㉛ 식의 의미(흉내): 안정 = OK · 증가 = 그 기간만 ALARM · census 결측 = ALARM · 창 첫 점의 빈 DIFF 는 0(영구 ALARM 없음)', () => {
    // CloudWatch 의 FILL·DIFF·IF 를 점 단위로 흉내 낸다(null = 그 기간에 점 없음). 알람은 2기간 창의 값 중 하나라도 > 0 이면 ALARM.
    const evaluate = (window: readonly (number | null)[]): number[] =>
      window.map((value, i) => {
        if (value === null) return 1; // FILL(active, -1) < 0
        const previous = i === 0 ? null : window[i - 1];
        return previous === null || previous === undefined ? 0 : value - previous; // FILL(DIFF(active), 0)
      });
    const alarming = (window: readonly (number | null)[]): boolean => evaluate(window).some((v) => v > 0);
    expect(alarming([1, 1])).toBe(false); // 안정 — 한 기간 창의 빈 DIFF 가 영구 ALARM 을 만들던 자리
    expect(alarming([1, 2])).toBe(true); // 증가
    expect(alarming([2, 2])).toBe(false); // 다음 창 — OK 로 돌아온다
    expect(alarming([2, 1])).toBe(false); // 감소(폐기)는 30번이 본다
    expect(alarming([1, null])).toBe(true); // census 결측
    expect(alarming([null, null])).toBe(true);
    expect(OPS_EXPRESSION_ALARMS['atmark-ops-active-operators-increased']?.expression).toBe('IF(FILL(active, -1) < 0, 1, FILL(DIFF(active), 0))');
  });

  it('운영자 콘솔 알람의 이름·임계값은 코드 상수와 같다 — 차원 값은 닫힌 목록 안이다', () => {
    expect(OPS_CODE_INVALID_THRESHOLD).toBe(20);
    expect(OPS_FAILING_ADDRESSES_THRESHOLD).toBeGreaterThan(1);
    expect(OPS_LAMBDA_ERRORS_THRESHOLD).toBe(5);
    expect(OPS_LAMBDA_THROTTLES_THRESHOLD).toBe(10);
    expect(API_LAMBDA_THROTTLES_THRESHOLD).toBe(5);
    expect(OPS_FUNCTION_NAME).toBe('atmark-ops');
    expect(LAMBDA_HANDLERS).toContain('ops');
    expect(OPS_PRIVILEGED_ALARM_ACTION).toBe('org.reject');
    expect(OPS_TICKET_VIOLATION_CODE).toBe('ticket_violation');
    expect(OPS_WRITE_FAILURE_CODES).toContain(OPS_TICKET_VIOLATION_CODE);
    // 37 은 33 과 같은 게이트(없음) — 액션이 늘 켜져 있다.
    expect(found['atmark-ops-ticket-violation']?.['ActionsEnabled']).toBeUndefined();
    expect(found['atmark-ops-privileged-action']?.['ActionsEnabled']).toBeUndefined();
    expect([...OPS_MAILER_SKIP_ALARM_REASONS].sort()).toEqual(['key_invalid', 'permission', 'placeholder']);
    for (const reason of OPS_MAILER_SKIP_ALARM_REASONS) expect(OPS_MAILER_SKIP_REASONS).toContain(reason);
    // 배포 순서의 정상 중간 상태(schema·config)는 울리지 않는다.
    expect(OPS_MAILER_SKIP_ALARM_REASONS).not.toContain('schema');
    expect(OPS_MAILER_SKIP_ALARM_REASONS).not.toContain('config');
  });

  it('결제 알람 열(WP-2 계획 §3-10 + 수정 reconcile_org_failed + 재검토 N5 reconcile_stale)이 모두 있다 — provider_auth_failed 포함 · 결제 EMF 알람은 차원이 없다', () => {
    const billing = Object.keys(found).filter((name) => name.startsWith('atmark-billing-')).sort();
    expect(billing).toEqual(
      [
        'atmark-billing-dlq-depth',
        'atmark-billing-webhook-rejected',
        'atmark-billing-sync-failed',
        'atmark-billing-provider-auth-failed',
        'atmark-billing-unknown-price',
        'atmark-billing-unbound-subscription',
        'atmark-billing-entitlement-held',
        'atmark-billing-webhook-missed',
        'atmark-billing-reconcile-org-failed',
        'atmark-billing-reconcile-stale',
      ].sort(),
    );
    for (const name of billing.filter((n) => n !== 'atmark-billing-dlq-depth')) {
      expect(found[name]?.['Dimensions'], name).toBeUndefined();
      expect(String(found[name]?.['MetricName']), name).toMatch(/^atmark\.billing\./);
    }
  });

  for (const [name, spec] of Object.entries(EXPECTED)) {
    it(`${name} — 메트릭·임계값·비교·기간·결측처리가 동결값과 같다`, () => {
      const properties = found[name];
      expect(properties, `${name} 알람이 템플릿에 없다`).toBeDefined();
      if (properties === undefined) return;

      if (isExpression(spec)) {
        // 식 알람: 최상위에 메트릭이 없고, `Metrics` 에 반환 식 하나 + 식이 쓰는 차원 없는 EMF 메트릭들.
        expect(properties['MetricName']).toBeUndefined();
        expect(properties['Threshold']).toBe(spec.threshold);
        expect(properties['ComparisonOperator']).toBe(spec.comparison);
        expect(properties['TreatMissingData']).toBe(spec.missingData);
        expect(properties['EvaluationPeriods']).toBe(1);
        const metrics = (properties['Metrics'] ?? []) as readonly Record<string, unknown>[];
        const returned = metrics.filter((metric) => metric['ReturnData'] !== false);
        expect(returned).toHaveLength(1);
        expect(returned[0]?.['Expression']).toBe(spec.expression);
        // 기간은 식 자신(입력 메트릭이 없는 INSIGHT_RULE_METRIC) 또는 입력 메트릭(아래)이 갖는다.
        expect(returned[0]?.['Period']).toBe(Object.keys(spec.inputs).length === 0 ? spec.periodSeconds : undefined);
        const inputs: Record<string, string> = {};
        for (const metric of metrics.filter((candidate) => candidate['ReturnData'] === false)) {
          const stat = metric['MetricStat'] as { Metric: Record<string, unknown>; Period: number; Stat: string } | undefined;
          expect(stat?.Metric['Namespace']).toBe(METRIC_NAMESPACE);
          expect(stat?.Metric['Dimensions']).toBeUndefined();
          expect(stat?.Period).toBe(spec.periodSeconds);
          expect(stat?.Stat).toBe('Sum');
          inputs[String(metric['Id'])] = String(stat?.Metric['MetricName']);
        }
        expect(inputs).toEqual(spec.inputs);
        return;
      }

      expect(properties['Namespace']).toBe(spec.namespace);
      expect(properties['MetricName']).toBe(spec.metricName);
      expect(properties['Statistic']).toBe(spec.statistic);
      expect(properties['Period']).toBe(spec.periodSeconds);
      expect(properties['Threshold']).toBe(spec.threshold);
      expect(properties['ComparisonOperator']).toBe(spec.comparison);
      expect(properties['TreatMissingData']).toBe(spec.missingData);
      expect(properties['EvaluationPeriods']).toBe(spec.evaluationPeriods ?? 1);
      if (spec.evaluationPeriods !== undefined) expect(properties['DatapointsToAlarm']).toBe(name === 'atmark-ai-watch-queue-age' ? 3 : spec.evaluationPeriods);

      // **차원이 없어야 한다.** 차원을 붙이면 EMF 의 빈 집합 롤업이 아니라 특정
      // 조합을 보게 되고, 그 조합이 한 번도 방출되지 않으면 알람은 영원히
      // INSUFFICIENT_DATA 다 — 존재하지만 아무것도 보지 않는 알람.
      //   예외는 `AWS/SQS`(DLQ 깊이 12·13·15 · ses-events 지연 25) — 큐 이름 차원이 **정확히** 우리 큐 이름이어야 한다.
      expect(properties['Dimensions']).toEqual(spec.dimensions);
    });
  }

  it('마흔여덟 모두 알람·복구 액션이 같은 SNS 토픽으로 간다', () => {
    const topics = new Set<string>();
    for (const properties of Object.values(found)) {
      const alarmActions = properties['AlarmActions'];
      const okActions = properties['OKActions'];
      expect(Array.isArray(alarmActions) && alarmActions.length === 1).toBe(true);
      expect(Array.isArray(okActions) && okActions.length === 1).toBe(true);
      topics.add(JSON.stringify(alarmActions));
    }
    // 토픽이 둘이면 한쪽을 구독하지 않은 사람이 절반의 알람을 못 본다.
    expect(topics.size).toBe(1);
  });

  it('알람 토픽이 산출물에 있고 평문 publish 를 거부한다', () => {
    const resources = Object.values(template.Resources ?? {});
    const topic = resources.find(
      (resource) =>
        resource.Type === 'AWS::SNS::Topic' && resource.Properties?.['TopicName'] === ALARM_TOPIC_NAME,
    );
    expect(topic, `SNS 토픽 ${ALARM_TOPIC_NAME} 이 없다`).toBeDefined();

    const policy = resources.find((resource) => resource.Type === 'AWS::SNS::TopicPolicy');
    expect(policy, 'enforceSSL 이 만드는 TopicPolicy 가 없다').toBeDefined();
  });

  it('알람 토픽의 구독은 이메일 하나이고 주소는 SSM 동적 참조다 — 리터럴 주소가 템플릿(=리포)에 없다(2026-10-01: 알람 37종 · 구독 0)', () => {
    const resources = template.Resources ?? {};
    const [topicId] = Object.entries(resources).find(
      ([, resource]) => resource.Type === 'AWS::SNS::Topic' && resource.Properties?.['TopicName'] === ALARM_TOPIC_NAME,
    ) ?? [undefined];
    const subscriptions = Object.values(resources).filter((resource) => resource.Type === 'AWS::SNS::Subscription');
    expect(subscriptions).toHaveLength(1);
    const properties = subscriptions[0]?.Properties ?? {};
    expect(properties['TopicArn']).toEqual({ Ref: topicId });
    expect(properties['Protocol']).toBe('email');
    expect(properties['Endpoint']).toBe(`{{resolve:ssm:${ALARM_EMAIL_SSM_PARAMETER}}}`);
    // 구독 어디에도 주소 리터럴이 없다 — 동적 참조를 리터럴로 되돌리는 변경을 잡는다(알람 설명의 `support@atmark.ai` 같은 서비스 주소는 대상 밖).
    expect(JSON.stringify(properties)).not.toContain('@');
  });
});

describe('observability — 에이전트별 세 알람의 Contributor Insights 규칙(메일 기본기 1차 · ADR-0016)', () => {
  const template = synthTemplate(true);
  const rules = Object.values(template.Resources ?? {})
    .filter((resource) => resource.Type === 'AWS::CloudWatch::InsightRule')
    .map((resource) => resource.Properties ?? {});
  const bodyOf = (name: string): Record<string, unknown> => {
    const rule = rules.find((candidate) => candidate['RuleName'] === name);
    expect(rule, `${name} 규칙이 템플릿에 없다`).toBeDefined();
    expect(rule?.['RuleState']).toBe('ENABLED');
    return JSON.parse(String(rule?.['RuleBody'])) as Record<string, unknown>;
  };

  it('규칙은 정확히 셋이고 api 로그 그룹(compute 스택의 이름 규칙과 같은 이름)을 JSON 으로 읽어 agent_id 로 센다', () => {
    expect(rules.map((rule) => rule['RuleName']).sort()).toEqual(Object.values(INSIGHT_RULE_NAMES).sort());
    // 이름이 compute 스택의 로그 그룹(`/aws/lambda/atmark-<handler>`)과 어긋나면 규칙은 아무 줄도 보지 않는다.
    expect(LAMBDA_HANDLERS).toContain('api');
    expect(API_LOG_GROUP_NAME).toBe('/aws/lambda/atmark-api');
    for (const name of Object.values(INSIGHT_RULE_NAMES)) {
      const body = bodyOf(name);
      expect(body['LogGroupNames']).toEqual([API_LOG_GROUP_NAME]);
      expect(body['LogFormat']).toBe('JSON');
      expect(body['AggregateOn']).toBe('Count');
      expect((body['Contribution'] as { Keys: unknown }).Keys).toEqual(['$.agent_id']);
    }
  });

  it('인증코드 규칙은 verification.lookup 줄만, 취소 규칙은 거부 이벤트만 채널(route_id) 무관하게 센다(보안 M1 · 코드 리뷰 M7-a · 진윤겸 결정)', () => {
    const filters = (name: string): unknown => (bodyOf(name)['Contribution'] as { Filters: unknown }).Filters;
    expect(filters(INSIGHT_RULE_NAMES.verificationLookupsByAgent)).toEqual([{ Match: '$.event', In: [ALARM_LOG_EVENTS.verificationLookup] }]);
    // ADR-0016 — 위험 보류 규칙은 risk_hold.held 줄(강제 held · 관찰 observed)만 센다.
    expect(filters(INSIGHT_RULE_NAMES.riskHoldsByAgent)).toEqual([{ Match: '$.event', In: [ALARM_LOG_EVENTS.riskHold] }]);
    expect(ALARM_LOG_EVENTS.scheduledCancelRejected).toBe('scheduled.cancel_rejected');
    expect(filters(INSIGHT_RULE_NAMES.scheduledCancelsByAgent)).toEqual([{ Match: '$.event', In: [ALARM_LOG_EVENTS.scheduledCancelRejected] }]);
    // 성공한 취소는 세지 않는다 — 상한(시간당 5)을 정상적으로 쓰는 에이전트가 울리지 않게.
    expect(JSON.stringify(filters(INSIGHT_RULE_NAMES.scheduledCancelsByAgent))).not.toContain(`"${ALARM_LOG_EVENTS.scheduledCancelled}"`);
    // 임계값은 하드 상한보다 낮다 — 거부 3번이면 같은 지시가 되풀이되는 것이다.
    expect(SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD).toBe(3);
    expect(SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD).toBeLessThan(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT);
    // http 로 우회하는 길이 규칙에서 보이지 않으면 안 된다 — route_id 로 거르는 필터가 다시 생기면 실패한다.
    expect(JSON.stringify(filters(INSIGHT_RULE_NAMES.scheduledCancelsByAgent))).not.toContain('route_id');
  });
});

describe('observability — 알람 6(관문 침묵)의 액션 게이트', () => {
  it('프로덕션 트래픽 개시 전에는 액션이 꺼져 있되 **리소스는 존재한다**', () => {
    const found = alarms(synthTemplate(false));
    const silence = found['atmark-gate-silence'];

    // 존재는 무조건이다 — 끄는 것과 만들지 않는 것은 다르다.
    expect(silence).toBeDefined();
    expect(silence?.['ActionsEnabled']).toBe(false);

    // 7번(보조 불변식)·28번(reconcile 정지)도 같은 게이트다 — 결측을 위반으로 읽으므로 컴퓨트 배포 전에는 울리면 안 된다.
    expect(found['atmark-approval-pending-overdue']?.['ActionsEnabled']).toBe(false);
    expect(found['atmark-billing-reconcile-stale']?.['ActionsEnabled']).toBe(false);
    // 31번(활성 운영자 증가 — census 결측 = 위반, ADR-0015)도 같은 게이트.
    expect(found['atmark-ops-active-operators-increased']?.['ActionsEnabled']).toBe(false);
    // 결측을 위반으로 읽는 알람은 정확히 일곱이다 — 넷은 이 게이트, AI 감시 하트비트(55)는 자기 게이트(`atmark:aiWatchAlarmsLive` — 기본 꺼짐, 아래 절), 고객 도메인 확인 틱(39)은 그 스케줄의 스위치(아래 절 — M5 부터 기본 켜짐)에 묶인다.
    const breaching = Object.entries(found).filter(([, properties]) => properties['TreatMissingData'] === 'breaching').map(([name]) => name).sort();
    expect(breaching).toEqual([
      'atmark-ai-watch-heartbeat-silence',
      'atmark-approval-pending-overdue',
      'atmark-billing-reconcile-stale',
      'atmark-domain-check-stale',
      'atmark-domain-policy-audit-silence',
      'atmark-gate-silence',
      'atmark-ops-active-operators-increased',
    ]);
    // 독립 감사 하트비트(48)만 게이트가 없다 — 감사 λ 는 배포부터 12시간마다 돈다(트래픽과 무관), 결측이 곧 감사 정지다.
    const ownSwitch = ['atmark-domain-policy-audit-silence', 'atmark-domain-check-stale'];
    for (const name of breaching.filter((n) => !ownSwitch.includes(n))) expect(found[name]?.['ActionsEnabled'], name).toBe(false);
    // 39 는 이 게이트가 아니라 확인 틱 스케줄의 스위치를 따른다(아래 절) — 트래픽 게이트가 꺼져 있어도 스케줄이 켜져 있으면 켜진다.
    expect(found['atmark-domain-check-stale']?.['ActionsEnabled']).toBe(DOMAIN_RECHECK_ENABLED_DEFAULT);
    expect(found['atmark-domain-policy-audit-silence']?.['ActionsEnabled']).toBeUndefined();

    // 나머지는 영향받지 않는다.
    expect(Object.keys(found).length).toBe(63);
    expect(found['atmark-audit-resolve-failure']?.['ActionsEnabled']).toBeUndefined();
  });
});

describe('observability — 알람 39(고객 도메인 확인 틱 정지)의 게이트 atmark:domainRecheckEnabled', () => {
  it('기본(M5 — 스케줄 ENABLED)은 액션 켜짐 — 프로덕션 트래픽 게이트와 무관 · 스케줄을 끄는 같은 컨텍스트(=false)로만 꺼진다', () => {
    expect(found(synthTemplate(true))['atmark-domain-check-stale']?.['ActionsEnabled']).toBe(true);
    expect(found(synthTemplate(false))['atmark-domain-check-stale']?.['ActionsEnabled']).toBe(true);
    expect(found(synthTemplate(true, { [DOMAIN_RECHECK_ENABLED_CONTEXT_KEY]: 'false' }))['atmark-domain-check-stale']?.['ActionsEnabled']).toBe(false);
    expect(found(synthTemplate(true, { [DOMAIN_RECHECK_ENABLED_CONTEXT_KEY]: 'yes' }))['atmark-domain-check-stale']?.['ActionsEnabled']).toBe(false);
    expect(DOMAIN_RECHECK_ENABLED_DEFAULT).toBe(true);
  });

  function found(template: CfnTemplate): Record<string, Record<string, unknown>> {
    return alarms(template);
  }
});

describe('observability — CloudTrail 관리 이벤트 트레일 · domain-control 밖 SES identity 변경 감시(ADR-0014 결정 15 · 계획 §3.5)', () => {
  const template = synthTemplate(true);
  const resources = Object.values(template.Resources ?? {});

  it('트레일 하나: 관리 이벤트 전부 · 다중 리전 · 파일 검증 · 데이터 이벤트·CloudWatch Logs 없음 · S3 90일 수명주기(공개 차단 · TLS 강제 · RETAIN)', () => {
    const trails = resources.filter((resource) => resource.Type === 'AWS::CloudTrail::Trail');
    expect(trails).toHaveLength(1);
    const trail = trails[0]?.Properties ?? {};
    expect(trail['TrailName']).toBe(MANAGEMENT_TRAIL_NAME);
    expect(trail['IsMultiRegionTrail']).toBe(true);
    expect(trail['IncludeGlobalServiceEvents']).toBe(true);
    expect(trail['EnableLogFileValidation']).toBe(true);
    expect(trail['IsLogging']).toBe(true);
    expect(trail['CloudWatchLogsLogGroupArn']).toBeUndefined();
    const selectors = (trail['EventSelectors'] ?? []) as readonly Record<string, unknown>[];
    for (const selector of selectors) {
      expect(selector['IncludeManagementEvents']).toBe(true);
      expect(selector['ReadWriteType']).toBe('All');
      expect(selector['DataResources'] ?? []).toEqual([]);
    }
    const buckets = Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === 'AWS::S3::Bucket');
    expect(buckets).toHaveLength(1);
    const [, bucket] = buckets[0] ?? ['', { Properties: {} }];
    expect((bucket as { DeletionPolicy?: string }).DeletionPolicy).toBe('Retain');
    const properties = bucket.Properties ?? {};
    expect(properties['PublicAccessBlockConfiguration']).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(JSON.stringify(properties['LifecycleConfiguration'])).toContain(`"ExpirationInDays":${String(MANAGEMENT_TRAIL_RETENTION_DAYS)}`);
    // 삭제 보호(보안 리뷰 L6) — Object Lock 거버넌스 90일 · 버전 · 이전 버전은 보존 기간이 끝난 뒤 지운다.
    expect(properties['ObjectLockEnabled']).toBe(true);
    expect(properties['ObjectLockConfiguration']).toEqual({ ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: MANAGEMENT_TRAIL_RETENTION_DAYS } } });
    expect(JSON.stringify(properties['LifecycleConfiguration'])).toContain('"NoncurrentDays":1');
    expect(MANAGEMENT_TRAIL_RETENTION_DAYS).toBe(90);
    const bucketPolicy = resources.find((resource) => resource.Type === 'AWS::S3::BucketPolicy');
    expect(JSON.stringify(bucketPolicy?.Properties)).toContain('aws:SecureTransport');
    expect(JSON.stringify(bucketPolicy?.Properties)).toContain('cloudtrail.amazonaws.com');
  });

  it('규칙 둘: aws.ses CloudTrail API 호출 · identity·정책·태그·구성 세트를 바꾸는 이름 · ① 호출자 ARN 이 domain-control 역할 세션이 아닐 때 ② ARN 칸이 없을 수 있는 호출자 종류 → 알람 토픽(요청 파라미터 없이)', () => {
    const rules = resources.filter((resource) => resource.Type === 'AWS::Events::Rule');
    // SES 셋 + AI 감시 Mac 사용자 둘(아래 절).
    expect(rules).toHaveLength(5);
    // ③ 태그 쓰기·지우기는 호출자와 무관하게(domain-control 포함 — 재검증 LOW-1).
    const tagRule = rules.find((r) => r.Properties?.['Name'] === SES_IDENTITY_TAG_RULE_NAME)?.Properties ?? {};
    expect((tagRule['EventPattern'] as { detail: Record<string, unknown> }).detail).toEqual({ eventSource: ['ses.amazonaws.com'], eventName: ['TagResource', 'UntagResource'] });
    const second = rules.find((r) => r.Properties?.['Name'] === SES_IDENTITY_CHANGE_NON_ROLE_RULE_NAME)?.Properties ?? {};
    const secondPattern = second['EventPattern'] as { detail: Record<string, unknown> };
    // `anything-but` 은 칸이 없는 이벤트와 맞지 않는다(보안 리뷰 L1) — ARN 이 늘 있는 종류를 뺀 나머지를 type 으로 잡는다.
    expect(secondPattern.detail['userIdentity']).toEqual({ type: [{ 'anything-but': ['AssumedRole', 'IAMUser', 'Root', 'FederatedUser'] }] });
    expect(secondPattern.detail['eventName']).toEqual((rules.find((r) => r.Properties?.['Name'] === SES_IDENTITY_CHANGE_RULE_NAME)?.Properties?.['EventPattern'] as { detail: Record<string, unknown> }).detail['eventName']);
    const rule = rules.find((r) => r.Properties?.['Name'] === SES_IDENTITY_CHANGE_RULE_NAME)?.Properties ?? {};
    expect(rule['Name']).toBe(SES_IDENTITY_CHANGE_RULE_NAME);
    expect(rule['State']).toBe('ENABLED');
    const pattern = rule['EventPattern'] as { source: string[]; 'detail-type': string[]; detail: Record<string, unknown> };
    expect(pattern.source).toEqual(['aws.ses']);
    expect(pattern['detail-type']).toEqual(['AWS API Call via CloudTrail']);
    expect(pattern.detail['eventSource']).toEqual(['ses.amazonaws.com']);
    const names = pattern.detail['eventName'] as unknown[];
    for (const prefix of ['CreateEmailIdentity', 'DeleteEmailIdentity', 'PutEmailIdentity']) expect(names).toContainEqual({ prefix });
    for (const name of ['TagResource', 'UntagResource', 'PutIdentityPolicy', 'DeleteIdentityPolicy', 'DeleteVerifiedEmailAddress']) expect(names).toContain(name);
    expect(names).toContainEqual({ wildcard: '*ConfigurationSet*' });
    expect(names).toHaveLength(SES_IDENTITY_CHANGE_EVENT_PREFIXES.length + SES_IDENTITY_CHANGE_EVENT_NAMES.length + 1);
    expect(pattern.detail['userIdentity']).toEqual({ arn: [{ 'anything-but': { prefix: 'arn:aws:sts::000000000000:assumed-role/atmark-runtime-domain-control/' } }] });
    const targets = (rule['Targets'] ?? []) as readonly Record<string, unknown>[];
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(targets[0]?.['Arn'])).toContain('AlarmTopic');
    // 무엇을 · 누가 · 언제만 — 요청 파라미터(정책 원문·주소)는 싣지 않는다.
    const input = JSON.stringify(targets[0]?.['InputTransformer']);
    expect(input).toContain('$.detail.eventName');
    expect(input).toContain('$.detail.userIdentity.arn');
    expect(input).not.toContain('requestParameters');
  });
});

describe('observability — AI 의심 메일 감시(54~61)의 Mac 가용성 게이트 atmark:aiWatchAlarmsLive · Mac 사용자 CloudTrail 감시', () => {
  const gated = ['atmark-ai-watch-queue-age', 'atmark-ai-watch-heartbeat-silence', 'atmark-ai-watch-fail-skip-rate'];
  const always = ['atmark-ai-watch-self-test-fail', 'atmark-ai-watch-verdict-latency', 'atmark-ai-watch-enqueue-failed', 'atmark-ai-watch-result-rejected', 'atmark-ai-watch-result-dlq-depth'];

  it('기본(감시를 켠 조직 없음)은 가용성 셋의 액션이 꺼져 있고 리소스는 있다 · "true" 로만 켜진다 · 나머지 다섯은 늘 켜짐', () => {
    expect(AI_WATCH_ALARMS_LIVE_DEFAULT).toBe(false);
    const off = alarms(synthTemplate(true));
    for (const name of gated) expect(off[name]?.['ActionsEnabled'], name).toBe(false);
    for (const name of always) expect(off[name]?.['ActionsEnabled'], name).toBeUndefined();
    const on = alarms(synthTemplate(true, { [AI_WATCH_ALARMS_LIVE_CONTEXT_KEY]: 'true' }));
    for (const name of gated) expect(on[name]?.['ActionsEnabled'], name).toBe(true);
    const typo = alarms(synthTemplate(true, { [AI_WATCH_ALARMS_LIVE_CONTEXT_KEY]: 'yes' }));
    for (const name of gated) expect(typo[name]?.['ActionsEnabled'], name).toBe(false);
  });

  it('Mac IAM 사용자 규칙 둘 — SQS·KMS 밖 호출 · 오류 코드가 있는 호출 → 알람 토픽(요청 파라미터 없이)', () => {
    const rules = Object.values(synthTemplate(true).Resources ?? {}).filter((r) => r.Type === 'AWS::Events::Rule');
    const arn = `arn:aws:iam::000000000000:user/${AI_WATCH_IAM_USER}`;
    const unexpected = rules.find((r) => r.Properties?.['Name'] === AI_WATCH_USER_UNEXPECTED_RULE_NAME)?.Properties ?? {};
    expect(unexpected['EventPattern']).toEqual({
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { userIdentity: { arn: [arn] }, eventSource: [{ 'anything-but': [...AI_WATCH_USER_EXPECTED_EVENT_SOURCES] }] },
    });
    const errors = rules.find((r) => r.Properties?.['Name'] === AI_WATCH_USER_ERROR_RULE_NAME)?.Properties ?? {};
    expect(errors['EventPattern']).toEqual({ 'detail-type': ['AWS API Call via CloudTrail'], detail: { userIdentity: { arn: [arn] }, errorCode: [{ exists: true }] } });
    for (const rule of [unexpected, errors]) {
      const targets = (rule['Targets'] ?? []) as readonly Record<string, unknown>[];
      expect(targets).toHaveLength(1);
      expect(JSON.stringify(targets[0]?.['Arn'])).toContain('AlarmTopic');
      expect(JSON.stringify(targets[0]?.['InputTransformer'])).not.toContain('requestParameters');
    }
  });
});

describe('observability — 알람 36(운영자 코드 메일 건너뜀)의 go-live 게이트 atmark:opsLive', () => {
  it('기본(컨텍스트 없음)은 켜짐 — 2026-09-28 go-live 뒤 굳혔다 · "false" 로만 끈다', () => {
    expect(OPS_LIVE_DEFAULT).toBe(true);
    const found = alarms(synthTemplate(true));
    expect(found['atmark-ops-mailer-skipped']).toBeDefined();
    expect(found['atmark-ops-mailer-skipped']?.['ActionsEnabled']).toBe(true);
    expect(alarms(synthTemplate(true, { [OPS_LIVE_CONTEXT_KEY]: 'false' }))['atmark-ops-mailer-skipped']?.['ActionsEnabled']).toBe(false);
    // 다른 운영자 콘솔 알람은 이 게이트와 무관하다.
    expect(found['atmark-ops-access-requested']?.['ActionsEnabled']).toBeUndefined();
  });

  it('-c atmark:opsLive=true 면 켜진다 · "true" 가 아니면 켜지 않는다', () => {
    expect(OPS_LIVE_CONTEXT_KEY).toBe('atmark:opsLive');
    expect(alarms(synthTemplate(true, { [OPS_LIVE_CONTEXT_KEY]: 'true' }))['atmark-ops-mailer-skipped']?.['ActionsEnabled']).toBe(true);
    expect(alarms(synthTemplate(true, { [OPS_LIVE_CONTEXT_KEY]: 'yes' }))['atmark-ops-mailer-skipped']?.['ActionsEnabled']).toBe(false);
  });
});

describe('observability — 임계값의 출처', () => {
  it('bounce 알람은 AWS 검토 개시선(5%)보다 낮다 — AWS 가 보기 전에 우리가 본다', () => {
    expect(BOUNCE_ALARM_RATE).toBeLessThan(SES_BOUNCE_REVIEW_RATE);
    expect(BOUNCE_ALARM_RATE).toBe(0.04);
  });

  it('reconcile 정지 알람선은 코드의 26시간 그대로다 — 판 간격(24시간)보다 길다', () => {
    expect(RECONCILE_STALE_SECONDS).toBe(RECONCILE_STALE_AFTER_MS / 1000);
    expect(RECONCILE_STALE_SECONDS).toBe(26 * 3600);
    expect(RECONCILE_STALE_AFTER_MS).toBeGreaterThan(RECONCILE_INTERVAL_MS);
  });

  it('complaint 알람은 AWS 검토 개시선(0.1%) 그 자체다', () => {
    expect(COMPLAINT_ALARM_RATE).toBe(0.001);
  });

  it('워밍업 알람 임계값은 코드 상수를 그대로 쓴다 — 캡이 바뀌면 알람도 바뀐다', () => {
    const found = alarms(synthTemplate(true));
    expect(found['atmark-warmup-cap-breached']?.['Threshold']).toBe(WARMUP_STEADY_STATE_DAILY_CAP);
  });
});
