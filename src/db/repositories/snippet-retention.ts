/**
 * src/db/repositories/snippet-retention.ts — **발신 스니펫 보존 스윕**(2026-09-24 검증 F3, 마이그레이션 202609241700).
 *
 * `messages.snippet`(발신 본문 앞 512자, US-004)을 **365일 뒤 비운다**. 본문 전체(S3 `outbound/content/*`)는 수명주기 365일이
 * 지우고(US-008), 홈 개인정보 문구도 "본문은 1년 뒤 삭제" 다 — 스니펫만 영원히 남으면 문구가 거짓이 된다.
 *
 * 누가 부르나: TTL 스위퍼(`workers/approval-expiry.ts`, EventBridge 5분 · 앱 롤). 새 Lambda·새 DB 롤을 만들지 않고 기존 스케줄에
 * 얹었다. 5분마다 돌지만 부분 인덱스(`messages_snippet_retention_idx`)가 "비울 것이 남은 행" 만 보므로 평소엔 빈 범위 스캔이다 —
 * "하루 한 번" 보다 촘촘해 만료 직후부터 늦어도 5분 안에 비워진다.
 *
 * 권한·가드: 앱 롤은 `snippet` 한 칸만 UPDATE 할 수 있고(컬럼 GRANT), 트리거 `messages_snippet_retention_only` 가 모든 롤에 대해
 * "NULL 로만 · 365일 넘은 행만" 을 강제한다. 기준 시각은 **DB `now()`** 다 — 트리거와 같은 시계를 써야 경계에서 둘이 어긋나지
 * 않는다(주입 시계로 자르면 경계의 행이 트리거에 거부돼 스윕 전체가 실패한다).
 *
 * **한 행이 스윕 전체를 멈추지 않는다**(L2) — 한 문장으로 비우면 한 행의 거부가 문장 전체를 롤백하고, 다음 틱이 같은 행을 맨 앞에
 * 다시 골라 영원히 멈춘다. 그래서:
 *   ① 한 트랜잭션 안에서 `(created_at, id)` 키셋으로 페이지를 고르고, 페이지 전체를 SAVEPOINT 안에서 한 문장으로 비운다(평소 경로).
 *   ② 그 문장이 실패하면 SAVEPOINT 로 되돌리고 **행마다** SAVEPOINT 를 걸어 하나씩 비운다 — 실패한 행은 `stuckIds` 로 세고 건너뛴다.
 *   ③ 키셋 커서가 실패한 행 **뒤**에서 다음 페이지를 고른다 — 같은 틱 안에서 막힌 행을 다시 고르지 않는다.
 * 틱마다 훑는 행은 `limit + SNIPPET_RETENTION_SKIP_MAX` 까지다. 막힌 행은 다음 틱에도 다시 실패하므로 `stuck` 이 매 틱 나오고, 워커가
 * 그 수를 메트릭(`atmark.snippet.retention_stuck`, 알람 11)으로 낸다 — 막힌 행이 `SKIP_MAX` 를 넘으면 진행이 다시 멈추지만 그보다
 * 한참 전에 알람이 운다. 권한 오류(SQLSTATE 42xxx — 문장 자체가 틀렸다)는 행 문제가 아니므로 던진다.
 */

import type { Pool, PoolClient } from 'pg';

import { sqlStateOf, withTransaction } from '../client';

/** 보존 일수 — 마이그레이션 202609241700 트리거의 `interval '365 days'` · `MAIL_BODY_RETENTION_DAYS`(S3 수명주기)와 같은 값. */
export const SNIPPET_RETENTION_DAYS = 365;

/** 한 번의 스윕에서 비우는 최대 행 수. 넘치면 다음 스윕(5분 뒤)이 이어받는다(오래된 순). */
export const SNIPPET_RETENTION_BATCH = 1000;

/** 한 번의 스윕이 **건너뛸 수 있는** 막힌 행 수 상한 — 틱당 훑는 행은 `limit + 이 값` 까지다(L2). */
export const SNIPPET_RETENTION_SKIP_MAX = 1000;

export interface SnippetSweepResult {
  /** 비운 행 수. */
  readonly cleared: number;
  /** UPDATE 가 거부돼 건너뛴 행(다른 트리거 등). 비어 있어야 정상이다. */
  readonly stuckIds: readonly string[];
}

export interface SnippetRetention {
  /** 보존 기간을 넘긴 행의 스니펫을 최대 `limit` 행 비운다. 거부된 행은 건너뛰고 센다. */
  sweep(limit: number): Promise<SnippetSweepResult>;
}

interface Candidate {
  readonly id: string;
  readonly created_at: Date;
}

/** 문장 자체가 틀린 오류(권한·문법 — SQLSTATE 42xxx)는 행 문제가 아니다. 던진다. */
function isStatementError(error: unknown): boolean {
  return sqlStateOf(error)?.startsWith('42') === true;
}

async function clearRows(client: PoolClient, ids: readonly string[]): Promise<number> {
  const result = await client.query('UPDATE messages SET snippet = NULL WHERE id = ANY($1::uuid[]) AND snippet IS NOT NULL', [ids]);
  return result.rowCount ?? 0;
}

async function sweepIn(client: PoolClient, limit: number): Promise<SnippetSweepResult> {
  let cleared = 0;
  const stuckIds: string[] = [];
  let cursor: Candidate | null = null;
  while (cleared < limit && stuckIds.length <= SNIPPET_RETENTION_SKIP_MAX) {
    // `SKIP LOCKED` — 발송 경로가 잡고 있는 행(있을 수 없지만 — 365일 넘은 행은 종단이다)이나 겹친 스윕을 기다리지 않는다.
    const page: { rows: Candidate[] } = await client.query<Candidate>(
      `SELECT id, created_at FROM messages
        WHERE snippet IS NOT NULL
          AND created_at < now() - make_interval(days => $2::int)
          AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY created_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit - cleared, SNIPPET_RETENTION_DAYS, cursor?.created_at ?? null, cursor?.id ?? null],
    );
    if (page.rows.length === 0) break;
    const ids = page.rows.map((row) => row.id);

    await client.query('SAVEPOINT snippet_page');
    try {
      cleared += await clearRows(client, ids);
      await client.query('RELEASE SAVEPOINT snippet_page');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT snippet_page');
      if (isStatementError(error)) throw error;
      // 페이지 안의 어느 행이 거부했다 — 행마다 다시 한다.
      for (const id of ids) {
        await client.query('SAVEPOINT snippet_row');
        try {
          cleared += await clearRows(client, [id]);
          await client.query('RELEASE SAVEPOINT snippet_row');
        } catch (rowError) {
          await client.query('ROLLBACK TO SAVEPOINT snippet_row');
          if (isStatementError(rowError)) throw rowError;
          stuckIds.push(id);
        }
      }
    }
    cursor = page.rows[page.rows.length - 1] ?? null;
  }
  return { cleared, stuckIds };
}

export function createPostgresSnippetRetention(pool: Pool): SnippetRetention {
  return {
    async sweep(limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit 은 1 이상의 정수다');
      return withTransaction(pool, (client) => sweepIn(client, limit));
    },
  };
}
