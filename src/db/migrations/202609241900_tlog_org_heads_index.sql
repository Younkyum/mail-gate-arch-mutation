-- ADR-0008 F35 — 에폭 마감의 헤드 추가 비용을 잎 수와 무관하게(헤드 하나당 색인 두 번).
--
-- 에폭은 모든 조직 로그의 헤드를 담는다(헤드 수 = 조직 로그 수). 헤드 추가 트리거는 행마다
--   ① 그 조직의 직전 헤드를 찾고 — PK (epoch, org_log_id) 역순 스캔에 기댔다.
--   ② 그 조직의 잎 수를 count(*) 로 센다 — 에폭 하나를 닫을 때마다 **전체 잎 수**만큼 읽는다(잎은 영구히 는다).
-- 실측(로컬 누적 DB: 조직 로그 5,575 · 헤드 1.74M · 잎 30k): ① 은 PK 로도 0.18ms, 색인으로 0.04ms. ② 가 장기 비용이다.
--
-- 고침: ① 은 (org_log_id, epoch DESC) 색인으로 한 행을 바로 찾는다. ② 는 잎 seq 가 0..n-1 연속(tlog_leaves_append 가 강제,
-- (org_log_id, seq) UNIQUE 색인)이므로 마지막 seq + 1 = 잎 수 — 색인 끝 한 행이다. 판정 규칙은 그대로다.

CREATE INDEX tlog_org_heads_log_epoch_idx ON tlog_org_heads (org_log_id, epoch DESC) INCLUDE (tree_size);

CREATE OR REPLACE FUNCTION tlog_org_heads_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous bigint;
  available bigint;
BEGIN
  SELECT tree_size INTO previous FROM tlog_org_heads WHERE org_log_id = NEW.org_log_id AND epoch < NEW.epoch ORDER BY epoch DESC LIMIT 1;
  IF previous IS NOT NULL AND NEW.tree_size < previous THEN
    RAISE EXCEPTION 'tlog_org_heads: 조직 로그가 줄었다 (% → %)', previous, NEW.tree_size USING ERRCODE = '23514';
  END IF;
  -- seq 는 0..n-1 연속이다(tlog_leaves_append) — 마지막 seq + 1 = 잎 수.
  SELECT seq + 1 INTO available FROM tlog_leaves WHERE org_log_id = NEW.org_log_id ORDER BY seq DESC LIMIT 1;
  IF NEW.tree_size > coalesce(available, 0) THEN
    RAISE EXCEPTION 'tlog_org_heads: 헤드 크기가 잎 수보다 크다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
