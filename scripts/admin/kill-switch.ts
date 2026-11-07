#!/usr/bin/env tsx
/**
 * scripts/admin/kill-switch.ts — 비상 정지. Stage 0(`src/policy/rules/kill-switch.ts`)이 **읽는 값만** 바꾼다.
 *
 *   pnpm admin:kill-switch --org <조직 id> on|off [--reason "<사유>"] [--by <운영자>] [--yes]   # organizations.abuse_freeze(플랫폼 동결) → 'org_abuse_freeze'
 *   pnpm admin:kill-switch --agent <agentId> on|off [--yes]    # agents.status active ↔ suspended(운영자 정지) → 'agent_not_active'
 *
 * **운영자 스위치다.** 콘솔(소유자 세션)은 다른 스위치를 쓴다 — 조직은 `owner_paused`(→ 'org_owner_paused'), 에이전트는
 * `suspended_by='owner'` 정지. 소유자는 이 CLI 가 건 동결·정지를 풀 수 없고, 이 CLI 는 소유자가 건 정지를 풀지 않는다
 * (정지를 **넘겨받는** 것은 한다 — 소유자 정지 위에 `on` 하면 운영자 정지가 된다). 검증 H3.
 *
 * 새 규칙이 없다 — Stage 0 은 이미 `abuse_freeze` 와 `status !== 'active'` 를 전건 DENY 한다(승인 릴리스·예약 발송도
 * 관문을 지난다). 정책 버전을 올리지 않는 이유: 정지는 정책이 아니라 **테넌트 상태**이고, Stage 0 이 정책보다 먼저
 * 끊는 자리다. 정책으로 끊고 싶으면 `admin:policy --mode disabled`(새 버전).
 *
 * **`off` 는 `suspended` 에서만 `active` 로 되돌린다.** `provisioning`(키가 안 붙은 에이전트)이나 `disabled` 를
 * `active` 로 올리는 경로가 여기 생기면 PP-A 원자성(키 붙은 뒤에만 active)을 CLI 한 줄이 우회한다.
 *
 * **상태 전이는 `src/admin/ops/agents.ts`** — 관리 API(`POST /api/kill-switch`)와 같은 함수다.
 *
 * **조직 동결 · 해제는 감사된다**(202610131610 · `setOrganizationFreezeAuditedOp` — 운영자 웹과 같은 함수) — 값이 실제로 바뀔 때 같은 트랜잭션에서 `owner_actions` 1행(행위 `org.abuse_freeze` ·
 * `org.abuse_unfreeze`, 행위자 `admin:kill-switch:<운영자>`, 사유) → 그 조직의 투명성 로그 잎. **해제(`off`)는 `--reason` 필수** — 공유 도메인 평판
 * 자동 동결(`system:platform_reputation`)을 푸는 경로이고, 해제 시각 이후의 이벤트만 다음 판정이 센다(해제 직후 옛 반송으로 다시 얼지 않게). 켜기는
 * 비상 경로라 사유가 없으면 `operator kill-switch` 로 적는다.
 */

import { parseArgs } from 'node:util';

import { ORG_FREEZE_REASON_MAX, ORGANIZATION_ID_PATTERN, setAgentSuspendedOp, setOrganizationFreezeAuditedOp } from '../../src/admin/ops/agents';
import { isAgentId } from '../../src/db/schema';
import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

const USAGE = 'pnpm admin:kill-switch (--org <조직 id> on|off [--reason "<사유>"] [--by <운영자>] | --agent <agentId> on|off) [--yes]';

export async function killSwitch(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      org: { type: 'string' },
      agent: { type: 'string' },
      reason: { type: 'string' },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  if ((values.org === undefined) === (values.agent === undefined)) throw new AdminInputError(`--org 와 --agent 중 정확히 하나. ${USAGE}`);
  const [state, ...extra] = positionals;
  if ((state !== 'on' && state !== 'off') || extra.length > 0) throw new AdminInputError(`on 또는 off 하나. ${USAGE}`);
  const on = state === 'on';

  if (values.org !== undefined) {
    const org = values.org.trim();
    if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid). ${USAGE}`);
    const reason = values.reason?.trim() ?? '';
    if (!on && reason === '') throw new AdminInputError(`조직 동결 해제(off)는 --reason 이 필요하다 — 감사(owner_actions)와 조직의 투명성 로그에 남는다. ${USAGE}`);
    if (reason.length > ORG_FREEZE_REASON_MAX) throw new AdminInputError(`--reason 은 ${String(ORG_FREEZE_REASON_MAX)}자 이하.`);
    // eslint-disable-next-line no-control-regex -- 한 줄 사유만(감사 칸 CHECK 와 같다).
    if (/[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw new AdminInputError('--reason 은 한 줄(제어 문자 없음).');
    const actor = actorOf('admin:kill-switch', values.by, deps.env);
    return withAdminConnection(deps, async ({ pool, target }) => {
      await confirmProduction(target, `조직 ${org} 전체 발송 ${on ? '정지' : '재개'} (abuse_freeze=${String(on)}) · 행위자 ${actor}`, values.yes, deps.io);
      const { changed } = await setOrganizationFreezeAuditedOp(pool, { organizationId: org, on, actor, reason: reason === '' ? null : reason });
      deps.io.out(`organization ${org} abuse_freeze=${String(on)}`);
      if (!changed) {
        deps.io.err('이미 그 상태다 — 바꾸지 않았다(감사 행 없음).');
        return EXIT_OK;
      }
      deps.io.err(on ? '조직의 모든 에이전트 발송이 Stage 0 에서 거부된다(org_abuse_freeze).' : '조직 정지를 풀었다 — 공유 도메인 평판 판정은 지금부터의 이벤트만 센다.');
      return EXIT_OK;
    });
  }

  const agent = values.agent?.trim() ?? '';
  if (!isAgentId(agent)) throw new AdminInputError(`--agent 는 에이전트 id(hex 32). ${USAGE}`);
  return withAdminConnection(deps, async ({ pool, target }) => {
    const result = await setAgentSuspendedOp(pool, agent, on, 'operator', (from, to) =>
      confirmProduction(target, `에이전트 ${agent} 발송 ${on ? '정지' : '재개'} (${from} → ${to})`, values.yes, deps.io),
    );
    deps.io.out(`agent ${agent} status=${result.status}${result.suspendedBy === null ? '' : ` suspended_by=${result.suspendedBy}`}`);
    if (!result.changed) {
      deps.io.err('이미 그 상태다 — 바꾸지 않았다.');
      return EXIT_OK;
    }
    deps.io.err(on ? '이 에이전트의 발송이 Stage 0 에서 거부된다(agent_not_active).' : '에이전트 정지를 풀었다.');
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(killSwitch);
