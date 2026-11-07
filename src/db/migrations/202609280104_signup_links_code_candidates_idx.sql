-- atmark:no-transaction
-- 202609280104_signup_links_code_candidates_idx.sql
-- 가입 코드 보안 검토(2026-09-28 L4) — 가입 코드 verify 의 후보 찾기(`admin/session.ts` `verifySignupCode`: 이 브라우저 결속 · 쓰지 않음 ·
-- 보낸 메일 · 최신 순)를 받치는 부분 색인.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — 가입 링크 표에 쓰기를 막지 않고 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS signup_links_code_candidates_idx ON signup_links (browser_binding, created_at DESC) WHERE used_at IS NULL AND status = 'sent';
