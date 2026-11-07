/**
 * AC-0 게이트 — **실제 Postgres 위에서** 기록면의 불변식과 `check:ac0` 의 판정 경로 전체를 본다.
 *
 * ① 기록면: append-only · 미래 시각 금지 · KST 자정 · 게이트당 start 하나 · 재시작 원인↔복귀 일차 · 메일함 모양.
 * ② 판정 경로: inbound_messages(전달 판정 원자료) · messages/outbound_recipients/threads(활동 분모)에 14일짜리
 *    게이트를 심고 `loadAc0Report` 가 통과를 낸다 → 같은 게이트에서 한 가지씩 빼면 통과가 사라진다.
 *
 * 과거 시각의 이벤트는 SQL 로 직접 넣는다 — CLI·저장소 함수는 시각 인자가 없다(소급 기록 경로 없음).
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { loadAc0Report, renderAc0Report } from '../../../src/gate/ac0-report';
import {
  createAc0Gate,
  loadGateEvents,
  recordForwarding,
  recordIntervention,
  recordRestart,
  type Ac0Gate,
} from '../../../src/gate/ac0-store';
import { DAY_MS, kstMidnightAfter } from '../../../src/observability/ac0-metrics';
import type { AgentId } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool } from '../db/support/harness';
import { busyWeek, inbound, newThread, sent, type DayFn } from './support/seed';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const OWNER = 'owner.ac0test@gmail.com';
const HOUR = 3_600_000;

async function expectRejected(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(run()).rejects.toThrow(pattern);
}

/** 게이트 + 과거 시각 이벤트(SQL 직접). T1 = 20일 전 KST 자정. */
async function historicGate(db: Pool): Promise<{ gate: Ac0Gate; agentId: AgentId; agentAddress: string; t1: Date; day: DayFn }> {
  const fixture = await seedFixture(db);
  const t1 = new Date(kstMidnightAfter(new Date()).getTime() - 20 * DAY_MS);
  const day = (n: number, h = 12): Date => new Date(t1.getTime() + (n - 1) * DAY_MS + h * HOUR);
  const gateRow = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO ac0_gates (organization_id, agent_id, human_mailboxes, created_at)
     VALUES ($1, $2, ARRAY[$3], $4) RETURNING id, created_at`,
    [fixture.organizationId, fixture.agentId, OWNER, day(0, 9)],
  );
  const { id, created_at } = gateRow.rows[0] as { id: string; created_at: Date };
  await db.query(
    `INSERT INTO ac0_gate_events (gate_id, kind, recorded_at, effective_at, return_day) VALUES ($1, 'start', $2, $3, 1)`,
    [id, day(0, 10), t1],
  );
  await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, 'forwarding_on', $2)`, [id, day(0, 11)]);
  // 관측: 1일차 6건 → 7일차 2건. Gmail caf 형태 봉투.
  const caf = `owner.ac0test+caf_=${fixture.address.replace('@', '=')}@gmail.com`;
  for (const [n, count] of [[1, 6], [3, 4], [7, 2]] as const) {
    for (let i = 0; i < count; i += 1) {
      await inbound(db, fixture.agentId, { receivedAt: day(n, 9 + i), from: `p${String(i)}@partner.kr`, envelopeSender: caf, recipient: fixture.address });
    }
  }
  // 대표가 직접 쓴 메일 — 전달이 아니다(판정식이 빼야 한다).
  await inbound(db, fixture.agentId, { receivedAt: day(1, 20), from: OWNER, envelopeSender: OWNER, recipient: fixture.address });
  return {
    gate: { id, organizationId: fixture.organizationId, agentId: fixture.agentId, humanMailboxes: [OWNER], createdAt: created_at },
    agentId: fixture.agentId,
    agentAddress: fixture.address,
    t1,
    day,
  };
}

async function recordOffAt(db: Pool, gateId: string, at: Date): Promise<void> {
  await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, 'forwarding_off', $2)`, [gateId, at]);
}

describe.skipIf(!DATABASE_AVAILABLE)('AC-0 기록면 — append-only · 시각 · 모양', () => {
  it('createAc0Gate: 게이트 + start(1일차 KST 자정) 를 한 번에. 시각 인자 없는 기록 함수들', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const day1At = kstMidnightAfter(new Date());
    const gate = await createAc0Gate(pool, { agentId: fixture.agentId, organizationId: null, humanMailboxes: [OWNER], day1At });
    expect(gate.organizationId).toBe(fixture.organizationId);

    await recordForwarding(pool, gate.id, 'on');
    await recordIntervention(pool, gate.id, 'agent_gap', '첨부를 못 읽어 내 Gmail 에서 처리');
    const events = await loadGateEvents(pool, gate.id);
    expect(events.map((event) => event.kind)).toEqual(['start', 'forwarding_on']);
    expect(events[0]).toMatchObject({ kind: 'start', effectiveAt: day1At });

    // 게이트당 start 하나.
    await expectRejected(
      () => pool.query(`INSERT INTO ac0_gate_events (gate_id, kind, effective_at, return_day) VALUES ($1, 'start', $2, 1)`, [gate.id, day1At]),
      /ac0_gate_events_one_start|duplicate key/,
    );
  });

  it('세 테이블 모두 UPDATE·DELETE 불가', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const gate = await createAc0Gate(pool, {
      agentId: fixture.agentId,
      organizationId: null,
      humanMailboxes: [OWNER],
      day1At: kstMidnightAfter(new Date()),
    });
    await recordIntervention(pool, gate.id, 'other', 'x');
    for (const [table, column] of [
      ['ac0_gates', 'gate_id'],
      ['ac0_gate_events', 'gate_id'],
      ['human_mailbox_interventions', 'gate_id'],
    ] as const) {
      const key = table === 'ac0_gates' ? 'id' : column;
      await expectRejected(() => pool.query(`UPDATE ${table} SET ${key} = ${key} WHERE ${key} = $1`, [gate.id]), /immutable|permission denied/);
      await expectRejected(() => pool.query(`DELETE FROM ${table} WHERE ${key} = $1`, [gate.id]), /append-only|permission denied/);
    }
  });

  it('미래 시각 기록 금지 · start/restart 는 KST 자정 · 기록 뒤 · 재시작 원인↔복귀 일차', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const day1At = kstMidnightAfter(new Date());
    const gate = await createAc0Gate(pool, { agentId: fixture.agentId, organizationId: null, humanMailboxes: [OWNER], day1At });
    const future = new Date(Date.now() + HOUR);

    await expectRejected(
      () => pool.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, 'forwarding_off', $2)`, [gate.id, future]),
      /future/,
    );
    await expectRejected(
      () => pool.query(`INSERT INTO human_mailbox_interventions (gate_id, category, reason, recorded_at) VALUES ($1, 'other', 'x', $2)`, [gate.id, future]),
      /future/,
    );
    // KST 자정이 아닌 복귀 시각.
    await expectRejected(() => recordRestart(pool, gate.id, 8, 'intervention_other', new Date(day1At.getTime() + HOUR)), /kst_midnight/);
    // 지난 자정으로의 복귀(이미 시작된 날).
    await expectRejected(
      () => recordRestart(pool, gate.id, 8, 'intervention_other', new Date(day1At.getTime() - DAY_MS)),
      /ac0_gate_events_shape/,
    );
    // B2②: 주소 전환 원인은 8일차로 복귀할 수 없다.
    await expectRejected(() => recordRestart(pool, gate.id, 8, 'intervention_address_transition', day1At), /ac0_gate_events_shape/);
    await recordRestart(pool, gate.id, 1, 'intervention_address_transition', day1At);
  });

  it('사람 메일함 모양 — 대문자·에이전트 도메인·빈 배열 거부, 개입 메모는 한 줄 ≤500자', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    for (const mailboxes of [['Owner@Gmail.com'], ['me@atmark.ai'], []]) {
      await expectRejected(
        () => pool.query(`INSERT INTO ac0_gates (organization_id, human_mailboxes) VALUES ($1, $2::text[])`, [fixture.organizationId, mailboxes]),
        /check constraint/,
      );
    }
    const gate = await createAc0Gate(pool, {
      agentId: null,
      organizationId: fixture.organizationId,
      humanMailboxes: [OWNER],
      day1At: kstMidnightAfter(new Date()),
    });
    await expectRejected(() => recordIntervention(pool, gate.id, 'other', 'line1\nline2'), /check constraint/);
    await expectRejected(() => recordIntervention(pool, gate.id, 'other', 'x'.repeat(501)), /check constraint/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('check:ac0 판정 경로 — DB 원자료에서 끝까지', () => {
  it('14일 게이트: 추세 OK · OFF 기록 · 무개입 · 활동 충족 → 통과(exit 0). 대표 직접 메일은 전달로 세지 않는다', async () => {
    const pool = testPool();
    const { gate, agentId, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    await busyWeek(pool, { agentId, agentAddress: 'x@atmark.ai', day }, 8);

    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.observation.dailyForwarded).toEqual([6, 0, 4, 0, 0, 0, 2]);
    expect(report.forwardedTotal).toBe(12);
    expect(report.verdict.proof.activity).toMatchObject({ newExternalContacts: 8, outboundSuccess: 36, multiTurnThreads: 3 });
    expect(report.verdict.status).toBe('passed');
    expect(report.verdict.exitCode).toBe(0);
    expect(renderAc0Report(report)).toContain('판정: 통과 (exit 0)');
  });

  it('② 같은 게이트에서 활동만 뺀다 → 증명 연장(exit 3)', async () => {
    const pool = testPool();
    const { gate, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.status).toBe('proof_extended');
    expect(report.verdict.exitCode).toBe(3);
  });

  it('② 대표에게만 30통 보낸 주 → 활동 분모 미달(내부 주소는 분모를 못 채운다)', async () => {
    const pool = testPool();
    const { gate, agentId, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    for (let i = 0; i < 30; i += 1) await sent(pool, agentId, day(8 + (i % 7), 10), [OWNER]);
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.proof.activity).toMatchObject({ outboundSuccess: 0, newExternalContacts: 0 });
    expect(report.verdict.status).toBe('proof_extended');
  });

  it('③ OFF 기록을 뺀다 → 전환 대기(exit 3)', async () => {
    const pool = testPool();
    const { gate, agentId, day } = await historicGate(pool);
    await busyWeek(pool, { agentId, agentAddress: 'x@atmark.ai', day }, 8);
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.status).toBe('awaiting_switch');
    expect(report.verdict.exitCode).toBe(3);
  });

  it('④ OFF 뒤에 caf 봉투 메일 1건 → 규칙이 꺼지지 않았다, 재시작 1일차(exit 1)', async () => {
    const pool = testPool();
    const { gate, agentId, agentAddress, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    await busyWeek(pool, { agentId, agentAddress: 'x@atmark.ai', day }, 8);
    await inbound(pool, agentId, {
      receivedAt: day(11, 15),
      from: 'late@partner.kr',
      envelopeSender: 'owner.ac0test+caf_=agent=atmark.ai@gmail.com',
      recipient: agentAddress,
    });
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.status).toBe('restart_required');
    expect(report.verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_leak' });
    expect(report.verdict.exitCode).toBe(1);
  });

  it('① 전달 판정 0건(봉투가 전부 원 발신자) → 관측 연장, 통과 아님', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const t1 = new Date(kstMidnightAfter(new Date()).getTime() - 20 * DAY_MS);
    const day = (n: number, h = 12): Date => new Date(t1.getTime() + (n - 1) * DAY_MS + h * HOUR);
    const gateRow = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO ac0_gates (organization_id, agent_id, human_mailboxes, created_at) VALUES ($1, $2, ARRAY[$3], $4) RETURNING id, created_at`,
      [fixture.organizationId, fixture.agentId, OWNER, day(0, 9)],
    );
    const { id, created_at } = gateRow.rows[0] as { id: string; created_at: Date };
    await pool.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at, effective_at, return_day) VALUES ($1, 'start', $2, $3, 1)`, [id, day(0, 10), t1]);
    await pool.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, 'forwarding_on', $2)`, [id, day(0, 11)]);
    // 관리자 라우팅처럼 봉투가 원 발신자 — 판정식이 못 본다. 0 ≤ 0 이 통과하면 안 된다.
    for (let i = 0; i < 5; i += 1) {
      await inbound(pool, fixture.agentId, { receivedAt: day(1, 9 + i), from: `p${String(i)}@partner.kr`, envelopeSender: `p${String(i)}@partner.kr`, recipient: fixture.address });
    }
    await busyWeek(pool, { agentId: fixture.agentId, agentAddress: 'x@atmark.ai', day }, 8);
    const gate: Ac0Gate = { id, organizationId: fixture.organizationId, agentId: fixture.agentId, humanMailboxes: [OWNER], createdAt: created_at };
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.observation.dailyForwarded.every((count) => count === 0)).toBe(true);
    expect(report.verdict.status).toBe('observation_extended');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('V3 H1·H2 — 표본·분모 조작이 통과를 만들지 못한다 (DB 원자료에서)', () => {
  /** start·ON 만 있는 게이트(전달 메일 없음). */
  async function bareGate(db: Pool): Promise<{ gate: Ac0Gate; agentId: AgentId; agentAddress: string; day: (n: number, h?: number) => Date }> {
    const fixture = await seedFixture(db);
    const t1 = new Date(kstMidnightAfter(new Date()).getTime() - 20 * DAY_MS);
    const day = (n: number, h = 12): Date => new Date(t1.getTime() + (n - 1) * DAY_MS + h * HOUR);
    const row = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO ac0_gates (organization_id, agent_id, human_mailboxes, created_at) VALUES ($1, $2, ARRAY[$3], $4) RETURNING id, created_at`,
      [fixture.organizationId, fixture.agentId, OWNER, day(0, 9)],
    );
    const { id, created_at } = row.rows[0] as { id: string; created_at: Date };
    await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at, effective_at, return_day) VALUES ($1, 'start', $2, $3, 1)`, [id, day(0, 10), t1]);
    await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, 'forwarding_on', $2)`, [id, day(0, 11)]);
    return {
      gate: { id, organizationId: fixture.organizationId, agentId: fixture.agentId, humanMailboxes: [OWNER], createdAt: created_at },
      agentId: fixture.agentId,
      agentAddress: fixture.address,
      day,
    };
  }

  it('H1-a: 에이전트 자기 메일이 규칙으로 되돌아온 3통 + 외부 2명 → 기준일 없음(내부 발신은 표본이 아니다)', async () => {
    const pool = testPool();
    const { gate, agentId, agentAddress, day } = await bareGate(pool);
    const caf = `owner.ac0test+caf_=${agentAddress.replace('@', '=')}@gmail.com`;
    for (let i = 0; i < 3; i += 1) {
      await inbound(pool, agentId, { receivedAt: day(1, 9 + i), from: agentAddress, envelopeSender: caf, recipient: agentAddress });
    }
    for (const partner of ['a@partner.kr', 'b@partner.kr']) {
      await inbound(pool, agentId, { receivedAt: day(1, 15), from: partner, envelopeSender: caf, recipient: agentAddress });
    }
    const report = await loadAc0Report(pool, gate, day(9, 1));
    expect(report.forwardedTotal).toBe(5);
    expect(report.verdict.observation.dailyForwarded[0]).toBe(2);
    expect(report.verdict.observation.dailySenders[0]).toBe(2);
    expect(report.verdict.observation.baselineDay).toBeNull();
    expect(report.verdict.status).toBe('observation_extended');
  });

  it('H1-b: 한 상대의 태그·대소문자 변형 3통 → 외부 발신자 1명, 기준일 없음', async () => {
    const pool = testPool();
    const { gate, agentId, agentAddress, day } = await bareGate(pool);
    const caf = `owner.ac0test+caf_=${agentAddress.replace('@', '=')}@gmail.com`;
    for (const from of ['bob+0@partner.kr', 'bob+1@partner.kr', 'bob@partner.kr']) {
      await inbound(pool, agentId, { receivedAt: day(1, 13), from, envelopeSender: caf, recipient: agentAddress });
    }
    const report = await loadAc0Report(pool, gate, day(9, 1));
    expect(report.verdict.observation.dailyForwarded[0]).toBe(3);
    expect(report.verdict.observation.dailySenders[0]).toBe(1);
    expect(report.verdict.observation.baselineDay).toBeNull();
  });

  it('H2①: 반송(bounce) 이벤트가 있는 발송은 outbound 성공이 아니다 — 36 → 29 로 미달', async () => {
    const pool = testPool();
    const { gate, agentId, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    await busyWeek(pool, { agentId, agentAddress: 'x@atmark.ai', day }, 8);
    const before = await loadAc0Report(pool, gate, day(15, 1));
    expect(before.verdict.status).toBe('passed');
    await pool.query(
      `INSERT INTO ses_events (message_id, event_type, event_at, dedupe_key)
       SELECT id, 'bounce', sent_at, encode(sha256(convert_to(id::text, 'UTF8')), 'hex')
         FROM messages WHERE agent_id = $1 AND direction = 'outbound' AND thread_id IN (
           SELECT m.thread_id FROM messages m JOIN outbound_recipients r ON r.message_id = m.id
            WHERE m.agent_id = $1 AND r.address LIKE 'new%')
        ORDER BY sent_at LIMIT 7`,
      [agentId],
    );
    const after = await loadAc0Report(pool, gate, day(15, 1));
    expect(after.verdict.proof.activity?.outboundSuccess).toBe(29);
    expect(after.verdict.status).toBe('proof_extended');
  });

  it('H2②: bob+1~+5 와 Gmail 점 변형은 신규 상대 한 명씩 — 신규 외부 상대 미달', async () => {
    const pool = testPool();
    const { gate, agentId, day } = await historicGate(pool);
    await recordOffAt(pool, gate.id, day(7, 23.5));
    for (let i = 0; i < 30; i += 1) {
      const variants = [`bob+${String(i % 5)}@client.kr`, i % 2 === 0 ? 'b.o.b@gmail.com' : 'bob+x@googlemail.com'];
      await sent(pool, agentId, day(8 + (i % 7), 10), [variants[i % 2] as string]);
    }
    for (let t = 0; t < 3; t += 1) {
      const thread = await newThread(pool, agentId);
      await sent(pool, agentId, day(9 + t, 9), ['bob@client.kr'], thread);
      await inbound(pool, agentId, { receivedAt: day(9 + t, 11), from: 'bob@client.kr', envelopeSender: 'bob@client.kr', threadId: thread, recipient: 'x@atmark.ai' });
      await sent(pool, agentId, day(9 + t, 13), ['bob@client.kr'], thread);
    }
    const report = await loadAc0Report(pool, gate, day(15, 1));
    expect(report.verdict.proof.activity).toMatchObject({ newExternalContacts: 2, outboundSuccess: 36, multiTurnThreads: 3 });
    expect(report.verdict.status).toBe('proof_extended');
  });
});
