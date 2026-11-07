/**
 * src/ops/console/board.ts — **주간 운영판**(마케팅 계획 2026-09-30 §6.1–6.3 · §9.2). 창업자가 금요일 30분에 읽는 한 쪽. **읽기 전용** — 쓰기 0 · 메일 0.
 *
 * 숫자는 정의 함수 `ops_weekly_board(now, 내부 조직)`(202610010900 — 건수와 조직 id 만, 개인 정보 칸은 ops 롤에 주지 않는다) 와 대기자 명단의 상태별 수
 * (`atmark_ops` 의 기존 칸 GRANT)에서 온다. **판정(문턱 · 사다리 · 하한 · 퍼센트 규칙)은 `board-rules.ts` 의 순수 함수**가 한다 — 테스트가 고정한다.
 *
 *   - 사다리: DB 가 볼 수 있는 신호만 계산한다(L0~L2). L3 신호(SES 계정 알람 · AWS 통지 · Spamhaus 등 · Postmaster 평판)와 Postmaster 스팸률 ·
 *     abuse@/postmaster@ 신고는 **수동 확인 목록**(링크)이다 — 계산하지 않는다.
 *   - 하한: 14일 누적 외부 발신 200통 미만이면 "0건" 은 초록이 아니라 **판정 불가 / insufficient volume** 이다(계획 §9.2 발송량 하한).
 *   - 퍼센트: 분모가 20 미만이면 싣지 않는다(`ratio` 의 `pct = null` — 화면은 n/N 만 그린다).
 *   - 코호트: 초대 주차(KST ISO 주) · 내부 조직(`INTERNAL_ORG_IDS`) 제외 · Beta 따로 · 7일 창이 닫히지 않은 주는 표시.
 */

import type { Queryable } from '../../db/client';
import {
  BOARD_MANUAL_CHECKS,
  BOARD_RULES,
  cohortRowOf,
  INTERNAL_ORG_IDS,
  ladderOf,
  type BoardGuardRaw,
  type CohortRaw,
} from './board-rules';
import { ok, waitlistGradeHint, type ApiResult } from './reads';

const DAY_MS = 24 * 60 * 60 * 1000;

interface BoardRaw {
  readonly guard: BoardGuardRaw;
  readonly north: { readonly global: number; readonly beta: number };
  readonly cohorts: readonly CohortRaw[];
}

export interface WaitlistLine {
  readonly waiting: number;
  readonly invited: number;
  readonly expired: number;
  readonly joined: number;
  /** 대기 중 항목의 등급 후보 분포(본인 확인 안 됨). `unknown` = 용도가 비어 있다(운영자가 메모를 읽고 정한다). */
  readonly grades: Readonly<Record<'A' | 'B' | 'hold' | 'unknown', number>>;
  /** A 후보가 7일 넘게 대기 중(내부 SLA 초과, 계획 §4.2). */
  readonly gradeASlaBreaches: number;
}

async function readWaitlistLine(db: Queryable, now: Date): Promise<WaitlistLine> {
  // 칸: status · use_case · note · created_at · invite_expires_at — `atmark_ops` 의 기존 GRANT(202609301520 · 1530). 메모는 있음/없음만 센다.
  const rows = await db.query<{ status: string; use_case: string | null; has_note: boolean; expired: boolean; overdue: boolean; n: number }>(
    `SELECT status, use_case, (note IS NOT NULL AND btrim(note) <> '') AS has_note,
            (status = 'invited' AND invite_expires_at <= $1) AS expired,
            created_at <= $2 AS overdue, count(*)::int AS n
       FROM waitlist_entries
      GROUP BY 1, 2, 3, 4, 5`,
    [now, new Date(now.getTime() - BOARD_RULES.gradeASlaDays * DAY_MS)],
  );
  const line = { waiting: 0, invited: 0, expired: 0, joined: 0, grades: { A: 0, B: 0, hold: 0, unknown: 0 }, gradeASlaBreaches: 0 };
  for (const row of rows.rows) {
    if (row.status === 'joined') line.joined += row.n;
    else if (row.status === 'invited') {
      if (row.expired) line.expired += row.n;
      else line.invited += row.n;
    } else if (row.status === 'waiting') {
      line.waiting += row.n;
      const grade = waitlistGradeHint(row.use_case, row.has_note ? 'note' : null) ?? 'unknown';
      line.grades[grade] += row.n;
      if (grade === 'A' && row.overdue) line.gradeASlaBreaches += row.n;
    }
  }
  return line;
}

/** 주간 운영판 — `GET /api/board`. 로컬(소유자 롤)과 호스팅(`atmark_ops` — 정의 함수 EXECUTE + 대기자 명단 칸 GRANT)이 같이 쓴다. */
export async function readWeeklyBoard(db: Queryable, now: Date): Promise<ApiResult> {
  const result = await db.query<{ board: BoardRaw }>('SELECT ops_weekly_board($1, $2::uuid[]) AS board', [now, [...INTERNAL_ORG_IDS]]);
  const raw = result.rows[0]?.board;
  if (raw === undefined) throw new Error('ops_weekly_board 가 행을 돌려주지 않았다');
  const ladder = ladderOf(raw.guard);
  const sends = raw.guard.externalSends;
  return ok({
    at: now.toISOString(),
    guardrail: {
      ...ladder,
      volume: {
        d7: sends.d7,
        d14: sends.d14,
        d28: sends.d28,
        floor14d: BOARD_RULES.volumeFloor14d,
        floor28d: BOARD_RULES.volumeFloor28d,
        launchFloorMet: sends.d28 >= BOARD_RULES.volumeFloor28d,
      },
      manual: BOARD_MANUAL_CHECKS,
    },
    northStar: { global: raw.north.global, beta: raw.north.beta, internalExcluded: INTERNAL_ORG_IDS.length },
    cohorts: { internalExcluded: INTERNAL_ORG_IDS.length, rows: raw.cohorts.map((row) => cohortRowOf(row, now)) },
    waitlist: await readWaitlistLine(db, now),
  });
}
