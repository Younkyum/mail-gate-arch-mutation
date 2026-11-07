/**
 * src/admin/routes/members.ts — 멤버·초대 (확장성 P1 R-1, 계획 §3.3). 역할은 라우트 표가 막는다(관리 = owner · 목록·나가기 = member).
 *
 *   - `GET /api/members` → `{members:[{userId,email,role,joinedAt,primary,you}], invites:[{id,email,role,createdAt,expiresAt,status}],
 *     limits:{maxMembers,pendingInvites,maxPendingInvites}}`
 *   - `POST /api/members/invites {email, role:'admin'|'member'}` → 201 `{invite}`
 *   - `POST /api/members/invites/{inviteId}/revoke` → 200 `{invite}`
 *   - `PATCH /api/members/{userId} {role}` → 200 `{member, changed}`
 *   - `DELETE /api/members/{userId}` → 204
 *   - `POST /api/members/leave` → 204 + 세션 쿠키 삭제
 *   - `POST /api/invites/claim {token}` (세션 전) → 202 `{ok:true}` + 로그인 논스 쿠키 · 401 `invite_invalid` · 429
 *
 * **이 파일은 메일을 보내지 않는다.** 초대는 `org_invites`(outbox)에, claim 은 `owner_login_links` 에 행을 적을 뿐이고 메일은 전용 Lambda
 * `atmark-login-mailer` 가 보낸다(ADR-0006). 커밋 뒤 그 Lambda 를 깨울 뿐이다(`kickLoginMailer`).
 */

import { bodyField, clientIpUnavailable, kickLoginMailer, logSecurityEvent, objectBody, sessionOf, type AdminCall } from '../context';
import { clearSessionCookie, errorResponse, jsonResponse, LOGIN_BROWSER_COOKIE, loginBrowserCookie, type AdminResponse } from '../http';
import { changeMemberRoleOp, inviteMemberOp, leaveOrganizationOp, listMembersOp, removeMemberOp, revokeInviteOp } from '../ops/members';
import { claimInvite, LOGIN_BROWSER_TTL_MS } from '../session';

export async function handleListMembers(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, await listMembersOp(call.deps.pool, sessionOf(call), call.deps.now()));
}

export async function handleInviteMember(call: AdminCall): Promise<AdminResponse> {
  const body = objectBody(call.request.body);
  const invite = await inviteMemberOp(call.deps.pool, sessionOf(call), { email: body['email'], role: body['role'] });
  // 초대 행(`org_invites`)이 커밋됐다 — 초대 메일을 1분 틱까지 기다리지 않게.
  await kickLoginMailer(call.deps);
  return jsonResponse(201, { invite });
}

export async function handleRevokeInvite(call: AdminCall): Promise<AdminResponse> {
  const invite = await revokeInviteOp(call.deps.pool, sessionOf(call), call.params['inviteId'], call.deps.now());
  return jsonResponse(200, { invite });
}

export async function handleChangeMemberRole(call: AdminCall): Promise<AdminResponse> {
  const body = objectBody(call.request.body);
  const result = await changeMemberRoleOp(call.deps.pool, sessionOf(call), call.params['userId'], body['role']);
  return jsonResponse(200, result);
}

export async function handleRemoveMember(call: AdminCall): Promise<AdminResponse> {
  await removeMemberOp(call.deps.pool, sessionOf(call), call.params['userId']);
  return jsonResponse(204, null);
}

export async function handleLeaveOrganization(call: AdminCall): Promise<AdminResponse> {
  await leaveOrganizationOp(call.deps.pool, sessionOf(call));
  return jsonResponse(204, null, [clearSessionCookie()]);
}

/** `POST /api/invites/claim {token}` — 로직과 열거·상한 규율은 `admin/session.ts` `claimInvite`. */
export async function handleClaimInvite(call: AdminCall): Promise<AdminResponse> {
  const sourceIp = call.request.sourceIp;
  if (sourceIp === null) return clientIpUnavailable(call.request);
  const outcome = await claimInvite(call.deps.pool, call.deps.loginKeys, {
    token: bodyField(call.request.body, 'token'),
    sourceIp,
    browserNonce: call.request.cookies[LOGIN_BROWSER_COOKIE],
    now: call.deps.now(),
  });
  if (outcome.kind === 'rate_limited') return errorResponse(429, 'rate_limited', '요청이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  if (outcome.kind === 'invalid') {
    logSecurityEvent('invite_invalid', call.request.path, call.request.requestId, null);
    return errorResponse(401, 'invite_invalid', '초대 링크가 유효하지 않다 — 만료됐거나, 취소됐거나, 이미 수락했다. 초대한 사람에게 다시 요청하라.');
  }
  // 커밋 뒤 · 링크 상한에 걸려 0행이어도 같게(`kickLoginMailer`).
  await kickLoginMailer(call.deps);
  return jsonResponse(202, { ok: true }, [loginBrowserCookie(outcome.nonce, LOGIN_BROWSER_TTL_MS / 1000)]);
}
