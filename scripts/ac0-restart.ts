#!/usr/bin/env tsx
/**
 * scripts/ac0-restart.ts — `pnpm ac0:restart` : 게이트 재시작을 기록한다 (계획 §3.2 · §11B B2②).
 *
 * **복귀 일차는 사람이 고르지 않는다.** 지금 판정(`check:ac0`)이 `재시작 필요` 일 때만 기록하고, 복귀 일차와
 * 원인은 그 판정에서 가져온다 — 개입 카테고리가 주소전환이면 1일차, 그 외 개입이면 8일차, 전달 누수·규칙
 * 재가동·관측 실패는 1일차. 재시작할 원인이 없으면 기록하지 않는다(exit 2).
 *
 * 복귀 구간은 **다음 KST 자정**에 시작한다. 8일차 복귀는 원인을 고쳐 배포한 **뒤에** 실행한다.
 * 1일차 복귀는 재공지 + 전달 규칙 ON(`pnpm ac0:forwarding on`)을 그 자정 전에 마친다.
 *
 *   pnpm ac0:restart [--gate <uuid>]
 */

import { parseArgs } from 'node:util';

import { loadAc0Report } from '../src/gate/ac0-report';
import { dbNow, recordRestart } from '../src/gate/ac0-store';
import { Ac0InputError, AC0_RESTART_SIGNAL_THRESHOLD } from '../src/gate/ac0-verdict';
import { formatKst, kstMidnightAfter } from '../src/observability/ac0-metrics';
import { resolveGate, runAc0Cli } from './ac0-common';

await runAc0Cli(async (pool) => {
  const { values } = parseArgs({ options: { gate: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help === true) {
    process.stdout.write('pnpm ac0:restart [--gate <uuid>] — check:ac0 가 "재시작 필요" 일 때만 기록한다.\n');
    return 0;
  }
  const gate = await resolveGate(pool, values.gate);
  const report = await loadAc0Report(pool, gate);
  const restart = report.verdict.restart;
  if (report.verdict.status === 'not_yet_true') {
    throw new Ac0InputError(
      `재시작이 이미 ${String(report.verdict.restarts.total)}회 — ${String(AC0_RESTART_SIGNAL_THRESHOLD)}회 초과는 "AC-0 이 아직 참이 아니다" 신호다. ` +
        '이 게이트에 재시작을 더 기록하지 않는다. P3·P4 에서 원인을 고친 뒤 `pnpm ac0:start --new-gate`.',
    );
  }
  if (restart === null) {
    throw new Ac0InputError(`지금 판정은 재시작 필요가 아니다(${report.verdict.status}). 기록하지 않는다.`);
  }
  const effectiveAt = kstMidnightAfter(await dbNow(pool));
  await recordRestart(pool, gate.id, restart.returnDay, restart.cause, effectiveAt);

  const total = report.verdict.restarts.total + 1;
  const lines = [
    `재시작 기록: ${String(restart.returnDay)}일차 복귀 · 원인 ${restart.cause} · ${formatKst(effectiveAt)} 부터`,
    `  ${restart.detail}`,
    restart.returnDay === 1
      ? '  그 자정 전에: 재공지(런북 2단계, 새 Idempotency-Key) · Gmail 전달 규칙 ON · `pnpm ac0:forwarding on`.'
      : '  전달 규칙은 OFF 그대로 둔다. 그 자정부터 증명 7일을 다시 센다.',
    `  재시작 누적 ${String(total)}회.`,
  ];
  if (total > AC0_RESTART_SIGNAL_THRESHOLD) {
    lines.push(
      `  재시작 ${String(AC0_RESTART_SIGNAL_THRESHOLD)}회 초과 — 게이트 실패가 아니라 "AC-0 이 아직 참이 아니다" 신호다. P3·P4 로 되돌아간다(§3.2).`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
});
