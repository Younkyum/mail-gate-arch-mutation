/**
 * src/admin/routes/identity.ts — 콘솔 신원 탭 (계약 §3 · T4 메모): 상태 읽기 · 게시 요청 · 정지 요청.
 *
 * **콘솔은 서명하지 않는다** — outbox(`passport_publish_requests`)에 요청 한 줄을 넣을 뿐이고, 서명·게시는 서명 Lambda 가 한다
 * (admin 역할에 KMS Decrypt(직접)·identity 버킷·CloudFront 권한이 없다 — `compute-stack.ts`). 요청과 감사 1행은 **한 트랜잭션**이다
 * (`audited`). 같은 종류의 요청이 이미 처리 중이면 그 요청을 돌려주고 감사하지 않는다(아무것도 바꾸지 않은 호출).
 * 다른 조직의 에이전트는 없는 에이전트와 같은 404(`requireAgentInOrganization`).
 */

import { IdentityRequestConflict, readIdentityView, requestIdentityChange } from '../../passport/admin-view';
import { actorOfSession, audited, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { errorResponse, jsonResponse, type AdminResponse } from '../http';
import { requireLiveAgent } from '../ops/addresses';
import { notFound } from '../ops/errors';

/** `GET /api/agents/{agentId}/identity` → `IdentityView`. */
export async function handleGetIdentity(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  const view = await readIdentityView(call.deps.pool, agentId);
  if (view === null) throw notFound('이 에이전트에는 신원(passport) 행이 없다.', 'identity_not_found');
  return jsonResponse(200, view);
}

async function requestChange(call: AdminCall, kind: 'publish' | 'suspend'): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  try {
    const result = await audited(
      call.deps.pool,
      session,
      kind === 'publish' ? 'agent.identity.publish' : 'agent.identity.suspend',
      // 삭제한 에이전트의 신원은 다시 게시하지 않는다(409 `agent_deleted` — 삭제가 신원 폐기를 요청했다). 정지(내리기)는 그대로 된다.
      async (tx) => {
        if (kind === 'publish') await requireLiveAgent(tx, agentId);
        return requestIdentityChange(tx, agentId, kind, actorOfSession(session));
      },
      (change) => (change.created ? agentId : undefined),
    );
    const identity = await readIdentityView(call.deps.pool, agentId);
    return jsonResponse(202, { request: result.request, identity });
  } catch (error) {
    if (error instanceof IdentityRequestConflict) return errorResponse(409, error.code, error.message);
    throw error;
  }
}

/** `POST /api/agents/{agentId}/identity/publish` → 202 `{request, identity}`. */
export function handlePublishIdentity(call: AdminCall): Promise<AdminResponse> {
  return requestChange(call, 'publish');
}

/** `POST /api/agents/{agentId}/identity/suspend` → 202 `{request, identity}`. */
export function handleSuspendIdentity(call: AdminCall): Promise<AdminResponse> {
  return requestChange(call, 'suspend');
}
