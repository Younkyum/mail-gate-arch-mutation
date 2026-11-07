/**
 * `workers/webhook-dispatcher` — **웹훅 outbox 를 비우는 워커** (계획 §3.4 1조·4조).
 *
 * 이벤트는 상태 전이와 같은 트랜잭션에서 outbox(`webhook_deliveries`)에 적힌다 — 승인·거절
 * (`approval/service.ts` → `approval-store.ts`), 만료(스위퍼), 발송 확정(`lease-store.settleSent`).
 * 이 워커는 그것을 at-least-once 로 꺼내 보낸다. 재시도·펜싱·SSRF 규칙은 전부
 * `webhooks/dispatcher.ts` 에 있고 여기서는 한 번의 스윕과 결말 관측만 한다.
 *
 * **발송하지 않는 워커다** — `NON_SENDING_ENTRYPOINTS` 에 있다. 여기서 "발송" 은 **메일**이다. 이 워커가
 * 내보내는 HTTP 는 에이전트 소유자가 등록한 URL 로 가는 식별자·시각뿐이고, 관문·SES 전송단에 닿지 않는다.
 * 네트워크 I/O 는 `webhooks/https-transport.ts` 하나뿐이다(`test/arch/network-egress.arch.test.ts`) — 이
 * 파일은 전송단을 **주입받는다**.
 *
 * 스케줄(1분 주기 등)은 인프라의 일이다. 이 함수는 한 번의 스윕만 한다.
 */

import { log } from '../observability/logger';
import {
  dispatchDueWebhooks,
  type DeliveryReport,
  type WebhookDispatchDependencies,
} from '../webhooks/dispatcher';

export const WEBHOOK_DISPATCHER_ROUTE_ID = 'webhook_dispatcher';

/** 한 스윕에서 집을 최대 전달 수. 넘치면 다음 스윕이 이어받는다(기한 순). */
const WEBHOOK_DISPATCH_BATCH = 50;

export interface WebhookDispatcherDependencies extends WebhookDispatchDependencies {
  readonly now: () => Date;
}

export async function runWebhookDispatcher(deps: WebhookDispatcherDependencies): Promise<readonly DeliveryReport[]> {
  const reports = await dispatchDueWebhooks(deps, deps.now(), { limit: WEBHOOK_DISPATCH_BATCH });
  for (const report of reports) {
    // URL·본문은 싣지 않는다 — URL 은 소유자가 적은 문자열이고 오타 하나면 남의 서버다.
    // 전달 id 는 전용 키가 없어 `detail` 에 싣는다(uuid 라 치환에 걸리지 않는다).
    log(report.outcome === 'dead' ? 'warn' : 'info', 'webhook.delivery', {
      route_id: WEBHOOK_DISPATCHER_ROUTE_ID,
      outcome: report.outcome,
      error_kind: report.errorKind,
      http_status: report.httpStatus,
      detail: report.deliveryId,
    });
  }
  return reports;
}
