/**
 * src/runtime/lambda.ts — Lambda 이벤트의 **최소 형태**와 수명주기 도구. 핸들러 전부가 쓴다.
 *
 * `@types/aws-lambda` 를 들이지 않고 여기서 필드를 좁게 적는다 — 우리가 읽는 필드만 타입에 있어야 "안 읽는
 * 필드에 기대는 코드" 가 컴파일되지 않는다.
 *
 * **수명주기(콜드 스타트 1회):** 조립 결과(풀·비밀·클라이언트)는 모듈 스코프의 `memoize` 에 산다. 같은 실행 환경의
 * 다음 호출은 같은 풀을 재사용한다. **실패한 조립은 캐시하지 않는다** — Secrets Manager 일시 장애 한 번이 그 실행
 * 환경을 수명 내내 죽이지 않게. 설정 오류(변수 없음)는 결정적이라 재시도해도 같은 오류로 다시 던진다(fail-closed).
 */

import { log } from '../observability/logger';
import type { RuntimePlatform } from './composition';

/** Lambda 컨텍스트 중 우리가 쓰는 것. */
export interface LambdaContext {
  readonly awsRequestId: string;
  /** 조립 루트가 계정 ID(S3 `ExpectedBucketOwner`)를 여기서 읽는다. */
  readonly invokedFunctionArn: string;
  callbackWaitsForEmptyEventLoop: boolean;
}

/**
 * 비동기 핸들러의 공통 머리. `callbackWaitsForEmptyEventLoop = false`:
 * pg 풀은 유휴 소켓을 이벤트 루프에 남긴다. 비동기 핸들러는 promise 가 끝나면 응답하지만, 콜백 호환 경로가
 * 루프가 빌 때까지 기다리면 **모든 호출이 타임아웃까지 매달린다.** 풀을 재사용하려면 이 값이 거짓이어야 한다.
 */
export function beginInvocation(context: LambdaContext): void {
  context.callbackWaitsForEmptyEventLoop = false;
}

/** 운영 플랫폼 — 환경 변수는 프로세스의 것, 계정은 호출 ARN 의 것. AWS 클라이언트는 실제(주입 없음). */
export function platformOf(context: LambdaContext): RuntimePlatform {
  return { env: process.env, invokedFunctionArn: context.invokedFunctionArn };
}

/**
 * 조립을 실행 환경당 한 번만 한다. **첫 성공 호출의 컨텍스트**로 조립하고 이후 호출은 그 결과를 재사용한다.
 * 거부된 promise 는 버린다(다음 호출이 다시 시도).
 */
export function memoize<A, T>(build: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let pending: Promise<T> | undefined;
  return (arg: A) => {
    pending ??= build(arg).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

// ---------------------------------------------------------------------------
// SQS — 부분 배치 실패
// ---------------------------------------------------------------------------

export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/**
 * `ReportBatchItemFailures` 응답. **이벤트 소스 매핑에 `FunctionResponseTypes: ['ReportBatchItemFailures']` 가
 * 켜져 있어야 의미가 있다** — 꺼져 있으면 Lambda 는 이 목록을 무시하고 배치 전체를 성공으로 지운다(실패 유실).
 */
export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

/**
 * 레코드마다 소비하고, **재전달해야 하는 것만** 실패로 돌려준다.
 *
 * `retry(outcome)` 이 참인 결말만 재전달된다 — 소비자 계약상 그것은 `failed` 하나다. 파싱 불가(`unparsable`)는
 * 재전달해도 같은 결과라 성공으로 지운다(소비자가 이미 error 로그를 남겼다). 소비자가 **던지면**(계약 위반 —
 * 소비자는 값으로 돌려준다) 그 레코드만 실패로 본다: 한 레코드의 예외가 배치 전체를 재전달시키지 않는다.
 * 레코드는 **순차로** 처리한다 — 소비자가 조직·스레드 단위 순서를 전제한다.
 */
export async function consumeSqsBatch<Outcome extends string>(
  routeId: string,
  event: SqsEvent,
  consume: (record: SqsRecord) => Promise<Outcome>,
  retry: (outcome: Outcome) => boolean,
): Promise<SqsBatchResponse> {
  const failures: { readonly itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let outcome: Outcome | 'thrown';
    try {
      outcome = await consume(record);
    } catch (error) {
      log('error', 'runtime.sqs_record_threw', {
        route_id: routeId,
        trace_id: record.messageId,
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      outcome = 'thrown';
    }
    if (outcome === 'thrown' || retry(outcome)) failures.push({ itemIdentifier: record.messageId });
  }
  log(failures.length > 0 ? 'warn' : 'info', 'runtime.sqs_batch', {
    route_id: routeId,
    outcome: failures.length > 0 ? 'partial_failure' : 'ok',
    detail: `records=${String(event.Records.length)} retry=${String(failures.length)}`,
  });
  return { batchItemFailures: failures };
}

/** 스케줄 워커 결과를 결말별 개수로 접는다(응답·로그용 — 식별자·주소를 싣지 않는다). */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 핸들러 골격 — SQS · 스케줄
// ---------------------------------------------------------------------------

/** 조립기. 핸들러 파일은 운영용(`memoize` + `platformOf`)을, 테스트는 가짜 의존성을 준다. */
export type Compose<D> = (context: LambdaContext) => Promise<{ readonly deps: D }>;

/**
 * SQS 소비 핸들러. **조립이 실패하면 던진다** — 배치 전체가 재전달된다(아무것도 처리하지 않았으므로 옳다).
 * 조립이 된 뒤에는 레코드 단위 부분 실패(`consumeSqsBatch`)다.
 */
export function sqsHandler<D, Outcome extends string>(
  routeId: string,
  compose: Compose<D>,
  consume: (deps: D, record: SqsRecord) => Promise<Outcome>,
  retry: (outcome: Outcome) => boolean,
): (event: SqsEvent, context: LambdaContext) => Promise<SqsBatchResponse> {
  return async (event, context) => {
    beginInvocation(context);
    const { deps } = await compose(context);
    return consumeSqsBatch(routeId, event, (record) => consume(deps, record), retry);
  };
}

/** 스케줄 실행 보고 — 결말별 개수만(식별자·주소 없음). */
export interface ScheduledRunReport {
  readonly routeId: string;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * EventBridge Scheduler 핸들러. 이벤트 본문은 읽지 않는다 — **무엇을 할지는 DB 의 기한이 정한다**(outbox 규율).
 * 워커가 던지면 로그를 남기고 다시 던진다: 호출이 실패로 기록돼야 알람·재시도가 산다. 다음 틱이 같은 행을 다시 집는다.
 */
export function scheduledHandler<D>(
  routeId: string,
  compose: Compose<D>,
  run: (deps: D) => Promise<Readonly<Record<string, number>>>,
): (event: unknown, context: LambdaContext) => Promise<ScheduledRunReport> {
  return async (_event, context) => {
    beginInvocation(context);
    const { deps } = await compose(context);
    const started = Date.now();
    try {
      const counts = await run(deps);
      log('info', 'runtime.scheduled_run', {
        route_id: routeId,
        latency_ms: Date.now() - started,
        detail: JSON.stringify(counts),
      });
      return { routeId, counts };
    } catch (error) {
      log('error', 'runtime.scheduled_failed', {
        route_id: routeId,
        latency_ms: Date.now() - started,
        error_kind: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
