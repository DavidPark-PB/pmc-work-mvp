-- 068_price_events_and_reason_codes.sql
-- Commerce OS v1 — Engine 1(Price) 기반 스키마.
-- 원칙: 가격을 "상태"로 저장하지 않고 "이벤트"로 기록한다(append-only, 100% 추적).
-- 범위: v1 MVP는 가격 엔진만. 광고/공급처/가지치기 스키마는 예약 필드만 심는다.

-- ── 1. Reason Code enum (자유텍스트 금지, KPI 집계용) ──────────────────────
DO $$ BEGIN
  CREATE TYPE price_action AS ENUM ('AUTO', 'REVIEW', 'BLOCK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE price_reason_code AS ENUM (
    -- AUTO (자동 실행 근거)
    'AUTO_UNDERCUT_SAFE', 'AUTO_MATCH_CONFIRMED', 'AUTO_PRICE_MAINTAINED',
    -- REVIEW (사람 승인)
    'REVIEW_LOW_CONFIDENCE', 'REVIEW_FLOOR_BINDS', 'REVIEW_COMPETITOR_BELOW_COST',
    'REVIEW_MAX_DROP_EXCEEDED', 'REVIEW_PRICE_ANOMALY',
    -- BLOCK (데이터 태스크로 전환)
    'BLOCK_LANDING_COST_UNKNOWN', 'BLOCK_NO_MATCH', 'BLOCK_MAP',
    'BLOCK_API_ERROR', 'BLOCK_STALE_COMPETITOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. price_events (append-only 이벤트 로그) ─────────────────────────────
CREATE TABLE IF NOT EXISTS price_events (
  id                  bigserial PRIMARY KEY,
  event_type          text NOT NULL,   -- PriceRecommendationCreated | PriceApproved | PriceApplied | CompetitorChanged | PriceUpdated | PriceReverted
  sku                 varchar(100),    -- internal_sku
  item_id             varchar(64),     -- eBay item_id
  old_price           numeric(12,2),
  new_price           numeric(12,2),
  recommended_price   numeric(12,2),
  currency            varchar(8) DEFAULT 'USD',
  action              price_action,
  reason_code         price_reason_code,
  -- 다차원 신뢰도 스냅샷(재현용)
  confidence_snapshot jsonb,           -- { identity, price, cost, supplier, overall }
  rule_version        text,            -- 어떤 규칙셋이 만들었나
  competitor_ref      jsonb,           -- { seller_id, competitor_item_id, competitor_total }
  landing_cost        numeric(12,2),   -- 판정 시점 랜딩코스트
  actor               text DEFAULT 'system',  -- system | user:<id>
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_events_sku        ON price_events (sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_events_item       ON price_events (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_events_action     ON price_events (action);
CREATE INDEX IF NOT EXISTS idx_price_events_reason     ON price_events (reason_code);
CREATE INDEX IF NOT EXISTS idx_price_events_type_time  ON price_events (event_type, created_at DESC);

COMMENT ON TABLE price_events IS 'Commerce OS v1: 가격 결정 이벤트 로그(append-only). 현재가는 최신 PriceApplied 이벤트에서 파생.';

-- ── 3. Engine 5 예약 필드 (지금 구현 X, 스키마만 예약 · NULL 허용) ─────────
--     나중에 스키마를 다시 뜯지 않기 위해 미리 심는다.
ALTER TABLE sku_master
  ADD COLUMN IF NOT EXISTS supplier_id           bigint,
  ADD COLUMN IF NOT EXISTS supplier_sku          varchar(120),
  ADD COLUMN IF NOT EXISTS supplier_cost         numeric(12,2),
  ADD COLUMN IF NOT EXISTS supplier_lead_time    integer,      -- 일 단위
  ADD COLUMN IF NOT EXISTS supplier_reliability  numeric(5,3), -- 0~1
  ADD COLUMN IF NOT EXISTS supplier_confidence   numeric(5,3); -- 0~1 (Confidence Model의 Supplier 축)

-- Identity 보강 예약 필드(매칭 신뢰도↑용 · 나중 채움)
ALTER TABLE sku_master
  ADD COLUMN IF NOT EXISTS upc_ean       varchar(20),
  ADD COLUMN IF NOT EXISTS attr_set      varchar(80),   -- Pokemon set 등
  ADD COLUMN IF NOT EXISTS attr_language varchar(20),
  ADD COLUMN IF NOT EXISTS attr_condition varchar(20),
  ADD COLUMN IF NOT EXISTS attr_pack_type varchar(20);  -- pack | box | case | bundle

CREATE INDEX IF NOT EXISTS idx_sku_master_upc ON sku_master (upc_ean) WHERE upc_ean IS NOT NULL;
