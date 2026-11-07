/**
 * `workers/ops-code-mailer` — **호스팅 운영자 콘솔 코드 메일 outbox 를 비운다**(`.omc/plans/ops-console.md` §3.4 · H10 · M1).
 *
 * 시스템 메일 범주(`SYSTEM_MAIL_ENTRYPOINTS` — `ops_code_notify`)다: 관문을 import 하지 않고 등록된 모듈(`src/notify/ops-code-notifier.ts`) 하나로만
 * 보낸다. 이 파일은 무엇을 누구에게 보낼지 모른다 — 기한이 된 도전 id 를 골라 `notify(id)` 를 부를 뿐이다.
 *
 * **격리(M1 — 소유자 로그인·가입·초대 메일은 이 워커와 무관하게 돈다).** login-mailer 틱에서 **가장 먼저**, 자기 예산(5초 · 10행) 안에서만 돌고,
 * **어떤 이유로도 던지지 않는다** — 건너뛸 때는 메트릭(`atmark.ops.mailer_skipped{reason}`)을 남긴다:
 *   - `schema` — 표·함수 없음(42P01 · 42883, 0500 적용 전) · `permission` — 권한 없음(42501)
 *   - `config` — 운영 코드 키링 비밀 ARN 없음·읽기 실패 · `placeholder` — 자리표시값 · `key_invalid` — 키링 형식 오류
 * 키링은 **보낼 것이 있을 때 처음** 읽는다(`loadNotifier` — 조립이 성공만 캐시한다). 보낼 것이 없으면 비밀을 읽지 않는다.
 * 그 밖의 오류도 로그만 남기고 삼킨다(결말 `failed`) — 틱 전체가 실패로 보고되지 않게.
 *
 * **예산은 기다림에도 건다**(코드 리뷰 M5) — 기한 조회는 남은 예산을 `statement_timeout`(그 조회 하나에만, `set_config(…, true)`)으로 걸고, 키링 읽기
 * (Secrets Manager)는 남은 예산과 경주시킨다. 넘으면 `config` 로 건너뛴다 — 운영 쪽이 멈춰도 소유자 메일이 예산 이상 늦지 않는다.
 */

import type { Queryable } from '../db/client';
import { OPS_CODE_NOTIFY_ROUTE_ID, type OpsCodeNotifier } from '../notify/ops-code-notifier';
import { log } from '../observability/logger';
import { countOpsMetric, OPS_METRIC_NAMES, type OpsMailerSkipReason } from '../ops/metrics';

/** 한 틱의 운영 워커 예산 — 행 수와 경과 시간(소유자 메일 워커들의 몫을 먹지 않는다). */
export const OPS_CODE_MAIL_BATCH = 10;
const OPS_CODE_MAIL_BUDGET_MS = 5_000;

export interface OpsCodeMailerWorkerDependencies {
  /** 기한이 된 도전 id 를 고르는 읽기 전용 조회에만 쓴다. */
  readonly db: Queryable;
  /** 알림기(운영 코드 키링을 처음 읽는다) — 건너뛸 이유가 있으면 그 이유. 던지면 `config` 로 본다. */
  readonly loadNotifier: () => Promise<OpsCodeNotifier | OpsMailerSkipReason>;
  readonly now: () => Date;
  /** 예산(ms) — 테스트만 줄인다. 기본 `OPS_CODE_MAIL_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/** 결말별 개수(`sent` · `dead` · `skipped` · `failed` …) — 0 은 싣지 않는다. 식별자 없음. */
export type OpsCodeMailReport = Readonly<Record<string, number>>;

/** DB 오류 → 건너뛸 이유(마이그레이션 전 · 권한). 그 밖은 `null`. */
export function skipReasonOf(error: unknown): OpsMailerSkipReason | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '42883') return 'schema';
  if (code === '42501') return 'permission';
  // 기한 조회가 남은 예산(statement_timeout)을 넘었다 — 운영 쪽 설정·DB 문제로 본다.
  if (code === '57014') return 'config';
  return null;
}

const TIMED_OUT = Symbol('timed_out');

/** 남은 예산과 경주 — 넘으면 `TIMED_OUT`(원래 약속은 뒤에서 끝나도 버린다). */
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, remainingMs));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 기한이 된 도전 id — 남은 예산을 `statement_timeout` 으로 건 한 번의 왕복(단순 질의 두 문장 = 암묵 트랜잭션 하나 · 끝나면 설정도 사라진다).
 * 값은 코드가 만든 것뿐이다(ISO 시각 · 정수) — 사용자 입력이 문장에 들어가지 않는다.
 */
async function dueChallenges(db: Queryable, now: Date, remainingMs: number): Promise<readonly { id: string }[]> {
  const timeout = String(Math.max(1, Math.floor(remainingMs)));
  const result = (await db.query(
    `SELECT set_config('statement_timeout', '${timeout}', true);
     SELECT id FROM ops_login_challenges
      WHERE status = 'pending' AND next_attempt_at <= '${now.toISOString()}'::timestamptz
      ORDER BY next_attempt_at, created_at
      LIMIT ${String(OPS_CODE_MAIL_BATCH)}`,
  )) as unknown;
  const last = Array.isArray(result) ? (result[result.length - 1] as { rows?: unknown } | undefined) : (result as { rows?: unknown });
  return (Array.isArray(last?.rows) ? last.rows : []) as { id: string }[];
}

function noteSkip(reason: OpsMailerSkipReason): void {
  countOpsMetric(OPS_METRIC_NAMES.mailerSkipped, { reason });
  log('warn', 'ops_code_notify.skipped', { route_id: OPS_CODE_NOTIFY_ROUTE_ID, reason });
}

function skip(reason: OpsMailerSkipReason): OpsCodeMailReport {
  noteSkip(reason);
  return { skipped: 1 };
}

/** 한 번의 배출 — **던지지 않는다.** */
export async function runOpsCodeMailer(deps: OpsCodeMailerWorkerDependencies): Promise<OpsCodeMailReport> {
  const started = Date.now();
  const budget = deps.budgetMs ?? OPS_CODE_MAIL_BUDGET_MS;
  const remaining = (): number => budget - (Date.now() - started);
  let due: readonly { id: string }[];
  try {
    due = await dueChallenges(deps.db, deps.now(), remaining());
  } catch (error) {
    const reason = skipReasonOf(error);
    if (reason !== null) return skip(reason);
    log('error', 'ops_code_notify.failed', { route_id: OPS_CODE_NOTIFY_ROUTE_ID, error_kind: error instanceof Error ? error.name : typeof error });
    return { failed: 1 };
  }
  if (due.length === 0) return {};

  let notifier: OpsCodeNotifier | OpsMailerSkipReason | typeof TIMED_OUT;
  try {
    const loading = deps.loadNotifier();
    loading.catch(() => undefined); // 예산을 넘긴 뒤의 거부가 처리되지 않은 거부로 새지 않게.
    notifier = await withinBudget(loading, remaining());
  } catch {
    notifier = 'config';
  }
  if (notifier === TIMED_OUT) return skip('config');
  if (typeof notifier === 'string') return skip(notifier);

  const report: Record<string, number> = {};
  for (const { id } of due) {
    if (remaining() <= 0) break;
    try {
      const outcome = await notifier.notify(id);
      report[outcome] = (report[outcome] ?? 0) + 1;
    } catch (error) {
      const reason = skipReasonOf(error);
      if (reason !== null) {
        noteSkip(reason);
        report['skipped'] = (report['skipped'] ?? 0) + 1;
        break;
      }
      log('error', 'ops_code_notify.failed', {
        route_id: OPS_CODE_NOTIFY_ROUTE_ID,
        trace_id: id,
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      report['failed'] = (report['failed'] ?? 0) + 1;
    }
  }
  return report;
}
