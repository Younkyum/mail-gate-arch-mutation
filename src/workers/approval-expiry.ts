/**
 * `workers/approval-expiry` — **TTL 스위퍼** (계획 §3.4 4조, `src/workers/approval-expiry.ts`).
 *
 * **발송하지 않는 워커다** — `NON_SENDING_ENTRYPOINTS` 에 있다. 만료의 뜻이 "보내지 않는다" 이고,
 * 이 파일은 관문을 import 하지 않으며 `approval/service.ts` 도 마찬가지다. 그래서 "만료가 발송을
 * 일으킨다" 는 경로는 **설정이 아니라 import 그래프에서** 존재하지 않는다 — Layer C 가 이 파일의
 * 직접 import 를, `test/arch/approval-boundary.arch.test.ts` 가 전이적 import 폐포를 본다.
 *
 * **`approval.expired` 웹훅(AC-d3)은 여기서 보내지 않는다.** 서비스가 이벤트를 만들고 저장소가 만료 전이와
 * **같은 트랜잭션**에서 outbox 에 적는다 — 전이에 지면 이벤트도 없고, 두 번 돌아도 dedupe 키가 1회로 만든다.
 * 실제 HTTP 는 `workers/webhook-dispatcher` 가 outbox 에서 꺼내 보낸다.
 *
 * 스케줄(EventBridge 1분 주기 등)은 인프라의 일이다. 이 함수는 한 번의 스윕만 한다.
 *
 * **발신 스니펫 보존 스윕도 이 스케줄에 얹혀 있다**(2026-09-24 검증 F3 — `runSnippetRetention`). 승인과 무관하지만 새 Lambda·새 DB
 * 롤을 만들지 않으려고 기존 앱 롤 스케줄 워커를 골랐다. 스윕이 여는 쓰기는 `messages.snippet` → NULL(365일 넘은 행) 하나뿐이다.
 */

import { sweepExpiredRequests, type ApprovalStore, type SweepResult } from '../approval/service';
import { INVITED_USER_ERASURE_BATCH, type InvitedUserErasure, type InvitedUserErasureResult } from '../db/repositories/invited-user-erasure';
import type { InjectionSignalRetention } from '../db/repositories/injection-signal-retention';
import type { ComplaintHashRetention } from '../db/repositories/complaint-hash-retention';
import type { LoginCodeAttemptRetention } from '../db/repositories/login-code-attempt-retention';
import type { OpsRetention } from '../db/repositories/ops-retention';
import type { OrgApiWindowRetention } from '../db/repositories/org-api-window-retention';
import type { RealtimeConnectionRetention } from '../db/repositories/realtime-connection-store';
import type { SignupLinkRetention } from '../db/repositories/signup-link-retention';
import { SNIPPET_RETENTION_BATCH, type SnippetRetention } from '../db/repositories/snippet-retention';
import { log } from '../observability/logger';
import { emitMetric, METRIC_NAMES } from '../observability/metrics';
import { emitOpsMetric, OPS_METRIC_NAMES } from '../ops/metrics';

export interface ApprovalExpiryDependencies {
  readonly approvals: ApprovalStore;
  /** 발신 스니펫 보존 스윕(F3). */
  readonly snippets: SnippetRetention;
  /** `/org-api` 창 행 보존(ADR-0010 L5) — 7일 넘은 행. */
  readonly orgApiWindows: OrgApiWindowRetention;
  /** 로그인·가입 코드 verify 시도 원장 보존(2026-09-28 L3) — 하루 넘은 행. */
  readonly loginCodeAttempts: LoginCodeAttemptRetention;
  /** 초대만 받은 사용자 주소 지우기(ADR-0010 L7) — 하루 한 번(`runInvitedUserErasure` 가 거른다). */
  readonly invitedUsers: InvitedUserErasure;
  /** 쓰이지 않은 가입 링크 보존(M2) — 하루 한 번(`runSignupLinkRetention` 이 거른다). */
  readonly signupLinks: SignupLinkRetention;
  /** 호스팅 운영자 콘솔(202609290500) — 코드 원장 보존 · 7일 넘은 접근 요청 만료 · census(알람 #31 · #32). 매 스윕(5분). */
  readonly ops: OpsRetention;
  /** 인젝션 구조 방어 신호 보존(ADR-0016, 202610041000) — 노출 8일 · 복사 지문 30일 · 코드 지문 24시간. 매 스윕(5분). */
  readonly injectionSignals: InjectionSignalRetention;
  /** 실시간 연결 표(묶음 E, 202610081300) — 만료 · 핑 없는 연결 닫기 · 7일 넘게 닫힌 행 지우기. 앱 롤은 함수 EXECUTE 하나. */
  readonly realtimeConnections: RealtimeConnectionRetention;
  /** 신고자 해시 보존(202610131612 · 재검증 I-1) — 받은 지 8일 넘은 SES complaint 행의 해시 NULL. 매 스윕(5분). */
  readonly complaintHashes: ComplaintHashRetention;
  readonly now: () => Date;
}

/** 한 스윕에서 만료시킬 최대 요청 수. 넘치면 다음 스윕이 이어받는다(오래된 순). */
export const APPROVAL_EXPIRY_BATCH = 100;

export function runApprovalExpiry(deps: Pick<ApprovalExpiryDependencies, 'approvals' | 'now'>): Promise<SweepResult> {
  return sweepExpiredRequests(deps.approvals, deps.now(), APPROVAL_EXPIRY_BATCH);
}

/** 관측 축의 `route_id` — 스니펫 보존 스윕(핸들러의 `APPROVAL_EXPIRY_ROUTE_ID` 와 같은 값). */
const SNIPPET_RETENTION_ROUTE_ID = 'approval_expiry';

/**
 * 보존 기간(365일)을 넘긴 발신 행의 `messages.snippet` 을 비운다(F3). 비운 행 수.
 *
 * 거부돼 건너뛴 행 수를 **매 스윕** `atmark.snippet.retention_stuck` 으로 낸다(0 포함 — L2, 알람 11). 하나라도 있으면 error 로그에
 * 첫 행 id 를 싣는다(메시지 id 는 주소·본문이 아니다) — 그 행을 거부한 트리거를 찾는 출발점이다.
 */
export async function runSnippetRetention(deps: Pick<ApprovalExpiryDependencies, 'snippets'>): Promise<number> {
  const { cleared, stuckIds } = await deps.snippets.sweep(SNIPPET_RETENTION_BATCH);
  emitMetric(METRIC_NAMES.snippetRetentionStuck, stuckIds.length, 'Count');
  if (stuckIds.length > 0) {
    log('error', 'snippet_retention.stuck', {
      route_id: SNIPPET_RETENTION_ROUTE_ID,
      message_id: stuckIds[0] ?? null,
      reason: 'row_update_rejected',
      detail: `보존 기간이 지난 스니펫 ${String(stuckIds.length)}행을 비우지 못했다(UPDATE 거부 — 다른 트리거·제약). 건너뛰고 나머지를 비웠다.`,
    });
  }
  return cleared;
}

/**
 * `/org-api` 창 행 보존(ADR-0010 후속 L5, 202609250200) — 7일 넘은 `org_api_request_windows` 행을 SECURITY DEFINER 함수로 지운다.
 * 앱 롤은 그 함수 EXECUTE 하나뿐(표 권한 0). 지운 행 수.
 */
export function runOrgApiWindowRetention(deps: Pick<ApprovalExpiryDependencies, 'orgApiWindows'>): Promise<number> {
  return deps.orgApiWindows.purge();
}

/**
 * 코드 verify 시도 원장 보존(2026-09-28 보안 검토 L3, 202609280102) — 하루 넘은 `login_code_attempts` 행을 SECURITY DEFINER 함수로 지운다.
 * 앱 롤은 그 함수 EXECUTE 하나뿐(표 권한 0). 매 스윕(5분). 지운 행 수.
 */
export function runLoginCodeAttemptRetention(deps: Pick<ApprovalExpiryDependencies, 'loginCodeAttempts'>): Promise<number> {
  return deps.loginCodeAttempts.purge();
}

/**
 * 하루 한 번 보존 과제(초대만 받은 사용자 주소 지우기 · 쓰이지 않은 가입 링크 보존)의 하루 창(UTC) — 18:00–18:05 UTC = 03:00–03:05 KST. 창 길이는 이 워커의 스케줄 주기(5분, 인프라
 * `SCHEDULES`)와 같아야 창 안에 틱이 정확히 하나다(테스트가 둘을 대조한다). 틱 하나를 놓치면 그날은 건너뛰고 다음 날 이어받는다 —
 * 조건이 "끝난 지 30일" 이라 하루 늦는 것이 약속을 깨지 않는다. 두 번 돌아도 함수가 멱등이다(지운 행은 후보에서 빠진다).
 */
const INVITED_USER_ERASURE_UTC_HOUR = 18;
export const INVITED_USER_ERASURE_WINDOW_MINUTES = 5;

/** 지금 틱이 하루 창 안인가. */
export function invitedUserErasureDue(now: Date): boolean {
  return now.getUTCHours() === INVITED_USER_ERASURE_UTC_HOUR && now.getUTCMinutes() < INVITED_USER_ERASURE_WINDOW_MINUTES;
}

/** 하루 창 한 번에 부르는 배치의 최대 수 — 한 배치가 상한(500)을 다 지우면 다음 배치로(하루 최대 5 000 명). */
export const INVITED_USER_ERASURE_MAX_BATCHES = 10;

/**
 * 배치를 더 부르지 않는 경과 시간(ms) — Lambda 제한(60초) 안에 밀린 수 측정과 다른 단계가 들어갈 자리를 남긴다. 배치 하나는 한 문장이라
 * `statement_timeout`(10초)이 따로 묶는다.
 */
const INVITED_USER_ERASURE_BUDGET_MS = 30_000;

/**
 * 초대만 받은 사용자의 주소를 지운다(ADR-0010 후속 L7, 202609250220) — 하루 창 밖이면 `null`(DB 에 가지 않는다). 후보 선정·조건 재검사는
 * SECURITY DEFINER `erase_invited_only_users` 안이다(앱 롤은 그 함수 EXECUTE 하나 · 사용자를 고르지 못한다).
 *
 * 한 배치가 상한만큼 **지웠으면**(`erased === 500`) 더 있을 수 있으니 다음 배치를 부른다 — 최대 `INVITED_USER_ERASURE_MAX_BATCHES`
 * (경과 `INVITED_USER_ERASURE_BUDGET_MS` 를 넘기면 거기서 멈춘다 — 남은 행은 다음 날, 밀리면 알람 14).
 * 끝나면(배치가 던져도) 지운·건너뛴 수와 **밀린 수**(약속 30일 + 7일을 넘긴 행 — `atmark.privacy.erasure_backlog`, 알람 14)를 낸다.
 * 배치가 던졌으면 지표를 낸 뒤 다시 던진다(핸들러가 다른 단계를 막지 않게 거둔다).
 */
export async function runInvitedUserErasure(deps: Pick<ApprovalExpiryDependencies, 'invitedUsers' | 'now'>): Promise<InvitedUserErasureResult | null> {
  if (!invitedUserErasureDue(deps.now())) return null;
  let erased = 0;
  let skipped = 0;
  let batches = 0;
  let failure: unknown = null;
  const started = Date.now();
  try {
    while (batches < INVITED_USER_ERASURE_MAX_BATCHES && Date.now() - started < INVITED_USER_ERASURE_BUDGET_MS) {
      const result = await deps.invitedUsers.erase(INVITED_USER_ERASURE_BATCH);
      batches += 1;
      erased += result.erased;
      skipped += result.skipped;
      if (result.erased < INVITED_USER_ERASURE_BATCH) break;
    }
  } catch (error) {
    failure = error;
  }
  emitMetric(METRIC_NAMES.privacyErasureErased, erased, 'Count');
  emitMetric(METRIC_NAMES.privacyErasureSkipped, skipped, 'Count');
  const backlog = await deps.invitedUsers.backlog();
  emitMetric(METRIC_NAMES.privacyErasureBacklog, backlog, 'Count');
  log(backlog > 0 ? 'error' : 'info', 'invited_user_erasure.done', {
    route_id: SNIPPET_RETENTION_ROUTE_ID,
    outcome: failure === null ? 'ok' : 'failed',
    detail:
      `초대만 받은 사용자 주소 ${String(erased)}개를 지웠다(배치 ${String(batches)} · 건너뜀 ${String(skipped)}). ` +
      `약속(30일)을 7일 넘긴 행 ${String(backlog)}.`,
  });
  if (failure !== null) throw failure;
  return { erased, skipped };
}

/**
 * 쓰이지 않은 가입 링크 보존(M2, 202609250240) — 하루 창 밖이면 `null`. 발송이 끝났고 만료 30일이 지난 행을 SECURITY DEFINER
 * `purge_expired_signup_links()` 가 지운다(앱 롤은 그 함수 EXECUTE 하나 · 표 권한 0). 지운 행 수.
 */
export async function runSignupLinkRetention(deps: Pick<ApprovalExpiryDependencies, 'signupLinks' | 'now'>): Promise<number | null> {
  if (!invitedUserErasureDue(deps.now())) return null;
  return deps.signupLinks.purge();
}

/** 운영 콘솔 스윕 결과. 마이그레이션 전(0500 없음)이면 셋 다 `null` — 스위퍼가 migrate 보다 먼저 배포돼도 실패하지 않는다(M1). */
export interface OpsRetentionResult {
  readonly purged: number | null;
  readonly expired: number | null;
  readonly census: { readonly active: number; readonly pending: number; readonly addressesFailingToday: number; readonly addressesLocked: number } | null;
}

/**
 * 호스팅 운영자 콘솔 — **census 먼저**(`ops_operator_census` → 게이지 넷 `atmark.ops.census_*`), 그다음 `purge_ops_login_records` · `expire_ops_requests`
 * (앱 롤은 함수 셋 EXECUTE 만). census 는 알람 #31(active 증가, 결측 = 위반)의 입력이라 **보존·만료가 실패해도 빠지지 않는다** — 둘은 서로도 막지
 * 않고, 첫 실패는 셋이 다 돈 뒤에 다시 던진다(핸들러가 `retention_step.failed` 로 남긴다). 주소·식별자는 싣지 않는다(수만).
 */
export async function runOpsRetention(deps: Pick<ApprovalExpiryDependencies, 'ops'>): Promise<OpsRetentionResult> {
  const failures: unknown[] = [];
  let census: OpsRetentionResult['census'] = null;
  try {
    census = await deps.ops.census();
  } catch (error) {
    failures.push(error);
  }
  if (census !== null) {
    emitOpsMetric(OPS_METRIC_NAMES.censusActive, census.active);
    emitOpsMetric(OPS_METRIC_NAMES.censusPending, census.pending);
    emitOpsMetric(OPS_METRIC_NAMES.censusAddressesFailingToday, census.addressesFailingToday);
    emitOpsMetric(OPS_METRIC_NAMES.censusAddressesLocked, census.addressesLocked);
  }
  const attempt = async (run: () => Promise<number | null>): Promise<number | null> => {
    try {
      return await run();
    } catch (error) {
      failures.push(error);
      return null;
    }
  };
  const purged = await attempt(() => deps.ops.purge());
  const expired = await attempt(() => deps.ops.expire());
  if (failures.length > 0) throw failures[0];
  return { purged, expired, census };
}

/**
 * 인젝션 구조 방어 신호 보존(ADR-0016, 202610041000) — SECURITY DEFINER `purge_injection_signals()`(인자 없음, 표마다 10 000). 앱 롤은 함수 EXECUTE 하나.
 * 마이그레이션 전이면 `null`(던지지 않는다). 지운 행 수.
 */
export function runInjectionSignalRetention(deps: Pick<ApprovalExpiryDependencies, 'injectionSignals'>): Promise<number | null> {
  return deps.injectionSignals.purge();
}

/**
 * 신고자 해시 보존(202610131612 · 재검증 I-1) — SECURITY DEFINER `atmark_purge_complaint_hashes()`(인자 없음, 5000). 마이그레이션 전이면 `null`.
 */
export function runComplaintHashRetention(deps: Pick<ApprovalExpiryDependencies, 'complaintHashes'>): Promise<number | null> {
  return deps.complaintHashes.purge();
}

/**
 * 실시간 연결 스윕(묶음 E, 202610081300) — SECURITY DEFINER `atmark_realtime_sweep()`(인자 없음, 각 5000). 연결이 끊겼는데 `$disconnect` 가 오지 않은
 * 행(핑 15분 없음)과 2시간 만료 행을 닫아 에이전트당 5개 상한이 낡은 행에 막히지 않게 한다. 마이그레이션 전이면 `null`.
 */
export function runRealtimeConnectionSweep(
  deps: Pick<ApprovalExpiryDependencies, 'realtimeConnections'>,
): Promise<{ readonly closed: number; readonly purged: number } | null> {
  return deps.realtimeConnections.sweep();
}
