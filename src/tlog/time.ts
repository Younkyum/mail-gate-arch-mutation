/**
 * src/tlog/time.ts — 잎·에폭의 시각 문자열. 원천 행 시각은 Postgres 가 마이크로초로 만들고(`INSTANT_SQL`), 서열기·에폭이 JS 에서 만드는
 * 시각은 밀리초 뒤에 `000` 을 붙인다 — 두 쪽 모두 `YYYY-MM-DDTHH:MM:SS.ffffffZ` 한 모양이다(`leaf.ts` `INSTANT_SHAPE`).
 */

/** SQL 조각 — `column` 을 잎의 시각 모양으로. */
export function instantSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function instantOf(date: Date): string {
  const iso = date.toISOString();
  if (!/\.\d{3}Z$/.test(iso)) throw new RangeError('시각 모양이 아니다');
  return `${iso.slice(0, -1)}000Z`;
}
