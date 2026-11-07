#!/usr/bin/env tsx
/**
 * scripts/admin/policy-request.ts — 에이전트의 정책 변경 요청(ADR-0007 2026-10-13 개정)을 운영자가 보고 · 승인하고 · 거절한다.
 *
 *   pnpm admin:policy-request --agent <agentId> --list
 *   pnpm admin:policy-request --agent <agentId> --approve <requestId> [--ack-risk] [--reason "<사유>"] [--by <운영자>] [--yes]
 *   pnpm admin:policy-request --agent <agentId> --reject <requestId> [--reason "<사유>"] [--by <운영자>] [--yes]
 *
 * **결정은 `src/admin/ops/policy-requests.ts` 의 `decidePolicyRequestOp`** — 콘솔(`POST /api/agents/{id}/change-requests/{rid}/approve|reject`)과
 * 같은 함수다: 같은 검사(관리 연산 `addRuleOp` · `removeRuleOp` · `changePolicyOp`) · 같은 새 정책 버전 · 낙관적 버전 확인(`--list` 와 같은 읽기로
 * 차이를 그린 버전을 `expectedVersion` 으로 보낸다 — 그 사이 정책이 바뀌면 409 `policy_changed`) · stale · 만료 · 위험 경고 확인(오염된 요청은
 * `--ack-risk` 없이 409 `risk_ack_required`, 서버 쪽 강제).
 *
 * **행위자는 운영자다 — 사용자 세션을 흉내 내지 않는다.** `decided_by = admin:policy-request:<--by | USER>`, `decided_user_id = NULL`,
 * 정책 버전 `created_by = admin:policy-request:<…> policy_request:<요청 id>`(`admin:rules` · `admin:policy` 와 같은 관례 — 투명성 잎은 정책 버전의
 * 기존 트리거).
 *
 * **감사(지속).** 결정과 **같은 트랜잭션**에서 `owner_actions` 1행 — 행위는 콘솔과 같은 코드(`agent.policy_request.approve` · `.reject` · `.stale`;
 * 만료는 시간이 닫은 것이라 콘솔처럼 행 없음) · 대상 = 에이전트 id · 운영자 행위자 칸(`operator_actor` = 위 행위자, 202610131610) · 사유
 * `policy_request:<요청 id>`(+ ` · <--reason>`). 그 행은 조직의 투명성 로그 `owner.action` 잎(`c.operator`)이 된다(`admin:agent-delete` 와 같은 길).
 * 서열기 능력(`owner_action_operator_actor`)이 없으면 가드가 55000 으로 끊고 결정도 함께 되돌아간다 — 감사 없는 결정은 남지 않는다.
 *
 * 이유(`reason`)와 값은 **에이전트가 쓴 글자**다 — 출력 전에 콘솔과 같은 표시 규칙(`displaySubject` · `displayAddress`)으로 거른다.
 */

import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { displayAddress, displaySubject, INVISIBLE_OR_CONTROL_CHARACTERS } from '../../src/admin/display';
import { recordOperatorActionOp } from '../../src/admin/ops/agents';
import { decidePolicyRequestOp, listPolicyRequestsOp, type PolicyRequestOutcome, type PolicyRequestView } from '../../src/admin/ops/policy-requests';
import { transactionPool } from '../../src/admin/ops/transaction';
import { withTransaction } from '../../src/db/client';
import { isAgentId, type AgentId } from '../../src/db/schema';
import type { PolicyRequestChange } from '../../src/policy/policy-requests';
import {
  actorOf,
  AdminInputError,
  confirmProduction,
  EXIT_FAILURE,
  EXIT_OK,
  isMain,
  runAdminMain,
  withAdminConnection,
  type AdminDeps,
  type TargetInfo,
} from './common';

const USAGE =
  'pnpm admin:policy-request --agent <agentId> (--list | --approve <requestId> [--ack-risk] | --reject <requestId>) [--reason "<사유>"] [--by <운영자>] [--yes]';

/** `--reason` 상한 — `admin:agent-delete` 와 같다(감사 칸 `OPERATOR_ACTION_REASON_MAX` 보다 짧다). */
export const DECISION_REASON_MAX = 500;

/** 결과 → 감사 행위(콘솔 `src/admin/routes/policy-requests.ts` 와 같은 코드). 만료는 행 없음. */
export const POLICY_REQUEST_AUDIT_ACTIONS: Readonly<Record<PolicyRequestOutcome['kind'], string | null>> = {
  approved: 'agent.policy_request.approve',
  rejected: 'agent.policy_request.reject',
  stale: 'agent.policy_request.stale',
  expired: null,
};

/** 목록의 이유 칸 길이 — 한 줄 표에 맞춘다(전문은 콘솔). */
export const REASON_PREVIEW_MAX = 60;

export function changeText(change: PolicyRequestChange): string {
  if (change.action === 'set_mode') return `${change.direction} mode → ${change.mode}`;
  const op = change.action === 'add_rule' ? '+' : '−';
  return `${change.direction} ${change.list} ${op} ${displayAddress(change.value)}`;
}

export function reasonPreview(reason: string): string {
  const clean = displaySubject(reason);
  return clean.length > REASON_PREVIEW_MAX ? `${clean.slice(0, REASON_PREVIEW_MAX - 1)}…` : clean;
}

function riskText(view: PolicyRequestView): string {
  if (!view.tainted) return '-';
  return view.taintedAtRequest ? 'tainted(요청 때)' : 'tainted(요청 뒤)';
}

/** 목록 한 줄 — `id \t 상태 \t 변경 \t 위험 \t 만든 시각 \t 이유(잘림)`. */
export function requestLine(view: PolicyRequestView): string {
  return [view.id, view.status, changeText(view.change), riskText(view), view.createdAt, reasonPreview(view.reason)].join('\t');
}

function diffText(view: PolicyRequestView): string {
  const diff = view.diff;
  if (diff === null) return '(차이 없음 — pending 이 아니다)';
  if (diff.kind === 'mode') return `${diff.direction} 모드 ${diff.before} → ${diff.after}${diff.inEffect ? ' (이미 그 상태)' : ''}`;
  return `${diff.direction} ${diff.list} ${diff.op === 'add' ? '+' : '−'} ${displayAddress(diff.value)} · 항목 ${String(diff.countBefore)} → ${String(diff.countAfter)}${diff.inEffect ? ' (이미 그 상태)' : ''}`;
}

export interface PolicyRequestCommand {
  readonly agentId: AgentId;
  readonly action: 'list' | 'approve' | 'reject';
  readonly requestId: string;
  readonly ackRisk: boolean;
  /** 감사 사유에 덧붙이는 운영자 메모(선택 · 한 줄). */
  readonly reason: string | undefined;
  readonly by: string | undefined;
  readonly yes: boolean;
}

/** 플래그 → 명령. 연결 전에 거부한다. `null` = `--help`. */
export function parsePolicyRequestArgs(argv: readonly string[]): PolicyRequestCommand | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      list: { type: 'boolean', default: false },
      approve: { type: 'string' },
      reject: { type: 'string' },
      'ack-risk': { type: 'boolean', default: false },
      reason: { type: 'string' },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return null;
  const agentRaw = values.agent?.trim() ?? '';
  if (!isAgentId(agentRaw)) throw new AdminInputError(`--agent 는 에이전트 id(hex 32). ${USAGE}`);
  const actions = [values.list, values.approve !== undefined, values.reject !== undefined].filter(Boolean).length;
  if (actions !== 1) throw new AdminInputError(`--list · --approve · --reject 중 정확히 하나. ${USAGE}`);
  if (values['ack-risk'] && values.approve === undefined) throw new AdminInputError('--ack-risk 는 --approve 와만 쓴다.');
  const action = values.list ? 'list' : values.approve !== undefined ? 'approve' : 'reject';
  const requestId = (values.approve ?? values.reject ?? '').trim();
  if (action !== 'list' && requestId === '') throw new AdminInputError(`요청 id 가 비었다. ${USAGE}`);
  const reason = values.reason?.trim();
  if (reason !== undefined) {
    if (action === 'list') throw new AdminInputError('--reason 은 --approve · --reject 와만 쓴다.');
    if (reason === '') throw new AdminInputError('--reason 이 비었다.');
    if (reason.length > DECISION_REASON_MAX) throw new AdminInputError(`--reason 은 ${String(DECISION_REASON_MAX)}자 이하.`);
    // eslint-disable-next-line no-control-regex -- 한 줄 사유만(출력 · 감사 한 줄을 깨지 않게).
    if (/[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw new AdminInputError('--reason 은 한 줄(제어 문자 없음).');
    if (INVISIBLE_OR_CONTROL_CHARACTERS.test(reason)) throw new AdminInputError('--reason 에 보이지 않는 글자(제로폭 · 방향 제어 등)를 쓸 수 없다.');
  }
  return { agentId: agentRaw, action, requestId, ackRisk: values['ack-risk'], reason, by: values.by, yes: values.yes };
}

export async function policyRequest(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const command = parsePolicyRequestArgs(argv);
  if (command === null) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  return withAdminConnection(deps, ({ pool, target }) => runPolicyRequest(pool, target, command, deps));
}

/**
 * 본체 — 붙은 풀에서. 테스트는 트랜잭션 풀(`transactionPool`)을 넘겨 되돌릴 픽스처(서열기 능력 지우기) 위에서 부른다.
 * 결정(`decidePolicyRequestOp` — 자기 트랜잭션을 연다, 여기서는 세이브포인트)과 감사 1행이 `withTransaction` 하나 안에 있다.
 */
export async function runPolicyRequest(pool: Pool, target: TargetInfo, command: PolicyRequestCommand, deps: AdminDeps): Promise<number> {
  const actor = actorOf('admin:policy-request', command.by, deps.env);
  const { agentId } = command;
  // 위험 노출 정의자가 에이전트의 조직을 다시 본다(202610131500 — 보안 감사 L-3). 운영자 CLI 는 그 에이전트의 조직으로 부른다.
  const owning = await pool.query<{ organization_id: string }>('SELECT organization_id::text AS organization_id FROM agents WHERE id = $1', [agentId]);
  const organizationId = owning.rows[0]?.organization_id;
  if (organizationId === undefined) throw new AdminInputError(`에이전트가 없다: ${agentId}`, 'agent_not_found');
  // 목록과 승인이 같은 읽기 — 승인은 여기서 본 버전을 `expectedVersion` 으로 보낸다(콘솔과 같은 낙관적 확인).
  const listed = await listPolicyRequestsOp(pool, organizationId, agentId, 'all', new Date());
  if (command.action === 'list') {
    for (const item of listed.items) deps.io.out(requestLine(item));
    const pending = listed.items.filter((item) => item.status === 'pending').length;
    deps.io.err(`에이전트 ${agentId} · 정책 v${String(listed.currentVersion)} · 대기 ${String(pending)}건 · 최근 ${String(listed.items.length)}건`);
    return EXIT_OK;
  }

  const seen = listed.items.find((item) => item.id === command.requestId);
  if (seen !== undefined) {
    deps.io.err(`요청 ${seen.id} · ${seen.status} · ${changeText(seen.change)}`);
    deps.io.err(`  이유: ${reasonPreview(seen.reason)}`);
    if (seen.status === 'pending') deps.io.err(`  승인하면: ${diffText(seen)}`);
    if (seen.tainted) {
      deps.io.err(`  ⚠ 위험 경고 — 이 에이전트는 요청 직전 또는 그 뒤에 위험 표시된 메일을 읽었다(마지막 ${seen.lastRiskExposureAt ?? '?'}).`);
      if (command.action === 'approve' && !command.ackRisk) deps.io.err('    승인하려면 내용을 확인하고 --ack-risk 를 준다(없으면 서버가 거부한다).');
    }
  }
  const verb = command.action === 'approve' ? '승인' : '거절';
  await confirmProduction(target, `에이전트 ${agentId} 정책 변경 요청 ${command.requestId} ${verb} (행위자 ${actor})`, command.yes, deps.io);

  const decision = command.action;
  const outcome = await withTransaction(pool, async (client) => {
    const tx = transactionPool(client);
    const decided = await decidePolicyRequestOp(tx, {
      organizationId,
      agentId,
      requestId: command.requestId,
      decision,
      actor,
      userId: null,
      ...(decision === 'approve' ? { expectedVersion: listed.currentVersion, riskAcknowledged: command.ackRisk } : {}),
      now: new Date(),
    });
    const action = POLICY_REQUEST_AUDIT_ACTIONS[decided.kind];
    if (action !== null) {
      await recordOperatorActionOp(tx, {
        organizationId,
        action,
        targetId: agentId,
        actor,
        reason: `policy_request:${decided.request.id}${command.reason === undefined ? '' : ` · ${command.reason}`}`,
      });
    }
    return decided;
  });
  const audit = POLICY_REQUEST_AUDIT_ACTIONS[outcome.kind];
  if (audit !== null) deps.io.err(`감사: owner_actions ${audit} · 행위자 ${actor} — 조직의 투명성 로그에 남는다.`);
  switch (outcome.kind) {
    case 'approved':
      deps.io.out(`approved\t${outcome.request.id}\tv${String(outcome.policy.version)}`);
      deps.io.err(`승인했다 — 정책 v${String(outcome.policy.version)} · 행위자 ${actor}`);
      return EXIT_OK;
    case 'rejected':
      deps.io.out(`rejected\t${outcome.request.id}`);
      deps.io.err(`거절했다 — 행위자 ${actor}`);
      return EXIT_OK;
    case 'stale':
      deps.io.out(`stale\t${outcome.request.id}\t${outcome.reason}`);
      deps.io.err(`지금 정책에서는 적용할 수 없어 요청을 닫았다(${outcome.reason}) — 정책은 바뀌지 않았다.`);
      return EXIT_FAILURE;
    case 'expired':
      deps.io.out(`expired\t${outcome.request.id}`);
      deps.io.err('7일이 지나 만료된 요청이다 — expired 로 닫았다. 정책은 바뀌지 않았다.');
      return EXIT_FAILURE;
  }
}

if (isMain(import.meta.url)) await runAdminMain(policyRequest);
