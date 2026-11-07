#!/usr/bin/env tsx
/**
 * scripts/ac0-start.ts — `pnpm ac0:start` : AC-0 게이트를 연다(1일차 시작 시각 기록).
 *
 *   pnpm ac0:start --agent <agentId> --human-mailbox <주소> [--human-mailbox <별칭> …] [--day1 YYYY-MM-DD] [--new-gate]
 *   pnpm ac0:start --org <organizationId> --human-mailbox <주소> …   (조직 전체 범위)
 *
 * - 1일차 = `--day1`(KST 날짜) 00:00 KST, 없으면 **다음 KST 자정**. 오늘이나 과거는 안 된다 — 1일차는 전달 규칙 ON
 *   기록 **뒤**에 시작해야 한다(그 전의 날은 규칙이 켜져 있었다는 기록이 없다).
 * - `--human-mailbox` 는 대표의 사람 메일함 **전부**(Gmail 계정 + "다른 주소에서 보내기" 별칭 + Workspace 주소).
 *   빠진 별칭으로 대표가 에이전트에게 직접 쓴 메일은 "전달" 로 잘못 세진다(`src/gate/forwarded.ts`).
 * - 게이트는 조직당 한 번 연다. 다시 시작하는 방법은 `pnpm ac0:restart` 다(재시작 횟수가 남아야 한다).
 *   `--new-gate` 는 ① 범위·메일함을 잘못 적은 경우, ② 재시작 3회 초과 신호(`check:ac0` 가 "AC-0 미성립") 뒤
 *   P3·P4 를 거쳐 다시 여는 경우의 탈출구다. 이전 게이트의 기록은 그대로 남는다. 게이트가 둘 이상이면 모든
 *   `ac0:*`·`check:ac0` 가 `--gate <id>` 를 요구한다(`scripts/ac0-common.ts` `resolveGate`).
 *
 * 검증·기록은 `src/gate/ac0-commands.ts` `startAc0GateOp` — 관리 API(`POST /api/gate/start`)와 같은 함수다.
 */

import { parseArgs } from 'node:util';

import { startAc0GateOp } from '../src/gate/ac0-commands';
import { formatKst } from '../src/observability/ac0-metrics';
import { runAc0Cli } from './ac0-common';

await runAc0Cli(async (pool) => {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      org: { type: 'string' },
      'human-mailbox': { type: 'string', multiple: true },
      day1: { type: 'string' },
      'new-gate': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(
      'pnpm ac0:start --agent <agentId> | --org <orgId>  --human-mailbox <주소> [...] [--day1 YYYY-MM-DD] [--new-gate]\n',
    );
    return 0;
  }
  const { gate, day1At } = await startAc0GateOp(pool, {
    agentId: values.agent ?? null,
    organizationId: values.org ?? null,
    humanMailboxes: values['human-mailbox'] ?? [],
    day1: values.day1,
    newGate: values['new-gate'] === true,
    // CLI 는 DB 전체의 게이트를 센다(기존 동작) — 관리 API 는 세션 조직으로 좁힌다.
    existingScopeOrganizationId: null,
  });
  process.stdout.write(
    [
      `AC-0 게이트 ${gate.id} 를 열었다.`,
      `  범위: ${gate.agentId === null ? `조직 ${gate.organizationId}` : `에이전트 ${gate.agentId}`}`,
      `  사람 메일함: ${gate.humanMailboxes.join(', ')}`,
      `  1일차 시작: ${formatKst(day1At)}`,
      '다음:',
      '  1) 그 전에 Gmail 전달 규칙(seed 필터)을 켜고 `pnpm ac0:forwarding on` — 1일차 시작 시점에 ON 기록이 없으면 관측이 무효다.',
      '  2) 매일 `pnpm check:ac0`. 1~5일차는 관측 전용(개입 원인 수정 외 작업 금지).',
      '',
    ].join('\n'),
  );
  return 0;
});
