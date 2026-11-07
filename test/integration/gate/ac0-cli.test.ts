/**
 * `pnpm check:ac0` · `ac0:*` — **CLI 를 실제로 띄워 exit code 계약을 끝까지 고정한다.**
 *
 *   0 통과 · 1 실패(재시작 필요 · AC-0 미성립) · 3 진행 중·판정 보류 · 2 판정 불가(입력·설정·DB)
 *
 * V3 가 찾은 B1(판정식 불일치 경고 + exit 0 이 한 화면)·B2(재시작 3회 초과 + exit 0)는 판정 함수가 아니라
 * **이 층**(판정 → 출력 → 프로세스 exit)에서 났고, 이 층의 자동 테스트가 0건이었다. cron 이 보는 것은 exit
 * code 뿐이므로 여기서는 프로세스의 exit status 와 출력 한 줄을 본다.
 *
 * 과거 시각은 SQL 로 직접 심는다(CLI 에는 시각 인자가 없다 — 소급 기록 경로 없음). 각 시나리오는 새 조직·
 * 새 게이트이고 항상 `--gate` 로 부른다(테스트 DB 에는 게이트가 여럿이다 — 그 자체가 아래 exit 2 시나리오).
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { DAY_MS, kstMidnightAfter } from '../../../src/observability/ac0-metrics';
import type { AgentId } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool } from '../db/support/harness';
import { busyWeek, inbound, type DayFn } from './support/seed';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const ROOT = resolve(__dirname, '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const OWNER = 'owner.cli@gmail.com';
const HOUR = 3_600_000;
const TIMEOUT = 120_000;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(script: string, args: readonly string[], databaseUrl = process.env['TEST_DATABASE_URL'] as string): CliResult {
  const result = spawnSync(TSX, [resolve(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const check = (gateId: string): CliResult => cli('check-ac0.ts', ['--gate', gateId]);

// ---------------------------------------------------------------------------
// 심기 — T1 = 30일 전 KST 자정. day(n, h) = n일차 h시(KST).
// ---------------------------------------------------------------------------

interface Seeded {
  readonly gateId: string;
  readonly agentId: AgentId;
  readonly agentAddress: string;
  readonly day: DayFn;
}

async function event(db: Pool, gateId: string, kind: 'forwarding_on' | 'forwarding_off', at: Date): Promise<void> {
  await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at) VALUES ($1, $2, $3)`, [gateId, kind, at]);
}

async function restart8(db: Pool, gateId: string, recordedAt: Date, effectiveAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO ac0_gate_events (gate_id, kind, recorded_at, effective_at, return_day, cause)
     VALUES ($1, 'restart', $2, $3, 8, 'intervention_other')`,
    [gateId, recordedAt, effectiveAt],
  );
}

async function intervention(db: Pool, gateId: string, at: Date, category = 'other'): Promise<void> {
  await db.query(`INSERT INTO human_mailbox_interventions (gate_id, category, reason, recorded_at) VALUES ($1, $2, 'cli test', $3)`, [
    gateId,
    category,
    at,
  ]);
}

/** 관측 통과(1일차 외부 6명 → 7일차 2통) · 7일차 23:30 OFF 까지. */
async function observedGate(db: Pool, daysAgo = 30): Promise<Seeded> {
  const fixture = await seedFixture(db);
  const t1 = new Date(kstMidnightAfter(new Date()).getTime() - daysAgo * DAY_MS);
  const day = (n: number, h = 12): Date => new Date(t1.getTime() + (n - 1) * DAY_MS + h * HOUR);
  const row = await db.query<{ id: string }>(
    `INSERT INTO ac0_gates (organization_id, agent_id, human_mailboxes, created_at) VALUES ($1, $2, ARRAY[$3], $4) RETURNING id`,
    [fixture.organizationId, fixture.agentId, OWNER, day(0, 9)],
  );
  const gateId = (row.rows[0] as { id: string }).id;
  await db.query(`INSERT INTO ac0_gate_events (gate_id, kind, recorded_at, effective_at, return_day) VALUES ($1, 'start', $2, $3, 1)`, [
    gateId,
    day(0, 10),
    t1,
  ]);
  await event(db, gateId, 'forwarding_on', day(0, 11));
  const caf = `owner.cli+caf_=${fixture.address.replace('@', '=')}@gmail.com`;
  for (const [n, count] of [[1, 6], [7, 2]] as const) {
    for (let i = 0; i < count; i += 1) {
      await inbound(db, fixture.agentId, { receivedAt: day(n, 9 + i), from: `p${String(i)}@partner.kr`, envelopeSender: caf, recipient: fixture.address });
    }
  }
  return { gateId, agentId: fixture.agentId, agentAddress: fixture.address, day };
}

async function withOff(db: Pool, seeded: Seeded): Promise<Seeded> {
  await event(db, seeded.gateId, 'forwarding_off', seeded.day(7, 23.5));
  return seeded;
}

/** 8일차 복귀 `count` 회 — 매번 "기타" 개입 → 다음 날 10시 복귀 기록 → 그다음 자정 복귀. 마지막 복귀 자정 = 8+count+1 일차… */
async function day8Restarts(db: Pool, seeded: Seeded, count: number): Promise<number> {
  for (let n = 0; n < count; n += 1) {
    await intervention(db, seeded.gateId, seeded.day(8 + n, 12));
    await restart8(db, seeded.gateId, seeded.day(9 + n, 10), seeded.day(10 + n, 0));
  }
  return 10 + count - 1;
}

describe.skipIf(!DATABASE_AVAILABLE)('check:ac0 exit code 계약 — CLI 프로세스 끝까지', () => {
  it(
    '기준: 관측 OK · OFF · 증명 무개입 · 활동 충족 → exit 0',
    async () => {
      const pool = testPool();
      const seeded = await withOff(pool, await observedGate(pool));
      await busyWeek(pool, seeded, 8);
      const result = check(seeded.gateId);
      expect(result.stdout).toContain('판정: 통과 (exit 0)');
      expect(result.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'B1: OFF 뒤 증명 7일 내내 판정식이 모르는 봉투(SRS)로 전달 도착 → exit 3 판정 보류, 경고와 exit 0 이 한 화면에 나오지 않는다',
    async () => {
      const pool = testPool();
      const seeded = await withOff(pool, await observedGate(pool));
      await busyWeek(pool, seeded, 8);
      for (let n = 8; n <= 14; n += 1) {
        await inbound(pool, seeded.agentId, {
          receivedAt: seeded.day(n, 15),
          from: 'still-old@partner.kr',
          envelopeSender: `SRS0=abcd=XY=gmail.com=owner.cli@forwarder.example`,
          recipient: seeded.agentAddress,
          forwardedFor: `${OWNER} ${seeded.agentAddress}`,
          forwardedTo: seeded.agentAddress,
        });
      }
      const result = check(seeded.gateId);
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('판정식 불일치 의심 7건');
      expect(result.stdout).toContain('판정: 판정 보류 — 판정식 확인 필요 (exit 3)');
      expect(result.stdout).not.toContain('exit 0');
    },
    TIMEOUT,
  );

  it(
    'B2: 8일차 복귀 3회 뒤 증명 충족 → exit 0 · 4회 뒤 같은 조건 → exit 1 AC-0 미성립, ac0:restart 는 기록을 거부(exit 2)',
    async () => {
      const pool = testPool();
      const three = await withOff(pool, await observedGate(pool));
      const threeProofStart = await day8Restarts(pool, three, 3);
      await busyWeek(pool, three, threeProofStart + 1);
      const control = check(three.gateId);
      expect(control.stdout).toContain('재시작 3회');
      expect(control.status).toBe(0);

      const four = await withOff(pool, await observedGate(pool));
      const fourProofStart = await day8Restarts(pool, four, 4);
      await busyWeek(pool, four, fourProofStart);
      const signal = check(four.gateId);
      expect(signal.stdout).toContain('판정: AC-0 미성립');
      expect(signal.stdout).toContain('(exit 1)');
      expect(signal.stdout).toContain('신호가 없었다면: 통과');
      expect(signal.status).toBe(1);

      const before = await pool.query(`SELECT count(*)::int AS n FROM ac0_gate_events WHERE gate_id = $1 AND kind = 'restart'`, [four.gateId]);
      const refused = cli('ac0-restart.ts', ['--gate', four.gateId]);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain('--new-gate');
      const after = await pool.query(`SELECT count(*)::int AS n FROM ac0_gate_events WHERE gate_id = $1 AND kind = 'restart'`, [four.gateId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
    TIMEOUT,
  );

  it(
    'B2②: "기타" 8일차 복귀 뒤, 복귀 기록 전 구간의 전달 메일 → 카테고리와 무관하게 exit 1 · 1일차 복귀',
    async () => {
      const pool = testPool();
      const seeded = await withOff(pool, await observedGate(pool));
      const proofStart = await day8Restarts(pool, seeded, 1);
      await busyWeek(pool, seeded, proofStart);
      const clean = check(seeded.gateId);
      expect(clean.status).toBe(0);
      // 개입(8일차 12시)과 복귀 기록(9일차 10시) 사이에 옛 주소로 온 전달 메일 — 수집 지연·판정식 소급으로 뒤늦게 보인 것.
      await inbound(pool, seeded.agentId, {
        receivedAt: seeded.day(8, 20),
        from: 'old-address@partner.kr',
        envelopeSender: `owner.cli+caf_=${seeded.agentAddress.replace('@', '=')}@gmail.com`,
        recipient: seeded.agentAddress,
      });
      const result = check(seeded.gateId);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('재시작 → 1일차 복귀 · 원인 forwarding_leak');
    },
    TIMEOUT,
  );

  it(
    '관측 중 → exit 3 · 누수 → exit 1',
    async () => {
      const pool = testPool();
      const observing = await observedGate(pool, 3);
      expect(check(observing.gateId).status).toBe(3);

      const leaking = await withOff(pool, await observedGate(pool));
      await busyWeek(pool, leaking, 8);
      await inbound(pool, leaking.agentId, {
        receivedAt: leaking.day(11, 15),
        from: 'late@partner.kr',
        envelopeSender: 'owner.cli+caf_=agent=atmark.ai@gmail.com',
        recipient: leaking.agentAddress,
      });
      const result = check(leaking.gateId);
      expect(result.stdout).toContain('forwarding_leak');
      expect(result.status).toBe(1);
    },
    TIMEOUT,
  );

  it(
    '판정 불가는 2 — 없는 게이트 · 게이트 여럿인데 --gate 없음(최근 것을 고르지 않는다) · DB 접속 불가',
    async () => {
      const pool = testPool();
      await observedGate(pool, 3);
      await observedGate(pool, 3);

      const missing = cli('check-ac0.ts', ['--gate', randomUUID()]);
      expect(missing.status).toBe(2);

      const ambiguous = cli('check-ac0.ts', []);
      expect(ambiguous.status).toBe(2);
      expect(ambiguous.stderr).toContain('--gate <id> 로 정한다');

      const unreachable = cli('check-ac0.ts', ['--gate', randomUUID()], 'postgres://nobody:nothing@127.0.0.1:1/none');
      expect(unreachable.status).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'ac0:probe 는 게이트 없이 돈다(실측은 ac0:start 전) — 기록하지 않고 exit 0',
    async () => {
      const pool = testPool();
      const fixture = await seedFixture(pool);
      await inbound(pool, fixture.agentId, {
        receivedAt: new Date(Date.now() - HOUR),
        from: 'seed@partner.kr',
        envelopeSender: `owner.cli+caf_=${fixture.address.replace('@', '=')}@gmail.com`,
        recipient: fixture.address,
      });
      const result = cli('ac0-probe.ts', ['--agent', fixture.agentId, '--human-mailbox', OWNER, '--hours', '2']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('전달(caf_rewrite)');
      const gates = await pool.query(`SELECT count(*)::int AS n FROM ac0_gates WHERE organization_id = $1`, [fixture.organizationId]);
      expect(gates.rows[0]).toEqual({ n: 0 });
    },
    TIMEOUT,
  );
});
