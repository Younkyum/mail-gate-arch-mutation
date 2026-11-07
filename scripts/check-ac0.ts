#!/usr/bin/env tsx
/**
 * scripts/check-ac0.ts — `pnpm check:ac0` (계획 §3.2 AC-b6, §6 GATE). **AC-0 의 판정 도구.**
 *
 * 한 출력에: 현재 일차·구간·전달 규칙 상태 / AC-b3 관측 추세(+최소 표본) / AC-b4 증명 구간 개입·누수 /
 * AC-b5 활동 분모 3종 / 판정과 다음 할 일. 전부 DB 에서 자동 산출한다 — markdown 체크박스는 근거가 아니다.
 *
 * exit: 0 통과 · 1 재시작 필요 · 3 진행 중 · 2 판정 불가(입력·설정·DB).
 *
 *   pnpm check:ac0 [--gate <uuid>]
 */

import { parseArgs } from 'node:util';

import { loadAc0Report, renderAc0Report } from '../src/gate/ac0-report';
import { resolveGate, runAc0Cli } from './ac0-common';

await runAc0Cli(async (pool) => {
  const { values } = parseArgs({ options: { gate: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help === true) {
    process.stdout.write('pnpm check:ac0 [--gate <uuid>]\nexit: 0 통과 · 1 재시작 필요 · 3 진행 중 · 2 판정 불가\n');
    return 0;
  }
  const gate = await resolveGate(pool, values.gate);
  const report = await loadAc0Report(pool, gate);
  process.stdout.write(`${renderAc0Report(report)}\n`);
  return report.verdict.exitCode;
});
