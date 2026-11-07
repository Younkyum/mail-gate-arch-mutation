/**
 * src/admin/routes/kill-switch.ts — `POST /api/kill-switch {scope:'agent'|'org', id, on}` → 200.
 * Stage 0 이 읽는 값만 바꾼다. 조직 범위는 **세션의 조직**만 — 다른 조직 id 는 404.
 *
 * **소유자 스위치만 만진다**(검증 H3):
 *   - 조직: `organizations.owner_paused`(→ `org_owner_paused`). 플랫폼 동결 `abuse_freeze` 는 운영자 CLI
 *     (`pnpm admin:kill-switch --org`)만 켜고 끈다 — 동결된 조직의 소유자가 콘솔에서 동결을 풀 길이 없다.
 *   - 에이전트: `suspended_by='owner'` 정지. 운영자가 건 정지는 풀지 못한다(409 `operator_suspension`).
 * 역할(F-1): 라우트 표가 admin 이상만 들인다 · 조직 정지 **해제**(`scope:'org', on:false`)는 owner 만(`requireRole`).
 * 행위와 감사 1행은 한 트랜잭션이다(`audited`). 아무것도 바꾸지 않은 호출(이미 그 상태)은 감사하지 않는다.
 */

import { setAgentSuspendedOp, setOwnerPauseOp } from '../ops/agents';
import { AdminInputError, notFound } from '../ops/errors';
import { audited, objectBody, requireAgentInOrganization, requireRole, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';

export async function handleKillSwitch(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const { scope, id, on } = body;
  if (typeof on !== 'boolean') throw new AdminInputError('on 은 true | false 다.', 'invalid_body');
  if (scope === 'org') {
    if (id !== session.organizationId) throw notFound('조직이 없다.', 'organization_not_found');
    // 조직 정지 **해제**는 owner 만(창업자 결정 F-1) — 켜기는 admin 도(라우트 표). 조직 검사 뒤라 다른 조직 id 는 여전히 404.
    if (!on) requireRole(session, 'owner');
    const result = await audited(
      call.deps.pool,
      session,
      on ? 'kill_switch.org.on' : 'kill_switch.org.off',
      (tx) => setOwnerPauseOp(tx, session.organizationId, on),
      (outcome) => (outcome.changed ? session.organizationId : undefined),
    );
    return jsonResponse(200, { scope, id, on, changed: result.changed });
  }
  if (scope !== 'agent') throw new AdminInputError("scope 는 'agent' | 'org' 다.", 'invalid_scope');
  const agentId = await requireAgentInOrganization(call.deps.pool, session, id);
  const result = await audited(
    call.deps.pool,
    session,
    on ? 'kill_switch.agent.on' : 'kill_switch.agent.off',
    (tx) => setAgentSuspendedOp(tx, agentId, on, 'owner'),
    (outcome) => (outcome.changed ? agentId : undefined),
  );
  return jsonResponse(200, { scope, id: agentId, on, status: result.status, suspendedBy: result.suspendedBy, changed: result.changed });
}
