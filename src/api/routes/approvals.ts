/**
 * `GET /v1/approvals/{id}` — **웹훅 유실 대비 조회** (계획 §3.4 1조).
 *
 * *"에이전트는 폴링하지 않는다 — `approval.resolved` / `message.sent` webhook 을 받는다.
 * `GET /v1/approvals/{id}` 도 제공(webhook 유실 대비)."* 웹훅 재시도는 약 31시간 뒤 멈춘다
 * (`webhooks/dispatcher.ts`) — 그 뒤의 진실은 여기서 읽는다.
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 조회 전용이고 관문을 import 하지 않는다.
 *
 * **인가는 행을 읽은 뒤, 행이 말하는 소유자로 한다** — `audit.ts` 와 같은 규약이다. 대상 에이전트를
 * 요청이 주장하게 두면 그 주장이 통과 조건이 된다. 없는 요청(404)과 남의 요청(403)이 구별되는 것도
 * 같은 판단이다(uuid 를 맞혀야 하는 공격자가 얻는 것보다 운영자가 얻는 것이 크다).
 *
 * **응답은 웹훅과 같은 결의 얇은 모양이다** — 수신자 주소·결정자를 싣지 않는다(`webhooks/events.ts`
 * 머리말). 에이전트는 자기가 보낸 요청의 수신자를 이미 알고, `decided_by` 는 소유자 쪽의 사정이다.
 */

import type { ApprovalStore } from '../../approval/service';
import type { AgentTokenStore } from '../../identity/agent-token';
import { authenticateRequest, authorizeRequest } from '../auth';
import { errorResponse, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';

export interface ApprovalRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly approvals: Pick<ApprovalStore, 'find' | 'items'>;
  readonly now: () => Date;
}


export async function handleGetApproval(
  deps: ApprovalRouteDependencies,
  request: ApiRequest,
  params: { readonly approvalId: string },
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.approvalId)) {
    return errorResponse(400, 'invalid_request', 'approval id must be a lowercase uuid.');
  }

  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return authentication.response;

  const approval = await deps.approvals.find(params.approvalId);
  if (approval === null) {
    return errorResponse(404, 'approval_not_found', `No approval with approval_id=${params.approvalId}.`);
  }
  const forbidden = authorizeRequest(authentication.principal, 'messages:read', approval.agent_id);
  if (forbidden !== null) return forbidden;

  const items = await deps.approvals.items(approval.id);
  return jsonResponse(200, {
    id: approval.id,
    agent_id: approval.agent_id,
    // 'message' | 'batch' — 배치(전환 공지)면 message_ids 가 여럿이다.
    kind: approval.subject,
    status: approval.status,
    created_at: approval.created_at.toISOString(),
    expires_at: approval.expires_at.toISOString(),
    decided_at: approval.decided_at === null ? null : approval.decided_at.toISOString(),
    granted_scope: approval.granted_scope,
    message_ids: items.map((item) => item.message_id),
  });
}
