#!/usr/bin/env tsx
/**
 * scripts/admin/agent-delete.ts — 에이전트 삭제(소프트 삭제 · 되돌릴 수 없다).
 *
 *   pnpm admin:agent-delete --agent <agentId> --reason "<사유>" [--from-operator-suspension] [--by <운영자>] [--yes]
 *
 * **삭제는 `src/admin/ops/agents.ts` 의 `deleteAgentOp`** — 콘솔(`POST /api/agents/{id}/delete`)과 같은 함수를 한 트랜잭션에서 부른다: 토큰 전부 폐기 ·
 * `status → disabled` · 주소 전부 폐기(대표 · 앵커 · 별칭) · 대기 예약 취소 · 웹훅 끄기 · 대기 중인 정책 변경 요청 닫기. 같은 거부도 그대로다:
 *   - 운영자 예약 주소(support@ 등)를 쥔 에이전트 → 409 `operator_reserved`(운영자가 그 주소를 먼저 옮긴다 — `admin:reserved-address`).
 *   - 운영자 정지(`admin:kill-switch --agent … on`) 상태 → 409 `operator_suspension`(공유 연산 · 콘솔과 같다). 운영자가 정지한 에이전트를 지우려면
 *     `--from-operator-suspension` — **한 트랜잭션**에서 조직 별칭 잠금 → 에이전트 행 잠금(FOR NO KEY UPDATE) → 운영자 정지 해제
 *     (`setAgentSuspendedOp`, 커밋 전이라 다른 트랜잭션에는 보이지 않는다) → `deleteAgentOp`. 커밋 뒤의 상태는 `disabled` 뿐이다 — 정지를 따로 풀고
 *     지우는 두 단계 사이의 발송 창(예약 발송 · 승인 릴리스 · 토큰 발급)이 없다(보안 리뷰 M1). `deleteAgentOp` 의 공유 의미는 그대로다.
 *   - `provisioning` → 409 `invalid_transition` · 없는 에이전트 → `agent_not_found`.
 *   - 이미 삭제됨 → 재생(상태는 그대로, 남은 주소 · 토큰 · 예약 · 웹훅만 정리).
 *
 * **감사(지속).** 삭제와 **같은 트랜잭션**에서 `owner_actions` 1행 — 행위 `agent.delete`(콘솔 삭제와 같은 코드) · 대상 = 에이전트 id · 행위자
 * `admin:agent-delete:<운영자>`(운영자 행위자 칸 `operator_actor`, 202610131610) · 사유 `--reason`(+ `from_operator_suspension`). 그 행은 조직의
 * 투명성 로그 `owner.action` 잎(`c.operator`)이 된다. 재생(이미 삭제됨)은 남은 것을 정리했을 때만 적는다. DB 의 나머지 흔적은 콘솔 삭제와 같다
 * (상태 잎 · 주소 폐기 잎 · 토큰 `revoked_at`).
 */

import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { displayAddress, INVISIBLE_OR_CONTROL_CHARACTERS } from '../../src/admin/display';
import { lockOrganizationAliases } from '../../src/admin/ops/addresses';
import { deleteAgentOp, recordOperatorActionOp, setAgentSuspendedOp } from '../../src/admin/ops/agents';
import { transactionPool } from '../../src/admin/ops/transaction';
import { withTransaction } from '../../src/db/client';
import { isAgentId, type AgentId } from '../../src/db/schema';

import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps, type TargetInfo } from './common';

const USAGE = 'pnpm admin:agent-delete --agent <agentId> --reason "<사유>" [--from-operator-suspension] [--by <운영자>] [--yes]';

export const DELETE_REASON_MAX = 500;

export interface AgentDeleteCommand {
  readonly agentId: AgentId;
  readonly reason: string;
  /** 운영자 정지를 같은 트랜잭션에서 풀고 지운다(운영자 정지 상태일 때만). */
  readonly fromOperatorSuspension: boolean;
  readonly by: string | undefined;
  readonly yes: boolean;
}

/** 플래그 → 명령. 연결 전에 거부한다. `null` = `--help`. */
export function parseAgentDeleteArgs(argv: readonly string[]): AgentDeleteCommand | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      reason: { type: 'string' },
      'from-operator-suspension': { type: 'boolean', default: false },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return null;
  const agentRaw = values.agent?.trim() ?? '';
  if (!isAgentId(agentRaw)) throw new AdminInputError(`--agent 는 에이전트 id(hex 32). ${USAGE}`);
  const reason = values.reason?.trim() ?? '';
  if (reason === '') throw new AdminInputError(`--reason 이 필요하다 — 되돌릴 수 없는 삭제의 사유가 감사(owner_actions)와 조직의 투명성 로그에 남는다. ${USAGE}`);
  if (reason.length > DELETE_REASON_MAX) throw new AdminInputError(`--reason 은 ${String(DELETE_REASON_MAX)}자 이하.`);
  // eslint-disable-next-line no-control-regex -- 한 줄 사유만(출력 · 노트 한 줄을 깨지 않게).
  if (/[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw new AdminInputError('--reason 은 한 줄(제어 문자 없음).');
  if (INVISIBLE_OR_CONTROL_CHARACTERS.test(reason)) throw new AdminInputError('--reason 에 보이지 않는 글자(제로폭 · 방향 제어 등)를 쓸 수 없다.');
  return { agentId: agentRaw, reason, fromOperatorSuspension: values['from-operator-suspension'], by: values.by, yes: values.yes };
}

export async function agentDelete(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const command = parseAgentDeleteArgs(argv);
  if (command === null) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  return withAdminConnection(deps, ({ pool, target }) => runAgentDelete(pool, target, command, deps));
}

/**
 * 본체 — 붙은 풀에서. 테스트는 트랜잭션 풀(`transactionPool`)을 넘겨 되돌릴 픽스처(운영자 예약 주소 허가) 위에서 부른다.
 * `deleteAgentOp` 는 호출자의 트랜잭션을 요구한다 — `withTransaction` 이 연다(트랜잭션 풀이면 세이브포인트).
 */
export async function runAgentDelete(pool: Pool, target: TargetInfo, command: AgentDeleteCommand, deps: AdminDeps): Promise<number> {
  const actor = actorOf('admin:agent-delete', command.by, deps.env);
  const { agentId } = command;
  const found = await pool.query<{ organization_id: string; status: string; suspended_by: string | null }>(
    'SELECT organization_id::text AS organization_id, status::text AS status, suspended_by::text AS suspended_by FROM agents WHERE id = $1',
    [agentId],
  );
  const agent = found.rows[0];
  if (agent === undefined) throw new AdminInputError(`에이전트가 없다: ${agentId}`, 'agent_not_found', 404);
  const live = await pool.query<{ address: string }>(
    'SELECT address FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL ORDER BY address',
    [agentId],
  );
  const operatorSuspended = agent.status === 'suspended' && agent.suspended_by === 'operator';
  if (command.fromOperatorSuspension && !operatorSuspended) {
    throw new AdminInputError(`--from-operator-suspension 은 운영자 정지한 에이전트에만 — 지금 ${agent.status}${agent.suspended_by === null ? '' : `(${agent.suspended_by})`}.`, 'not_operator_suspended', 409);
  }
  deps.io.err(`에이전트 ${agentId} · 조직 ${agent.organization_id} · 상태 ${agent.status}${agent.suspended_by === null ? '' : `(${agent.suspended_by})`}`);
  deps.io.err(`  살아 있는 주소: ${live.rows.length === 0 ? '없음' : live.rows.map((row) => displayAddress(row.address)).join(', ')}`);
  await confirmProduction(
    target,
    `에이전트 ${agentId} 삭제(되돌릴 수 없다 — 토큰 · 주소 전부 폐기)${command.fromOperatorSuspension ? ' · 운영자 정지 해제와 한 트랜잭션' : ''} · 행위자 ${actor} · 사유 ${command.reason}`,
    command.yes,
    deps.io,
  );

  const result = await withTransaction(pool, async (client) => {
    const tx = transactionPool(client);
    if (command.fromOperatorSuspension) {
      // 잠금 순서는 `deleteAgentOp` 와 같다(조직 별칭 → 에이전트 행) — 별칭 추가 · 토큰 발급 · 웹훅 등록과 교착하지 않고 줄 선다.
      await lockOrganizationAliases(tx, agent.organization_id);
      const locked = await tx.query<{ status: string; suspended_by: string | null }>(
        'SELECT status::text AS status, suspended_by::text AS suspended_by FROM agents WHERE id = $1 FOR NO KEY UPDATE',
        [agentId],
      );
      const now = locked.rows[0];
      if (now?.status !== 'suspended' || now.suspended_by !== 'operator') {
        throw new AdminInputError('운영자 정지 상태가 바뀌었다 — 다시 확인하라. 아무것도 바꾸지 않았다.', 'not_operator_suspended', 409);
      }
      // 커밋 전 해제 — 다른 트랜잭션은 커밋된 'suspended' 를 보다가 커밋 뒤 'disabled' 를 본다('active' 는 보이지 않는다).
      await setAgentSuspendedOp(tx, agentId, false, 'operator');
    }
    const deleted = await deleteAgentOp(tx, agent.organization_id, agentId);
    if (!deleted.replayed || deleted.changed) {
      await recordOperatorActionOp(tx, {
        organizationId: agent.organization_id,
        action: 'agent.delete',
        targetId: agentId,
        actor,
        reason: `${command.reason}${command.fromOperatorSuspension ? ' · from_operator_suspension' : ''}${deleted.replayed ? ' · replayed' : ''}`,
      });
    }
    return deleted;
  });
  deps.io.out(`agent\t${agentId}`);
  deps.io.out(`replayed\t${String(result.replayed)}`);
  deps.io.out(`addresses\t${result.addresses.map(displayAddress).join(',')}`);
  deps.io.out(`revoked_tokens\t${String(result.revokedTokens)}`);
  deps.io.out(`cancelled_scheduled\t${String(result.cancelledScheduled)}`);
  deps.io.out(`disabled_webhooks\t${String(result.disabledWebhooks)}`);
  deps.io.err(
    result.replayed
      ? `이미 삭제된 에이전트다 — ${result.changed ? '남은 것을 정리했다' : '바뀐 것 없음'}.`
      : '삭제했다 — 되돌릴 수 없다.',
  );
  deps.io.out(`audited\t${String(!result.replayed || result.changed)}`);
  deps.io.err(`감사: owner_actions agent.delete · 행위자 ${actor} — 조직의 투명성 로그에 남는다.`);
  return EXIT_OK;
}

if (isMain(import.meta.url)) await runAdminMain(agentDelete);
