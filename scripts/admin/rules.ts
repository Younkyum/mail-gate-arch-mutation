#!/usr/bin/env tsx
/**
 * scripts/admin/rules.ts — 연락처 목록(`agent_contact_rules`, 정책 v2) 보기·더하기·지우기. `admin:seeds` 를 대체한다.
 *
 *   pnpm admin:rules --agent <agentId> --show
 *   pnpm admin:rules --agent <agentId> --add <주소|도메인> --direction outbound|inbound --list allow|block [--by <운영자>] [--yes]
 *   pnpm admin:rules --agent <agentId> --remove <ruleId> [--by <운영자>] [--yes]
 *
 * 값: 이메일 주소(`a@example.com` — `+tag` 까지 정확히) 또는 도메인(`example.com` 은 그 도메인만, 하위 도메인은 `*.example.com`).
 * **바꾸면 언제나 새 `policy_versions` 행이다** — 스냅샷이 바뀐 뒤의 목록 전량을 싣는다(AC-9).
 *
 * **검증·쓰기는 `src/admin/ops/rules.ts`** — 관리 API(`POST /api/agents/{id}/rules` · `DELETE …/rules/{ruleId}`)와 같은 함수다
 * (같은 입력 = 같은 거부 코드). 이 파일은 플래그 파싱·확인 프롬프트·출력만 한다.
 */

import { parseArgs } from 'node:util';

import { readPolicyOp, type PolicyView, type RuleView } from '../../src/admin/ops/policy';
import { addRuleOp, removeRuleOp, resolveContactRuleInput } from '../../src/admin/ops/rules';
import { isAgentId, type AgentId } from '../../src/db/schema';
import {
  actorOf,
  AdminInputError,
  confirmProduction,
  EXIT_OK,
  isMain,
  runAdminMain,
  withAdminConnection,
  type AdminDeps,
} from './common';

const USAGE =
  'pnpm admin:rules --agent <agentId> (--show | --add <값> --direction outbound|inbound --list allow|block | --remove <ruleId>) ' +
  '[--by <운영자>] [--yes]';

function lines(view: PolicyView): string[] {
  const row = (direction: string, list: string, rule: RuleView): string => `${direction}\t${list}\t${rule.value}\t${rule.id}`;
  return [
    ...view.outbound.allow.map((rule) => row('outbound', 'allow', rule)),
    ...view.outbound.block.map((rule) => row('outbound', 'block', rule)),
    ...view.inbound.allow.map((rule) => row('inbound', 'allow', rule)),
    ...view.inbound.block.map((rule) => row('inbound', 'block', rule)),
  ];
}

function summary(view: PolicyView): string {
  const outbound = view.outbound.legacyMode === null ? view.outbound.mode : `legacy(${view.outbound.legacyMode})`;
  return `정책 v${String(view.version)} · 발신 ${outbound} · 수신 ${view.inbound.mode}`;
}

export async function rules(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      show: { type: 'boolean', default: false },
      add: { type: 'string' },
      direction: { type: 'string' },
      list: { type: 'string' },
      remove: { type: 'string' },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const agentRaw = values.agent?.trim() ?? '';
  if (!isAgentId(agentRaw)) throw new AdminInputError(`--agent 는 에이전트 id(hex 32). ${USAGE}`);
  const agentId: AgentId = agentRaw;
  const actions = [values.show, values.add !== undefined, values.remove !== undefined].filter(Boolean).length;
  if (actions !== 1) throw new AdminInputError(`--show · --add · --remove 중 정확히 하나. ${USAGE}`);
  // 입력 검증은 연결 전에 — 같은 함수(`resolveContactRuleInput`)가 API 와 같은 코드로 거부한다.
  const input =
    values.add === undefined ? null : resolveContactRuleInput({ direction: values.direction, list: values.list, value: values.add });

  return withAdminConnection(deps, async ({ pool, target }) => {
    const actor = actorOf('admin:rules', values.by, deps.env);
    if (values.show) {
      const view = await readPolicyOp(pool, agentId);
      for (const line of lines(view)) deps.io.out(line);
      deps.io.err(summary(view));
      return EXIT_OK;
    }
    if (input !== null) {
      const result = await addRuleOp(pool, agentId, input, actor, () =>
        confirmProduction(target, `에이전트 ${agentId} ${input.direction} ${input.list} + ${input.value} · 정책 새 버전`, values.yes, deps.io),
      );
      deps.io.out(`${result.rule.id}\t${result.rule.value}`);
      deps.io.err(summary(result.policy));
      return EXIT_OK;
    }
    const view = await removeRuleOp(pool, agentId, values.remove ?? '', actor, (rule) =>
      confirmProduction(target, `에이전트 ${agentId} ${rule.direction} ${rule.list} − ${rule.value} · 정책 새 버전`, values.yes, deps.io),
    );
    deps.io.err(summary(view));
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(rules);
