/**
 * src/admin/org-api/rate-limit.ts — **`/org-api` 조직별 요청 상한**(ADR-0010 후속 L5, 마이그레이션 202609250200).
 *
 * API Gateway 스로틀(`ANY /org-api/{proxy+}`)은 전 조직이 나눠 쓰는 버킷 하나라 전체 천장으로만 남기고, 조직 공정성은 여기서 건다:
 *   - 인증 성공 직후 **한 문장** — 키 × 분 창 행을 upsert(`n + 1`, 키 상한에 닿은 행은 올리지 않는다) + 같은 창의 조직 합.
 *   - 키당 분당 `ORG_API_KEY_REQUESTS_PER_MINUTE` · 조직당 분당 `ORG_API_ORG_REQUESTS_PER_MINUTE` → 429 `rate_limited` + `Retry-After`
 *     (다음 분 창까지 남은 초, 1–60). 시계는 DB `now()` 하나(가드 트리거와 같은 시계).
 *   - 키 상한에 걸린 요청은 계수를 올리지 않는다(두드리는 키가 같은 조직의 다른 키 몫을 먹지 않게). 조직 상한에 걸린 요청은 제 키
 *     창을 1 올린다(키 창은 60 에서 멈춘다 — 조직 합의 상한은 활성 키 5 × 60).
 *   - 조직 합은 문장 시작 스냅샷의 **다른 키** 창 + 제 키의 새 값이다. 같은 순간 다른 키의 커밋 전 요청은 안 보일 수 있다(느슨한 쪽 —
 *     키 몇 개만큼 초과할 수 있다). 제 키의 계수는 행 잠금으로 정확하다.
 */

import type { Queryable } from '../../db/client';

/** 키 하나의 분당 요청 상한. */
export const ORG_API_KEY_REQUESTS_PER_MINUTE = 60;
/** 조직 하나(모든 키 합)의 분당 요청 상한. */
export const ORG_API_ORG_REQUESTS_PER_MINUTE = 120;

type OrgApiRateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly scope: 'key' | 'organization'; readonly retryAfterSeconds: number };

/** 요청 하나를 센다 — 인증된 키 · 그 조직. 상한이면 `allowed:false`(다음 창까지 초). */
export async function countOrgApiRequest(db: Queryable, keyId: string, organizationId: string): Promise<OrgApiRateDecision> {
  const result = await db.query<{ key_n: number | null; other_n: number; retry_after: number }>(
    `WITH hit AS (
       INSERT INTO org_api_request_windows AS w (org_api_key_id, organization_id, window_start, n)
       VALUES ($1::uuid, $2::uuid, date_trunc('minute', now()), 1)
       ON CONFLICT (org_api_key_id, window_start) DO UPDATE SET n = w.n + 1 WHERE w.n < $3::int
       RETURNING w.n
     )
     SELECT (SELECT n FROM hit) AS key_n,
            (SELECT coalesce(sum(o.n), 0)::int FROM org_api_request_windows o
              WHERE o.organization_id = $2::uuid AND o.window_start = date_trunc('minute', now()) AND o.org_api_key_id <> $1::uuid) AS other_n,
            (60 - floor(extract(second FROM now())))::int AS retry_after`,
    [keyId, organizationId, ORG_API_KEY_REQUESTS_PER_MINUTE],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('org_api_request_windows 계수 문장이 행을 돌려주지 않았다');
  const retryAfterSeconds = Math.min(60, Math.max(1, row.retry_after));
  if (row.key_n === null) return { allowed: false, scope: 'key', retryAfterSeconds };
  if (row.key_n + row.other_n > ORG_API_ORG_REQUESTS_PER_MINUTE) return { allowed: false, scope: 'organization', retryAfterSeconds };
  return { allowed: true };
}
