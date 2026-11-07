-- 202610131610_owner_actions_operator_actor.sql
-- 감사 행위자 셋째 — **운영자 · 시스템**(2026-10-13 보안 후속: #92 L1 운영자 CLI 지속 행위자 · 공유 도메인 평판 자동 동결의 감사).
--
-- 무엇이 모자랐나: `owner_actions` 는 소유자 세션 또는 조직 API 키 행위자만 받았다(`owner_actions_one_actor`, 202609250160). 운영자 CLI
-- (`admin:agent-delete`)의 삭제는 DB 에 행위자 · 사유가 남지 않아 운영 노트에 손으로 옮겨 적었고, 플랫폼이 스스로 거는 조직 동결(공유 도메인 평판 —
-- 202610131620)은 적을 감사 칸이 없었다. `ops_actions` 는 호스팅 콘솔 티켓 원장이라(운영자 세션 · 행위 허용 목록 · 투명성 로그 밖) 고르지 않았다 —
-- `owner_actions` 는 조직의 투명성 로그(`owner.action` 잎)로 이미 이어진다. 조직 소유자가 "운영자 · 플랫폼이 내 조직에 한 일" 을 자기 로그에서 본다.
--
--   ① 칸 둘 — `operator_actor`(`admin:<명령>:<운영자>` · `system:<원인>`) · `operator_reason`(한 줄 사유 · 판정 근거). 둘 다 있거나 둘 다 없다.
--   ② `owner_actions_one_actor` 를 세 칸 중 정확히 하나로 다시 세운다(NOT VALID — 검증은 202610131611). 같은 이름이라 가드 목록은 그대로다.
--   ③ 가드 트리거 `owner_actions_operator_actor_guard` — 운영자 행위자 행은 **표 소유자 롤로 도는 문장만** 적는다(운영자 CLI = 소유자 롤 접속 ·
--      플랫폼 동결 = 소유자의 정의자 함수). admin 롤(표 전체 INSERT)과 앱 롤은 운영자 · 시스템을 사칭한 감사 행을 적지 못한다(42501).
--   ③-2 **서열기 능력 표**(적대 검토 M-1) `tlog_capabilities` — 새 서열기가 틱마다 정의자 `atmark_tlog_record_capabilities` 로 "나는 운영자 행위자를
--      잎으로 옮길 수 있다"(`owner_action_operator_actor`)를 적는다. 가드 트리거는 운영자 행위자 행을 **그 능력이 적힌 뒤에만** 받는다(아니면 55000).
--      옛 서열기는 운영자 행위자 행을 잎 모양으로 옮기지 못해 되돌릴 수 없는 `source.missing(unrepresentable)` 잎을 커밋한다 — 배포 순서를 어겨도
--      그런 행이 생기지 않게 DB 가 막는다. 표는 소유자 롤 · 정의자만(런타임 롤 권한 0, 능력 이름은 닫힌 목록).
--   ④ 권한: `atmark_tlog` SELECT(operator_actor, operator_reason) — 서열기가 잎의 `c.operator` 커밋 재료로 읽는다(평문 없음).
--      `atmark_admin` SELECT(operator_actor) — 콘솔 로그가 행위자 **종류**(운영자 · 시스템)만 가른다(문자열은 화면에 보내지 않는다).
--      `atmark_ops` SELECT(operator_actor, operator_reason) — 호스팅 운영자 콘솔 감사 화면의 "누가 · 왜".
--
-- **배포 순서(deploy §54):** 이 파일 → `AtmarkTransparency`(서열기가 새 칸을 읽고 `c.operator` 잎을 만든다) → compute. 운영자 행위자 행은 새 CLI 와
-- 새 compute(평판 동결)만 만든다 — 새 서열기가 올라가기 전에는 그 둘을 돌리지 않는다(옛 서열기는 행위자 없는 행에서 잎을 만들지 못해 배치를 되돌린다).
-- 옛 코드(세션 · 키만 적음)는 이 뒤에도 그대로 돈다 — expand 전용. 잠금: 칸 추가(기본값 없음 — 행을 다시 쓰지 않는다) · CHECK 셋 NOT VALID ·
-- 트리거 하나 · GRANT. 5초.

SET LOCAL lock_timeout = '5s';

ALTER TABLE owner_actions ADD COLUMN operator_actor text;
ALTER TABLE owner_actions ADD COLUMN operator_reason text;

ALTER TABLE owner_actions
  ADD CONSTRAINT owner_actions_operator_shape CHECK (
    (operator_actor IS NULL) = (operator_reason IS NULL)
    AND (operator_actor IS NULL OR (operator_actor ~ '^(admin|system):[a-z0-9_.-]{1,60}(:[^[:cntrl:]]{1,100})?$' AND length(operator_actor) <= 200))
    AND (operator_reason IS NULL OR (length(operator_reason) BETWEEN 1 AND 600 AND operator_reason !~ '[[:cntrl:]]'))) NOT VALID;

ALTER TABLE owner_actions DROP CONSTRAINT owner_actions_one_actor;
ALTER TABLE owner_actions
  ADD CONSTRAINT owner_actions_one_actor CHECK (num_nonnulls(session_id, org_api_key_id, operator_actor) = 1) NOT VALID;

COMMENT ON COLUMN owner_actions.operator_actor IS
  '운영자 · 시스템 행위자(202610131610) — admin:<명령>:<운영자> | system:<원인>. session_id · org_api_key_id 와 정확히 하나. 표 소유자 롤 문장만 적는다(가드 트리거). 잎에는 c.operator 커밋으로만.';
COMMENT ON COLUMN owner_actions.operator_reason IS
  '운영자 행위의 한 줄 사유 · 시스템 행위의 판정 근거(202610131610). operator_actor 와 함께만. 잎에는 c.operator 커밋으로만.';

CREATE TABLE tlog_capabilities (
  capability   text PRIMARY KEY CHECK (capability IN ('owner_action_operator_actor')),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  -- 거둔 시각(재검증 R-2) — 서열기를 되돌리기 전에 운영자가 소유자 롤로 `UPDATE … SET revoked_at = now()`. 기록 정의자는 이 행을 **되살리지 않는다**
  -- (ON CONFLICT DO NOTHING — 옛 · 새 서열기 어느 쪽 틱도 거둔 능력을 다시 켜지 못한다). 다시 켜는 것은 운영자의 의도된 행위뿐이다:
  -- 소유자 롤 `UPDATE tlog_capabilities SET revoked_at = NULL WHERE capability = 'owner_action_operator_actor'`(deploy §54).
  revoked_at   timestamptz
);
REVOKE ALL ON tlog_capabilities FROM PUBLIC;
REVOKE ALL ON tlog_capabilities FROM atmark_app, atmark_admin, atmark_login_mailer, atmark_ops, atmark_tlog;
COMMENT ON TABLE tlog_capabilities IS
  '서열기 능력(202610131610 · 적대 검토 M-1 · 재검증 R-2) — 새 서열기가 틱마다 atmark_tlog_record_capabilities 로 적는다(거둔 행은 되살리지 않는다). owner_actions 의 운영자 행위자 행은 owner_action_operator_actor 가 적혀 있고 revoked_at IS NULL 일 때만(가드 55000).';

CREATE FUNCTION atmark_tlog_record_capabilities(p_capabilities text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.tlog_capabilities (capability)
  SELECT c FROM pg_catalog.unnest(p_capabilities) AS c
   WHERE c = 'owner_action_operator_actor'
  ON CONFLICT (capability) DO NOTHING
$$;
REVOKE ALL ON FUNCTION atmark_tlog_record_capabilities(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_tlog_record_capabilities(text[]) TO atmark_tlog;

CREATE FUNCTION owner_actions_operator_actor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.operator_actor IS NULL THEN
    RETURN NEW;
  END IF;
  -- current_user — 정의자 함수 안에서는 함수 소유자다(플랫폼 동결). 운영자 CLI 는 소유자 롤로 붙는다. admin · 앱 롤의 직접 INSERT 는 여기서 끊긴다.
  IF NOT pg_catalog.pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'owner_actions: operator/system actor rows are written only by the owner role' USING ERRCODE = '42501';
  END IF;
  -- 새 서열기가 아직 돌지 않았거나 운영자가 능력을 거뒀다(배포 · 되돌리기 — deploy §54). 옛 서열기는 이 행을 되돌릴 수 없는 source.missing 잎으로 만든다.
  -- FOR SHARE(최종 검증 F-1) — 이 INSERT 의 트랜잭션이 끝날 때까지 능력 행을 잡는다. 운영자의 거두기(UPDATE revoked_at)는 진행 중인 운영자 행 INSERT 가
  -- 커밋 · 롤백될 때까지 기다린다 — 거두기가 끝난 뒤에 보이지 않던 운영자 행이 새로 커밋되는 창이 없다.
  PERFORM 1 FROM public.tlog_capabilities t WHERE t.capability = 'owner_action_operator_actor' AND t.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner_actions: the transparency sequencer cannot represent operator actors yet — deploy AtmarkTransparency first (deploy §54)'
      USING ERRCODE = '55000', DETAIL = 'tlog_capability_missing';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION owner_actions_operator_actor_guard() FROM PUBLIC;

CREATE TRIGGER owner_actions_operator_actor_guard BEFORE INSERT ON owner_actions
  FOR EACH ROW EXECUTE FUNCTION owner_actions_operator_actor_guard();

GRANT SELECT (operator_actor, operator_reason) ON owner_actions TO atmark_tlog;
GRANT SELECT (operator_actor) ON owner_actions TO atmark_admin;
GRANT SELECT (operator_actor, operator_reason) ON owner_actions TO atmark_ops;
