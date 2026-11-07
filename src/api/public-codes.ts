/**
 * src/api/public-codes.ts — **내부 판정 코드 → 공개 코드** (가림 정책, `.omc/plans/docs-site.md` §veil).
 *
 * 공개 API(`/v1/**`)와 MCP 결과는 에이전트 컨텍스트와 사용자 문서로 그대로 복제된다. 거기에 인프라 공급자나 내부 휴리스틱을
 * 말하는 코드가 나가면 우리 구조를 밖에 적어 주는 셈이다. 그래서 **응답을 만드는 경계에서만** 바꾼다 — audit 행·투명성 로그
 * 잎·DB CHECK·로그는 원래 코드를 그대로 가진다(집계와 사후 검증의 축이 흔들리지 않게).
 *
 * 쓰는 자리: `decisionBody`(`outbound-http.ts` — 발송·답장·전달·초안·전환 공지의 `decision.reasons`, MCP 는 이 본문을 그대로
 * 옮긴다)와 `GET /v1/audit`(`routes/audit.ts` — `reasons`·`resolution_reason`). 새 공개 자리가 생기면 여기 함수를 부른다.
 *
 * 이 파일은 `src/policy/gate.ts` 를 import 하지 않는다 — `routes/audit.ts` 는 관문을 import 할 수 없는 조회 전용 진입점이다.
 */

import type { DecisionReason } from '../policy/types';

/**
 * **판정 사유 전부의 공개 이름.** `Record<DecisionReason, …>` 라 유니온에 사유가 늘면 여기서 컴파일이 멈춘다 — 새 사유가
 * 검토 없이 밖으로 나가지 않는다. 대부분은 소유자 정책·요금제·운영 상태를 말하는 이름이라 그대로 둔다. 바꾸는 것은 셋이다:
 *
 * | 내부 | 공개 | 이유 |
 * |---|---|---|
 * | `ses_account_level_suppression` | `suppression_list` | 공급자 이름. 받는 쪽의 반송·불만 이력이라는 뜻은 `suppression_list` 와 같다 — 이미 문서화된 코드를 다시 쓴다. |
 * | `warmup_daily_cap` | `daily_send_limit` | 내부 휴리스틱(첫 발송 뒤 단계적 상향). `plan_daily_cap`(업그레이드로 풀림)·`rate_limit_per_day`(소유자 정책)와 섞으면 할 일을 틀리게 알려 주므로 새 중립 이름. |
 * | `unregistered_route` | `evaluation_error` | 내부 구조(발송 경로 매니페스트). 공개 경로는 모두 등록돼 있어 밖에서 보이면 우리 쪽 결함이다 — "판정하지 못해 안전하게 막았다" 와 같다. |
 */
export const PUBLIC_REASON_CODES: Readonly<Record<DecisionReason, string>> = {
  // 거부 — Stage 0
  org_billing_blocked: 'org_billing_blocked',
  org_abuse_freeze: 'org_abuse_freeze',
  org_owner_paused: 'org_owner_paused',
  org_pending_review: 'org_pending_review',
  org_review_rejected: 'org_review_rejected',
  agent_not_active: 'agent_not_active',
  outbound_disabled: 'outbound_disabled',
  // 고객 도메인(ADR-0014) — 소유자가 콘솔에서 보는 도메인 상태 그대로의 이름. 단계 0 에서는 만들어지지 않는다.
  domain_suspended: 'domain_suspended',
  domain_plan_limit: 'domain_plan_limit',
  // 거부 — 신원 · 억제 · 목록
  from_forgery: 'from_forgery',
  // 이 에이전트의 주소지만 지금 쓸 수 없다(폐기된 별칭 — ADR-0014 개정). 위조와 가른다.
  from_inactive: 'from_inactive',
  recipient_is_self: 'recipient_is_self',
  suppression_list: 'suppression_list',
  ses_account_level_suppression: 'suppression_list',
  recipient_blocklisted: 'recipient_blocklisted',
  // 거부 — 한도 · 예산 · 내용
  rate_limit_per_minute: 'rate_limit_per_minute',
  rate_limit_per_hour: 'rate_limit_per_hour',
  rate_limit_per_day: 'rate_limit_per_day',
  recipients_per_message: 'recipients_per_message',
  plan_recipients_per_message: 'plan_recipients_per_message',
  warmup_daily_cap: 'daily_send_limit',
  plan_daily_cap: 'plan_daily_cap',
  // 도메인 워밍업도 같은 내부 휴리스틱이다 — `warmup_daily_cap` 과 같은 중립 이름(ADR-0014).
  domain_warmup_daily_cap: 'daily_send_limit',
  budget_exhausted: 'budget_exhausted',
  attachment_bytes_exceeded: 'attachment_bytes_exceeded',
  mime_type_not_allowed: 'mime_type_not_allowed',
  recipient_ceiling_exceeded: 'recipient_ceiling_exceeded',
  // 거부 — 발신 모드
  recipient_not_allowlisted: 'recipient_not_allowlisted',
  reply_only_no_inbound_thread: 'reply_only_no_inbound_thread',
  reply_only_inbound_quarantined: 'reply_only_inbound_quarantined',
  // 거부 — 관문
  unregistered_route: 'evaluation_error',
  evaluation_error: 'evaluation_error',
  release_window_expired: 'release_window_expired',
  // 허용
  allowlist_match: 'allowlist_match',
  unrestricted_mode: 'unrestricted_mode',
  not_blocklisted: 'not_blocklisted',
  seed_relationship: 'seed_relationship',
  standing_approval: 'standing_approval',
  auto_approve_reply_within_thread: 'auto_approve_reply_within_thread',
  auto_approve_verification_sender: 'auto_approve_verification_sender',
  auto_approve_domain: 'auto_approve_domain',
  approval_granted: 'approval_granted',
  reply_within_thread: 'reply_within_thread',
  // 승인 대기 · 유예
  new_recipient: 'new_recipient',
  transition_announcement: 'transition_announcement',
  bootstrap_grace: 'bootstrap_grace',
  // 위험 보류(ADR-0016) — 무엇이 걸렸는지(오염 맥락 · DLP 계열)는 소유자 승인 화면에만 보인다. 에이전트에게 계열을 알려 주면 피해 갈
  // 인코딩을 고르는 단서가 된다 — 하나의 중립 이름으로 접는다.
  tainted_context: 'risk_review',
  dlp_atmark_credential: 'risk_review',
  dlp_third_party_secret: 'risk_review',
  dlp_verification_code: 'risk_review',
  dlp_secret_link: 'risk_review',
  dlp_inbound_copy: 'risk_review',
  dlp_scan_limit: 'risk_review',
  reply_only_risk_hold: 'reply_only_risk_hold',
  // 소유자 발신 승인(`send_approval = always` — ADR-0016 2026-10-08). 소유자가 고른 설정이라 그대로 말한다(회피 단서가 아니다).
  owner_requires_approval: 'owner_requires_approval',
  reply_only_owner_approval: 'reply_only_owner_approval',
};

/**
 * 사유 하나의 공개 이름. 표에 없는 문자열은 **옛 audit 행의 옛 이름**(`recipient_not_in_allowlist`·`blocklist`·
 * `outbound_mode_disabled` …)이다 — 모두 소유자 정책의 이름이라 그대로 둔다.
 */
export function publicReasonCode(code: string): string {
  return Object.hasOwn(PUBLIC_REASON_CODES, code) ? PUBLIC_REASON_CODES[code as DecisionReason] : code;
}

/** 사유 배열의 공개 판. 순서를 지키고 겹침은 하나로 접는다(`suppression_list` 와 공급자 억제가 함께 걸리면 한 번). */
export function publicReasons(codes: readonly string[]): string[] {
  return [...new Set(codes.map(publicReasonCode))];
}

/** 전송단이 실패한 시도의 공개 해소 사유 — 502 응답의 `error` 와 같은 코드다. */
export const PUBLIC_RESOLUTION_SEND_FAILED = 'send_failed';
/** 모양을 모르는 해소 사유의 중립값. `sent` 는 정확히 `sent` 하나라 그 밖은 모두 나가지 않은 시도다. */
export const PUBLIC_RESOLUTION_OTHER = 'not_sent';
/** 뜻이 그대로 공개돼도 되는 해소 사유(소유자의 승인 결말·발송 성공). */
const PUBLIC_RESOLUTIONS: ReadonlySet<string> = new Set(['sent', 'approval_rejected', 'approval_expired']);
const RELEASE_DENIED_PREFIX = 'release_denied:';
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * `GET /v1/audit` 의 `resolution_reason` 공개 판.
 *
 * 저장값은 `sent` · `failed:<전송단 오류 원문>` · `approval_rejected` · `approval_expired` · `release_denied:<거부 사유>` 다
 * (`db/repositories/audit-sink.ts` · `approval-store.ts` · `policy/gate.ts`). **`failed:` 뒤는 SDK·저장소 오류 문장**이라 그대로
 * 내보내지 않는다 — `send_failed` 로 접는다. `release_denied:` 뒤는 판정 사유 코드라 `publicReasonCode` 를 지난다.
 * 그 밖의 값은 모양을 모르므로 `not_sent` 로 둔다.
 */
export function publicResolutionReason(value: string | null): string | null {
  if (value === null) return null;
  if (PUBLIC_RESOLUTIONS.has(value)) return value;
  if (value.startsWith('failed:')) return PUBLIC_RESOLUTION_SEND_FAILED;
  if (value.startsWith(RELEASE_DENIED_PREFIX)) {
    const reason = value.slice(RELEASE_DENIED_PREFIX.length);
    if (CODE.test(reason)) return `${RELEASE_DENIED_PREFIX}${publicReasonCode(reason)}`;
  }
  return PUBLIC_RESOLUTION_OTHER;
}
