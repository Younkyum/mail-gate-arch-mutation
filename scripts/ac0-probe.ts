#!/usr/bin/env tsx
/**
 * scripts/ac0-probe.ts — `pnpm ac0:probe` : 최근 수신 메일에 전달 판정식을 적용해 **원자료와 함께** 보여 준다.
 *
 * `+caf_=` 판정식 실측용(`docs/runbooks/ac0-shadow-log.md` §4). 봉투 발신자·From·X-Forwarded-* 원문과
 * 판정 결과를 나란히 찍는다 — 확인 메일과 첫 전달 메일에서 가정(`src/gate/forwarded.ts` 의
 * `isForwardedFormOf`)이 맞는지 여기서 본다. 본문은 읽지 않는다(DB 에 없다).
 *
 * **게이트 없이도 돈다.** 런북은 실측(§4)을 `ac0:start` **전에** 하라고 한다 — 판정식이 틀린 채로 1일차를
 * 시작하면 관측이 공허해지기 때문이다. 그래서 게이트 대신 범위(`--agent`|`--org`)와 사람 메일함을 직접 받는다.
 * 게이트가 있으면 `--gate`(또는 게이트가 하나뿐이면 생략). 이 CLI 는 아무것도 기록하지 않는다.
 *
 *   pnpm ac0:probe --agent <agentId> --human-mailbox <주소> [...] [--limit 20] [--hours 72]   (게이트 전)
 *   pnpm ac0:probe [--gate <uuid>] [--limit 20] [--hours 72]                                  (게이트 후)
 */

import { parseArgs } from 'node:util';

import { toAgentId } from '../src/db/schema';
import { dbNow, loadAgentOrganization, loadInboundEvidence, type Ac0Scope } from '../src/gate/ac0-store';
import { Ac0InputError } from '../src/gate/ac0-verdict';
import { classifyForwarded } from '../src/gate/forwarded';
import { formatKst } from '../src/observability/ac0-metrics';
import { resolveGate, runAc0Cli } from './ac0-common';

const USAGE =
  'pnpm ac0:probe --agent <agentId>|--org <orgId> --human-mailbox <주소> [...] [--limit 20] [--hours 72]   (게이트 전)\n' +
  'pnpm ac0:probe [--gate <uuid>] [--limit 20] [--hours 72]                                              (게이트 후)\n';

await runAc0Cli(async (pool) => {
  const { values } = parseArgs({
    options: {
      gate: { type: 'string' },
      agent: { type: 'string' },
      org: { type: 'string' },
      'human-mailbox': { type: 'string', multiple: true },
      limit: { type: 'string' },
      hours: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const limit = Number(values.limit ?? '20');
  const hours = Number(values.hours ?? '72');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Ac0InputError('--limit 은 1~500');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 60) throw new Ac0InputError('--hours 는 0~1440');

  let scope: Ac0Scope;
  let humanMailboxes: readonly string[];
  const adHoc = values.agent !== undefined || values.org !== undefined;
  if (adHoc) {
    if (values.gate !== undefined) throw new Ac0InputError('--gate 와 --agent/--org 는 함께 쓰지 않는다.');
    if (values.agent !== undefined && values.org !== undefined) throw new Ac0InputError('--agent 와 --org 중 하나만.');
    humanMailboxes = [...new Set((values['human-mailbox'] ?? []).map((value) => value.trim().toLowerCase()))];
    if (humanMailboxes.length === 0) throw new Ac0InputError(`게이트 없이 볼 때는 --human-mailbox 가 필요하다.\n${USAGE}`);
    if (values.agent !== undefined) {
      const agentId = toAgentId(values.agent);
      const organizationId = await loadAgentOrganization(pool, agentId);
      if (organizationId === null) throw new Ac0InputError(`에이전트 ${values.agent} 가 없다.`);
      scope = { organizationId, agentId };
    } else {
      scope = { organizationId: values.org as string, agentId: null };
    }
  } else {
    if (values['human-mailbox'] !== undefined) throw new Ac0InputError('--human-mailbox 는 게이트 없이 볼 때만(게이트의 메일함을 쓴다).');
    const gate = await resolveGate(pool, values.gate);
    scope = gate;
    humanMailboxes = gate.humanMailboxes;
  }

  const now = await dbNow(pool);
  const rows = await loadInboundEvidence(pool, scope, new Date(now.getTime() - hours * 3_600_000), new Date(now.getTime() + 1), limit);
  process.stdout.write(`사람 메일함: ${humanMailboxes.join(', ')} · 최근 ${String(hours)}시간 · ${String(rows.length)}건\n\n`);
  for (const row of rows) {
    const verdict = classifyForwarded(row, humanMailboxes);
    const label = verdict.forwarded
      ? `전달(${verdict.basis})`
      : `전달 아님(${verdict.reason}${verdict.auxiliarySignal ? ', ⚠ X-Forwarded-* 보조 신호 있음 — 판정식 불일치 의심' : ''})`;
    process.stdout.write(
      [
        `${formatKst(row.receivedAt)}  ${row.id}`,
        `  envelope_sender      ${row.envelopeSender ?? '(널 발신자)'}`,
        `  from_address         ${row.fromAddress}`,
        `  envelope_recipient   ${row.envelopeRecipient}`,
        `  X-Forwarded-For      ${row.forwardedForHeader ?? '-'}`,
        `  X-Forwarded-To       ${row.forwardedToHeader ?? '-'}`,
        `  판정                 ${label}`,
        '',
      ].join('\n'),
    );
  }
  return 0;
});
