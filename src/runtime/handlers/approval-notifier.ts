/**
 * EventBridge Scheduler(1분) → `workers/approval-notifier`. 소유자 승인 알림 outbox 배출(시스템 메일 범주).
 *
 * 소유자 **로그인** 링크 메일은 여기서 보내지 않는다 — 전용 Lambda `handlers/login-mailer.ts`(역할 atmark-runtime-login-mailer ·
 * DB 롤 atmark_login_mailer)가 보낸다. 이 Lambda 는 api 와 발송 역할을 공유하므로, 여기서 로그인 키를 쥐면 api 탈취가 곧
 * 소유자 세션이 된다(ADR-0006).
 */

import { APPROVAL_NOTIFY_ROUTE_ID } from '../../notify/approval-notifier';
import { runApprovalNotifier } from '../../workers/approval-notifier';
import { runDomainNotifier } from '../../workers/domain-notifier';
import { runQuarantineNotifier } from '../../workers/quarantine-notifier';
import { composeApprovalNotifier, type ApprovalNotifierLambdaDependencies } from '../composition';
import { memoize, platformOf, scheduledHandler, type Compose, type LambdaContext } from '../lambda';

/**
 * 틱 하나 = 승인 알림 배출 → 고객 도메인 알림 배출(ADR-0014 M3b — `workers/domain-notifier`, 같은 발송 역할 · 같은 앱 롤). 도메인 알림 쪽 실패는
 * 승인 알림의 결과를 지우지 않는다(로그 후 다시 던져 틱을 실패로 — 다음 틱이 잇는다). 보고는 `domain_` 접두사로 합친다.
 * 그다음 격리 알림 배출(ADR-0016 2026-10-07 — `workers/quarantine-notifier`, 킬 스위치가 꺼져 있으면 `null` 이라 건너뛴다). 보고는 `quarantine_` 접두사.
 */
export function createApprovalNotifierHandler(compose: Compose<ApprovalNotifierLambdaDependencies>) {
  return scheduledHandler(APPROVAL_NOTIFY_ROUTE_ID, compose, async (deps) => {
    const approvals = await runApprovalNotifier(deps);
    const domains = await runDomainNotifier(deps.domainNotices);
    const quarantines = deps.quarantineNotices === null ? {} : await runQuarantineNotifier(deps.quarantineNotices);
    return {
      ...approvals,
      ...Object.fromEntries(Object.entries(domains).map(([key, value]) => [`domain_${key}`, value])),
      ...Object.fromEntries(Object.entries(quarantines).map(([key, value]) => [`quarantine_${key}`, value])),
    };
  });
}

export const handler = createApprovalNotifierHandler(
  memoize((context: LambdaContext) => composeApprovalNotifier(platformOf(context))),
);
