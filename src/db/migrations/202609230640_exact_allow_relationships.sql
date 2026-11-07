-- 202609230640_exact_allow_relationships.sql
-- 허용 매칭은 좁게 — 관계 주소는 **소유자가 본 주소 그대로**(소문자만, `+tag` 보존) (검증 V1 MINOR-2).
--
-- 무엇이 바뀌었나(앱 코드): 승인이 만드는 관계(`approval/service.relationshipsFor`)·seed(`identity/seed-contacts`)·
--   allowlist 가 `+tag` 를 자르지 않고 저장되고, 로더의 허용 매칭(관계·grant·allowlist)이 소문자 정확 일치가 됐다
--   (`policy-loader.comparableAddress`). 예전에는 소유자가 `Sales+EU@Corp.com` 을 승인하면 관계 행이
--   `sales@corp.com` 으로 저장돼 `sales@`·모든 `sales+*` 가 승인 없이 통과했다 — 소유자는 그 주소들을 본 적이 없다.
--   억제·차단(거부 쪽)은 그대로 넓다(`normalizeAddress`).
--
-- 이미 저장된 행은 어떻게 되나 — **판단:**
--   ① `approved` 관계 중 `+tag` 절단으로 저장된 행(그 관계를 만든 승인의 항목에 그 주소가 **정확히는** 없다)은,
--      항목에 있던 원래 주소로 관계 행을 **하나 더** 만든다(아래 INSERT). 소유자가 실제로 승인한 주소는 계속
--      승인 없이 나간다 — 정확 일치로 바뀌었다는 이유로 소유자에게 같은 상대를 다시 묻지 않는다.
--   ② 옛 절단형 행(`sales@corp.com`)은 **지우지도 고치지도 않는다.** 이 테이블은 UPDATE·DELETE 가 트리거로
--      막혀 있고(관계 이력은 "누가 무엇을 열었나" 의 기록이다), append-only 마이그레이션이 그 트리거를 끄고
--      이력을 고쳐 쓰는 선례를 만들지 않는다. 남는 넓이: 그 행은 이제 **정확히 `sales@` 하나만** 덮는다
--      (`sales+*` 는 더 이상 덮지 않는다). 폐기는 P5 의 `revoked_at` 경로다.
--   ③ seed 행·allowlist 의 절단형은 원래 입력이 저장돼 있지 않아 되살릴 수 없다 — 그대로 두면 태그 달린 원래
--      주소는 좁은 쪽(승인 대기·목록 밖)으로 떨어진다. 안전 방향이다.
--   운영 DB 에는 해당 행이 없다(스택 미배포 — `docs/runbooks/deploy.md`). 이 파일은 개발·스테이징 DB 를 위한 것이다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

INSERT INTO sender_relationships
  (agent_id, scope, address, domain, thread_id, trust_category, granted_via_approval_id, granted_by, domain_scope_confirmed_by)
SELECT DISTINCT r.agent_id, r.scope, x.exact, NULL::text, r.thread_id, 'approved'::trust_category,
       r.granted_via_approval_id, r.granted_by, NULL::text
  FROM sender_relationships r
  JOIN approval_request_items i ON i.approval_id = r.granted_via_approval_id
  CROSS JOIN LATERAL (SELECT lower(btrim(u)) AS exact FROM unnest(i.recipients) AS u) x
 WHERE r.trust_category = 'approved'
   AND r.scope IN ('recipient', 'thread')
   AND (r.scope = 'recipient' OR i.thread_id = r.thread_id)
   AND x.exact ~ '^[^@[:space:]]+@[^@[:space:]]+$'
   AND x.exact <> r.address
   -- `normalizeAddress` 의 절단 규칙 그대로: 로컬파트의 첫 `+` 가 맨 앞이 아닐 때만 자른다.
   AND position('+' IN split_part(x.exact, '@', 1)) > 1
   AND split_part(split_part(x.exact, '@', 1), '+', 1) || '@' || split_part(x.exact, '@', 2) = r.address
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN sender_relationships.address IS
  '허용 판정 키 — 소문자화만 한 주소(`+tag` 보존, policy-loader.comparableAddress). 로더는 정확 일치로만 매칭한다. 202609230640 이전의 행은 `+tag` 절단형일 수 있다(그 행은 절단형 주소 하나만 덮는다).';
