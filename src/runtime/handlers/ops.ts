/**
 * API Gateway HTTP API `atmark-ops`(payload v2, `ops.atmark.ai`) → `src/ops/hosted/app.ts`. **별도 Lambda · 별도 IAM 역할(SES · S3 · KMS 0) ·
 * 전용 DB 롤 `atmark_ops`**(`.omc/plans/ops-console.md` §3.1). api · admin λ 와 코드도 권한도 섞이지 않는다.
 *
 * Host 가 `ops.atmark.ai` 가 아니면(execute-api 기본 엔드포인트 포함) 조립 **전에** 421. 비밀이 자리표시면 503 `ops_unavailable`(크래시 없음 · M1).
 * 조립이 실패하면 503 과 요청 id 만 — 원인은 로그로만 간다.
 */

import { log } from '../../observability/logger';
import { handleOpsRequest, unavailableResult } from '../../ops/hosted/app';
import { checkHost, errorResult, textResult, type OpsHttpEvent, type OpsHttpResult } from '../../ops/hosted/http';
import { composeOps, createOpsComposer, type ComposedOps } from '../ops-composition';
import { beginInvocation, type LambdaContext } from '../lambda';

export function createOpsHandler(compose: () => Promise<ComposedOps>) {
  return async (event: OpsHttpEvent, context: LambdaContext): Promise<OpsHttpResult> => {
    beginInvocation(context);
    const host = checkHost(event);
    if (!host.ok) return textResult(host.status, host.code);
    let composed: ComposedOps;
    try {
      composed = await compose();
    } catch (error) {
      log('error', 'runtime.compose_failed', {
        route_id: 'ops',
        trace_id: event.requestContext.requestId,
        error_kind: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message : String(error),
      });
      return errorResult(503, 'ops_unavailable', `요청 ${event.requestContext.requestId}`);
    }
    if (composed.kind === 'unavailable') {
      log('warn', 'ops.unavailable', { route_id: 'ops', reason: composed.reason });
      return unavailableResult(event);
    }
    return handleOpsRequest(composed.deps, event);
  };
}

export const handler = createOpsHandler(createOpsComposer(() => composeOps({ env: process.env })));
