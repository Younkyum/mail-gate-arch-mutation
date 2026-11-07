-- 202609260125_scheduled_send_console_cancel.sql
-- 메일 기본기 1차 2회차 Y2 — **콘솔 예약 취소**(진윤겸 결정 2026-09-26, `.omc/handoffs/mail-basics-fix2.md`).
--
-- owner·admin 은 콘솔에서 조직의 어떤 예약이든 취소할 수 있다 — `agent_cancellable = false`(보호 예약)도, 상한 없이. 에이전트 경로(http·mcp)는
-- 그대로다: 보호 예약은 403, 에이전트당 시간당 5건(부분 색인 `scheduled_sends_agent_cancel_idx` 의 술어 `cancelled_via IN ('http','mcp')` —
-- 콘솔 취소는 그 색인에도, 그 상한에도 들지 않는다. 202609260108 머리말이 예고한 그대로다).
--
--   ① `cancelled_via` CHECK 에 `console` 을 더한다. **같은 이름으로** 지우고 다시 더한다(한 트랜잭션 — 제약이 없는 틈이 없다). 이름이 같으므로
--      `REQUIRED_GUARDS`(`constraint:scheduled_sends.scheduled_sends_cancelled_via_check`)는 그대로다. 새 제약은 `NOT VALID` 로 더하고
--      기존 행 검증은 202609260126 의 `VALIDATE CONSTRAINT` 가 한다(0105·0106 과 같은 규율 — ACCESS EXCLUSIVE 아래에서 표를 훑지 않는다).
--      모양 CHECK(`scheduled_sends_cancelled_shape`)는 경로 **값**을 적지 않는다(`cancelled` 이면 경로가 NOT NULL 일 것만 본다) — `console` 행도
--      그대로 맞으므로 바꾸지 않는다(바꾸면 같은 잠금을 한 번 더 잡을 뿐이다).
--   ② SECURITY DEFINER 함수 `console_cancel_scheduled_send(조직, 예약, 사유, 메모)` 하나 — admin 롤의 **유일한** 예약 쓰기 길이다.
--      칼럼 UPDATE GRANT 를 고르지 않은 이유(최소 권한):
--        - 칼럼 GRANT 라면 admin 에 `status` 와 취소 칼럼 넷의 UPDATE, 판정에 필요한 `lease_expires_at` SELECT 를 줘야 한다. 그러면 admin 롤을
--          쥔 쪽이 `cancelled_via = 'http'|'mcp'` 로 적어 **에이전트 경로를 위조**하거나(감사 의미가 뒤집히고, 에이전트 시간당 상한을 채워
--          에이전트의 정당한 취소를 막는다) 다른 조직의 예약을 WHERE 만 바꿔 취소할 수 있다. 모양 CHECK·종단 가드는 이것을 막지 못한다.
--        - 함수는 경로를 **리터럴 `'console'`** 로 적고, 상태 전이를 `scheduled → cancelled` 하나로, 대상을 `agents.organization_id = 조직` 인
--          행으로 묶는다. admin 롤은 표 권한 0 을 늘리지 않고 EXECUTE 하나만 얻는다(`RESTRICTED_ROLE_GRANTS[atmark_admin]`).
--      판정 순서는 에이전트 경로(`scheduled-send-store.ts` `cancel`)와 같다: 없음(다른 조직 포함) → 이미 취소(재생) → 발송됨 → 임대 중이거나
--      `scheduled:{id}` 발송행 있음 → 취소. 보호 플래그·시간당 상한 단계가 없다(소유자 경로). 행은 `FOR UPDATE` 로 잡는다 — 워커의
--      `claimDue`(`SKIP LOCKED`)·`markDispatched`(`status = 'scheduled'` 펜싱)와의 경합은 에이전트 경로와 같게 닫힌다. 시각은 DB `now()` 다
--      (호출자가 취소 시각을 고르지 못한다).
--      **조직 인자는 인가가 아니라 범위다**: 호출자(admin 롤)가 넘기는 값이다. 인가(세션 → 조직 · 역할 owner|admin)는 라우트
--      (`src/admin/routes/scheduled.ts` · 라우터 표)가 먼저 한다 — `disable_webhook_endpoint`(202609260115)의 짝 검사와 같은 위치다.
--      사유·메모의 모양은 표 CHECK(0105)가 그대로 본다. 쓰기 1회 트리거·불변 핵심·종단 가드도 정의자 롤에 그대로 선다.
--      `search_path` 는 `pg_catalog, public, pg_temp`(pg_temp **마지막** — migrate `status` 의 `unsafeSecurityDefiners` 가 본다), PUBLIC 실행 불가.
--   ③ 감사는 이 파일에 없다 — 라우트가 같은 트랜잭션에서 `owner_actions` 한 행(`scheduled.cancel`, `target_id` = 예약 id)을 적는다(`audited`).
--
-- 롤백 호환: 옛 코드는 이 함수를 부르지 않는다. 옛 콘솔 로그는 `console` 경로를 모르는 값으로 보고 `null` 로 보인다(취소 상태·사유는 보인다).

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_admin') THEN
    RAISE EXCEPTION
      'role atmark_admin does not exist; provision the admin role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- ① 경로 CHECK — console 추가(같은 이름 · NOT VALID, 검증은 202609260126)
-- ---------------------------------------------------------------------------

ALTER TABLE scheduled_sends
  DROP CONSTRAINT scheduled_sends_cancelled_via_check,
  ADD CONSTRAINT scheduled_sends_cancelled_via_check CHECK (
    cancelled_via IS NULL OR cancelled_via IN ('http', 'mcp', 'console')) NOT VALID;

COMMENT ON COLUMN scheduled_sends.cancelled_via IS
  '취소 경로(http|mcp = 에이전트 토큰, console = 소유자 콘솔) — 라우터·정의자 함수가 리터럴로 정한다. 누가(토큰·세션) 취소했는지는 적지 않는다(콘솔은 owner_actions 가 적는다).';

-- ---------------------------------------------------------------------------
-- ② 콘솔 취소 — SECURITY DEFINER 하나(admin 만 EXECUTE)
-- ---------------------------------------------------------------------------

CREATE FUNCTION console_cancel_scheduled_send(p_organization_id uuid, p_schedule_id uuid, p_reason_code text, p_note text)
RETURNS TABLE (outcome text, result_cancelled_at timestamptz, result_reason_code text, result_cancelled_via text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target record;
  v_cancelled_at timestamptz;
  v_reason_code text;
  v_cancelled_via text;
BEGIN
  SELECT s.id, s.status::text AS status, s.cancelled_at, s.cancel_reason_code, s.cancelled_via,
         (s.lease_expires_at IS NOT NULL AND s.lease_expires_at > now()) AS lease_active,
         EXISTS (SELECT 1 FROM public.messages m WHERE m.agent_id = s.agent_id AND m.idempotency_key = 'scheduled:' || s.id::text)
           AS send_row_exists
    INTO target
    FROM public.scheduled_sends s
    JOIN public.agents a ON a.id = s.agent_id
   WHERE s.id = p_schedule_id AND a.organization_id = p_organization_id
     FOR UPDATE OF s;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF target.status = 'cancelled' THEN
    RETURN QUERY SELECT 'replayed'::text, target.cancelled_at, target.cancel_reason_code, target.cancelled_via;
    RETURN;
  END IF;
  IF target.status = 'dispatched' THEN
    RETURN QUERY SELECT 'already_dispatched'::text, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF target.lease_active OR target.send_row_exists THEN
    RETURN QUERY SELECT 'in_flight'::text, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;
  UPDATE public.scheduled_sends s
     SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = p_reason_code, cancel_note = p_note, cancelled_via = 'console'
   WHERE s.id = p_schedule_id AND s.status = 'scheduled'
  RETURNING s.cancelled_at, s.cancel_reason_code, s.cancelled_via INTO v_cancelled_at, v_reason_code, v_cancelled_via;
  -- 행을 쥐고 있으므로 0행일 수 없다 — 있으면 판정 순서가 깨진 것이라 던진다(조용히 성공처럼 보이지 않게).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'console cancel of scheduled send % changed no row', p_schedule_id USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT 'cancelled'::text, v_cancelled_at, v_reason_code, v_cancelled_via;
END;
$$;

COMMENT ON FUNCTION console_cancel_scheduled_send(uuid, uuid, text, text) IS
  '콘솔 예약 취소(메일 기본기 1차 Y2) — 조직의 scheduled 예약을 cancelled_via=console 로 취소한다(보호 예약 포함 · 상한 없음). 결과: not_found|replayed|already_dispatched|in_flight|cancelled. 조직 인자는 범위(인가는 라우트). admin 롤만 EXECUTE.';

REVOKE ALL ON FUNCTION console_cancel_scheduled_send(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_cancel_scheduled_send(uuid, uuid, text, text) TO atmark_admin;
