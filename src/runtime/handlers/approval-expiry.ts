/**
 * EventBridge Scheduler(5분) → `workers/approval-expiry`. 만료의 뜻은 "보내지 않는다" 다. 같은 호출에서 보존 단계들이 차례로 돈다(아래 순서).
 *
 * **단계는 서로 막지 않는다**(적대적 검토 M1) — 한 단계가 던져도 나머지는 돈다(하루 한 번 도는 지우기 단계가 앞 단계 실패로 하루 밀리지 않게).
 * 실패한 단계는 `retention_step.failed` 로그로 남기고, 모든 단계가 끝난 뒤 **첫 실패를 다시 던진다** — 호출은 실패로 보고된다
 * (`runtime.scheduled_failed` · Lambda Errors).
 */

import { log } from '../../observability/logger';
import {
  runApprovalExpiry,
  runComplaintHashRetention,
  runInjectionSignalRetention,
  runInvitedUserErasure,
  runLoginCodeAttemptRetention,
  runOpsRetention,
  runOrgApiWindowRetention,
  runRealtimeConnectionSweep,
  runSignupLinkRetention,
  runSnippetRetention,
  type ApprovalExpiryDependencies,
} from '../../workers/approval-expiry';
import { composeApprovalExpiry } from '../composition';
import { memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';

/** 관측 축의 `route_id`. 워커 파일에 상수가 없어 여기서 정한다(NON_SENDING 진입점 — 매니페스트 id 가 없다). */
export const APPROVAL_EXPIRY_ROUTE_ID = 'approval_expiry';

export function createApprovalExpiryHandler(compose: Compose<ApprovalExpiryDependencies>) {
  return scheduledHandler(APPROVAL_EXPIRY_ROUTE_ID, compose, async (deps) => {
    const failures: unknown[] = [];
    /** 한 단계 — 던지면 기록하고 `null`(다음 단계는 그대로 돈다). */
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        failures.push(error);
        log('error', 'retention_step.failed', {
          route_id: APPROVAL_EXPIRY_ROUTE_ID,
          reason: name,
          error_kind: error instanceof Error ? error.name : typeof error,
          detail: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };
    const expiry = await step('approval_expiry', () => runApprovalExpiry(deps));
    const snippetsCleared = await step('snippet_retention', () => runSnippetRetention(deps));
    // `/org-api` 창 행 보존(ADR-0010 L5) — 7일 넘은 행만(함수 안에서 고른다).
    const orgApiWindowsPurged = await step('org_api_window_retention', () => runOrgApiWindowRetention(deps));
    // 로그인·가입 코드 verify 시도 원장 보존(2026-09-28 L3) — 하루 넘은 행만(함수 안에서 고른다).
    const loginCodeAttemptsPurged = await step('login_code_attempt_retention', () => runLoginCodeAttemptRetention(deps));
    // 하루 창에서만(창 밖이면 null · DB 에 가지 않는다 · 결과에는 0).
    const invitedErasure = await step('invited_user_erasure', () => runInvitedUserErasure(deps));
    const signupLinksPurged = await step('signup_link_retention', () => runSignupLinkRetention(deps));
    // 호스팅 운영자 콘솔(202609290500) — 마이그레이션 전이면 null(던지지 않는다).
    const ops = await step('ops_retention', () => runOpsRetention(deps));
    // 인젝션 구조 방어 신호(ADR-0016) — 노출 8일 · 복사 지문 30일 · 코드 지문 24시간. 마이그레이션 전이면 null.
    const injectionSignalsPurged = await step('injection_signal_retention', () => runInjectionSignalRetention(deps));
    // 실시간 연결(묶음 E) — 낡은 열린 행 닫기 · 7일 넘게 닫힌 행 지우기. 마이그레이션 전이면 null.
    const realtime = await step('realtime_connection_sweep', () => runRealtimeConnectionSweep(deps));
    // 신고자 해시(공유 도메인 평판 · 재검증 I-1) — 받은 지 8일 넘은 행. 마이그레이션 전이면 null.
    const complaintHashesPurged = await step('complaint_hash_retention', () => runComplaintHashRetention(deps));
    if (failures.length > 0) throw failures[0];
    return {
      expired: expiry?.expired.length ?? 0,
      lost: expiry?.lost.length ?? 0,
      snippets_cleared: snippetsCleared ?? 0,
      org_api_windows_purged: orgApiWindowsPurged ?? 0,
      login_code_attempts_purged: loginCodeAttemptsPurged ?? 0,
      invited_users_erased: invitedErasure?.erased ?? 0,
      signup_links_purged: signupLinksPurged ?? 0,
      ops_records_purged: ops?.purged ?? 0,
      ops_requests_expired: ops?.expired ?? 0,
      injection_signals_purged: injectionSignalsPurged ?? 0,
      realtime_connections_closed: realtime?.closed ?? 0,
      realtime_connections_purged: realtime?.purged ?? 0,
      complaint_hashes_purged: complaintHashesPurged ?? 0,
    };
  });
}

export const handler = createApprovalExpiryHandler(
  memoize((context: LambdaContext) => composeApprovalExpiry(platformOf(context))),
);
