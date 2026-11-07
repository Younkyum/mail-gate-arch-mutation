/**
 * src/admin/routes/watch.ts — 콘솔 '감시' 탭의 받기 설정 · 보류 메일(ADR-0016 2026-10-08 · 연산 `ops/watch.ts`).
 *
 *   - `GET   /api/watch/settings`                        → 200 `{trustedSenders:[{kind, value, createdAt}], maxTrustedSenders, updatedAt}`   member
 *   - `PATCH /api/watch/settings {trustedSenders:[..]}`  → 200 위 + `{changed, added, removed}` — 목록을 **통째로** 바꾼다             **owner**
 *   - `GET   /api/agents/{agentId}/watch`                → 200 `{agentId, riskHandling, riskNotify, sendApproval, updatedAt}`               member
 *   - `PATCH /api/agents/{agentId}/watch {riskHandling?, riskNotify?, sendApproval?}` → 200 위 + `{changed, sendApprovalChanged}`         admin
 *     (`sendApproval` auto | always — 정책 새 버전 · 감사 `watch.send_approval.set`, ADR-0016 2026-10-08)
 *   - `PATCH /api/watch/settings {agentSelfEnroll?, enrollDailyCap?, notifyOnEnroll?, notifyOnSignup?}` → 200 위 + `{changed}` — 조직 설정(묶음 D,
 *     trustedSenders 와 한 요청에 섞지 않는다 · 감사 `watch.org.set`)                                                                       **owner**
 *   - `GET   /api/watch/signups?agentId=&limit=&cursor=` → 200 `{items:[{agentId, agentName, serviceDomain, kind, firstSeenAt, lastSeenAt, messageCount}], nextCursor}` member
 *   - `GET   /api/watch/held?agentId=&limit=&cursor=`    → 200 `{items:[HeldMessageView], nextCursor}` — 최근 것부터 · 본문 없음              member
 *   - `POST  /api/watch/held/{messageId}/release`        → 200 `{id, agentId, releasedAt, releasedFrom, level, replayed}`                  admin
 *
 * 신뢰 발신자는 **소유자만** 바꾼다 — 탐지 효과를 건너뛰는 유일한 설정이라(DMARC 인증된 From 에만 서지만) 정책을 넓히는 쪽이다. 위험 처리 · 알림 ·
 * 풀기는 관리자도 된다(정책 수정 · 예약 취소와 같은 역할). 풀기는 정책 차단(409 `release_policy_blocked`) · 판정 없음(409 `release_not_scanned`) ·
 * 숨지 않은 메일(409 `message_not_held`)을 거부하고, 이미 풀린 메일은 200 `replayed`(감사 없음). 바뀐 호출만 감사 1행(행위와 한 트랜잭션 — `audited`).
 */

import { actorOfSession, audited, objectBody, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { AdminInputError, notFound } from '../ops/errors';
import {
  agentWatchPatchOf,
  getAgentWatchSettingsOp,
  getOrgWatchSettingsOp,
  heldListQueryOf,
  isMessageId,
  listHeldOp,
  listSignupsOp,
  ORG_WATCH_PATCH_KEYS,
  orgWatchPatchOf,
  releaseHeldOp,
  setAgentWatchOp,
  setOrgWatchOp,
  setTrustedSendersOp,
  signupListQueryOf,
  trustedSendersOf,
  WATCH_AGENT_SET_ACTION,
  WATCH_ORG_SET_ACTION,
  WATCH_RELEASE_ACTION,
  WATCH_SEND_APPROVAL_SET_ACTION,
  WATCH_TRUSTED_SENDERS_SET_ACTION,
  type AgentWatchChange,
  type OrgWatchChange,
} from '../ops/watch';

const ORG_KEYS: ReadonlySet<string> = new Set(['trustedSenders', ...ORG_WATCH_PATCH_KEYS]);

/** `GET /api/watch/settings` */
export async function handleGetWatchSettings(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, await getOrgWatchSettingsOp(call.deps.pool, sessionOf(call).organizationId));
}

/** `PATCH /api/watch/settings {trustedSenders}` 또는 조직 설정 키 */
export async function handleSetWatchSettings(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const unknown = Object.keys(body).find((key) => !ORG_KEYS.has(key));
  if (unknown !== undefined) {
    throw new AdminInputError(`모르는 키: ${unknown} (trustedSenders · agentSelfEnroll · enrollDailyCap · notifyOnEnroll · notifyOnSignup)`, 'invalid_body');
  }
  const orgKeys = Object.keys(body).filter((key) => key !== 'trustedSenders');
  // 한 번에 한 묶음 — 신뢰 발신자 목록 또는 조직 설정(감사 행위 이름이 하나로 정해지게).
  if (orgKeys.length > 0) {
    if (body['trustedSenders'] !== undefined) throw new AdminInputError('trustedSenders 와 조직 설정은 따로 바꾼다.', 'invalid_body');
    const patch = orgWatchPatchOf(body);
    const changed = await audited<OrgWatchChange>(
      call.deps.pool,
      session,
      WATCH_ORG_SET_ACTION,
      (tx) => setOrgWatchOp(tx, session.organizationId, session.userId, patch),
      (outcome) => (outcome.changed ? session.organizationId : undefined),
    );
    return jsonResponse(200, changed);
  }
  const entries = trustedSendersOf(body['trustedSenders']);
  const result = await audited(
    call.deps.pool,
    session,
    WATCH_TRUSTED_SENDERS_SET_ACTION,
    (tx) => setTrustedSendersOp(tx, session.organizationId, session.userId, entries),
    (outcome) => (outcome.changed ? session.organizationId : undefined),
  );
  return jsonResponse(200, result);
}

/** `GET /api/agents/{agentId}/watch` */
export async function handleGetAgentWatch(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  return jsonResponse(200, await getAgentWatchSettingsOp(call.deps.pool, agentId));
}

/** `PATCH /api/agents/{agentId}/watch {riskHandling?, riskNotify?, sendApproval?}` */
export async function handleSetAgentWatch(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const patch = agentWatchPatchOf(objectBody(call.request.body));
  const result = await audited<AgentWatchChange>(
    call.deps.pool,
    session,
    (outcome) => (outcome.sendApprovalChanged ? WATCH_SEND_APPROVAL_SET_ACTION : WATCH_AGENT_SET_ACTION),
    (tx) => setAgentWatchOp(tx, session.organizationId, session.userId, agentId, patch, actorOfSession(session), session.role),
    (outcome) => (outcome.changed ? agentId : undefined),
  );
  return jsonResponse(200, result);
}

/** `GET /api/watch/signups?agentId=&limit=&cursor=` */
export async function handleListSignups(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  return jsonResponse(200, await listSignupsOp(call.deps.pool, session.organizationId, signupListQueryOf(call.request.query)));
}

/** `GET /api/watch/held` */
export async function handleListHeld(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  return jsonResponse(200, await listHeldOp(call.deps.pool, session.organizationId, heldListQueryOf(call.request.query)));
}

/** `POST /api/watch/held/{messageId}/release` */
export async function handleReleaseHeld(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const id = call.params['messageId'] ?? '';
  if (!isMessageId(id)) throw new AdminInputError('messageId 는 받은 메일 id(소문자 uuid)다.', 'invalid_message_id');
  if (call.request.body !== undefined) {
    const body = objectBody(call.request.body);
    if (Object.keys(body).length > 0) throw new AdminInputError('본문은 비어 있어야 한다.', 'invalid_body');
  }
  const outcome = await audited(
    call.deps.pool,
    session,
    WATCH_RELEASE_ACTION,
    (tx) => releaseHeldOp(tx, session.organizationId, session.userId, id),
    (result) => (result.kind === 'released' ? id : undefined),
  );
  switch (outcome.kind) {
    case 'not_found':
      throw notFound('받은 메일이 없다.', 'message_not_found');
    case 'policy_blocked':
      throw new AdminInputError('수신 정책으로 막은 메일은 풀지 않는다 — 수신 정책(허용 · 차단 목록)을 고쳐라.', 'release_policy_blocked', 409);
    case 'not_releasable':
      throw new AdminInputError('검사를 마치지 못한 메일은 풀지 않는다.', 'release_not_scanned', 409);
    case 'not_held':
      throw new AdminInputError('숨은 메일이 아니다.', 'message_not_held', 409);
    case 'released':
    case 'replayed':
      // 실시간 힌트(묶음 E) — 풀기는 커밋됐다(`audited` 트랜잭션). 처음 풀 때만(다시 누른 `replayed` 는 이미 밀었다). 던지지 않는다 · 1초 상한.
      if (outcome.kind === 'released' && call.deps.realtime !== undefined) await call.deps.realtime.messagesVisible([id]);
      return jsonResponse(200, {
        id,
        agentId: outcome.agentId,
        releasedAt: outcome.releasedAt.toISOString(),
        releasedFrom: outcome.releasedFrom,
        level: outcome.releasedFrom === 'risk_hold' ? 'risk' : 'block',
        replayed: outcome.kind === 'replayed',
      });
  }
}
