-- 202609260115_webhook_events_v2.sql
-- 메일 기본기 1차 A4 — 웹훅 v2: 구독 · 소프트 삭제 · 재등록 상한 · 재전송(`.omc/plans/mail-basics.md` §4 A4 · §5).
-- 202609260110(열거형 값 셋) 위에 얹는다 — 그 값들을 이 파일이 처음 쓴다.
--
--   ① `webhook_endpoints.event_types webhook_event_type[] NULL` — **엔드포인트별 opt-in 구독.** `NULL` = 옛 4종(`LEGACY_EVENT_TYPES`)이라
--      기존 엔드포인트·기존 수신측은 아무것도 바뀌지 않는다. 새 세 종(delivered·bounced·complained)은 여기 적은 엔드포인트만 받는다.
--      불변 핵심 트리거(`webhook_endpoints_immutable_core`)의 예외 목록에 없으므로 **등록 뒤 바꿀 수 없다**(바꾸려면 새로 등록한다).
--   ② 소프트 삭제 — `disabled_at` **쓰기 1회**(`webhook_endpoints_disabled_once`, 되살리기·시각 고치기 거부). 앱 롤은 여전히 이 표에 UPDATE 가
--      없다(`APP_FORBIDDEN_PRIVILEGES`) — 삭제는 SECURITY DEFINER `disable_webhook_endpoint(agent, endpoint)` 하나로만 한다: 켜진 행을 끄는
--      방향 하나뿐이고 URL·구독·시크릿 칸은 건드릴 수 없다. 인가는 라우트가 한다 — 함수의 에이전트 인자는 호출자(앱 롤)가 넘기는 값이라
--      인가가 아니라 짝 일관성 검사다(보안 L4). 삭제된 엔드포인트로는 새 전달이 적히지 않는다(적재 SELECT 가 `disabled_at IS NULL`
--      만 고르고, 이미 적힌 pending 은 디스패처가 `endpoint_disabled` 로 dead 처리한다).
--   ③ 재등록 상한 — 등록 · 삭제를 되풀이해 엔드포인트(= 시크릿 파생 · outbox 팬아웃)를 굴리는 것을 막는다. 앱(`api/routes/webhook-endpoints.ts`)은
--      에이전트당 **24시간 10회**(비활성 포함)에서 409 를 낸다. 이 트리거(`webhook_endpoints_registration_ceiling`)는 앱 검사가 빠졌을 때의
--      바닥으로 **24시간 20회**를 지킨다 — 같은 advisory 잠금 키(`webhook_endpoints_active:<agent>`) 아래에서 센다. 바닥을 앱과 같은 10 으로
--      두지 않은 이유: 소유자 롤의 직접 INSERT(운영·테스트)가 활성 천장 10 을 채운 뒤 하나를 끄고 다시 넣는 흐름(202609250300 ⑥)을
--      막지 않기 위해서다. 앱 경로의 수는 10 이 정한다.
--   ④ 재전송 — `webhook_deliveries.redelivery_of uuid NULL` 은 **루트**(원래 전달 행)를 가리킨다. 재전송 행은 새 행이고 같은
--      `event_id`·`event_type`·`body`·`endpoint_id` 를 쓴다(수신측은 같은 id 로 멱등 처리한다). 모양 CHECK: 재전송 행의 dedupe 키는
--      `redelivery:<루트 id>:<1..3>` 이다 — 기존 유니크 인덱스 `(endpoint_id, dedupe_key)` 가 그대로 **루트당 3회 천장**이 된다. 가드 트리거
--      (`webhook_deliveries_redelivery_guard`)가 루트 모양(루트는 재전송 행이 아니다 · dead · 칸 일치) · 활성 엔드포인트 · 목적지 거부류
--      (`blocked_destination`·`invalid_url`·`endpoint_disabled`)로 죽은 가족 행 없음 · 천장 3 을 같은 루트 잠금 아래에서 다시 본다.
--      불변 핵심 트리거(`webhook_deliveries_immutable_core`)의 예외 목록에 없으므로 `redelivery_of` 는 적힌 뒤 바뀌지 않는다.
--   ⑤ 색인 셋 — 재전송 가족 세기(부분) · 전달 목록(엔드포인트별 최신순) · 재등록 세기(에이전트별 생성 시각)는 **이 파일에 없다.**
--      202609260117·0118·0119 가 `CONCURRENTLY` 로 만든다(러너의 비트랜잭션 지시자, `src/db/migrate.ts`). 그 사이(색인 파일까지 이어서
--      도는 짧은 틈) 트리거의 세기 쿼리는 이 색인 없이 돈다 — 재전송 세기는 새 코드가 아직 배포 전이라(migrate → Compute) 부르는 쪽이 없고,
--      재등록 세기는 옛 코드의 등록에도 서지만 에이전트당 몇 행인 `webhook_endpoints` 를 읽을 뿐이다.
--
-- 가드 목록은 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS`(W3 표지 아래), 앱 롤 허용 목록은 `src/runtime/role-bootstrap.ts`
-- `RESTRICTED_ROLE_GRANTS`(W3 표지 아래 — 함수 EXECUTE 하나). 새 칸 둘은 표 단위 INSERT 권한이 이미 덮는다(칸 단위 UPDATE 는 없다).
--
-- 잠금(코드 리뷰 H1): `webhook_deliveries` 는 수신 기록·승인·디스패처가 쉬지 않고 쓰는 outbox 이고 지우지 않아 계속 자란다. 그래서 이
--   파일은 ACCESS EXCLUSIVE 를 쥔 동안 **어느 표도 훑지 않는다** — 칸 추가(기본값 없음 — 재작성 없음)·함수·트리거·**`NOT VALID`** 제약만
--   한다. `NOT VALID` 제약은 새 행·UPDATE 에는 바로 서고 기존 행만 검증을 미룬다. 기존 행 검증은 202609260116 의 `VALIDATE CONSTRAINT`
--   (SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다)가 하고, 색인은 0117~0119 가 만든다. 5초 안에 잠금을 못 잡으면 실패하고 아무것도
--   바뀌지 않는다(다시 돌린다).

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- ① 구독
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_endpoints ADD COLUMN event_types webhook_event_type[];

-- 빈 배열은 "아무것도 받지 않는 엔드포인트" 라 뜻이 없다 — NULL(옛 4종)과 헷갈리지 않게 막는다. 종류는 7이 전부다.
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_event_types_shape CHECK (
  event_types IS NULL
  OR (cardinality(event_types) BETWEEN 1 AND 7 AND array_position(event_types, NULL) IS NULL)
) NOT VALID;

COMMENT ON COLUMN webhook_endpoints.event_types IS
  '구독한 이벤트 종류(opt-in). NULL = 옛 4종(approval.resolved · approval.expired · message.sent · message.received). 등록 뒤 불변.';

-- ---------------------------------------------------------------------------
-- ② 소프트 삭제 — disabled_at 쓰기 1회 + 끄기 전용 함수
-- ---------------------------------------------------------------------------

-- 왜: 지운 엔드포인트가 되살아나면 소유자가 끊었다고 믿는 URL 로 이벤트가 다시 나간다(URL 은 그사이 남의 서버일 수 있다). 되살리는
--   대신 새로 등록한다(새 id → 새 시크릿). 소유자 롤도 막는다.
CREATE FUNCTION webhook_endpoints_disabled_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
    RAISE EXCEPTION 'webhook endpoint % is deleted — disabled_at is write-once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_disabled_once
  BEFORE UPDATE OF disabled_at ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_disabled_once();

-- 삭제의 유일한 경로(앱 롤). 켜진 행을 **지금** 시각으로 끄는 것 하나뿐 — 되살리기·시각 고르기·다른 칸 쓰기가 표현되지 않는다.
-- (에이전트, 엔드포인트) 짝이 맞는 행만 끈다. 이것은 **인가가 아니라 일관성 검사다**(보안 L4): `p_agent_id` 는 호출자(앱 롤)가 넘기는
-- 값이라 앱 롤을 쥔 쪽은 아무 에이전트 id 나 넘길 수 있다. 인가(토큰 → 에이전트)는 라우트(`api/routes/webhook-endpoints.ts`)가 먼저 하고,
-- 이 검사는 라우트가 엉뚱한 짝을 넘기는 실수를 0행으로 만든다. 끈 시각을 돌려주고, 없거나 이미 꺼져 있으면 NULL.
CREATE FUNCTION disable_webhook_endpoint(p_agent_id text, p_endpoint_id uuid) RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.webhook_endpoints
     SET disabled_at = now()
   WHERE id = p_endpoint_id AND agent_id = p_agent_id::bpchar AND disabled_at IS NULL
  RETURNING disabled_at
$$;

COMMENT ON FUNCTION disable_webhook_endpoint(text, uuid) IS
  '웹훅 엔드포인트 소프트 삭제(메일 기본기 A4) — (에이전트, 엔드포인트) 짝이 맞는 켜진 행만 now() 로 끈다(짝 검사는 인가가 아니라 일관성 검사 — 인가는 라우트). 끈 시각 또는 NULL. 앱 롤만 EXECUTE.';

REVOKE ALL ON FUNCTION disable_webhook_endpoint(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION disable_webhook_endpoint(text, uuid) TO atmark_app;

-- ---------------------------------------------------------------------------
-- ③ 재등록 상한(바닥 20/24h — 앱은 10/24h)
-- ---------------------------------------------------------------------------

CREATE FUNCTION webhook_endpoints_registration_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recent integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook_endpoints_active:' || NEW.agent_id, 0));
  SELECT count(*) INTO recent FROM public.webhook_endpoints e
   WHERE e.agent_id = NEW.agent_id AND e.created_at > now() - interval '24 hours';
  IF recent >= 20 THEN
    RAISE EXCEPTION 'webhook_endpoints: agent % registered % endpoints in 24h (max 20)', NEW.agent_id, recent
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_registration_ceiling
  BEFORE INSERT ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_registration_ceiling();

-- ---------------------------------------------------------------------------
-- ④ 재전송
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_deliveries ADD COLUMN redelivery_of uuid;

-- FK 는 NOT VALID 로 — 검증(표 전체 읽기)은 202609260116. 이름은 칼럼 REFERENCES 의 자동 이름과 같다(`REQUIRED_GUARDS`).
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_redelivery_of_fkey
  FOREIGN KEY (redelivery_of) REFERENCES webhook_deliveries (id) ON DELETE RESTRICT NOT VALID;

-- 원래 행의 dedupe 키는 `<type>:<대상>` 이라 `redelivery:` 로 시작하지 않는다. 재전송 행은 루트 id 와 순번 1..3 을 담는다 — 순번 4 는 모양에서
--   죽고, 같은 순번 둘은 `(endpoint_id, dedupe_key)` 유니크에서 죽는다.
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_redelivery_shape CHECK (
  (redelivery_of IS NULL AND dedupe_key !~ '^redelivery:')
  OR (redelivery_of IS NOT NULL AND redelivery_of <> id
      AND dedupe_key ~ ('^redelivery:' || redelivery_of::text || ':[1-3]$'))
) NOT VALID;

CREATE FUNCTION webhook_deliveries_redelivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  root public.webhook_deliveries%ROWTYPE;
  used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook_redelivery:' || NEW.redelivery_of::text, 0));
  SELECT * INTO root FROM public.webhook_deliveries WHERE id = NEW.redelivery_of;
  IF NOT FOUND OR root.redelivery_of IS NOT NULL THEN
    RAISE EXCEPTION 'redelivery_of % must point to a root delivery', NEW.redelivery_of USING ERRCODE = '23514';
  END IF;
  IF root.status <> 'dead' THEN
    RAISE EXCEPTION 'root delivery % is not dead (%)', root.id, root.status USING ERRCODE = '23514';
  END IF;
  IF (NEW.endpoint_id, NEW.event_id, NEW.event_type, NEW.body) IS DISTINCT FROM (root.endpoint_id, root.event_id, root.event_type, root.body) THEN
    RAISE EXCEPTION 'redelivery of % must repeat the root endpoint, event and body', root.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
    RAISE EXCEPTION 'redelivery of % must start pending with no attempts', root.id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e WHERE e.id = NEW.endpoint_id AND e.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'redelivery of % targets a deleted endpoint', root.id USING ERRCODE = '23514';
  END IF;
  -- 목적지 거부류는 SSRF 차단·잘못된 URL·삭제다 — 다시 보내면 내부망 탐침을 반복해 줄 뿐이다(dispatcher.ts 머리말).
  IF EXISTS (SELECT 1 FROM public.webhook_deliveries d
              WHERE (d.id = root.id OR d.redelivery_of = root.id)
                AND d.status = 'dead'
                AND d.last_error IN ('blocked_destination', 'invalid_url', 'endpoint_disabled')) THEN
    RAISE EXCEPTION 'delivery % died on a rejected destination — not redeliverable', root.id USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO used FROM public.webhook_deliveries d WHERE d.redelivery_of = root.id;
  IF used >= 3 THEN
    RAISE EXCEPTION 'delivery % already redelivered % times (max 3)', root.id, used USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_deliveries_redelivery_guard
  BEFORE INSERT ON webhook_deliveries
  FOR EACH ROW WHEN (NEW.redelivery_of IS NOT NULL)
  EXECUTE FUNCTION webhook_deliveries_redelivery_guard();

COMMENT ON COLUMN webhook_deliveries.redelivery_of IS
  '재전송 행이면 루트(원래 전달 행) id. 루트당 3회(dedupe 키 redelivery:<루트>:<1..3>). 루트는 dead 여야 하고 칸(엔드포인트·이벤트·본문)이 같다. 불변.';
