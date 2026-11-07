/**
 * src/admin/routes/gate.ts — AC-0 판정 조회·기록 (계약 `/api/gate*`). `pnpm check:ac0`·`ac0:start|forwarding|intervention`
 * 과 **같은 함수**(`src/gate/ac0-report.ts`·`src/gate/ac0-commands.ts`)를 부른다. 게이트는 세션 조직의 것만 보인다.
 *
 * 판정 게이트를 자동으로 고르지 않는다(`scripts/ac0-common.ts` 와 같은 규율 — 틀린 게이트의 통과는 공허 통과다): 후보가 정확히
 * 하나일 때만 판정을 싣고, 여럿이면 `report: null` + 목록을 준다(`?gate=<id>` 로 고른다).
 */

import type { Queryable } from '../../db/client';
import {
  Ac0GateExistsError,
  recordForwardingOp,
  recordInterventionOp,
  resolveForwardingState,
  resolveInterventionCategory,
  resolveInterventionReason,
  startAc0GateOp,
} from '../../gate/ac0-commands';
import { loadAc0Report, renderAc0Report } from '../../gate/ac0-report';
import { listAc0Gates, loadAc0Gate, type Ac0Gate } from '../../gate/ac0-store';
import { AdminInputError, notFound } from '../ops/errors';
import { audited, objectBody, requireAgentInOrganization, sessionOf, type AdminCall, type OwnerSession } from '../context';
import { jsonResponse, type AdminResponse } from '../http';

/** `check:ac0` 의 exit 의미(계획 AC-b6). */
const AC0_EXIT_MEANING = {
  0: '통과',
  1: '재시작 필요 · AC-0 미성립',
  2: '판정 불가(입력·설정·DB)',
  3: '진행 중 · 판정 보류',
} as const;

function gateView(gate: Ac0Gate): Record<string, unknown> {
  return {
    id: gate.id,
    organizationId: gate.organizationId,
    agentId: gate.agentId,
    humanMailboxes: gate.humanMailboxes,
    createdAt: gate.createdAt.toISOString(),
  };
}

async function requireGateInOrganization(db: Queryable, session: OwnerSession, raw: unknown): Promise<Ac0Gate> {
  const gate = typeof raw === 'string' && /^[0-9a-f-]{36}$/i.test(raw) ? await loadAc0Gate(db, raw) : null;
  if (gate === null || gate.organizationId !== session.organizationId) throw notFound('게이트가 없다.', 'gate_not_found');
  return gate;
}

/** `GET /api/gate?agent={id}[&gate={id}]` */
export async function handleGateReport(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentFilter = call.request.query['agent'];
  const agentId = agentFilter === undefined ? null : await requireAgentInOrganization(call.deps.pool, session, agentFilter);
  const gates = (await listAc0Gates(call.deps.pool, session.organizationId)).filter(
    (gate) => agentId === null || gate.agentId === null || gate.agentId === agentId,
  );
  const chosen =
    call.request.query['gate'] !== undefined
      ? await requireGateInOrganization(call.deps.pool, session, call.request.query['gate'])
      : gates.length === 1
        ? gates[0]
        : undefined;
  let report: Record<string, unknown> | null = null;
  if (chosen !== undefined) {
    const loaded = await loadAc0Report(call.deps.pool, chosen);
    report = {
      gateId: chosen.id,
      gate: gateView(chosen),
      verdict: loaded.verdict,
      exitCode: loaded.verdict.exitCode,
      exitMeaning: AC0_EXIT_MEANING[loaded.verdict.exitCode],
      forwardedTotal: loaded.forwardedTotal,
      auxiliaryOnly: loaded.auxiliaryOnly,
      text: renderAc0Report(loaded),
    };
  }
  return jsonResponse(200, {
    gates: gates.map(gateView),
    report,
    ambiguous: chosen === undefined && gates.length > 1,
    exitMeaning: AC0_EXIT_MEANING,
  });
}

/** `POST /api/gate/start {agentId, humanMailboxes[], day1?}` → 201 `{gateId, day1}` */
export async function handleGateStart(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const agentId = body['agentId'] === undefined || body['agentId'] === null ? null : await requireAgentInOrganization(call.deps.pool, session, body['agentId']);
  const mailboxes = body['humanMailboxes'];
  const day1 = body['day1'];
  let started;
  try {
    started = await audited(
      call.deps.pool,
      session,
      'gate.start',
      (tx) =>
        startAc0GateOp(tx, {
          agentId,
          organizationId: agentId === null ? session.organizationId : null,
          humanMailboxes: Array.isArray(mailboxes) ? mailboxes.filter((value): value is string => typeof value === 'string') : [],
          day1: typeof day1 === 'string' ? day1 : undefined,
          newGate: body['newGate'] === true,
          existingScopeOrganizationId: session.organizationId,
        }),
      (result) => result.gate.id,
    );
  } catch (error) {
    // CLI 문구(`pnpm ac0:restart`·`--new-gate`)를 웹 사용자에게 보이지 않는다 — 웹에서 할 수 있는 것만 말한다.
    if (error instanceof Ac0GateExistsError) {
      throw new AdminInputError(
        `이 조직에 게이트가 이미 ${String(error.count)}개 있다. 재시작은 콘솔에서 하지 않는다(운영자에게 요청). ` +
          '범위를 잘못 정해 따로 새 게이트를 열려면 "새 게이트로 따로 연다" 를 체크하고 다시 시작하라 — 그 뒤 판정할 게이트를 골라야 한다.',
        'gate_exists',
        409,
      );
    }
    throw error;
  }
  const { gate, day1At } = started;
  return jsonResponse(201, { gateId: gate.id, day1: day1At.toISOString() });
}

/** `POST /api/gate/forwarding {gateId, state:'on'|'off'}` → 201 */
export async function handleGateForwarding(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const gate = await requireGateInOrganization(call.deps.pool, session, body['gateId']);
  const state = resolveForwardingState(body['state']);
  const recordedAt = await audited(
    call.deps.pool,
    session,
    state === 'on' ? 'gate.forwarding.on' : 'gate.forwarding.off',
    (tx) => recordForwardingOp(tx, gate.id, state),
    () => gate.id,
  );
  return jsonResponse(201, { gateId: gate.id, state, recordedAt: recordedAt.toISOString() });
}

/** `POST /api/gate/intervention {gateId, category, reason}` → 201 */
export async function handleGateIntervention(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const gate = await requireGateInOrganization(call.deps.pool, session, body['gateId']);
  const category = resolveInterventionCategory(body['category']);
  const reason = resolveInterventionReason(body['reason']);
  const { recordedAt, returnDay } = await audited(
    call.deps.pool,
    session,
    'gate.intervention',
    (tx) => recordInterventionOp(tx, gate.id, category, reason),
    () => gate.id,
  );
  return jsonResponse(201, { gateId: gate.id, category, recordedAt: recordedAt.toISOString(), returnDay });
}
