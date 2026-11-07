/**
 * 릴리스 재평가 거부의 **분류표**와 재시도 계획(§4.3). 재평가 거부를 전부 `release_denied` 로 닫으면 시간이 풀어 줄 거부
 * (분당 한도 등)에 사람이 승인한 메일이 영구 종결된다(T3 실측: 20통 중 15통). 분류는 여기 한 곳에만 있다 — 관문이 이 표로
 * 닫을지 미룰지 정하고 워커는 재시도 시각만 적는다.
 *
 * `satisfies Record<DenyReason, …>` 라 새 사유가 생기면 컴파일이 멈춘다 — "분류 누락 → 영구" 기본값을 두지 않는다
 * (`release-deferral.test.ts` 가 유니온 원문과 런타임에서 한 번 더 대조한다).
 *
 * 기준 — **사람의 승인이 유효한 채로 시간(또는 소유자의 설정 변경)만으로 풀리는가.**
 *   - 일시적: 분·시·일 한도, 워밍업 캡, 요금제 한도, 예산, 평가 실패 — 속도·양·인프라의 사실.
 *   - 영구: kill-switch, 신원, 억제, 차단, 수신자 수, 내용 가드, 모드 거부, 미등록 경로 — 상대·봉투·의사의 사실.
 *     봉투는 사람이 본 그대로 고정이고, kill-switch 는 "멈춰라" 이지 "나중에 몰아서 보내라" 가 아니다.
 * 예산은 소유자가 올리면 풀리고(영구면 승인을 다시 받아야 한다 — 승인 피로), `evaluation_error` 는 장애가 승인을 무효로 만들지 않는다.
 * 스스로 풀리지 않는 일시적 거부도 창 끝에서 닫힌다(무한 재시도 없음).
 */

import type { Decision, DenyReason } from './types';

/** 거부 사유 하나의 성질. */
export type DenialPersistence =
  | { readonly kind: 'permanent' }
  /** 시간이 지나면 풀린다. `fallbackRetrySeconds` 는 규칙이 `retry_after` 를 주지 않을 때만 쓴다. */
  | { readonly kind: 'transient'; readonly fallbackRetrySeconds: number };

const PERMANENT: DenialPersistence = { kind: 'permanent' };

function transient(fallbackRetrySeconds: number): DenialPersistence {
  return { kind: 'transient', fallbackRetrySeconds };
}

const MINUTE = 60;
const HOUR = 3600;

/** 분류표 — 키 집합이 `DenyReason` 과 정확히 같아야 컴파일된다. */
export const DENY_REASON_PERSISTENCE = {
  // Stage 0 — kill switches. "멈춰라" 는 "나중에 몰아서" 가 아니다(머리말).
  org_billing_blocked: PERMANENT,
  org_abuse_freeze: PERMANENT,
  // 소유자 정지도 그때 걸린 것을 죽인다 — 풀리는 순간 대기열이 흘러나가면 안 된다(멈춘 이유가 그 대기열일 수 있다).
  org_owner_paused: PERMANENT,
  // 검토 전·거절 조직 — 같은 이유. 운영자의 활성화는 검토 전에 쌓인 대기열의 승인이 아니다.
  org_pending_review: PERMANENT,
  org_review_rejected: PERMANENT,
  agent_not_active: PERMANENT,
  // 발신 모드 "전부 X" — 켜는 순간 밀린 승인분이 나가면 끈 이유를 무력화한다.
  outbound_disabled: PERMANENT,
  // 고객 도메인 정지·제거(ADR-0014) — kill-switch 와 같은 이유.
  domain_suspended: PERMANENT,
  // 요금제 강등으로 정지된 도메인 — 업그레이드하면 같은 봉투가 나간다.
  domain_plan_limit: transient(HOUR),
  // Stage 1 — 봉투는 고정이다.
  from_forgery: PERMANENT,
  from_inactive: PERMANENT,
  recipient_is_self: PERMANENT,
  // Stage 2·3 — 상대에 관한 사실(바운스·불만·차단 의사).
  suppression_list: PERMANENT,
  ses_account_level_suppression: PERMANENT,
  recipient_blocklisted: PERMANENT,
  // Stage 4 — 속도·양. 규칙이 `retry_after` 를 준다.
  rate_limit_per_minute: transient(MINUTE),
  rate_limit_per_hour: transient(HOUR),
  rate_limit_per_day: transient(HOUR),
  warmup_daily_cap: transient(HOUR),
  plan_daily_cap: transient(HOUR),
  domain_warmup_daily_cap: transient(HOUR),
  // Stage 4 이지만 봉투의 성질이다(소유자 정책이 묶었다).
  recipients_per_message: PERMANENT,
  // 요금제만 묶었다(ADR-0011 §9) — 요금제가 풀리면 같은 봉투가 나간다.
  plan_recipients_per_message: transient(HOUR),
  // Stage 5 — 월 경계·예산 변경으로 풀린다(머리말).
  budget_exhausted: transient(HOUR),
  // Stage 6 — 내용 가드. 봉투·첨부는 고정이다.
  attachment_bytes_exceeded: PERMANENT,
  mime_type_not_allowed: PERMANENT,
  recipient_ceiling_exceeded: PERMANENT,
  // Stage 7 — 목록 추가는 앞으로의 발송에 대한 결정이지 지나간 봉투의 승인이 아니다.
  recipient_not_allowlisted: PERMANENT,
  reply_only_no_inbound_thread: PERMANENT,
  // 격리는 수신 시점의 불변 판정이다.
  reply_only_inbound_quarantined: PERMANENT,
  // 관문 단계.
  unregistered_route: PERMANENT,
  evaluation_error: transient(5 * MINUTE),
  // 시간이 만든 거부다 — 기다릴수록 더 늦는다.
  release_window_expired: PERMANENT,
  reply_only_risk_hold: PERMANENT,
  reply_only_owner_approval: PERMANENT,
} as const satisfies Record<DenyReason, DenialPersistence>;

/** 재시도 시각에 더하는 여유(초). 카운터 윈도가 경계를 포함해(`>= now - 1 minute`) 정확히 60초 뒤의 재시도는 다시 거부된다. */
export const RELEASE_RETRY_MARGIN_SECONDS = 1;

/**
 * 허용 쪽의 창 끝 유예(초). 마지막 재시도는 정확히 창 끝에 잡히고 스윕(1분)·lease 재집기(300초) 뒤에 집히므로, 0 이면
 * 창 끝의 재평가가 허용이어도 닫힌다. 15분 = 스윕 + 재집기 + 여유. 거부 쪽은 유예가 없다.
 */
export const RELEASE_WINDOW_GRACE_SECONDS = 15 * MINUTE;

/**
 * 허용된 릴리스의 창이 닫혔는가(`now >= deadlineAt + 유예`) — 닫혔으면 보내지 않는다. 창 검사가 거부 쪽에만 있으면 멈췄던 워커가
 * 사흘 뒤 승인분을 전부 내보낸다. 관문(`reserveRelease`)이 쓰고, 일정 저장소(`claimDueReleases`)는 같은 식을 SQL 로 적는다.
 */
export function releaseWindowClosed(now: Date, deadlineAt: Date): boolean {
  return now.getTime() >= deadlineAt.getTime() + RELEASE_WINDOW_GRACE_SECONDS * 1000;
}

/** 관문이 릴리스를 닫지 않고 미룬다는 결정. */
export interface ReleaseDeferral {
  /** 다음 릴리스 시각 — 창 끝을 넘지 않는다. */
  readonly retryAt: Date;
  /** 미룬 이유 — 재평가의 첫 거부 사유(`approval_releases.last_deferral_reason`). */
  readonly reason: DenyReason;
}

function persistenceOf(reason: string): DenialPersistence | null {
  return Object.hasOwn(DENY_REASON_PERSISTENCE, reason)
    ? DENY_REASON_PERSISTENCE[reason as DenyReason]
    : null;
}

/**
 * 릴리스 재평가 거부 — 미룰 것인가(재시도 시각) / 닫을 것인가(`null`). 닫는 경우: 거부가 아니다 · 사유 중 **하나라도** 영구 ·
 * 창이 끝났다(무한 재시도 없음) · 거부 사유가 하나도 없다(시간이 풀어 준다는 근거가 없다).
 */
export function planReleaseRetry(decision: Decision, now: Date, deadlineAt: Date): ReleaseDeferral | null {
  if (decision.verdict !== 'denied') return null;
  if (now.getTime() >= deadlineAt.getTime()) return null;

  let first: DenyReason | null = null;
  let fallbackSeconds = 0;
  for (const reason of decision.reasons) {
    const persistence = persistenceOf(reason);
    if (persistence === null) continue;
    if (persistence.kind === 'permanent') return null;
    first ??= reason as DenyReason;
    fallbackSeconds = Math.max(fallbackSeconds, persistence.fallbackRetrySeconds);
  }
  if (first === null) return null;

  const waitSeconds = (decision.retryAfterSeconds ?? fallbackSeconds) + RELEASE_RETRY_MARGIN_SECONDS;
  const retryAt = Math.min(now.getTime() + waitSeconds * 1000, deadlineAt.getTime());
  return { retryAt: new Date(retryAt), reason: first };
}
