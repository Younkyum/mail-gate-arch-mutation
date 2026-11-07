import type { Queryable } from '../../src/db/client';

/**
 * 통합 테스트용 — DB 가 방금 적은 기한을 워커가 JS 시계(`now: () => new Date()`)로 `<= $now` 비교하기 전에, JS 시계가 DB 시계를 넘을 때까지 기다린다.
 *
 * 두 가지를 막는다.
 * - **µs 경합**: DB 기본값 `now()`(마이크로초)로 적힌 기한(`welcome_mails.next_attempt_at` · `ops_request_code` 의 도전)은 같은 밀리초 안의
 *   JS 시각(밀리초에서 잘림)보다 늦다 → 아직 기한 전(메일 0 · `{}`). 같은 컨테이너의 Postgres(자체 실행기)는 왕복이 0.1ms 안팎이라 실제로 났다
 *   (CI 36883729770 — `fdfe9df`).
 * - **시계 어긋남**: 로그인·가입·초대 링크는 `date_trunc('milliseconds', now())` 로 잘라 넣으므로 같은 시계라면 µs 경합이 없다. 그래도 JS 시계가
 *   DB 시계보다 조금이라도 뒤면 같은 모양으로 기한 전이 된다.
 *
 * 고정 대기 대신 DB 시계(`clock_timestamp()` — 앞서 적힌 어떤 `now()` 보다 늦다)를 읽어 밀리초로 올리고, `Date.now()` 가 그보다 커질 때까지 1ms 씩
 * 기다린다 — 타이머가 일찍 깨어나도 조건을 다시 보므로 성립한다. 런북 `docs/runbooks/ci-cd.md` §11-9.
 */
export async function afterDbNow(db: Queryable): Promise<void> {
  const row = await db.query<{ ms: string }>(`SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`);
  const dbMs = Number(row.rows[0]?.ms);
  if (!Number.isFinite(dbMs)) throw new Error('DB 시각을 읽지 못했다');
  while (Date.now() <= dbMs) await new Promise((resolve) => setTimeout(resolve, 1));
}
