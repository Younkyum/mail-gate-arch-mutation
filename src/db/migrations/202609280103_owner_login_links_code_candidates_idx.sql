-- atmark:no-transaction
-- 202609280103_owner_login_links_code_candidates_idx.sql
-- 로그인 코드 보안 검토(2026-09-28 L4) — 코드 verify 의 후보 찾기(`admin/session.ts` `lockLoginCodeCandidates`: 이 브라우저 결속 · 쓰지 않음 ·
-- 무효화 전 · 보낸 메일 · 최신 순)를 받치는 부분 색인. 쓰인·무효화된·안 보낸 행은 색인에 들어가지 않는다.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — 로그인 링크 표에 쓰기를 막지 않고 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS owner_login_links_code_candidates_idx ON owner_login_links (browser_binding, created_at DESC) WHERE used_at IS NULL AND invalidated_at IS NULL AND status = 'sent';
