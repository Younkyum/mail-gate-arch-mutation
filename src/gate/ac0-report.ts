/**
 * src/gate/ac0-report.ts — `pnpm check:ac0` 의 조립부 (계획 AC-b6: "3종을 한 출력으로, exit code 로 판정").
 *
 * 조회(`ac0-store`) → 전달 판정(`forwarded`) → 활동 분모(`observability/ac0-metrics`) → 판정(`ac0-verdict`)
 * → 한 화면. 판정에 들어가는 값은 전부 여기서 DB 로부터 다시 계산한다 — 캐시·체크박스·전날 출력을 읽지 않는다.
 */

import type { Queryable } from '../db/client';
import {
  computeAc0Activity,
  formatKst,
  formatKstDate,
  AC0_ACTIVITY_THRESHOLDS,
  type Ac0Activity,
} from '../observability/ac0-metrics';
import {
  dbNow,
  loadActivityRows,
  loadAgentDomains,
  loadGateEvents,
  loadHeldCustomerDomains,
  loadInboundEvidence,
  loadInterventions,
  type Ac0Gate,
} from './ac0-store';
import { isAgentRootDomain } from './ac0-commands';
import {
  AC0_MIN_BASELINE_SENDERS,
  ac0ActivityWindows,
  decideAc0,
  type Ac0Status,
  type Ac0Verdict,
  type ForwardedArrival,
  type InterventionCategory,
} from './ac0-verdict';
import { classifyForwarded, contactKey, isHumanMailbox } from './forwarded';

export interface Ac0Report {
  readonly gate: Ac0Gate;
  readonly verdict: Ac0Verdict;
  /** 게이트 전체 기간의 전달 판정 건수. */
  readonly forwardedTotal: number;
  /** 게이트 전체 기간의 판정식 불일치 의심 건수(봉투는 전달 형태가 아닌데 `X-Forwarded-*` 가 사람 메일함/에이전트를 가리킨 수신). */
  readonly auxiliaryOnly: number;
}

/**
 * 내부 주소 판정 — 사람 메일함(별칭·Gmail 점 무시), 이 조직의 에이전트 도메인, 그리고 **`atmark.ai` 는 항상**.
 * 조직이 커스텀 도메인만 쓰면 `agentDomains` 에 `atmark.ai` 가 없어서 **다른 조직의** `@atmark.ai` 에이전트가
 * 외부 상대로 잡힌다(V3 H2③) — 에이전트끼리 주고받은 메일은 AC-0 이 증명하려는 "거래 상대와의 일" 이 아니다.
 */
export function internalAddressPredicate(gate: Ac0Gate, agentDomains: readonly string[]): (address: string) => boolean {
  const domains = new Set(agentDomains.map((domain) => domain.toLowerCase()));
  return (address) => {
    const domain = address.slice(address.lastIndexOf('@') + 1).trim().replace(/>$/, '').toLowerCase();
    return isAgentRootDomain(domain) || domains.has(domain) || isHumanMailbox(address, gate.humanMailboxes);
  };
}

export async function loadAc0Report(db: Queryable, gate: Ac0Gate, asOfInput?: Date): Promise<Ac0Report> {
  const asOf = asOfInput ?? (await dbNow(db));
  const events = await loadGateEvents(db, gate.id);
  const interventions = await loadInterventions(db, gate.id);

  // 게이트의 첫 기록부터 지금까지 — 재시작이 있어도 누수·관측 판정에 필요한 범위는 이 안이다.
  const since = events.reduce((earliest, event) => (event.recordedAt < earliest ? event.recordedAt : earliest), gate.createdAt);
  const evidence = await loadInboundEvidence(db, gate, since, new Date(asOf.getTime() + 1));
  // 내부 도메인 = 이 조직 에이전트 주소의 도메인 + 어느 조직이든 쥔 고객 도메인(수신 판정과 같은 표 — ADR-0014 · 보안 리뷰 L2).
  const isInternal = internalAddressPredicate(gate, [...(await loadAgentDomains(db, gate)), ...(await loadHeldCustomerDomains(db))]);
  const auxiliaryArrivals: Date[] = [];
  const forwardedArrivals: ForwardedArrival[] = [];
  for (const row of evidence) {
    const result = classifyForwarded(row, gate.humanMailboxes);
    if (result.forwarded) {
      // H1: 내부 발신(에이전트 도메인 — 에이전트가 대표 Gmail 로 보낸 메일이 규칙에 되돌아온 것 등)은 관측 표본이
      //     아니다. 그래도 누수 판정에는 든다(규칙이 켜져 있다는 증거) — 그래서 버리지 않고 sender=null 로 싣는다.
      forwardedArrivals.push({ at: row.receivedAt, sender: isInternal(row.fromAddress) ? null : contactKey(row.fromAddress) });
    } else if (result.auxiliarySignal) {
      auxiliaryArrivals.push(row.receivedAt);
    }
  }

  const windows = ac0ActivityWindows({ asOf, events, forwardedArrivals });
  const activities: Ac0Activity[] = [];
  for (const window of windows) {
    const rows = await loadActivityRows(db, gate, window);
    activities.push(computeAc0Activity({ window, isInternal, contactKey, ...rows }));
  }

  const verdict = decideAc0({ asOf, events, forwardedArrivals, auxiliaryArrivals, interventions }, activities);
  return { gate, verdict, forwardedTotal: forwardedArrivals.length, auxiliaryOnly: auxiliaryArrivals.length };
}

// ---------------------------------------------------------------------------
// 출력
// ---------------------------------------------------------------------------

const STATUS_LABEL: Readonly<Record<Ac0Status, string>> = {
  held: '판정 보류 — 판정식 확인 필요',
  not_yet_true: 'AC-0 미성립 — 재시작 3회 초과, P3·P4 로 복귀',
  waiting: '관측 대기',
  observing: '관측 중',
  observation_extended: '관측 연장',
  awaiting_switch: '전환 대기',
  proving: '증명 중',
  proof_extended: '증명 연장(활동 분모 미달)',
  passed: '통과',
  restart_required: '재시작 필요',
};

const CATEGORY_LABEL: Readonly<Record<InterventionCategory, string>> = {
  address_transition: '주소전환',
  agent_gap: '에이전트',
  deliverability: '배달',
  policy_friction: '정책',
  other: '기타',
};

const PHASE_LABEL: Readonly<Record<Ac0Verdict['phase'], string>> = {
  before: '시작 전',
  observation: '관측(1–7일차, 규칙 ON)',
  switch: '전환(규칙 OFF 기록 대기/완료)',
  proof: '증명(8–14일차, 규칙 OFF)',
};

function mark(ok: boolean | null): string {
  return ok === null ? '…' : ok ? 'OK' : 'NG';
}

export function renderAc0Report(report: Ac0Report): string {
  const { gate, verdict } = report;
  const lines: string[] = [];
  const o = verdict.observation;
  const p = verdict.proof;

  lines.push(`AC-0 게이트 판정 — ${formatKst(verdict.asOf)} (일차 경계 KST 00:00)`);
  lines.push(
    `게이트 ${gate.id} · 범위 ${gate.agentId === null ? `조직 ${gate.organizationId}` : `에이전트 ${gate.agentId}`}` +
      ` · 사람 메일함 ${gate.humanMailboxes.join(', ')}`,
  );
  lines.push(
    `현재: ${verdict.dayNumber === null ? '1일차 이전' : `${String(verdict.dayNumber)}일차`} · 구간 ${PHASE_LABEL[verdict.phase]}` +
      ` · 전달 규칙 ${verdict.forwardingNow === 'unrecorded' ? '기록 없음' : verdict.forwardingNow.toUpperCase()}`,
  );
  lines.push(
    `1일차 ${formatKstDate(o.anchor)} · 재시작 ${String(verdict.restarts.total)}회` +
      ` (1일차 복귀 ${String(verdict.restarts.toDay1)} · 8일차 복귀 ${String(verdict.restarts.toDay8)})`,
  );
  lines.push('');

  // AC-b3
  const days = o.dailyForwarded
    .map((count, index) => `${String(index + 1)}일 ${String(count)}(${String(o.dailySenders[index] ?? 0)}명)`)
    .join(' · ');
  lines.push(`[AC-b3] 관측 추세 — forwarded_from_human_mailbox (규칙 ON, 1일차 시작 시 ON 기록 ${o.onAtStart ? '있음' : '없음'})`);
  lines.push(`  일별 외부 발신 전달 건수(서로 다른 외부 발신자): ${days === '' ? '(끝난 날 없음)' : days}${verdict.phase === 'observation' ? ` · 오늘 ${String(o.todayForwarded)}` : ''}`);
  if (o.baselineDay === null) {
    lines.push(
      `  기준일 없음 — 서로 다른 외부 발신자 ${String(AC0_MIN_BASELINE_SENDERS)}명 이상에게서 전달이 온 날이 아직 없다(B2① 최소 표본). 통과 아님.`,
    );
  } else {
    const baseline = o.dailyForwarded[o.baselineDay - 1] ?? 0;
    const comparison = o.comparisonDay === null ? undefined : o.dailyForwarded[o.comparisonDay - 1];
    lines.push(
      `  기준일 ${String(o.baselineDay)}일차 ${String(baseline)}건 · ${String(o.dailySenders[o.baselineDay - 1] ?? 0)}명` +
        `(최소 ${String(AC0_MIN_BASELINE_SENDERS)}명)` +
        `${o.baselineDay > 1 ? ` — 관측 연장 +${String(o.baselineDay - 1)}일` : ''}` +
        ` → 비교일 ${String(o.comparisonDay)}일차 ${comparison === undefined ? '(진행 전)' : `${String(comparison)}건`}` +
        ` ≤ ${String(baseline / 2)} : ${mark(o.trend === 'pending' ? null : o.trend === 'passed')}`,
    );
  }
  if (report.auxiliaryOnly > 0) {
    lines.push(
      `  ⚠ 판정식 불일치 의심 ${String(report.auxiliaryOnly)}건(이 1일차 구간 ${String(verdict.auxiliary.length)}건 — 1건이라도 있으면 통과가 아니다)` +
        ' — 봉투는 전달 형태가 아닌데 X-Forwarded-* 가 사람 메일함/에이전트를 가리킨다. `pnpm ac0:probe` 로 보고 런북 §4 로 판정식을 실측 교체한다.',
    );
  }
  lines.push('');

  // AC-b4
  lines.push(`[AC-b4] 증명 — human_mailbox_intervention (규칙 OFF)`);
  if (p.start === null) {
    lines.push('  증명 구간 시작 전 — 전달 규칙 OFF 기록이 있어야 시작한다.');
  } else {
    lines.push(
      `  증명 시작 ${formatKst(p.start)} · 끝난 증명일 ${String(p.completeDays)} · 개입 ${String(p.interventions.length)}건` +
        ` · 규칙 OFF 뒤 전달 도착(누수) ${String(p.leaks.length)}건 : ${mark(
          p.interventions.length > 0 || p.leaks.length > 0 ? false : p.completeDays >= 7 ? true : null,
        )}`,
    );
    for (const record of p.interventions) {
      lines.push(`    - ${formatKst(record.recordedAt)} [${CATEGORY_LABEL[record.category]}] ${record.reason}`);
    }
  }
  if (verdict.observationInterventions.length > 0) {
    lines.push(`  (관측·전환 구간 개입 ${String(verdict.observationInterventions.length)}건 — 판정에 들지 않지만 원인 수정 대상)`);
    for (const record of verdict.observationInterventions) {
      lines.push(`    - ${formatKst(record.recordedAt)} [${CATEGORY_LABEL[record.category]}] ${record.reason}`);
    }
  }
  lines.push('');

  // AC-b5
  const t = AC0_ACTIVITY_THRESHOLDS;
  lines.push('[AC-b5] 활동 분모 (증명 구간 연속 7일 창 — 첫 충족 창, 없으면 최근 창 · 자동 산출)');
  if (p.activity === null) {
    lines.push('  창 없음 — 끝난 증명일이 7일 이상일 때 산출한다.');
  } else {
    const a = p.activity;
    lines.push(`  창 ${formatKst(a.window.start)} ~ ${formatKst(a.window.end)}`);
    lines.push(
      `  신규 외부 상대 ${String(a.newExternalContacts)}/${String(t.newExternalContacts)} : ${mark(a.newExternalContacts >= t.newExternalContacts)}` +
        ` · outbound 성공 ${String(a.outboundSuccess)}/${String(t.outboundSuccess)} : ${mark(a.outboundSuccess >= t.outboundSuccess)}` +
        ` · 3턴+ 스레드 ${String(a.multiTurnThreads)}/${String(t.multiTurnThreads)} : ${mark(a.multiTurnThreads >= t.multiTurnThreads)}`,
    );
  }
  lines.push('');

  lines.push(`판정: ${STATUS_LABEL[verdict.status]} (exit ${String(verdict.exitCode)})`);
  if (verdict.restart !== null) {
    lines.push(`  재시작 → ${String(verdict.restart.returnDay)}일차 복귀 · 원인 ${verdict.restart.cause}: ${verdict.restart.detail}`);
  }
  for (const line of verdict.next) lines.push(`  · ${line}`);
  return lines.join('\n');
}
