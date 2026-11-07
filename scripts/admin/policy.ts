#!/usr/bin/env tsx
/**
 * scripts/admin/policy.ts — 에이전트 정책 보기·바꾸기(정책 v2). **바꾸는 것은 언제나 새 `policy_versions` 행이다**(§4.3).
 *
 *   pnpm admin:policy --agent <agentId>                                     # 현재 정책(읽기만 — 모드·목록·한도)
 *   pnpm admin:policy --agent <agentId> [--outbound all|allowlist|blocklist|none] [--inbound all|allowlist|blocklist|none]
 *        [--per-minute N] [--auto-approve-verification-senders on|off [--i-know-ac7-is-unverified]] [--by <운영자>] [--yes]
 *
 * 모드는 **콘솔 이름**이다(콘솔·API 와 같은 어휘 — 매핑표는 `src/admin/ops/policy.ts`). 레거시 승인 모드(`approval_required`·
 * `reply_only`)는 받지 않는다(`legacy_mode_rejected`, ADR-0007). 목록은 `pnpm admin:rules` 가 바꾼다.
 *
 * **`--auto-approve-verification-senders on` 은 명시 플래그 없이 거부한다.** 운영 결정(2026-09-23, `.omc/handoffs/
 * gate-readiness.md` "AC-7 판정 보류"): 그 규칙의 전제가 injection 스캐너인데 스캐너는 봉인 홀드아웃에서 불합격했고
 * v2 평가는 보류다. 레거시 승인 모드에서만 의미가 있는 손잡이라 콘솔에는 없다.
 *
 * **검증·쓰기는 `src/admin/ops/policy.ts` 에 있다** — 관리 API(`PATCH /api/agents/{id}/policy`)와 같은 함수다.
 * 이 파일은 플래그 파싱·확인 프롬프트·출력만 한다.
 */

import { parseArgs } from 'node:util';

import {
  changePolicyOp,
  CONSOLE_MODES,
  readPolicyOp,
  resolvePolicyChange,
  type PolicyChange,
  type PolicyView,
} from '../../src/admin/ops/policy';
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

export const AC7_ACK_FLAG = 'i-know-ac7-is-unverified';

const USAGE =
  'pnpm admin:policy --agent <agentId> ' +
  `[--outbound ${CONSOLE_MODES.join('|')}] [--inbound ${CONSOLE_MODES.join('|')}] [--per-minute N] ` +
  `[--auto-approve-verification-senders on|off [--${AC7_ACK_FLAG}]] [--by <운영자>] [--yes]`;

/** CLI 플래그 → 공유 검증(`resolvePolicyChange`). 규칙은 API 와 같다. */
export function parseChange(values: {
  outbound?: string | undefined;
  inbound?: string | undefined;
  'per-minute'?: string | undefined;
  'auto-approve-verification-senders'?: string | undefined;
  [AC7_ACK_FLAG]?: boolean | undefined;
}): PolicyChange {
  const raw = values['auto-approve-verification-senders'];
  if (raw !== undefined && raw !== 'on' && raw !== 'off') {
    throw new AdminInputError(`--auto-approve-verification-senders 는 on | off: ${raw}`, 'invalid_request');
  }
  return resolvePolicyChange({
    outboundMode: values.outbound,
    inboundMode: values.inbound,
    perMinute: values['per-minute'],
    verificationSenders: raw === undefined ? undefined : raw === 'on',
    ac7Acknowledged: values[AC7_ACK_FLAG] === true,
  });
}

function describe(view: PolicyView): string[] {
  const limits = view.limits;
  const outboundMode = view.outbound.legacyMode === null ? view.outbound.mode : `legacy(${view.outbound.legacyMode})`;
  return [
    `outbound ${outboundMode} · allow ${String(view.outbound.allow.length)} · block ${String(view.outbound.block.length)}`,
    `inbound ${view.inbound.mode} · allow ${String(view.inbound.allow.length)} · block ${String(view.inbound.block.length)}`,
    `per_minute ${String(limits['per_minute'])} · per_hour ${String(limits['per_hour'])} · per_day ${String(limits['per_day'])}`,
    `auto_approve_verification_senders ${String(view.autoApproveVerificationSenders)}`,
  ];
}

export async function policy(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      outbound: { type: 'string' },
      inbound: { type: 'string' },
      'per-minute': { type: 'string' },
      'auto-approve-verification-senders': { type: 'string' },
      [AC7_ACK_FLAG]: { type: 'boolean', default: false },
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
  const change = parseChange(values);
  const mutating =
    change.outboundMode !== undefined ||
    change.inboundMode !== undefined ||
    change.perMinute !== undefined ||
    change.verificationSenders !== undefined;

  return withAdminConnection(deps, async ({ pool, target }) => {
    if (!mutating) {
      const current = await readPolicyOp(pool, agentId);
      deps.io.out(`version ${String(current.version)}`);
      for (const line of describe(current)) deps.io.out(line);
      return EXIT_OK;
    }
    const summary = [
      change.outboundMode === undefined ? null : `outbound → ${change.outboundMode}`,
      change.inboundMode === undefined ? null : `inbound → ${change.inboundMode}`,
      change.perMinute === undefined ? null : `per_minute → ${String(change.perMinute)}`,
      change.verificationSenders === undefined ? null : `auto_approve_verification_senders → ${String(change.verificationSenders)}`,
    ]
      .filter((part) => part !== null)
      .join(' · ');
    await confirmProduction(target, `에이전트 ${agentId} 정책 새 버전: ${summary}`, values.yes, deps.io);
    if (change.verificationSenders === true) deps.io.err('⚠ AC-7 미검증 상태에서 auto_approve_verification_senders 를 켠다(명시 플래그).');

    const result = await changePolicyOp(pool, agentId, change, actorOf('admin:policy', values.by, deps.env));
    deps.io.out(`version ${String(result.version)}`);
    for (const line of describe(result)) deps.io.out(line);
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(policy);
