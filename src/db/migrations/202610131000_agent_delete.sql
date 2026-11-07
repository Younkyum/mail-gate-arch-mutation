-- 202610131000_agent_delete.sql
-- 에이전트 삭제(진윤겸 결정 2026-10-13 — "별칭 삭제하는 로직이랑 동일하게. 어차피 기록은 계속 남고."). 콘솔 `POST /api/agents/{id}/delete`
-- (`src/admin/ops/agents.ts` `deleteAgentOp`)가 한 트랜잭션에서: `agents.status → 'disabled'` · 주소 **전부**(대표·앵커 포함) 폐기 · 토큰 전부 폐기 ·
-- 대기 중 예약 발송 취소 · 웹훅 끄기. 행은 지우지 않는다(받은 메일 · 로그 · 감사 · 투명성 잎 그대로). 이 파일은 그 DB 쪽 바닥이다.
--
--   ① CHECK `agent_addresses_primary_not_retired`(202609270110 ②)를 지운다 — CHECK 는 다른 표(agents)를 볼 수 없어 "삭제한 에이전트의 대표는
--      폐기할 수 있다" 를 말하지 못한다. 대신 ② 의 가드가 같은 규칙을 지킨다(대표는 **삭제한 에이전트일 때만** 폐기). 꺼지면 대표가 살아 있는
--      에이전트에서 빠진다 — 그래서 ② 의 트리거는 이미 `REQUIRED_GUARDS` 에 있고, ③ 이 새로 든다.
--   ② 폐기 가드 `agent_addresses_retire_guard` 재정의 — 202609291002 정의 그대로 + 대표 예외 한 줄: 그 에이전트가 `disabled` 면 대표도 폐기한다.
--      `disabled` 는 ③ 으로 종단이라 판정과 커밋 사이에 되살아나지 않는다. 재발급 규칙(같은 조직 곧바로 · 다른 조직 30일 — 보류 트리거
--      `agent_addresses_reissue_hold`)은 대표에도 이미 선다(202609291002 ②, 대표 INSERT 도 본다). search_path 고정(202609291003 L6)도 다시 건다
--      (CREATE OR REPLACE 는 함수 설정을 지운다).
--   ③ 트리거 `agents_disabled_terminal`(`BEFORE UPDATE OF status`) — 운영자가 정지한 에이전트 · 운영자 예약 주소(support@ 등)를 쥔 에이전트는 disabled 로 만들지 않는다(42501 —
--      그 주소는 운영자 허가 행이 있는 조직에만 다시 발급되므로 30일 뒤 남에게 가지는 않지만, 지원 창구를 소유자 콘솔이 끄지 못하게). 그리고
--      `disabled` 는 **되돌리지 않는다**(모든 롤 — 소유자 롤도. 운영 복구가 꼭
--      필요하면 런북이 트리거를 끄는 마이그레이션을 따로 낸다). admin 롤은 `UPDATE (status)` 를 가져 raw UPDATE 로 삭제한 에이전트를 되살려
--      폐기된 주소 없이 다시 보내게 할 수 있었다(삭제는 주소가 폐기된 뒤라 수신은 되살아나지 않지만, 요금제 한도를 비운 채 다시 쓴다).
--   ④ 트리거 `agents_disabled_identity_revoke`(`AFTER UPDATE OF status`, → disabled) — 공개 신원 폐기 요청(`passport_publish_requests`
--      kind `revoke`, 요청자 `system:agent_deleted`)을 넣는다. 정의자 함수다 — admin 롤은 revoke 를 넣지 못한다(202609241210 ④ 요청자 가드 —
--      콘솔 세션의 임의 revoke 를 막는 가드는 그대로 둔다: 이 길은 "삭제" 한 경로뿐이다). 게시(published)·게시 중단(suspended)인 여권만
--      (draft 는 공개된 적이 없다 — 폐기할 것이 없다). 우선 칸에 이미 대기 중인 요청(정지)이 있으면 그 요청을 기다리지 않고 건너뛴다 —
--      공개 조회의 `agent.status` 는 그때도 `revoked` 다(`src/passport/public-view.ts` — agents.status 를 읽는다). 그 정지 요청은 서명 워커가
--      처리할 때 폐기로 바뀐다(`src/passport/publisher.ts` `effectiveKind` — 삭제한 에이전트의 공개된 여권은 어떤 요청이든 폐기, draft 는 거부).
--   ⑤ 트리거 `approval_requests_reject_approve_disabled_agent`(`BEFORE UPDATE`, pending → approved) — 삭제한 에이전트의 승인은 승인되지
--      않는다(조직 정지 가드 202609230750 ⑦ 과 같은 모양). 앱은 삭제 때 대기 승인을 거두지 않는다(승인 표는 append-only 결정 원장이다) — 대신
--      승인이 막히고, 승인 링크·콘솔 승인은 이 가드에서 55000 으로 멈춘다. 발송 자체는 Stage 0(`status <> 'active'` → DENY)이 한 번 더 막는다.
--   ⑥ 정의자 함수 `console_cancel_agent_scheduled_sends(org, agent)` — 삭제한 에이전트의 대기 예약을 한 번에 취소한다(admin 롤은 예약 표에
--      UPDATE 가 없다 — 한 건 취소 함수 `console_cancel_scheduled_send` 와 같은 판정 · 같은 `cancelled_via = 'console'`).
--   ⑦ 트리거 `agent_addresses_reject_disabled_agent`(`BEFORE INSERT`) — 삭제한 에이전트에는 주소를 새로 붙이지 않는다(되살린 주소로 다시 받는 길).
--   ⑧ 트리거 `agent_api_keys_reject_disabled_agent` · `webhook_endpoints_reject_disabled_agent`(`BEFORE INSERT`) — 삭제한 에이전트에는 토큰 ·
--      웹훅을 새로 붙이지 않는다(보안 리뷰 HIGH-1 · MED-2 — 앱의 확인과 삭제 커밋 사이의 경합 · 옛 코드). 인증도 삭제한 에이전트의 토큰을 폐기로 읽는다.
--   웹훅은 기존 정의자 함수 `disable_webhook_endpoint` 를 엔드포인트마다 부른다(새 권한 없음). 토큰은 기존 `UPDATE (revoked_at)`.
--
-- 투명성: 상태 변경은 기존 잎(`agents_tlog_enqueue_update` — status 칸 변경), 주소 폐기는 기존 잎 `identity.address_retired`(대표 포함 —
-- 202609270115 의 WHEN 은 대표를 가리지 않는다). 새 잎 종류 없음.
--
-- 잠금: CHECK DROP(짧은 ACCESS EXCLUSIVE) · 함수 여덟 · 트리거 일곱. 5초 안에 못 잡으면 실패한다.
-- 롤백 호환: 옛 코드는 대표를 폐기하지 않고(앱 가드 `address_primary_not_retirable`) disabled 를 만들지 않는다 — 옛 코드가 이 파일 뒤에서 하는
-- 일은 그대로 돈다. 단 옛 migrate 번들의 status 는 지운 CHECK 를 `REQUIRED_GUARDS` 에서 찾으므로 **compute 배포 전까지 빨갛다**
-- (터널 `pnpm db:migrate` → `deploy-compute migrate=false` 사이 — 런북 deploy §50).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 대표 폐기 CHECK → ② 가드로
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_primary_not_retired;

-- ---------------------------------------------------------------------------
-- ② 폐기 가드 — 대표는 삭제한(disabled) 에이전트일 때만
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_addresses_retire_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent_addresses: 이미 폐기한 주소다 — retired_at 은 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.retired_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (OLD.is_primary OR NEW.is_primary)
     AND NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.id = OLD.agent_id AND a.status = 'disabled') THEN
    RAISE EXCEPTION 'agent_addresses: 대표 주소는 에이전트를 삭제할 때만 폐기한다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.is_primary IS DISTINCT FROM OLD.is_primary OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_addresses: 폐기 문장은 retired_at 만 바꾼다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_addresses_address:' || OLD.address, 0));
  NEW.retired_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ③ disabled 는 종단
-- ---------------------------------------------------------------------------

CREATE FUNCTION agents_disabled_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'disabled' AND NEW.status IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'agents: 삭제한(disabled) 에이전트는 되살리지 않는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  -- 운영자가 정지한 에이전트는 삭제하지 않는다(보안 재검토 L-3 — 모든 롤. 운영자 정지를 소유자 삭제로 우회하지 못한다 · admin 롤은 202609230750 ⑧ 이
  -- 이미 막는다). 운영자가 정지를 푼 뒤에 삭제한다. 앱이 먼저 409 `operator_suspension` 으로 막는다.
  IF NEW.status = 'disabled' AND OLD.status = 'suspended' AND OLD.suspended_by = 'operator' THEN
    RAISE EXCEPTION 'agents: 운영자가 정지한 에이전트는 삭제하지 않는다(id=%)', NEW.id USING ERRCODE = '42501';
  END IF;
  -- 운영자 예약 주소(support@ · onve@ · claude@ — `atmark_operator_assignable_addresses()`)를 쥔 에이전트는 삭제하지 않는다(보안 리뷰 MED-4 — 지원
  -- 창구가 소유자 콘솔 한 번으로 사라지지 않게). 운영자가 그 주소를 먼저 옮기거나 폐기한다. 앱이 먼저 409 `operator_reserved` 로 막는다.
  IF NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled' AND EXISTS (
       SELECT 1 FROM public.agent_addresses d
        WHERE d.agent_id = NEW.id AND d.retired_at IS NULL AND d.address = ANY (public.atmark_operator_assignable_addresses())) THEN
    RAISE EXCEPTION 'agents: 운영자 예약 주소를 쥔 에이전트는 삭제하지 않는다(id=%)', NEW.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_disabled_terminal BEFORE UPDATE OF status ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_disabled_terminal();

-- ---------------------------------------------------------------------------
-- ④ 삭제 → 공개 신원 폐기 요청
-- ---------------------------------------------------------------------------

CREATE FUNCTION agents_disabled_identity_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.passport_publish_requests (agent_id, kind, requested_by)
  SELECT p.agent_id, 'revoke', 'system:agent_deleted'
    FROM public.passports p
   WHERE p.agent_id = NEW.id AND p.superseded_at IS NULL AND p.status IN ('published', 'suspended')
   LIMIT 1
  ON CONFLICT (agent_id) WHERE status = 'pending' AND kind IN ('suspend', 'revoke') DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION agents_disabled_identity_revoke() FROM PUBLIC;

CREATE TRIGGER agents_disabled_identity_revoke AFTER UPDATE OF status ON agents
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM 'disabled' AND NEW.status = 'disabled')
  EXECUTE FUNCTION agents_disabled_identity_revoke();

-- ---------------------------------------------------------------------------
-- ⑤ 삭제한 에이전트의 승인은 승인되지 않는다
-- ---------------------------------------------------------------------------

-- 정의자 함수다 — 에이전트 행을 `FOR SHARE` 로 잡아 삭제(행을 NO KEY UPDATE 로 쥔다)와 줄 세운다(보안 리뷰 LOW — 판정 뒤 삭제 커밋 경합). 승인을 부르는
-- 앱 롤에는 agents UPDATE 칸이 없어 행 잠금을 잡을 수 없다(주지 않는다 — 최소 권한).
CREATE FUNCTION approval_requests_reject_approve_disabled_agent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  agent_status text;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    SELECT a.status::text INTO agent_status FROM public.agents a WHERE a.id = NEW.agent_id FOR SHARE;
    IF agent_status = 'disabled' THEN
      RAISE EXCEPTION 'approval % cannot be approved — the agent was deleted', NEW.id USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION approval_requests_reject_approve_disabled_agent() FROM PUBLIC;

CREATE TRIGGER approval_requests_reject_approve_disabled_agent
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_reject_approve_disabled_agent();

-- ---------------------------------------------------------------------------
-- ⑥ 삭제 → 대기 중 예약 발송 전부 취소(SECURITY DEFINER — admin 만 EXECUTE)
-- ---------------------------------------------------------------------------
-- 한 건 취소 함수(`console_cancel_scheduled_send`, 202609260125)와 같은 판정: `scheduled` 이고 임대(lease) 중이 아니며 발송 행이 없는 것만.
-- 임대 중·발송 행이 있는 예약(지금 나가는 중)은 건드리지 않는다 — 발송 경로의 Stage 0 이 `agent_not_active` 로 거부한다(에이전트가 이미
-- disabled). 에이전트가 disabled 가 **아니면** 아무것도 하지 않는다(0) — 이 함수는 삭제 트랜잭션 안에서만 뜻이 있다(인가는 라우트 · 조직
-- 인자는 범위). 돌려주는 값 = 취소한 수.

CREATE FUNCTION console_cancel_agent_scheduled_sends(p_organization_id uuid, p_agent_id char(32)) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.id = p_agent_id AND a.organization_id = p_organization_id AND a.status = 'disabled') THEN
    RETURN 0;
  END IF;
  UPDATE public.scheduled_sends s
     SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'owner_request', cancel_note = 'agent deleted', cancelled_via = 'console'
   WHERE s.agent_id = p_agent_id AND s.status = 'scheduled'
     AND NOT (s.lease_expires_at IS NOT NULL AND s.lease_expires_at > now())
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.agent_id = s.agent_id AND m.idempotency_key = 'scheduled:' || s.id::text);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION console_cancel_agent_scheduled_sends(uuid, char) IS
  '에이전트 삭제(202610131000) — 삭제한(disabled) 에이전트의 scheduled 예약을 cancelled_via=console · owner_request 로 전부 취소한다(임대 중·발송 행 있음 제외). disabled 가 아니면 0. admin 롤만 EXECUTE.';

REVOKE ALL ON FUNCTION console_cancel_agent_scheduled_sends(uuid, char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_cancel_agent_scheduled_sends(uuid, char) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ⑦ 삭제한 에이전트에는 주소를 새로 붙이지 않는다
-- ---------------------------------------------------------------------------
-- 앱(`requireLiveAgent` — 별칭 추가 · 대표 선택)이 먼저 409 `agent_deleted` 로 막는다. 이 트리거는 그 검사가 빠졌을 때의 바닥이다 — admin 롤은
-- `agent_addresses` INSERT 를 가져, 삭제한 에이전트에 주소를 다시 붙여 메일을 받게 할 수 있었다(모든 롤).

CREATE FUNCTION agent_addresses_reject_disabled_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents a WHERE a.id = NEW.agent_id AND a.status = 'disabled') THEN
    RAISE EXCEPTION 'agent_addresses: 삭제한(disabled) 에이전트에는 주소를 붙이지 않는다(agent=%)', NEW.agent_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_addresses_reject_disabled_agent BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_reject_disabled_agent();

-- ---------------------------------------------------------------------------
-- ⑧ 삭제한 에이전트에는 토큰 · 웹훅을 새로 붙이지 않는다
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_api_keys_reject_disabled_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents a WHERE a.id = NEW.agent_id AND a.status = 'disabled') THEN
    RAISE EXCEPTION 'agent_api_keys: 삭제한(disabled) 에이전트에는 토큰을 붙이지 않는다(agent=%)', NEW.agent_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_api_keys_reject_disabled_agent BEFORE INSERT ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_reject_disabled_agent();

CREATE FUNCTION webhook_endpoints_reject_disabled_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents a WHERE a.id = NEW.agent_id AND a.status = 'disabled') THEN
    RAISE EXCEPTION 'webhook_endpoints: 삭제한(disabled) 에이전트에는 웹훅을 붙이지 않는다(agent=%)', NEW.agent_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_reject_disabled_agent BEFORE INSERT ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_reject_disabled_agent();
