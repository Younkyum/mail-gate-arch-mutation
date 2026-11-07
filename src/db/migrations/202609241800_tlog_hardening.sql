-- 202609241800_tlog_hardening.sql
-- ADR-0008 투명성 로그 — 적대적 검증 결함 수정(2026-09-24, 배포 전). 202609241600 을 고치지 않고 위에 얹는다(적용 이력의 체크섬을 지킨다).
--
--   ① 키 행(M1): 롤마다 넣을 수 있는 목적이 하나다 — `atmark_tlog` 는 `checkpoint` 만, `atmark_tlog_anchor` 는 `anchor` 만. 앵커 과제(외부 응답을
--      파싱한다)가 체크포인트 목적의 키 행을 넣어 콘솔·번들의 vkey 를 오염시키지 못한다. 키 행의 모양도 DB 가 다시 계산해 본다:
--      checkpoint = C2SP vkey(이름+키id+base64(0x01‖공개키)) · 키 id = SHA-256(이름‖0x0A‖0x01‖공개키)[:4] · 키 자료 = 공개키 칸;
--      anchor = `ecdsa-p256:` ‖ hex(SHA-256(SPKI)). 에폭은 `checkpoint` 목적의 키로만 서명된다.
--   ② origin: 체크포인트 첫 줄 = 서명 키 이름(C2SP 관례) — 운영 값을 SQL 에 박지 않는다(스테이징은 다른 origin, 런북 §3). 대신 **한 DB 의
--      에폭은 origin 이 바뀌지 않는다**(바꾸려면 새 로그 — 새 DB 다).
--   ③ 앵커 상태(M2): OTS 의 끝은 `bitcoin_claimed`(캘린더가 Bitcoin 증명을 붙였다 — 블록 헤더 대조 전)다. `confirmed` 는 Rekor 만 —
--      고정한 샤드 키로 Rekor 체크포인트 서명을 확인했을 때다. 새 모양 CHECK 는 NOT VALID 다: 로컬 DB 에는 이 규칙 전의 OTS `confirmed`
--      행(테스트 실행 흔적)이 있다. 운영에는 앵커 행이 없다(배포 전). 새로 쓰는 행은 모두 새 모양을 지킨다.

-- ---------------------------------------------------------------------------
-- ① 키 행
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_keys ADD CONSTRAINT tlog_keys_shape CHECK (
  CASE purpose
    WHEN 'checkpoint' THEN
      length(public_key) = 32
      AND key_id ~ '^[^[:space:]+]+\+[0-9a-f]{8}\+[A-Za-z0-9+/]{44}$'
      AND decode(substring(key_id FROM '^[^+]+\+[0-9a-f]{8}\+(.*)$'), 'base64') = '\x01'::bytea || public_key
      AND substring(sha256(convert_to(split_part(key_id, '+', 1), 'UTF8') || '\x0a01'::bytea || public_key) FROM 1 FOR 4)
          = decode(split_part(key_id, '+', 2), 'hex')
    WHEN 'anchor' THEN
      key_id = 'ecdsa-p256:' || encode(sha256(public_key), 'hex')
  END);

CREATE OR REPLACE FUNCTION tlog_keys_purpose_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (current_user = 'atmark_tlog' AND NEW.purpose <> 'checkpoint')
     OR (current_user = 'atmark_tlog_anchor' AND NEW.purpose <> 'anchor') THEN
    RAISE EXCEPTION 'tlog_keys: 롤 % 는 목적 % 의 키를 넣을 수 없다', current_user, NEW.purpose USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_keys_purpose_guard BEFORE INSERT ON tlog_keys FOR EACH ROW EXECUTE FUNCTION tlog_keys_purpose_guard();

-- ---------------------------------------------------------------------------
-- ② 에폭 — origin = 서명 키 이름 · origin 불변 · 체크포인트 목적의 키
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_epochs DROP CONSTRAINT tlog_epochs_checkpoint_shape;
ALTER TABLE tlog_epochs ADD CONSTRAINT tlog_epochs_checkpoint_shape CHECK (
  split_part(checkpoint, E'\n', 1) = split_part(key_id, '+', 1)
  AND split_part(checkpoint, E'\n', 1) ~ '^[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$'
  AND split_part(checkpoint, E'\n', 2) = (epoch + 1)::text
  AND split_part(checkpoint, E'\n', 3) = encode(global_root, 'base64'));

-- 202609241600 의 연속·시각·게시 규칙 그대로 + origin 불변 + 서명 키 목적.
CREATE OR REPLACE FUNCTION tlog_epochs_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last record;
BEGIN
  SELECT epoch, closed_at, checkpoint INTO last FROM tlog_epochs ORDER BY epoch DESC LIMIT 1;
  IF (last.epoch IS NULL AND NEW.epoch <> 0) OR (last.epoch IS NOT NULL AND NEW.epoch <> last.epoch + 1) THEN
    RAISE EXCEPTION 'tlog_epochs: 에폭은 연속이어야 한다 (받음 %)', NEW.epoch USING ERRCODE = '23514';
  END IF;
  IF last.closed_at IS NOT NULL AND NEW.closed_at <= last.closed_at THEN
    RAISE EXCEPTION 'tlog_epochs: 마감 시각은 앞으로만 간다' USING ERRCODE = '23514';
  END IF;
  IF last.checkpoint IS NOT NULL AND split_part(NEW.checkpoint, E'\n', 1) <> split_part(last.checkpoint, E'\n', 1) THEN
    RAISE EXCEPTION 'tlog_epochs: origin 은 바뀌지 않는다 (% → %)', split_part(last.checkpoint, E'\n', 1), split_part(NEW.checkpoint, E'\n', 1)
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tlog_keys k WHERE k.key_id = NEW.key_id AND k.purpose = 'checkpoint') THEN
    RAISE EXCEPTION 'tlog_epochs: 체크포인트 목적의 키로만 서명한다' USING ERRCODE = '23514';
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'tlog_epochs: 게시 표시는 게시 뒤에' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ③ 앵커 상태 — OTS: submitted → bitcoin_claimed · Rekor: pending → confirmed
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_anchors DROP CONSTRAINT tlog_anchors_state_check;
ALTER TABLE tlog_anchors ADD CONSTRAINT tlog_anchors_state_check
  CHECK (state IN ('pending', 'submitted', 'bitcoin_claimed', 'confirmed', 'failed'));
ALTER TABLE tlog_anchors DROP CONSTRAINT tlog_anchors_state_shape;
ALTER TABLE tlog_anchors ADD CONSTRAINT tlog_anchors_state_shape CHECK (
  CASE state
    WHEN 'pending' THEN receipt IS NULL AND upgraded IS NULL AND confirmed_at IS NULL
    WHEN 'failed' THEN receipt IS NULL AND upgraded IS NULL AND confirmed_at IS NULL
    WHEN 'submitted' THEN target = 'opentimestamps' AND receipt IS NOT NULL AND receipt_at IS NOT NULL AND upgraded IS NULL AND confirmed_at IS NULL
    WHEN 'bitcoin_claimed' THEN target = 'opentimestamps' AND receipt IS NOT NULL AND receipt_at IS NOT NULL AND upgraded IS NOT NULL
                                AND confirmed_at IS NULL
    WHEN 'confirmed' THEN target = 'rekor' AND receipt IS NOT NULL AND receipt_at IS NOT NULL AND upgraded IS NULL AND confirmed_at IS NOT NULL
  END) NOT VALID;

CREATE OR REPLACE FUNCTION tlog_anchors_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected bytea;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT sha256(convert_to(checkpoint, 'UTF8')) INTO expected FROM tlog_epochs WHERE epoch = NEW.epoch;
    IF expected IS NULL OR NEW.digest <> expected THEN
      RAISE EXCEPTION 'tlog_anchors: digest 는 그 에폭 체크포인트의 SHA-256 이어야 한다' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR NEW.receipt IS NOT NULL THEN
      RAISE EXCEPTION 'tlog_anchors: 새 앵커는 대기 상태다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.endpoint IS DISTINCT FROM OLD.endpoint OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tlog_anchors: 앵커의 대상은 바뀌지 않는다' USING ERRCODE = '23514';
  END IF;
  IF (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
     OR (OLD.receipt_at IS NOT NULL AND NEW.receipt_at IS DISTINCT FROM OLD.receipt_at)
     OR (OLD.upgraded IS NOT NULL AND NEW.upgraded IS DISTINCT FROM OLD.upgraded) THEN
    RAISE EXCEPTION 'tlog_anchors: 영수증은 한 번만 쓴다' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('confirmed', 'bitcoin_claimed', 'failed')
     OR NOT ((OLD.state, NEW.state) IN (('pending', 'pending'), ('pending', 'submitted'), ('pending', 'confirmed'), ('pending', 'failed'),
                                        ('submitted', 'submitted'), ('submitted', 'bitcoin_claimed'))) THEN
    RAISE EXCEPTION 'tlog_anchors: 상태 전이 % → % 는 허용되지 않는다', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
