#!/usr/bin/env tsx
/**
 * scripts/ac0-forwarding.ts — `pnpm ac0:forwarding on|off` : Gmail 전달 규칙을 켜고 끈 **시각**을 기록한다.
 *
 * 계획 §3.2 C1: "마지막 7일 동안 전달 규칙이 비활성이었음이 로그에 기록되지 않으면 통과로 세지 않는다."
 * 이 기록이 그 로그다. 기록 시각은 DB now() — 시각 인자가 없다. **Gmail 에서 실제로 끈 직후에** 실행한다.
 *
 * 기록은 막지 않는다 — 사실을 기록하지 못하게 하면 로그가 거짓이 된다. 대신 기록 뒤의 판정을 바로 보여 준다
 * (관측 도중 OFF 는 관측 무효, 증명 도중 ON 은 재시작).
 *
 * 교차 검증: OFF 기록 10분 뒤부터 `forwarded_from_human_mailbox` 판정 메일이 1건이라도 오면 `check:ac0` 가
 * "규칙이 실제로 꺼지지 않았다" 로 재시작(1일차)을 낸다.
 *
 *   pnpm ac0:forwarding on|off [--gate <uuid>]
 */

import { parseArgs } from 'node:util';

import { loadAc0Report, renderAc0Report } from '../src/gate/ac0-report';
import { recordForwardingOp, resolveForwardingState } from '../src/gate/ac0-commands';
import { Ac0InputError } from '../src/gate/ac0-verdict';
import { formatKst } from '../src/observability/ac0-metrics';
import { resolveGate, runAc0Cli } from './ac0-common';

await runAc0Cli(async (pool) => {
  const { values, positionals } = parseArgs({
    options: { gate: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write('pnpm ac0:forwarding on|off [--gate <uuid>] — Gmail 에서 실제로 켜고/끈 직후에 실행한다.\n');
    return 0;
  }
  const [raw, ...rest] = positionals;
  if (rest.length > 0) throw new Ac0InputError('사용법: pnpm ac0:forwarding on|off');
  let state;
  try {
    state = resolveForwardingState(raw);
  } catch {
    throw new Ac0InputError('사용법: pnpm ac0:forwarding on|off');
  }

  const gate = await resolveGate(pool, values.gate);
  // 기록은 관리 API(`POST /api/gate/forwarding`)와 같은 함수.
  const recordedAt = await recordForwardingOp(pool, gate.id, state);
  process.stdout.write(`전달 규칙 ${state.toUpperCase()} 기록: ${formatKst(recordedAt)} (게이트 ${gate.id})\n\n`);
  const report = await loadAc0Report(pool, gate);
  process.stdout.write(`${renderAc0Report(report)}\n`);
  return 0;
});
