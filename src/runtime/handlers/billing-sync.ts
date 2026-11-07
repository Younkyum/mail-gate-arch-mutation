/**
 * `atmark-billing-sync` — 결제 동기화 λ(WP-2, 계획 §3-1 · §3-5). **입력 셋을 가른다**(모르는 입력은 던진다):
 *   - SQS FIFO(`atmark-billing-events.fifo`, 배치 1 · ReportBatchItemFailures) → `consumeBillingRecord`. `failed`·`deferred` 를 재전달한다
 *     (`batchItemFailures`) — 재전달은 큐의 최대 수신 횟수(10회)까지라 약 1시간 뒤 DLQ 로 가고(알람), 그 뒤에는 redrive 가 필요하다.
 *   - Scheduler 15분 틱 `{"action":"reconcile"}`(운영자 수동은 `"restart":true` 로 새 판) → `runReconcile`(한 번에 약 45초 안 · 커서 저장).
 *     응답의 `restartApplied` 가 수동 restart 의 결과다 — `false` 면 새 판이 열리지 않았다(대개 `status: "concurrent"` — 다른 실행이 돌고
 *     있었다. 잠시 뒤 다시 부른다, 재검토 N5).
 *   - 운영자 수동 `{"action":"sync-org","organizationId":"<uuid>"}` → `syncOrganization`(계기 `operator_sync` — `--release-to-provider` 뒤).
 *
 * 조립이 실패하면 던진다 — SQS 배치는 통째로 다시 오고(아무것도 처리하지 않았다), 스케줄 호출은 실패로 남는다(다음 틱이 잇는다). 예외 하나:
 * 결제 DB 롤이 아직 없으면(`BillingNotReadyError` — 배포 중) reconcile 틱은 알람 없이 `not_migrated` 로 끝난다.
 */

import { consumeBillingRecord, syncOrganization, type BillingSyncDependencies, type SyncOrganizationOutcome } from '../../billing/sync';
import { runReconcile, type ReconcileReport } from '../../billing/reconcile';
import { log } from '../../observability/logger';
import { countMetric, emitMetric, METRIC_NAMES } from '../../observability/metrics';
import { BillingNotReadyError, composeBillingSync, currentBillingSyncDeps } from '../billing-composition';
import { beginInvocation, consumeSqsBatch, memoize, type Compose, type LambdaContext, type SqsBatchResponse, type SqsEvent } from '../lambda';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BillingSyncInput =
  | { readonly kind: 'sqs'; readonly event: SqsEvent }
  | { readonly kind: 'reconcile'; readonly restart: boolean }
  | { readonly kind: 'sync-org'; readonly organizationId: string };

/** 입력 판별 — 모양이 하나라도 어긋나면 던진다(조용히 무시하면 스케줄·수동 호출의 오타가 "성공" 으로 남는다). */
export function classifyBillingSyncInput(event: unknown): BillingSyncInput {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new TypeError('billing-sync: 모르는 입력(객체가 아니다)');
  const record = event as Record<string, unknown>;
  if ('Records' in record) {
    const records = record['Records'];
    if (!Array.isArray(records) || !records.every((r) => typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>)['messageId'] === 'string' && typeof (r as Record<string, unknown>)['body'] === 'string')) {
      throw new TypeError('billing-sync: SQS 레코드 모양이 아니다');
    }
    return { kind: 'sqs', event: event as SqsEvent };
  }
  const keys = Object.keys(record).sort().join(',');
  if (record['action'] === 'reconcile' && (keys === 'action' || (keys === 'action,restart' && record['restart'] === true))) {
    return { kind: 'reconcile', restart: record['restart'] === true };
  }
  if (record['action'] === 'sync-org' && keys === 'action,organizationId' && typeof record['organizationId'] === 'string' && UUID_SHAPE.test(record['organizationId'])) {
    return { kind: 'sync-org', organizationId: record['organizationId'] };
  }
  throw new TypeError('billing-sync: 모르는 입력');
}

export type BillingSyncResult = SqsBatchResponse | ReconcileReport | { readonly organization: SyncOrganizationOutcome };

export function createBillingSyncHandler(compose: Compose<BillingSyncDependencies>) {
  return async (event: unknown, context: LambdaContext): Promise<BillingSyncResult> => {
    beginInvocation(context);
    const input = classifyBillingSyncInput(event);
    let deps: BillingSyncDependencies;
    try {
      ({ deps } = await compose(context));
    } catch (error) {
      // 배포 중(결제 DB 롤 전) — reconcile 틱은 알람 없이 건너뛴다. SQS 는 던져서 배치를 통째로 다시 받는다(최대 수신 횟수 10회를 넘기면 약 1시간 뒤
      // DLQ 로 가고 알람 — 그 뒤에는 redrive 가 필요하다).
      if (input.kind === 'reconcile' && error instanceof BillingNotReadyError) {
        countMetric(METRIC_NAMES.billingReconcileSkipped);
        // 대조를 기대하지 않는 상태 — 나이 0(stale 알람이 배포 중에 울리지 않게, 틱이 살아 있다는 신호는 낸다).
        emitMetric(METRIC_NAMES.billingReconcileCompletedAgeSeconds, 0, 'Seconds');
        log('info', 'billing.reconcile', { route_id: 'billing_sync', outcome: 'not_ready' });
        if (input.restart) log('warn', 'billing.reconcile_restart_not_applied', { route_id: 'billing_sync', outcome: 'not_ready' });
        return {
          status: 'not_migrated',
          restartApplied: input.restart ? false : null,
          phase: null,
          pages: 0,
          subscriptions: 0,
          organizations: 0,
          applied: 0,
          missed: 0,
        };
      }
      throw error;
    }
    if (input.kind === 'sqs') {
      return consumeSqsBatch('billing_sync', input.event, (record) => consumeBillingRecord(deps, record.body), (outcome) => outcome === 'failed' || outcome === 'deferred');
    }
    if (input.kind === 'reconcile') return runReconcile(deps, { restart: input.restart });
    return { organization: await syncOrganization(deps, input.organizationId) };
  };
}

const composed = memoize(() => composeBillingSync({ env: process.env }));
/** 조립은 실행 환경당 한 번, Paddle 키는 호출마다 5분 캐시에서(M-5). */
export const handler = createBillingSyncHandler(async (context) => ({ deps: await currentBillingSyncDeps(await composed(context)) }));
