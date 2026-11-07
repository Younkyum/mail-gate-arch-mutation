/**
 * src/observability/metrics.ts — **알람이 걸리는 수치.** 조회 가능한 기록이 아니다.
 *
 * 메트릭은 "무엇이 몇 번" 만 안다. "누구에게" 는 `audit_logs` 에 묻는다(`logger.ts` 경계 ①).
 *
 * ## 기수 — 왜 `agent_id` 가 차원에 없는가
 * CloudWatch 는 차원 조합 하나당 시계열 하나로 과금한다. `agent_id` 를 넣으면 관측 비용이 에이전트 수
 * (성장 지표)를 따라 커지고, 시계열마다 표본이 줄어 비율 알람(bounce·complaint)이 무의미해진다
 * ("2통 중 1통 반송 → 50%"). 그래서 차원은 전부 닫힌 유니온(`route_id`·`verdict`·`reason`·`outcome`·`lane`)이고
 * 상한이 에이전트·수신자·메일 수와 무관하다. 에이전트별 질문은 `audit_logs`(또는 `ALARM_LOG_EVENTS` 로그)가 답한다.
 *
 * ## 왜 EMF 인가
 * 메트릭은 발송 성공 직후 경로에서 나간다. `PutMetricData` 는 지연을 붙이고 던질 수 있다(BLOCKER).
 * EMF 는 stdout 한 줄이라 AWS SDK 도, 던지는 I/O 도 없다(남은 것은 `writeLine` 이 삼킨다).
 */

import type { AiWatchBand, AiWatchRejectReason } from '../inbound/ai-watch/contract';
import type { VerificationLookupOutcome } from '../mail/verification';
import type { AuditDecision, DecisionReason } from '../policy/types';
import { writeLine } from './logger';

/** CloudWatch 네임스페이스. 알람 정의(`infra/cdk/stacks/observability-stack.ts`)가 같은 값을 쓴다. */
export const METRIC_NAMESPACE = 'Atmark';

/**
 * 메트릭 이름 — **알람과의 단일 진실 원천.** CDK 스택이 이 객체를 import 한다 — 이름을 두 번 적으면
 * 한쪽을 고치는 날 알람이 아무 데이터도 보지 않는 채 영원히 초록이 된다.
 */
export const METRIC_NAMES = {
  /** 관문을 지난 발송 시도. 알람 6(관문 침묵)의 분모이자 생사 신호. */
  attempts: 'atmark.gate.attempts',
  /**
   * Stage 1 `from_inactive`(ADR-0014 개정) — 이 에이전트의 **지금 쓸 수 없는** 주소(폐기 별칭 · M3a 부터 잠든 앵커)를 From 으로 썼다. 위반이 아니라
   * 여권에는 세지 않지만, 반복되면 폐기된 주소를 계속 쓰는 에이전트(설정 낡음 · 탈취 시도)다 — `from_forgery` 와 따로 세어 알람 축에서 사라지지 않게
   * 한다(보안 리뷰 L1). 차원 `route_id`. 알람은 관측 스택의 판단.
   */
  fromInactive: 'atmark.gate.from_inactive',
  /** 관문 왕복 지연(ms). 알람 없음 — 대시보드용. */
  latencyMs: 'atmark.gate.latency_ms',
  /** **실제로 나간 수신자 수.** 알람 2(워밍업 캡 돌파)의 축. 메일 수가 아니라 수신자 수다(R22). */
  recipients: 'atmark.send.recipients',
  /** 전송 성공 **뒤** audit 해소가 실패했다 = 법적 기록에 구멍. 알람 1. */
  auditResolveFailed: 'atmark.audit.resolve_failed',
  /** 평가~lease 구간을 잠그지 못했다 = fail-closed 전건 차단. 알람 3. */
  serializationUnavailable: 'atmark.gate.serialization_unavailable',
  /** 메일은 나갔는데 `messages` 행 확정에 실패했다. 알람 없음 — 알람 1의 형제이나 법적 기록은 온전하다. */
  outboundUnsettled: 'atmark.outbound.unsettled',
  /** 관문에 닿기도 전에 죽은 요청(멱등 키 누락·인증·본문). 관문 지표에 안 보이는 유일한 축. */
  preflightRejected: 'atmark.api.preflight_rejected',
  /**
   * 가장 오래된 `pending` 승인 요청의 나이(초) — §4.3 보조 불변식 *"TTL 을 넘겨 pending 인 행이
   * 0이어야 한다"* 의 측정값. TTL 스위퍼가 스윕 **뒤에** 방출한다. 값이 TTL 상한(7일)을 넘으면
   * 스위퍼가 무언가를 만료시키지 못하고 있다. 알람 없음 — 이 값의 위반 판정은 `approvalPendingOverdue`(알람 7)가 한다.
   */
  approvalPendingAgeSeconds: 'atmark.approval.pending_age_seconds',
  /**
   * **소유자 승인 알림**(P2, `src/notify/approval-notifier.ts`) — SES 가 받은 알림 수. 에이전트 메일이 아니므로
   * `recipients`(알림 2, 워밍업 캡)에 **섞지 않는다** — 섞으면 알림이 워밍업 알람을 울리거나, 반대로 캡 돌파를
   * 알림 수만큼 가린다. 알람 없음.
   */
  approvalNotificationSent: 'atmark.approval.notification_sent',
  /** 조직당 속도 상한에 걸려 큐에 남은 알림. 지속되면 에이전트가 승인 요청을 쏟아내고 있다. 알람 없음. */
  approvalNotificationDeferred: 'atmark.approval.notification_deferred',
  /**
   * **소유자에게 닿지 못한** 알림 — 소유자 이메일 없음(`owner_email IS NULL`) 또는 전송 재시도 소진.
   * 그 요청은 아무도 모른 채 TTL 에 만료된다(막히는 방향이지만, 에이전트는 "거절" 로 읽는다).
   * 알람 후보 1순위다 — 동결표(7종)를 늘리는 것은 리드의 판단이라 여기서는 메트릭만 낸다.
   */
  approvalNotificationUndeliverable: 'atmark.approval.notification_undeliverable',
  /**
   * **§4.3 보조 불변식 위반 수** — `audit_pending_overdue(now - 30분)` 의 행 수(`approval/service.measurePendingOverdue`).
   * TTL 스위퍼와 릴리스 스윕이 **둘 다** 낸다(한쪽이 멈추면 다른 쪽이 본다). 0 이 불변식이다. 알람 7.
   */
  approvalPendingOverdue: 'atmark.approval.pending_overdue',
  /** 문의 전달(US-009, `src/notify/contact-forwarder.ts`) — 운영자에게 한 통 나갔다. */
  contactForwardSent: 'atmark.contact.forward_sent',
  /**
   * 문의 전달이 **막혔다** — 전달 주소 비밀이 비었거나(자리값·모양 틀림·읽기 실패) 시도를 다 썼다. 0 이 정상이다. 비밀이 빈 채로
   * 문의가 오면 행은 `pending` 으로 남고 이 값이 1분마다 오른다(ADR-0009).
   */
  contactForwardBlocked: 'atmark.contact.forward_blocked',
  /**
   * 문의가 **차선 시간당 상한**(`CONTACT_FORWARD_LANE_HOURLY_CAP` — support 30 · role 10, 차원 `lane`)에 걸려 전달되지 않았다(`src/contact/intake.ts`, 거부 행
   * `rate_global`). 1건이라도 나면 문의 창구가 폭탄을 맞고 있거나 정상 문의가 버려지고 있다 — 알람 8(2026-09-24 검증 F6).
   */
  contactRateGlobal: 'atmark.contact.rate_global',
  /**
   * SES 이벤트의 **헤더 From 이 발신 주소(`mail.source`)와 다르거나 예약 주소(`login@`·`support@`)를 담았는데 발신 주소가 그 예약
   * 주소가 아니다**(2026-09-24 최종 검증 M3b, `src/mail/events/from-alignment.ts`). IAM 은 `FromEmailAddress` 만 보고, raw MIME 의
   * `From` 이 달라도 SES 가 거부하는지는 문서에 없다(ADR-0006) — 사후 탐지다. 0 이 정상이다(세 발송면이 같은 값을 쓴다). 알람 10.
   */
  sesFromMismatch: 'atmark.ses.from_mismatch',
  /**
   * 발신 스니펫 보존 스윕이 **비우지 못한 행 수**(2026-09-24 최종 검증 L2, `src/db/repositories/snippet-retention.ts`). 다른 트리거가
   * UPDATE 를 거부한 행은 건너뛰고 나머지를 비운다 — 그 행은 다음 스윕에도 다시 실패하므로 값이 매 스윕 나온다. 0 이 정상. 알람 11.
   */
  snippetRetentionStuck: 'atmark.snippet.retention_stuck',
  /**
   * 초대만 받은 사용자 주소 지우기(ADR-0010 L7) — **약속(30일)을 7일 넘긴 행 수**(`invited_user_erasure_backlog()`). TTL 스위퍼가 하루 창
   * (03:00 KST)에서 매일 낸다(0 포함). 0 이 정상 — 1 이상이면 지우기가 막혔거나(잠금·제약·대기 메일) 하루 5 000 명을 넘게 밀렸다. 알람 14.
   */
  privacyErasureBacklog: 'atmark.privacy.erasure_backlog',
  /** 같은 창에서 지운 사용자 수(여러 배치 합). 알람 없음. */
  privacyErasureErased: 'atmark.privacy.erasure_erased',
  /** 같은 창에서 후보였지만 건너뛴 수(잠금·제약·재검사 불일치). 알람 없음 — 밀린 수(위)가 결과를 본다. */
  privacyErasureSkipped: 'atmark.privacy.erasure_skipped',
  // --- 결제 공급자(WP-2, Paddle — `.omc/plans/wp2-paddle-adapter.md` §3-10). **차원 없이** 방출한다(알람은 빈 집합 롤업을 본다).
  //   웹훅 λ(`src/runtime/handlers/billing-webhook.ts`)가 `billingWebhook*` 을, sync λ(`src/billing/sync.ts`·`reconcile.ts`)가 나머지를 낸다.
  //   고객 id·구독 id·금액은 메트릭에 없다(로그에도 event_id·type·결과 코드만).
  /** 서명 실패·창 밖·헤더 형식 오류로 401 을 준 웹훅(+ 바디 초과 413). 5분에 5건 이상이면 비밀 오입력·공격. 알람 `atmark-billing-webhook-rejected`. */
  billingWebhookRejected: 'atmark.billing.webhook_rejected',
  /** sync λ 가 메시지 처리에 실패했다(던짐 — SQS 가 재시도). 알람 `atmark-billing-sync-failed`. */
  billingSyncFailed: 'atmark.billing.sync_failed',
  /** Paddle API 401/403 — 키가 자리표시·만료·권한 부족(스위치가 켜진 뒤). 알람 `atmark-billing-provider-auth-failed`. */
  billingProviderAuthFailed: 'atmark.billing.provider_auth_failed',
  /** 우리가 모르는 가격 id 의 구독 — 요금제를 바꾸지 않고 noop. 알람 `atmark-billing-unknown-price`. */
  billingUnknownPrice: 'atmark.billing.unknown_price',
  /** 원 거래가 `billing_checkouts` 에 없는 구독(결속 거부). 알람 `atmark-billing-unbound-subscription`. */
  billingUnboundSubscription: 'atmark.billing.unbound_subscription',
  /** 운영자·백필 행이 결제 결과를 막았다(칸별 지배 실패 — D-3). 알람 `atmark-billing-entitlement-held`. */
  billingEntitlementHeld: 'atmark.billing.entitlement_held',
  /** reconcile 이 본 Paddle 쪽 변화에 2시간 안에 웹훅이 없었다. 알람 `atmark-billing-webhook-missed`. */
  billingWebhookMissed: 'atmark.billing.webhook_missed',
  /** 서명이 맞고 허용 이벤트라 큐에 넣었다. 알람 없음. */
  billingWebhookAccepted: 'atmark.billing.webhook_accepted',
  /** 서명은 맞으나 허용 목록 밖 이벤트(200 · 큐 0). 알람 없음. */
  billingWebhookIgnored: 'atmark.billing.webhook_ignored',
  /** 발신 IP 가 Paddle 공개 목록 밖(D-6 — 기록만, 거부하지 않는다). 알람 없음. */
  billingWebhookForeignIp: 'atmark.billing.webhook_foreign_ip',
  /** sync 가 엔타이틀먼트를 새 버전으로 썼다. 알람 없음. */
  billingSyncApplied: 'atmark.billing.sync_applied',
  /** sync 결과가 지금 행과 같아 쓰지 않았다. 알람 없음. */
  billingSyncNoop: 'atmark.billing.sync_noop',
  /** 재조회 결과가 표의 `provider_updated_at` 보다 옛것이었다. 알람 없음. */
  billingSyncStale: 'atmark.billing.sync_stale',
  /** 재조회 404 — `ignored(not_found)`. 알람 없음. */
  billingProviderNotFound: 'atmark.billing.provider_not_found',
  /**
   * reconcile 을 건너뛰었다 — 스위치 꺼짐·키 자리표시·결제 표 전(설정 전 정상), 또는 stale 한 묶음이 페이지 상한(5쪽)을 넘어 그 묶음을 넘겼다
   * (로그 `billing.reconcile_stale_pages` — 공급자 이상, 코드 검토 N-4). 알람 없음.
   */
  billingReconcileSkipped: 'atmark.billing.reconcile_skipped',
  /** reconcile 이 본 활성 구독 수. 알람 없음 — 대시보드용. */
  billingActiveSubscriptions: 'atmark.billing.active_subscriptions',
  /**
   * 한 Paddle 고객이 여러 조직에 붙어 있다(결속 충돌·공유 고객 — H-1). 정보 메트릭 — 알람 없음. 포털은 409
   * `billing_portal_shared_customer`, 체크아웃은 customer 를 미리 채우지 않는다. 로그에 식별자는 싣지 않는다.
   */
  billingCustomerShared: 'atmark.billing.customer_shared',
  /**
   * reconcile 의 orgs 단계에서 한 조직의 재계산이 실패해 그 조직만 건너뛰었다(틱은 계속 — 조용히 새는 실패).
   * 알람 `atmark-billing-reconcile-org-failed`.
   */
  billingReconcileOrgFailed: 'atmark.billing.reconcile_org_failed',
  /**
   * reconcile 한 틱이 `concurrent` 로 끝났다 — 다른 실행이 단일 실행 잠금을 쥐었거나 틱 도중 판이 바뀌었다(재검토 N5). 예약 동시성 1 이라
   * 평소 0 이다. 알람 없음 — 계속 오르면 잠금이 풀리지 않은 연결이 남은 것이다(`billing.reconcile_lock_release_missed` 로그와 함께 본다).
   */
  billingReconcileConcurrent: 'atmark.billing.reconcile_concurrent',
  /**
   * 마지막으로 **끝난** reconcile 판(`billing_reconcile_state.completed_at`, 한 번도 끝나지 않았으면 첫 판의 `started_at`)의 나이(초). 매 틱
   * 낸다 — 스위치 꺼짐·결제 표 전(대조를 기대하지 않는 상태)이면 0. 알람 `atmark-billing-reconcile-stale`(26시간 초과 · 결측 = 위반):
   * 틱은 도는데 판이 끝나지 않는 것과 틱이 아예 멈춘 것(방출 없음)을 함께 본다.
   */
  billingReconcileCompletedAgeSeconds: 'atmark.billing.reconcile_completed_age_seconds',
  // --- 메일 기본기 1차(`.omc/plans/mail-basics.md` §4 A1·A3·A4). 알람은 웹훅 dead 비율 하나(`webhookDelivered`·`webhookDead`)만 이 이름을 본다 —
  //   에이전트별 두 알람(인증코드 조회·MCP 취소)은 메트릭이 아니라 **로그 + Contributor Insights 규칙**이 본다(차원에 `agent_id` 를 둘 수 없다 —
  //   위 "기수"). 그 로그 이벤트 이름은 아래 `ALARM_LOG_EVENTS` 다.
  /** 인증코드 조회 1회. 차원 `outcome` = `VerificationLookupOutcome`(found·candidates·not_found·ambiguous·unauthenticated). 알람 없음. */
  verificationLookups: 'atmark.verification.lookups',
  /** 확정 모드에서 링크 호스트가 발신 도메인(`from_domain`)과 같지도 하위도 아니라 버린 링크 수. 알람 없음(ADR-0013 재개방 조건이 본다). */
  verificationLinksDroppedHostMismatch: 'atmark.verification.links_dropped_host_mismatch',
  /** 예약 취소 1건(재생 제외). 차원 `route_id` = `http` | `mcp`(취소 경로 — `ScheduledCancelChannel`). 알람 없음. */
  scheduledCancelled: 'atmark.scheduled.cancelled',
  /** 웹훅 전달 성공(2xx) — 디스패처가 낸다. 알람 `atmark-webhook-dead-ratio` 의 분모 쪽. */
  webhookDelivered: 'atmark.webhook.delivered',
  /** 웹훅 전달 포기(`dead`) — 디스패처가 낸다. 알람 `atmark-webhook-dead-ratio` 의 분자. */
  webhookDead: 'atmark.webhook.dead',
  /** ses-events 트랜잭션에서 웹훅 적재가 실패해 savepoint 로 되돌렸다 — 기록은 커밋되고 그 웹훅은 유실된다. 알람 없음(0 이 정상). */
  webhookEnqueueFailed: 'atmark.webhook.enqueue_failed',
  /**
   * 공유 도메인(`atmark.ai`) 조직 평판(202610131620) — 경고(`warn`) · 이번에 동결(`frozen`) · 동결선이지만 운영자 조직(`freeze_exempt`)마다 1.
   * 이미 동결된 조직(`already_frozen`)은 세지 않는다(같은 사고로 알람이 계속 울리지 않게). 알람 `atmark-platform-reputation-freeze`.
   */
  platformReputationFlagged: 'atmark.reputation.platform_flagged',
  /** 공유 도메인 조직 평판 판정 · 동결 호출이 던졌다(이벤트는 재전달 — 판정은 멱등). 알람 `atmark-platform-reputation-check-failed`(0 이 정상). */
  platformReputationCheckFailed: 'atmark.reputation.platform_check_failed',
  /** 재전송 요청으로 새 전달 행을 만들었다(루트당 3회 천장 안). 알람 없음. */
  webhookRedelivered: 'atmark.webhook.redelivered',
  // --- 인젝션 구조 방어(ADR-0016 · 202610041000). 에이전트별 보류 급증은 메트릭이 아니라 로그(`ALARM_LOG_EVENTS.riskHold`) + Contributor Insights 가 본다.
  /**
   * 위험 신호가 실린 발송 평가 한 번(릴리스 제외 — `gate.observeRiskHold`). 차원 `route_id` · `outcome`(`clear`·`held`·`observed`·`skipped`) ·
   * `reason`(첫 위험 사유). 알람 없음 — 대시보드(관찰 → 강제 판단, 강제 뒤 보류율).
   */
  riskHoldEvaluated: 'atmark.risk_hold.evaluated',
  /**
   * 발신 DLP 적중 — 계열마다 1(`api/outbound-service.ts`). 차원 `reason` = `dlp_<계열>` **하나만**(알람이 그 차원 집합을 본다). 알람
   * `atmark-dlp-atmark-credential`(`dlp_atmark_credential` ≥ 1 / 5분 — Atmark 자격 증명이 발송 본문에 실렸다).
   */
  dlpFindings: 'atmark.dlp.findings',
  /**
   * 예약을 **만들 때** 고정한 DLP 계열 — 계열마다 1(`pinScheduledRisk`, 재검증 N5). 같은 예약이 발송 때 `dlp.findings` 로 한 번 더 세지므로 알람
   * 메트릭과 나눴다. 차원 `reason` 하나. 알람 없음.
   */
  dlpPinned: 'atmark.dlp.pinned',
  /** 키 묶음에 kid 가 없어 비교하지 못한 지문 수(ADR-0016 "키링 보존 ≥ 30일" — 키를 일찍 뺐다). 0 이 정상. 알람 `atmark-dlp-dropped-fingerprints`(≥1 / 1시간). */
  dlpDroppedFingerprints: 'atmark.dlp.dropped_fingerprints',
  /** 읽기 라우트의 노출 기록 한 건(노출 항목 수). 차원 `route_id`(읽기 면) · `outcome`(`T0`·`T1`·`T2`). 알람 없음. */
  exposureRecorded: 'atmark.exposure.recorded',
  /**
   * 노출 기록 실패 → 읽기 라우트 503(fail closed — 기록 없이 본문을 주지 않는다). 차원 `route_id`(읽기 면). 알람
   * `atmark-exposure-write-failed`(≥ 1 / 5분) — 에이전트가 받은 메일을 읽지 못하고 있다.
   */
  exposureWriteFailed: 'atmark.exposure.write_failed',
  /** 허용 한도(5분)보다 먼 미래 시각의 T2 노출 행 수(`security/taint.ts` `futureExposureCount`) — 잘라서 유효로 둔다. 0 이 정상. 알람 없음(로그 warn). */
  exposureFuture: 'atmark.exposure.future',
  // --- 격리 알림(ADR-0016 2026-10-07 · `src/notify/quarantine-notifier.ts`) — 소유자에게 간 시스템 메일. 차원 `route_id`(`quarantine_notice`). 알람 없음.
  /** 격리 알림 한 통이 SES 에 들어갔다. */
  quarantineNoticeSent: 'atmark.quarantine_notice.sent',
  /**
   * 신뢰 발신자 우회(ADR-0016 2026-10-08)가 위험도 `high` 메일에 섰다 — 격리 · 알림 없이 에이전트에게 보였다. 신뢰 발신자 계정 탈취의 신호일 수 있다. 차원 `route_id`
   * (`inbound_consumer`). 알람 없음(로그 `inbound.watch` reason `trusted_bypass_high` 와 함께).
   */
  watchTrustedBypassHigh: 'atmark.watch.trusted_bypass_high',
  /** 조직 하루 상한(20)에 걸려 보내지 않은 창(`suppressed` — 다음 알림이 수를 말한다). 늘면 그 조직에 격리가 몰린다는 뜻이다. */
  quarantineNoticeSuppressed: 'atmark.quarantine_notice.suppressed',
  /**
   * 틱의 대조(보안 리뷰 L1) — 최근 24시간 격리 메일 중 알림 창에 묶이지 않은 수(수신 트리거가 실패를 삼켰거나 에이전트 잠금을 못 잡았다). 0 이 정상. 알람 없음(비용 —
   * 0 보다 크면 `quarantine_notice.unrecorded` warn 로그).
   */
  quarantineNoticeUnrecorded: 'atmark.quarantine_notice.unrecorded',
  /** 보내기 직전 표지가 남은 채 임대가 끝나 다시 보내지 않고 닫은 알림(나갔는지 모른다 — 보낸 뒤 기록 실패 · 프로세스 죽음). 0 이 정상. 알람 없음. */
  quarantineNoticeUnsettledSend: 'atmark.quarantine_notice.unsettled_send',
  // --- AI 의심 메일 감시(ADR-0017 초안 · 경고 전용) — 알람은 `observability-stack.ts`(WP-B). 본문·점수 원값은 어떤 차원에도 없다.
  /** 결과 λ — 유효 하트비트 1건당 1. 차원 없음. 알람 `atmark-ai-watch-heartbeat-silence`(10분 0건, breaching, 액션은 조직이 켜질 때). */
  aiWatchHeartbeat: 'atmark.ai_watch.heartbeat',
  /** 결과 λ — `self_test: "fail"` 하트비트당 1. 차원 없음. */
  aiWatchSelfTestFail: 'atmark.ai_watch.self_test_fail',
  /** 결과 λ — 판정 기록 1건당 1(0행 재생은 세지 않는다). 차원 `outcome`(`ontime`|`late`). fail-skip 률의 분자. */
  aiWatchVerdicts: 'atmark.ai_watch.verdicts',
  /** 결과 λ — 판정 기록의 `now − enqueued_at`(ms). 차원 없음. */
  aiWatchVerdictLatencyMs: 'atmark.ai_watch.verdict_latency_ms',
  /** 결과 λ — 계약 위반 결과(스키마 · 모양). 차원 `reason`(`AiWatchRejectReason`). 위조·버전 불일치의 흔적. */
  aiWatchResultRejected: 'atmark.ai_watch.result_rejected',
  /** 결과 λ — flagged 판정의 밴드. 차원 `outcome`(`high`|`mid`). 알람 없음(모델 드리프트 대시보드). */
  aiWatchFlags: 'atmark.ai_watch.flags',
  /** inbound λ — 요청 큐 SendMessage 성공 1건당 1(shadow 포함). 차원 없음. fail-skip 률의 분모. */
  aiWatchEnqueued: 'atmark.ai_watch.enqueued',
  /** inbound λ — 요청 큐 전송 실패(작업 skipped · 보류 즉시 해제). 차원 없음. */
  aiWatchEnqueueFailed: 'atmark.ai_watch.enqueue_failed',
  /** inbound λ — 조직 1시간 상한(승격 규칙 7)에 걸려 작업을 만들지 않은 메일. 차원 없음. 알람 없음. */
  aiWatchRateCapped: 'atmark.ai_watch.rate_capped',
  /**
   * inbound λ — **고객 도메인**(`atmark.ai` 밖) 봉투 수신자 중 에이전트가 없어 `unknown_recipient` 로 버린 수(새로 기록한 거부 행만 — SQS 재전달의
   * duplicate 는 세지 않는다). 차원 없음(도메인은 기수 · 관측 PII 규칙 — 어느 도메인인지는 `inbound_rejections` 가 말한다). 알람
   * `atmark-domain-inbound-noisy`(시간당 합 `NOISY_INBOUND_HOURLY_THRESHOLD` 이상 — 도메인 합이라 한 도메인 상한보다 먼저 울린다).
   */
  inboundUnknownCustomDomain: 'atmark.inbound.unknown_recipient_custom_domain',
  // --- 실시간 WebSocket(묶음 E) — 힌트 푸시(best-effort). 알람 없음(대시보드). 차원 없음.
  /** 만드는 λ(수신 · 승인 · 풀기) — `PostToConnection` 성공 프레임 1개당 1. */
  realtimePushed: 'atmark.realtime.pushed',
  /** 만드는 λ — 푸시 실패(조회 · 전송 오류 · 1초 초과). 만드는 트랜잭션은 이미 커밋됐다 — 이벤트만 사라진다. */
  realtimePushFailed: 'atmark.realtime.push_failed',
  /** 만드는 λ — 대상 행 하나가 빌더 검증을 못 넘어 그 행만 건너뛰었다(나머지는 나간다). 0 이 정상 — 0 이 아니면 대상 함수 · 빌더가 어긋났다. */
  realtimePushRowSkipped: 'atmark.realtime.push_row_skipped',
  /** 실시간 λ — `$connect` 거부(토큰 · 쿼리 토큰 · 상한 · 비활성). */
  realtimeConnectRejected: 'atmark.realtime.connect_rejected',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

/**
 * 에이전트별 알람(메일 기본기 1차 — D10 인증코드 조회 · A3 MCP 취소)이 보는 **로그 이벤트 이름**. `observability-stack.ts` 의 Contributor
 * Insights 규칙이 api 로그 그룹에서 `$.event` 로 거르고 `$.agent_id` 로 기여자를 센다. 메트릭 차원에는 `agent_id` 를 둘 수 없으므로(위 "기수")
 * 에이전트별 판정은 로그가 한다 — `agent_id` 는 로그 어휘(`LOG_FIELD_KEYS`)에 있다. 이름을 두 번 적으면 규칙이 아무 줄도 보지 않는다
 * (METRIC_NAMES 와 같은 이유로 여기 한 곳에 둔다).
 *
 * 필드는 **동결된 로그 어휘 안에서** 싣는다(`test/arch/observability-pii.arch.test.ts` — 새 키를 만들지 않는다). 코드 값·URL·도메인·note 는 싣지 않는다.
 *   - `verificationLookup` — 조회마다 한 줄: `agent_id` · `outcome`(`VerificationLookupOutcome`) · `detail`(모드 `VerificationMode`).
 *   - `scheduledCancelled` — 취소마다 한 줄: `agent_id` · `route_id`(취소 경로 `http`|`mcp`) · `reason`(`CancelReasonCode`) · `detail`(schedule id).
 *   - `scheduledCancelRejected` — 에이전트 토큰의 취소가 보호에 막힐 때마다 한 줄: `agent_id` · `route_id`(`http`|`mcp`) · `outcome`
 *     (`rate_limited`|`not_agent_cancellable`). 상한을 넘으려는 시도 자체가 주입의 신호다(코드 리뷰 M7-a).
 *     규칙(`atmark-scheduled-cancels-by-agent`)은 **거부만** 센다(진윤겸 결정 2026-09-26) — 채널 무관(http·mcp, 보안 M1). 성공한 취소는 정상
 *     사용이라 세지 않는다(성공 줄 `scheduledCancelled` 는 조사용으로 남는다). 소유자 콘솔 취소는 두 줄 모두 내지 않는다.
 */
export const ALARM_LOG_EVENTS = {
  /**
   * 위험 보류(ADR-0016) — 강제 모드의 보류·거부(`held`) 또는 관찰 모드의 "보류했을" 평가(`observed`)마다 한 줄: `agent_id` · `route_id` · `reason`
   * (첫 위험 사유) · `outcome`. 규칙 `atmark-risk-holds-by-agent` 가 에이전트별로 센다(보류 급증 = 인젝션이 에이전트를 반복해 움직이는 흔적).
   */
  riskHold: 'risk_hold.held',
  verificationLookup: 'verification.lookup',
  scheduledCancelled: 'scheduled.cancelled',
  scheduledCancelRejected: 'scheduled.cancel_rejected',
} as const;

/** **차원 키의 전부.** `LOG_FIELD_KEYS` 보다 좁다 — `agent_id` 가 없다(위 "기수"). */
export const METRIC_DIMENSION_KEYS = ['route_id', 'verdict', 'reason', 'outcome', 'lane'] as const;

export type MetricDimensionKey = (typeof METRIC_DIMENSION_KEYS)[number];

/**
 * 차원 값의 타입 — 닫힌 유니온. `route_id` 만 `string` 인 것은 출처가 `OUTBOUND_ROUTES[].id` 하나라서다
 * (여기서 리터럴로 굳히면 매니페스트가 두 곳이 된다).
 */
export interface MetricDimensions {
  readonly route_id?: string;
  readonly verdict?: AuditDecision;
  /** 판정 사유, 또는 AI 감시 결과 거부 사유(`aiWatchResultRejected` 전용 — 닫힌 어휘). */
  readonly reason?: DecisionReason | AiWatchRejectReason;
  /** 발송 결과 두 값, 또는 인증코드 조회 결과(`verificationLookups` 전용 — 닫힌 다섯 값), 또는 AI 감시 시기·밴드(`aiWatchVerdicts`·`aiWatchFlags` 전용). */
  readonly outcome?: 'sent' | 'failed' | VerificationLookupOutcome | RiskHoldEvaluation | ExposureLevelOutcome | AiWatchTiming | Exclude<AiWatchBand, 'low'>;
  /** 문의 전달 차선(`contactRateGlobal` 전용 — 닫힌 두 값, `src/contact/intake.ts` `ContactLane`). */
  readonly lane?: 'support' | 'role';
}

/** 위험 보류 평가의 결말(`riskHoldEvaluated` 전용 — 닫힌 네 값). */
export type RiskHoldEvaluation = 'clear' | 'held' | 'observed' | 'skipped';

/** AI 감시 판정 시기(`aiWatchVerdicts` 전용 — 마감 안/뒤). */
export type AiWatchTiming = 'ontime' | 'late';

/** 노출 등급(`exposureRecorded` 전용 — `security/taint.ts` `TaintLevel`). */
export type ExposureLevelOutcome = 'T0' | 'T1' | 'T2';

/** CloudWatch 단위 — 쓰는 것만 둔다. */
export type MetricUnit = 'Count' | 'Milliseconds' | 'Seconds';

const KNOWN_DIMENSIONS = new Set<string>(METRIC_DIMENSION_KEYS);

/**
 * 메트릭 한 건을 EMF 로 방출한다. **던지지 않는다**(`writeLine` 이 삼킨다).
 * 차원 어휘 밖의 키는 버린다 — 모르는 차원이 기수 폭발의 입구다.
 */
export function emitMetric(
  name: MetricName,
  value: number,
  unit: MetricUnit,
  dimensions: MetricDimensions = {},
): void {
  const present: Record<string, string> = {};
  for (const [key, raw] of Object.entries(dimensions)) {
    if (!KNOWN_DIMENSIONS.has(key)) continue;
    if (typeof raw !== 'string' || raw === '') continue;
    present[key] = raw;
  }

  // 정렬한다 — 키 순서가 흔들리면 같은 조합의 집계가 조용히 둘로 쪼개진다.
  const dimensionNames = Object.keys(present).sort();

  // **빈 차원 집합을 항상 함께 방출한다.** EMF 는 적힌 조합만 발행하고 차원 없는 롤업을 만들지 않으므로,
  // 없으면 차원 없이 정의한 알람이 영원히 `INSUFFICIENT_DATA` 다. 비용은 이름당 시계열 하나.
  const dimensionSets = dimensionNames.length === 0 ? [[]] : [[], dimensionNames];

  let line: string;
  try {
    line = JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: dimensionSets,
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      ...present,
      [name]: value,
    });
  } catch {
    return;
  }
  writeLine(line);
}

/** 카운터 1건. 가장 흔한 형태라 이름을 준다. */
export function countMetric(name: MetricName, dimensions: MetricDimensions = {}): void {
  emitMetric(name, 1, 'Count', dimensions);
}
