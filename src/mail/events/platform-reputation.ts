/**
 * src/mail/events/platform-reputation.ts — **공유 도메인(`atmark.ai`) 조직 평판 자동 동결**(2026-10-13 보안 후속 · ADR-0004 2026-10-13 덧붙임).
 *
 * 왜: 콘솔에서 만든 새 에이전트의 기본값이 "발신 전체"(ADR-0007 2026-10-13 개정)다. 고객 도메인은 도메인마다 평판 동결이 있지만
 * (`src/domains/reputation.ts`), `atmark.ai` 로 보내는 메일은 조직 단위 자동 제동이 없었다 — 한 조직의 반송 · 신고가 **모든 조직이 함께 쓰는**
 * SES 계정 평판(검토선 bounce 5% · complaint 0.1%)을 끌어내린다. 그래서 조직마다 `atmark.ai` 발신의 bounce · complaint 를 창 둘(7일 · 24시간)로
 * 재고, 선을 넘으면 그 조직을 **플랫폼 동결**(`organizations.abuse_freeze` → Stage 0 `org_abuse_freeze` — 운영자만 푼다)한다.
 *
 * 판정은 이 파일의 순수 함수와 DB 정의자 `atmark_platform_reputation_judge`(202610131620)가 **같은 식**이다 — 통합 테스트가 격자로 대조한다.
 * 집행(동결 · 감사 · 투명성 로그)은 DB 정의자 `atmark_platform_reputation_check` 가 한 트랜잭션에서 한다. SES 이벤트 소비자가 bounce · complaint
 * 를 기록할 때마다(재전달 포함) 그 메시지로 부른다(`workers/ses-event-consumer.ts`).
 *
 * **수는 수신자 단위다**(PR #94 적대 검토 M-4 — 202610131612): 분모 = 전달 시도 수신자(delivery · bounce 알림의 `recipient_count` 합), bounce 분자 =
 * 영구 bounce 수신자 합(계정 억제 목록 `OnAccountSuppressionList` 는 빼고 — SES 평판에 들지 않는다), complaint = **서로 다른 신고자**(주소 해시) 수와
 * **서로 다른 신고 도메인** 수.
 *
 * **선(SES 검토선보다 보수적 — 공유 도메인은 한 조직의 사고가 모두의 사고다):**
 *   - complaint: 창의 전달 시도 ≥ 50 **그리고** 서로 다른 신고자 ≥ 3 **그리고** 신고 도메인 계열 ≥ 2 **그리고** 신고자 ÷ 전달 시도 ≥ 0.08% → 동결.
 *     신고자는 정규형(`canonicalComplainant` — 소문자 · `+tag` 절단)으로, 도메인은 **계열**(`complaintDomainFamily` — outlook/hotmail/live/msn ·
 *     yahoo.* · gmail/googlemail 은 각각 하나)로 센다. 같은 메일함의 `+tag` 셋이나 한 메일 서비스의 별칭 도메인으로는 신고자 · 도메인 수를 늘리지
 *     못한다(재검증 R-1). 볼륨 바닥(50)은 몇 통만 보내는 조직이 신고 셋에 얼지 않게 한다.
 *   - (영구) bounce: 창의 전달 시도 ≥ 50 **그리고** bounce 수신자 ≥ 10 **그리고** 윌슨 95% 하한 ≥ 3% → 동결(최소 볼륨 — 몇 통의 오타 · 유도된 없는 주소로
 *     작은 조직이 얼지 않게).
 *   - **계정 기여분**(7일): 조직의 7일 전달 시도 ≥ 200 일 때만 — bounce ÷ SES 계정 전체 전달 ≥ 1.0%p(≥ 10) · 신고자 ÷ 같은 분모 ≥ 0.02%p(≥ 3 · 도메인 ≥ 2).
 *     계정 전체 검토선의 20% 를 한 조직이 채우는 것을 막는다. 볼륨 바닥(200)이 없으면 계정 볼륨이 작은 지금 "신고 3건 = 동결" 이 되어 소량 조직을
 *     겨냥한 DoS 가 싸진다(적대 검토 M-3).
 *   - 경고(알람만 — 바닥 없음): 신고자 ≥ 2 그리고 0.05% · bounce ≥ 5 그리고 윌슨 하한 ≥ 2%.
 *
 * **남은 위험(ADR-0004 2026-10-13 · 최종 검증 I-2):** 서로 다른 계열의 **무료 계정 둘**이면 별칭 로컬파트(서비스가 주는 별칭 주소 · 같은 메일함의 다른 철자 —
 * 우리는 `+tag` 만 접는다)로 신고자 3명 · 계열 2를 만들 수 있다. 피해 조직의 에이전트가 그 주소들로 보내게 만들 수 있고 피해 조직의 창 전달 시도가 50 이상
 * 3 750 미만이면 complaint 비율 경로로 얼 수 있다. 같은 메일함의 `+tag` · 같은 서비스의 별칭 도메인만으로는 안 된다. 동결은 되돌릴 수 있고 감사 · 알람 62 가 남는다 — 운영자 응답 목표는 ADR 에 적었다.
 * 에이전트 단위 1단계(그 에이전트만 정지)는 두지 않았다: 조직이 에이전트를 새로 만들어 이어 보내는 길을 닫으려면 결국 조직 단위가 필요하고, 두 단계 상태
 * 기계가 운영자 해제 경로를 둘로 만든다(같은 ADR).
 *
 * **세는 범위:** `ses_events` ⋈ `messages`(`from_domain = 'atmark.ai'`) ⋈ `agents`(조직) — 조직의 **모든** 에이전트(삭제 · 정지 포함) · 모든 주소(대표 ·
 * 앵커 · 별칭). 창 = 이벤트를 받은 시각(`received_at`), 그리고 **운영자가 감사된 해제(`org.abuse_unfreeze`, 운영자 행위자 행만)를 한 시각 이후만**.
 *
 * **세지 않는 것 · 얼리지 않는 것:**
 *   - 시스템 메일(로그인 · 가입 · 환영 `onve@` · 알림)은 `messages` 행이 없다 — 조직 지표에 들지 않는다.
 *   - 고객 도메인 발신은 도메인 평판(`src/domains/reputation.ts`)이 따로 본다.
 *   - **운영자 예약 주소를 가진 조직**(support@ · abuse@ · postmaster@ 의 운영 조직)은 판정만 하고 자동 동결하지 않는다(`freeze_exempt` — 알람만).
 */

import { wilsonLowerBound } from '../../domains/reputation';

/** 평판 동결을 거는 공유 도메인(에이전트 주소 도메인). */
export const PLATFORM_REPUTATION_DOMAIN = 'atmark.ai';

export const PLATFORM_REPUTATION_THRESHOLDS = {
  /** 7일 창과 24시간 창 — 같은 식. */
  windowsMs: [7 * 24 * 3_600_000, 24 * 3_600_000],
  freezeComplaintRate: 0.0008,
  freezeComplaintMinCount: 3,
  /** 신고 경로는 서로 다른 신고 도메인 **계열**이 이만큼 있어야 한다(적대 검토 M-3 · 재검증 R-1). */
  freezeComplaintMinDomains: 2,
  /** 신고 경로의 창 볼륨 바닥(전달 시도 수신자 — 재검증 R-1). */
  freezeComplaintMinAttempts: 50,
  freezeBounceWilsonLower: 0.03,
  freezeBounceMinCount: 10,
  /** bounce 경로의 창 볼륨 바닥(전달 시도 수신자). */
  freezeBounceMinAttempts: 50,
  /** 계정 기여분(7일) — 분모 = SES 계정 전체 전달 시도. 조직 볼륨 바닥이 먼저다. */
  freezeAccountMinOrgAttempts: 200,
  freezeAccountBounceContribution: 0.01,
  freezeAccountBounceMinCount: 10,
  freezeAccountComplaintContribution: 0.0002,
  freezeAccountComplaintMinCount: 3,
  warnComplaintRate: 0.0005,
  warnComplaintMinCount: 2,
  warnBounceWilsonLower: 0.02,
  warnBounceMinCount: 5,
  /** 메시지 쪽 범위 — 창 시작보다 이만큼 앞서 보낸 메일의 늦은 이벤트까지만(질의 상한). */
  messageLookbackMs: 30 * 24 * 3_600_000,
} as const;

/** 감사 행 · 로그의 시스템 행위자(`owner_actions.operator_actor`). */
export const PLATFORM_REPUTATION_ACTOR = 'system:platform_reputation';
/** 동결 · 해제 감사 행위 코드(`owner_actions.action`). 해제는 운영자(`setOrganizationFreezeAuditedOp` — CLI · 운영자 웹)가 적는다. */
export const ORG_ABUSE_FREEZE_ACTION = 'org.abuse_freeze';
export const ORG_ABUSE_UNFREEZE_ACTION = 'org.abuse_unfreeze';

export interface PlatformReputationCounts {
  /** 전달 시도 수신자(delivery + bounce 알림의 수신자 합 — bounce 종류 무관). */
  readonly attempts: number;
  /** 영구 bounce 수신자(계정 억제 목록 제외). */
  readonly bounces: number;
  /** 서로 다른 신고자 수. */
  readonly complaints: number;
  /** 서로 다른 신고 도메인 수. */
  readonly complaintDomains: number;
}

export type PlatformReputationAction = 'ok' | 'warn' | 'freeze';

export interface PlatformReputationVerdict {
  readonly action: PlatformReputationAction;
  /** 걸린 선(`7d:complaint_rate` 처럼 창 접두 — 조직 · 주소 없음). */
  readonly reasons: readonly string[];
}

function windowReasons(counts: PlatformReputationCounts): { readonly freeze: string[]; readonly warn: string[] } {
  const t = PLATFORM_REPUTATION_THRESHOLDS;
  const complaintRate = counts.attempts > 0 ? counts.complaints / counts.attempts : 0;
  // bounce 는 전달 시도의 부분집합 — 넘는 입력은 시도 수로 자른다(DB `atmark_wilson_lower` 와 같은 자르기).
  const bounceLower = wilsonLowerBound(Math.min(Math.max(counts.bounces, 0), counts.attempts), counts.attempts);
  const freeze: string[] = [];
  const warn: string[] = [];
  if (
    counts.attempts >= t.freezeComplaintMinAttempts &&
    counts.complaints >= t.freezeComplaintMinCount &&
    counts.complaintDomains >= t.freezeComplaintMinDomains &&
    complaintRate >= t.freezeComplaintRate
  ) {
    freeze.push('complaint_rate');
  }
  if (counts.attempts >= t.freezeBounceMinAttempts && counts.bounces >= t.freezeBounceMinCount && bounceLower >= t.freezeBounceWilsonLower) freeze.push('bounce_wilson');
  if (counts.complaints >= t.warnComplaintMinCount && complaintRate >= t.warnComplaintRate) warn.push('complaint_rate_warn');
  if (counts.bounces >= t.warnBounceMinCount && bounceLower >= t.warnBounceWilsonLower) warn.push('bounce_wilson_warn');
  return { freeze, warn };
}

/** 조직 하나의 판정 — 두 창 + 계정 기여분. 동결 사유가 하나라도 있으면 동결, 아니면 경고 사유가 있으면 경고. */
export function judgePlatformReputation(input: {
  readonly week: PlatformReputationCounts;
  readonly day: PlatformReputationCounts;
  readonly accountAttemptsWeek: number;
}): PlatformReputationVerdict {
  const t = PLATFORM_REPUTATION_THRESHOLDS;
  const week = windowReasons(input.week);
  const day = windowReasons(input.day);
  const contribution: string[] = [];
  if (input.accountAttemptsWeek > 0 && input.week.attempts >= t.freezeAccountMinOrgAttempts) {
    if (input.week.bounces >= t.freezeAccountBounceMinCount && input.week.bounces / input.accountAttemptsWeek >= t.freezeAccountBounceContribution) {
      contribution.push('account_bounce_contribution');
    }
    if (
      input.week.complaints >= t.freezeAccountComplaintMinCount &&
      input.week.complaintDomains >= t.freezeComplaintMinDomains &&
      input.week.complaints / input.accountAttemptsWeek >= t.freezeAccountComplaintContribution
    ) {
      contribution.push('account_complaint_contribution');
    }
  }
  const freeze = [...week.freeze.map((r) => `7d:${r}`), ...day.freeze.map((r) => `24h:${r}`), ...contribution.map((r) => `7d:${r}`)];
  if (freeze.length > 0) return { action: 'freeze', reasons: freeze };
  const warn = [...week.warn.map((r) => `7d:${r}`), ...day.warn.map((r) => `24h:${r}`)];
  return { action: warn.length > 0 ? 'warn' : 'ok', reasons: warn };
}

/**
 * 신고자 정규형(재검증 R-1) — 소문자 · 앞뒤 공백 제거 · 로컬파트의 첫 `+` 부터 `@` 앞까지 절단(`x+1@d` ≡ `x@d`). `@` 가 없으면 `null`.
 * 정규형 주소의 sha256 이 `ses_events.complaint_recipient_hashes` 다.
 */
export function canonicalComplainant(address: string): string | null {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const plus = local.indexOf('+');
  const bare = plus === -1 ? local : local.slice(0, plus);
  return bare === '' ? null : `${bare}@${value.slice(at + 1)}`;
}

/**
 * 신고 도메인 **계열**(재검증 R-1 · 최종 검증 I-1) — 한 메일 서비스의 별칭 도메인은 하나로 센다. 작은 닫힌 지도이고, 접미사는 **알려진 공개 접미사 모양에만**
 * 맞춘다(`live.nation.com` · `outlook.acme.com` · `msn.com.evil.io` 같은 남의 도메인을 계열로 접지 않는다). 넓히면 이 표와 테스트를 함께 고친다(SQL 쪽 사본은 없다 —
 * 해시는 이 함수의 값으로만 만든다):
 *   - `microsoft` — outlook · hotmail · live · msn + (`com` | `co.XX` | `com.XX` | `XX`).
 *   - `yahoo` — yahoo + 같은 접미사 · ymail.com · rocketmail.com.
 *   - `google` — gmail.com · googlemail.com.
 *   - `apple` — icloud.com · me.com · mac.com.
 * 그 밖의 도메인은 도메인 그대로. 이 값의 sha256 이 `ses_events.complaint_domain_hashes` 다.
 */
const PUBLIC_SUFFIX = '(com|co\\.[a-z]{2}|com\\.[a-z]{2}|[a-z]{2})';
const MICROSOFT_FAMILY = new RegExp(`^(outlook|hotmail|live|msn)\\.${PUBLIC_SUFFIX}$`);
const YAHOO_FAMILY = new RegExp(`^yahoo\\.${PUBLIC_SUFFIX}$`);

export function complaintDomainFamily(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (MICROSOFT_FAMILY.test(value)) return 'family:microsoft';
  if (YAHOO_FAMILY.test(value) || value === 'ymail.com' || value === 'rocketmail.com') return 'family:yahoo';
  if (value === 'gmail.com' || value === 'googlemail.com') return 'family:google';
  if (value === 'icloud.com' || value === 'me.com' || value === 'mac.com') return 'family:apple';
  return value;
}

/** 신고자 해시를 지우는 보존 기간(일) — 7일 창 + 하루 여유. 스위퍼가 이보다 오래된 행의 해시를 NULL 로(재검증 I-1, `atmark_purge_complaint_hashes`). */
export const COMPLAINT_HASH_RETENTION_DAYS = 8;

/**
 * DB 정의자 `atmark_platform_reputation_check` 의 결과 하나.
 *   - `not_platform` — 그 메시지는 고객 도메인 발신(도메인 평판이 본다).
 *   - `ok` · `warn` — 판정 그대로(경고는 알람).
 *   - `frozen` — 이번 호출이 조직을 동결했다(감사 · 투명성 로그 잎 · 알람).
 *   - `already_frozen` — 동결선을 넘었지만 이미 동결돼 있다(쓰기 0).
 *   - `freeze_exempt` — 동결선을 넘었지만 운영자 예약 주소 조직이다(쓰기 0 · 알람 — 사람이 판단).
 *   - `freeze_deferred` — 동결선을 넘었지만 투명성 로그 서열기가 아직 운영자 행위자를 옮기지 못한다(`tlog_capabilities` 없음 — 배포 순서, 쓰기 0 · 알람).
 */
export type PlatformReputationOutcome = 'not_platform' | 'ok' | 'warn' | 'frozen' | 'already_frozen' | 'freeze_exempt' | 'freeze_deferred';

export interface PlatformReputationResult {
  readonly organizationId: string;
  readonly outcome: PlatformReputationOutcome;
  readonly reasons: readonly string[];
}
