/**
 * ops/ai-watch/worker/log.ts — 워커의 **유일한** 로거(설계 §1.4).
 *
 * 메일 본문 · 토큰 id · 로짓 · 점수 원값은 로그에 나가면 안 된다. 그래서 이 로거는 **허용 키 목록**을 갖고, 값도 모양으로 거른다:
 *   - 키가 `ALLOWED_KEYS` 밖이면 버린다(조용히 — 대신 `dropped` 수를 남긴다).
 *   - 문자열은 `SAFE_STRING`(영숫자·`._:-`, 80자)만 — 공백·개행이 든 문자열(= 문장 · 본문 조각)은 들어올 수 없다.
 *   - 숫자는 유한한 값만, 불리언은 그대로.
 * 에러는 `error.name` 만 싣는다(`message` 는 입력 일부를 담을 수 있다 — ORT·토크나이저 오류 문구를 믿지 않는다).
 */

export const ALLOWED_KEYS = [
  'event',
  'job_id',
  'latency_ms',
  'verdict',
  'band',
  'model_version',
  'worker_id',
  'error_kind',
  'reason',
  'outcome',
  'self_test',
  'draining',
  'count',
  'passed',
  'failed',
  'queue_lag_ms',
  'rss_mb',
] as const;
export type LogKey = (typeof ALLOWED_KEYS)[number];
export type LogFields = Partial<Record<LogKey, string | number | boolean | null>>;

const SAFE_STRING = /^[A-Za-z0-9._:-]{0,80}$/;
const ALLOWED = new Set<string>(ALLOWED_KEYS);

export type LogLevel = 'info' | 'warn' | 'error';

/** 거른 결과(테스트가 본다). */
export function sanitize(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) {
      dropped += 1;
      continue;
    }
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && SAFE_STRING.test(value)) out[key] = value;
    else dropped += 1;
  }
  if (dropped > 0) out['dropped'] = dropped;
  return out;
}

export type LineWriter = (line: string) => void;

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
}

export function createLogger(write: LineWriter = (line) => process.stdout.write(`${line}\n`)): Logger {
  return {
    log(level, fields) {
      try {
        write(JSON.stringify({ ts: new Date().toISOString(), level, ...sanitize(fields) }));
      } catch {
        // 로그가 워커를 죽이지 않는다.
      }
    },
  };
}

/** 에러 → 닫힌 종류 이름(메시지는 싣지 않는다). */
export function errorKind(error: unknown): string {
  if (error instanceof Error && SAFE_STRING.test(error.name) && error.name !== '') return error.name;
  return 'unknown';
}
