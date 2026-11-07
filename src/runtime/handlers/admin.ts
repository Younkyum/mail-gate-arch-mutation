/**
 * API Gateway HTTP API `atmark-console`(payload v2, `console.atmark.ai`) → `admin/router.ts`. **별도 Lambda · 별도 IAM 역할
 * (SES 0) · 전용 DB 롤 `atmark_admin`(소유자 롤 아님 — ADR-0006).** api Lambda 와 코드도 권한도 섞이지 않는다
 * (`test/arch/admin-separation.arch.test.ts`).
 *
 * 조립이 실패하면 503 과 요청 id 만 — 원인은 로그로만 간다. 정적 자산(`/_assets/…` — 스타일시트·페이지 스크립트)은 조립 **전에**
 * 답한다(`routeAdminAssetEvent` — DB·비밀·세션 0, 조립이 실패해도 나간다). 콘솔 폰트는 사이트 출처(`https://atmark.ai/_fonts/…`)가 낸다 — 이 λ 는 폰트를
 * 내지 않고 번들에 폰트 데이터가 없다(리뷰 M4 — 예약 동시성 3 을 `/api/me` 와 다투지 않게).
 *
 * **과제 이벤트(ADR-0014 단계 4 · 계획 §3.4)** — EventBridge Scheduler `atmark-domain-recheck`(10분)가 `{"task":"domain-recheck"}` 로 부른다.
 * 판별은 **엄격**하다: 키 집합이 정확히 `{task}` 이고 값이 그 상수면 과제, `requestContext.http` 가 있으면 HTTP, **둘 다 아니면 던진다**.
 * 과제는 HTTP 조립(로그인 키 · S3 · 결제 · admin 롤)을 거치지 않고 **틱 롤 풀(크기 1)을 이벤트마다 열어 `finally` 에서 `end()`** 한다.
 * 이 함수의 `lambda:InvokeFunction` 을 가진 런타임 역할은 Scheduler 역할뿐이다(인프라 테스트 — Lambda 자원 정책은 같은 계정 주체를 막지 못한다, L1).
 *
 * **자가 등록 이벤트(ADR-0016 2026-10-08 · `runtime/enroll-event.ts`)** — api λ 가 RequestResponse 로 `{source:'atmark.api', action:'agent.enroll', v:1, …}` 를
 * 부른다(api 역할의 `lambda:InvokeFunction` on 이 함수 ARN 하나). 이 입구가 하는 일은 **자가 등록 하나뿐**이다 — 모양이 정확히 맞지 않으면(다른 action ·
 * 키 하나 더) 위의 "모르는 이벤트" 로 던진다. HTTP 라우터 · 관리 연산 어느 것도 이 입구로 닿지 않는다. 판정은 `admin/ops/enroll.ts` 가 DB 에서 처음부터 한다.
 * 결과의 새 토큰은 응답에만 있다(로그 없음).
 */

import type { AdminDependencies } from '../../admin/context';
import { type AdminHttpEvent, type AdminHttpResult } from '../../admin/http';
import { adminUnavailable, routeAdminAssetEvent, routeAdminEvent } from '../../admin/router';
import { runDomainTick, type DomainTickReport } from '../../domains/lifecycle';
import { log } from '../../observability/logger';
import { enrollAgentOp } from '../../admin/ops/enroll';
import { composeAdmin, composeDomainTick, type ComposedDomainTick } from '../admin-composition';
import { RUNTIME_ENV } from '../config';
import { parseEnrollEvent, type EnrollResult } from '../enroll-event';
import { beginInvocation, memoize, type LambdaContext } from '../lambda';

/** 스케줄러 과제 이름(compute-stack `DOMAIN_RECHECK_SCHEDULE` 의 입력과 같다). */
export const DOMAIN_RECHECK_TASK = 'domain-recheck';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{"task":"domain-recheck"}` — 키가 정확히 하나이고 값이 그 상수일 때만. */
export function isDomainRecheckEvent(event: unknown): boolean {
  return isRecord(event) && Object.keys(event).length === 1 && event['task'] === DOMAIN_RECHECK_TASK;
}

/** API Gateway HTTP API(payload v2) 이벤트 — `requestContext.http` 가 있다. */
export function isAdminHttpEvent(event: unknown): event is AdminHttpEvent {
  return isRecord(event) && isRecord(event['requestContext']) && isRecord(event['requestContext']['http']);
}

/** 자가 등록 별칭 이름(compute-stack `AdminEnrollAlias`). */
export const ADMIN_ENROLL_ALIAS = 'enroll';

/** 이 호출이 `enroll` 별칭으로 왔는가 — `invokedFunctionArn` 의 한정자(`…:function:atmark-admin:enroll`). */
export function isEnrollAliasInvocation(context: Pick<LambdaContext, 'invokedFunctionArn'>): boolean {
  const parts = context.invokedFunctionArn.split(':');
  return parts.length === 8 && parts[5] === 'function' && parts[7] === ADMIN_ENROLL_ALIAS;
}

/**
 * HTTP 모양 이벤트가 **콘솔 HTTP API 에서 왔는가**(적대 검증 D2-U048). API Gateway 는 `requestContext.apiId` 를 자기 id 로 채운다 — 직접 invoke(발송 역할이 자가 등록
 * 때문에 이 함수를 부를 수 있다)는 아무 값이나 넣을 수 있지만 콘솔 API id 는 CDK 가 환경(`ATMARK_CONSOLE_API_ID`)으로만 준다. 환경이 없으면 거부한다(fail closed).
 * 이것으로 막는 것은 위조 `sourceIp` · 위조 쿠키 재생 같은 "API Gateway 를 건너뛴" 요청이다(세션 검사는 그대로 뒤에 있다).
 */
export function isFromConsoleApi(event: AdminHttpEvent, consoleApiId: string | undefined): boolean {
  const apiId = event.requestContext.apiId;
  return consoleApiId !== undefined && /^[a-z0-9]{1,32}$/.test(consoleApiId) && apiId === consoleApiId;
}

/** 판별 — 셋 중 하나가 아니면 던진다(모르는 이벤트를 HTTP 로도 과제로도 자가 등록으로도 읽지 않는다). */
export function adminEventKind(event: unknown): 'http' | 'domain-recheck' | 'agent-enroll' {
  if (isDomainRecheckEvent(event)) return 'domain-recheck';
  if (parseEnrollEvent(event) !== null) return 'agent-enroll';
  if (isAdminHttpEvent(event)) return 'http';
  throw new Error('admin: 모르는 이벤트(HTTP API v2 · {"task":"domain-recheck"} · 자가 등록 이벤트만)');
}

/** 과제 한 번 — 풀은 이 이벤트 전용이고 끝나면 닫는다(실패해도). */
export async function runDomainRecheckTask(compose: () => Promise<ComposedDomainTick>, now: () => Date = () => new Date()): Promise<DomainTickReport> {
  const { pool, invoker } = await compose();
  try {
    return await runDomainTick({ pool, invoker, now });
  } finally {
    await pool.end().catch((error: unknown) => {
      log('warn', 'runtime.pool_end_failed', { route_id: DOMAIN_RECHECK_TASK, error_kind: error instanceof Error ? error.name : typeof error });
    });
  }
}

export function createAdminHandler(
  compose: (context: LambdaContext) => Promise<{ readonly deps: AdminDependencies }>,
  composeTick: () => Promise<ComposedDomainTick> = () => composeDomainTick({ env: process.env }),
  consoleApiId: () => string | undefined = () => process.env[RUNTIME_ENV.consoleApiId],
) {
  async function handle(event: AdminHttpEvent, context: LambdaContext): Promise<AdminHttpResult>;
  async function handle(event: unknown, context: LambdaContext): Promise<AdminHttpResult | DomainTickReport | EnrollResult>;
  async function handle(event: unknown, context: LambdaContext): Promise<AdminHttpResult | DomainTickReport | EnrollResult> {
    beginInvocation(context);
    const kind = adminEventKind(event);
    // 별칭 경계(배포 전 보안 리뷰 — 2026-10-08): `enroll` 별칭으로 온 호출은 자가 등록 이벤트 **만**, 그 밖(한정자 없는 함수 — 콘솔 · 스케줄러)에서는 자가 등록
    //   이벤트를 받지 않는다. 발송 역할은 별칭 ARN 만 부를 수 있으므로(IAM) 그 역할로는 HTTP · 과제 이벤트가 이 함수에 닿지 않는다.
    const viaEnrollAlias = isEnrollAliasInvocation(context);
    if (viaEnrollAlias !== (kind === 'agent-enroll')) {
      log('warn', 'admin.alias_mismatch', { route_id: 'admin', outcome: 'rejected', reason: viaEnrollAlias ? 'non_enroll_event_on_alias' : 'enroll_event_off_alias' });
      throw new Error('admin: 이 입구로는 받지 않는 이벤트(자가 등록은 enroll 별칭으로만 · 별칭으로는 자가 등록만)');
    }
    if (kind === 'agent-enroll') {
      const enroll = parseEnrollEvent(event);
      if (enroll === null) throw new Error('admin: 자가 등록 이벤트 모양이 바뀌었다');
      try {
        const { deps } = await compose(context);
        return await enrollAgentOp(deps.pool, deps.custody(), enroll);
      } catch (error) {
        log('error', 'agent.enroll_failed', { route_id: 'internal:agent.enroll', trace_id: enroll.requestId, error_kind: error instanceof Error ? error.name : typeof error });
        return { ok: false, error: 'unavailable' };
      }
    }
    if (kind === 'domain-recheck') {
      try {
        return await runDomainRecheckTask(composeTick);
      } catch (error) {
        log('error', 'domain.tick_failed', { route_id: DOMAIN_RECHECK_TASK, error_kind: error instanceof Error ? error.name : typeof error });
        throw error;
      }
    }
    const httpEvent = event as AdminHttpEvent;
    if (!isFromConsoleApi(httpEvent, consoleApiId())) {
      log('warn', 'admin.foreign_http_event', { route_id: 'admin', outcome: 'rejected', reason: 'api_id_mismatch' });
      throw new Error('admin: 콘솔 HTTP API 에서 오지 않은 HTTP 이벤트');
    }
    const asset = routeAdminAssetEvent(httpEvent);
    if (asset !== null) return asset;
    let deps: AdminDependencies;
    try {
      ({ deps } = await compose(context));
    } catch (error) {
      log('error', 'runtime.compose_failed', {
        route_id: 'admin',
        trace_id: httpEvent.requestContext.requestId,
        error_kind: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message : String(error),
      });
      return adminUnavailable(httpEvent.requestContext.requestId);
    }
    return routeAdminEvent(deps, httpEvent);
  }
  return handle;
}

export const handler = createAdminHandler(
  memoize((context: LambdaContext) => composeAdmin({ env: process.env, invokedFunctionArn: context.invokedFunctionArn })),
);
