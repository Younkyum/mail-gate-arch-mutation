#!/usr/bin/env tsx
/**
 * scripts/ac0-intervention.ts — `pnpm ac0:intervention` : `human_mailbox_intervention` 기록 (계획 §3.2 V1②).
 *
 * 계획에 생산자가 정의돼 있지 않았다. 이것이 그 생산자다 — 대표가 **직접** 부른다. 개입 시각 = 기록 시각
 * (DB now()). 늦게 적으면 늦은 날로 들어간다(보수적 방향). append-only — 지울 수 없다.
 *
 *   pnpm ac0:intervention --category <주소전환|에이전트|배달|정책|기타> --reason "한 줄 메모" [--gate <uuid>]
 */

import { parseArgs } from 'node:util';

import { recordInterventionOp, resolveInterventionCategory, resolveInterventionReason } from '../src/gate/ac0-commands';
import { Ac0InputError } from '../src/gate/ac0-verdict';
import { formatKst } from '../src/observability/ac0-metrics';
import { resolveGate, runAc0Cli } from './ac0-common';

const HELP = `pnpm ac0:intervention --category <카테고리> --reason "한 줄 메모" [--gate <uuid>]

개입이다 — 에이전트가 처리했어야 할 메일을 사람이 **자기 메일함에서** 직접 읽거나 쓴 것.
  예) 거래처가 옛 주소로 보낸 견적 요청을 Gmail 에서 읽고 직접 답했다      → 주소전환
  예) 에이전트가 첨부를 못 읽어서 내 Gmail 로 받아 처리했다                 → 에이전트
  예) 에이전트 메일이 상대 스팸함에 가서 내 Gmail 로 다시 보냈다             → 배달
  예) 승인 요청이 만료돼 급해서 내 Gmail 로 직접 보냈다                      → 정책

개입이 아니다 — 기록하지 않는다.
  - 승인 매직링크 클릭(승인·거절). 제품의 정상 동작이다. 링크가 개인 메일함에 오는 것도 AC-0 과 무관하다.
  - 에이전트에게 지시하거나 에이전트 수신함을 조회한 것(사람 메일함을 쓴 것이 아니다).
  - 에이전트 업무와 무관한 개인 메일을 내 메일함에서 읽고 쓴 것.

카테고리 → 재시작 복귀 일차 (계획 B2②)
  주소전환(address_transition) → 1일차 (재공지 + 추세 재측정)
  에이전트(agent_gap) · 배달(deliverability) · 정책(policy_friction) · 기타(other) → 8일차

--reason 은 무슨 일이었는지 한 줄(≤500자, 줄바꿈 금지). 메일 원문·본문을 붙여 넣지 않는다.
`;

await runAc0Cli(async (pool) => {
  const { values } = parseArgs({
    options: {
      category: { type: 'string' },
      reason: { type: 'string' },
      gate: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  // 검증·기록은 관리 API(`POST /api/gate/intervention`)와 같은 함수.
  let category;
  try {
    category = resolveInterventionCategory(values.category);
  } catch {
    throw new Ac0InputError(`--category 가 필요하다(주소전환|에이전트|배달|정책|기타).\n\n${HELP}`);
  }
  const reason = resolveInterventionReason(values.reason);

  const gate = await resolveGate(pool, values.gate);
  const { recordedAt, returnDay } = await recordInterventionOp(pool, gate.id, category, reason);
  process.stdout.write(
    `개입 기록: ${formatKst(recordedAt)} [${category}] ${reason}\n` +
      `  증명 구간이면 재시작이 필요하다 → 복귀 ${String(returnDay)}일차. \`pnpm check:ac0\` 로 판정을 본다.\n`,
  );
  return 0;
});
