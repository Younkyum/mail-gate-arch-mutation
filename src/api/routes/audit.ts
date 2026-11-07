/**
 * `GET /v1/audit?message_id=...` — **왜 이 메일이 나갔는가** (계획 §6 P1b 9번 / AC-9).
 *
 * ---
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** `src/api/routes/**` 의 모든 파일은
 * (i) 관문을 import 하고 매니페스트에 등록됐거나 (ii) 허용목록에 **명시**됐거나
 * 둘 중 정확히 하나여야 한다(Layer C, fail-closed). 조회 전용이므로 (ii) 다.
 *
 * 그 분류에는 대가가 따른다: **이 파일은 `src/policy/gate.ts` 를 import 할 수 없다.**
 * Layer C 가 "허용목록 진입점은 관문을 import 하지 않는다" 를 반대 방향으로도 단언하기
 * 때문이다(분류 위반). 타입 하나를 빌려 오는 것도 안 된다 — `importsModule` 은 타입
 * import 도 import 로 센다. 그래서 응답 모양은 `audit-reader.ts` 가 따로 정의한다.
 * 불편이 아니라 **분류가 실재한다는 증거**다.
 */

import { authenticateRequest, authorizeRequest } from '../auth';
import type { AuditReader, AuditRecord } from '../audit-reader';
import type { AgentTokenStore } from '../../identity/agent-token';
import { errorResponse, jsonResponse, queryOf, type ApiRequest, type ApiResponse } from '../http';
import { publicReasons, publicResolutionReason } from '../public-codes';

export interface AuditRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly audit: AuditReader;
  readonly now: () => Date;
}

/**
 * 응답 한 행. **`reasons` 가 배열로 나가는 것이 요점이다** — 사유는 하나가 아니다. 사유와 해소 사유는 공개 이름으로 옮긴다
 * (`public-codes.ts`): 전송 실패의 해소 사유에는 전송단 오류 원문이 저장돼 있어 그대로 내보내지 않는다.
 */
function toBody(record: AuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    agent_id: record.agentId,
    message_id: record.messageId,
    decision: record.decision,
    reasons: publicReasons(record.reasons),
    policy_version: record.policyVersion,
    policy_version_id: record.policyVersionId,
    evaluated_at: record.evaluatedAt.toISOString(),
    latency_ms: record.latencyMs,
    trace_id: record.traceId,
    resolved_at: record.resolvedAt === null ? null : record.resolvedAt.toISOString(),
    resolution_reason: publicResolutionReason(record.resolutionReason),
  };
}

export async function handleAuditQuery(
  deps: AuditRouteDependencies,
  request: ApiRequest,
): Promise<ApiResponse> {
  const messageId = queryOf(request, 'message_id');
  if (messageId === null) {
    return errorResponse(400, 'invalid_request', 'The message_id query parameter is required.');
  }

  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return authentication.response;

  const records = await deps.audit.byMessageId(messageId);
  const first = records[0];
  if (first === undefined) {
    return errorResponse(404, 'audit_not_found', `No audit record for message_id=${messageId}.`);
  }

  // **인가는 행을 읽은 뒤에 한다.** 대상 에이전트를 요청이 주장하게 두면(예: 쿼리
  // 파라미터의 agent_id) 그 주장이 곧 통과 조건이 된다. 행이 말하는 소유자로만 판정한다.
  // 존재하지 않는 메시지(404)와 남의 메시지(403)가 구별되는 것은 의도된 비용이다 —
  // uuid 를 맞혀야 하는 공격자가 얻는 정보보다, 운영자가 "권한인가 오타인가" 를
  // 즉시 아는 이득이 크다.
  const forbidden = authorizeRequest(authentication.principal, 'audit:read', first.agentId);
  if (forbidden !== null) return forbidden;

  return jsonResponse(200, {
    message_id: messageId,
    // 보통 1행이다. lease 만료 후 재시도는 **새 시도**이므로 행이 늘 수 있고,
    // 그 목록 자체가 "이 메일이 몇 번 시도됐는가" 에 대한 답이다.
    attempts: records.map(toBody),
  });
}
