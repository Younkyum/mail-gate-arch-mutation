-- 202609241320_outbound_body_reference.sql
-- US-004 — 발신 로그 상세가 "무엇을 보냈는가" 를 보이게 한다.
--
-- 원인(2026-09-24 운영 읽기 전용 확인 + 코드): 발신 본문은 **처음부터 S3 에 있었다** — 발송 앞단(`outbound-service.proceed`)이
-- `outbound/content/{messages.id}.json`(제목·text·html·회신 헤더, `api/content-store.ts`)에 write-once 로 쓴다. 승인 릴리스가
-- 몇 시간 뒤 같은 본문을 읽는 경로가 그것이다. 그런데 `messages` 행은 그 위치를 **기록하지 않았다** — `snippet`·`body_storage_key`
-- 는 P1a 부터 칸만 있고 어느 INSERT 도 채우지 않았다. 관리 콘솔은 S3 권한이 0 이라(ADR-0006) 본문을 읽을 길도 없었다.
--
-- 이 파일이 하는 일:
--   ① **키 모양을 id 에 묶는다.** 발신 행의 `body_storage_key` 는 NULL 이거나 정확히 `outbound/content/{id}.json` 이다. 관리 로그
--      상세는 조직 범위로 고른 행의 이 칸으로 S3 를 읽는다 — 이 CHECK 가 없으면 행에 쓸 수 있는 쪽(앱 롤: messages INSERT)이
--      다른 조직 발송의 본문 키를 적어 관리 콘솔로 그 본문을 읽게 만들 수 있다. 앱 롤에는 이 칸의 UPDATE 가 없다(202609230750 —
--      컬럼 단위 UPDATE 목록 밖). INSERT 시점의 값만 있고, 그 값은 이 CHECK 를 지나야 한다.
--   ② **이미 나간 발송을 잇는다.** 관문을 지난 발신 행(`audit_logs` 가 있는 행)은 본문 쓰기가 끝난 뒤에만 관문에 닿는다
--      (`proceed`: put → 관문). 그 행들의 `body_storage_key` 를 채운다 — 객체는 이미 있다. 관문 전 행(audit 없음 — 본문 쓰기가
--      실패했을 수 있다)은 건드리지 않는다. `snippet` 은 SQL 로 만들 수 없다(본문이 S3 에만 있다) — 옛 행은 NULL 로 남고,
--      상세는 S3 본문을 직접 보인다.
--
-- 새 GRANT 는 없다: `atmark_admin` 은 `messages`·`ses_events` 에 테이블 단위 SELECT 가 이미 있다(202609230720). 앱 롤은
-- `messages` INSERT 가 테이블 단위다(202609230750) — `snippet`·`body_storage_key` 를 INSERT 에 싣는 데 추가 권한이 필요 없다.
-- 본문 전체는 여전히 Postgres 에 없다(§5.2 V5 — 칸 추가 없음, `snippet` 512자 CHECK 그대로).

UPDATE messages m
   SET body_storage_key = 'outbound/content/' || m.id::text || '.json'
 WHERE m.direction = 'outbound'
   AND m.body_storage_key IS NULL
   AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.message_id = m.id);

ALTER TABLE messages
  ADD CONSTRAINT messages_outbound_body_key_is_own
  CHECK (direction <> 'outbound' OR body_storage_key IS NULL OR body_storage_key = 'outbound/content/' || id::text || '.json');
