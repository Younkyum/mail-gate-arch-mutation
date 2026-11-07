/**
 * scripts/ac0-common.ts — `pnpm ac0:*` · `pnpm check:ac0` 공용: 풀·게이트 선택·exit code.
 *
 * exit code (계획 AC-b6 — `src/gate/ac0-verdict.ts` 머리말):
 *   0 통과 · 1 실패(재시작 필요 · AC-0 미성립) · 3 진행 중·판정 보류 · **2 판정 불가(입력·설정·DB)**
 * 기록 CLI(start·forwarding·intervention·restart)는 성공 0, 입력 오류 2.
 *
 * **1 은 판정만 낸다.** DB·런타임 오류가 1 로 새면 cron 이 "재시작 필요" 로 읽는다. Node 는 잡히지 않은 예외와
 * 리스너 없는 풀 `'error'`(유휴 연결이 끊길 때 pg 가 낸다)에 **exit 1** 로 죽으므로, 둘 다 여기서 2 로 바꾼다.
 * 이 계약을 `test/integration/gate/ac0-cli.test.ts` 가 CLI 를 실제로 띄워 고정한다.
 */

import type { Pool } from 'pg';

import { createAppPool, DatabaseConfigError } from '../src/db/client';
import { listAc0Gates, loadAc0Gate, type Ac0Gate } from '../src/gate/ac0-store';
import { Ac0InputError } from '../src/gate/ac0-verdict';

export const EXIT_INPUT_ERROR = 2;

/**
 * `--gate` 가 있으면 그것. 없으면 게이트가 **정확히 하나일 때만** 그것.
 *
 * 둘 이상이면 판정 불가(2)다 — "가장 최근" 을 고르지 않는다. 게이트가 여럿인 것은 `--new-gate`(범위를 잘못
 * 적었거나, 재시작 신호 뒤 P3·P4 를 거쳐 새로 연 경우)나 여러 조직이 한 DB 에 있을 때이고, 그때 최근 것이
 * 판정 대상이라는 보장이 없다. **틀린 게이트를 판정한 exit 0 도 공허 통과다**(V3). 기록 CLI 도 같은 규칙 —
 * OFF·개입을 다른 게이트에 적는 것은 판정 대상 게이트에 기록이 없는 것과 같다.
 */
export async function resolveGate(pool: Pool, gateArg: string | undefined): Promise<Ac0Gate> {
  if (gateArg !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(gateArg)) throw new Ac0InputError(`--gate 는 uuid 다: ${gateArg}`);
    const gate = await loadAc0Gate(pool, gateArg);
    if (gate === null) throw new Ac0InputError(`게이트 ${gateArg} 가 없다.`);
    return gate;
  }
  const gates = await listAc0Gates(pool);
  const [only] = gates;
  if (only === undefined) throw new Ac0InputError('게이트가 없다 — 먼저 `pnpm ac0:start` 를 실행한다.');
  if (gates.length > 1) {
    const listed = gates
      .slice(0, 10)
      .map((gate) => `  ${gate.id}  ${gate.createdAt.toISOString()}  ${gate.agentId === null ? `조직 ${gate.organizationId}` : `에이전트 ${gate.agentId}`}`)
      .join('\n');
    throw new Ac0InputError(
      `게이트가 ${String(gates.length)}개다 — 어느 것을 판정할지 --gate <id> 로 정한다(최근 것을 자동으로 고르지 않는다).\n${listed}` +
        (gates.length > 10 ? `\n  … 외 ${String(gates.length - 10)}개` : ''),
    );
  }
  return only;
}

/** 잡히지 않은 오류를 판정 불가(2)로 — Node 기본값(exit 1 = 재시작 필요)으로 새지 않게. */
function exitUndecidable(error: unknown): never {
  process.stderr.write(`판정 불가: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT_INPUT_ERROR);
}
process.on('uncaughtException', exitUndecidable);
process.on('unhandledRejection', exitUndecidable);

/** CLI 본체를 돌리고 exit code 를 정한다. 입력·설정·DB 오류는 전부 2(판정 불가) — 1(게이트 실패)과 섞지 않는다. */
export async function runAc0Cli(main: (pool: Pool) => Promise<number>): Promise<void> {
  let pool: Pool | undefined;
  let code: number;
  let poolError: Error | null = null;
  try {
    pool = createAppPool();
    // 유휴 연결 오류. 리스너가 없으면 pg 가 던져 프로세스가 exit 1 로 죽는다.
    pool.on('error', (error) => {
      poolError ??= error;
    });
    code = await main(pool);
  } catch (error) {
    const known = error instanceof Ac0InputError || error instanceof DatabaseConfigError || error instanceof TypeError;
    process.stderr.write(`${known ? '입력 오류' : '판정 불가'}: ${error instanceof Error ? error.message : String(error)}\n`);
    code = EXIT_INPUT_ERROR;
  } finally {
    await pool?.end().catch(() => undefined);
  }
  const lateError = poolError as Error | null;
  if (lateError !== null) {
    process.stderr.write(`판정 불가: DB 연결 오류 — ${lateError.message}\n`);
    code = EXIT_INPUT_ERROR;
  }
  process.exitCode = code;
}
