-- 202609241700_message_snippet_retention.sql
-- 2026-09-24 검증 F3 — `messages.snippet`(발신 본문 앞 512자, US-004)이 **영원히** 남았다. 홈 개인정보 문구는 "메일 본문은 1년 뒤
-- 삭제" 라고 말하고(S3 `outbound/content/*` 는 수명주기 365일, US-008), 스니펫은 본문의 일부다 — 문구와 저장이 어긋났다.
--
-- 이 파일이 하는 일 셋:
--
--   ① 부분 인덱스 — `snippet IS NOT NULL` 인 행의 `created_at`. 스윕(`src/db/repositories/snippet-retention.ts`)이 5분마다
--      "365일 넘은, 스니펫이 남은 행" 을 찾는다. 인덱스가 없으면 그 질의가 매번 `messages` 전체를 훑는다. 스윕이 비운 행은
--      인덱스에서 빠지므로 인덱스는 "아직 비울 것이 남은 행" 만큼만 자란다.
--
--   ② 앱 롤에 `snippet` **한 칸만** UPDATE 를 준다. 스윕은 TTL 스위퍼(approval-expiry Lambda — 앱 롤)가 돈다. 새 DB 롤·새 비밀을
--      만드는 대신 기존 스케줄 워커에 얹었다 — 그 대가가 "api Lambda(같은 앱 롤)도 이 칸을 UPDATE 할 수 있다" 이고, ③ 이 그
--      대가를 "365일 넘은 행의 스니펫을 **지우는 것**" 으로만 좁힌다(어차피 지워질 값이다).
--
--   ③ **가드 트리거(모든 롤).** 컬럼 단위 권한은 "무엇을" 바꿀지만 막고 "어떻게" 는 막지 못한다 — `snippet` UPDATE 권한만으로는
--      앱 롤이 스니펫을 아무 문자열로 바꿔 관리 콘솔의 발신 로그(소유자가 보는 "무엇을 보냈는가")를 위조할 수 있다. 그래서:
--        - 스니펫은 **NULL 로만** 바뀐다(다른 값으로 바꾸기·NULL 에서 되살리기 금지).
--        - 그리고 그 행이 **365일보다 오래됐을 때만**(`created_at` 은 불변 — `messages_identity_immutable`). 보존 기간 안의
--          스니펫은 누구도(소유자 롤 포함) 지우지 못한다 — 로그가 조용히 비지 않게.
--      `agent_api_keys_last_used_at_forward_only`(202609241400)와 같은 이유로 롤을 가리지 않는다.
--
-- 거부된 시도(`status='denied'`)의 스니펫도 같은 규칙이다 — 스니펫은 관문 **전**(prepare)에 INSERT 로 들어가고, 거부 뒤에
-- 지우려면 관문의 거부 경로(`gate-chokepoint`)를 고쳐야 한다. 그 행은 소유자 자신의 에이전트가 시도한 메일이고 소유자만 본다
-- (ADR-0006 "US-004 추가" 잔여 위험). 365일 스윕은 상태와 무관하게 비운다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① 스윕 인덱스 — 비울 것이 남은 행만
-- ---------------------------------------------------------------------------
CREATE INDEX messages_snippet_retention_idx ON messages (created_at) WHERE snippet IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ② 앱 롤 — `snippet` 한 칸만
-- ---------------------------------------------------------------------------
GRANT UPDATE (snippet) ON messages TO atmark_app;

-- ---------------------------------------------------------------------------
-- ③ 가드 — NULL 로만, 365일 넘은 행만 (모든 롤)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messages_snippet_retention_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snippet IS DISTINCT FROM OLD.snippet THEN
    IF NEW.snippet IS NOT NULL THEN
      RAISE EXCEPTION 'messages.snippet can only be cleared (id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF OLD.created_at >= now() - interval '365 days' THEN
      RAISE EXCEPTION 'messages.snippet can only be cleared after the 365-day retention (id=%, created_at=%)', OLD.id, OLD.created_at
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_snippet_retention_only
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_snippet_retention_only();
