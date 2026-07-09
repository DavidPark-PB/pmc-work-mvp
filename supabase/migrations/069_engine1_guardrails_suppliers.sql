-- 069_engine1_guardrails_suppliers.sql
-- Commerce OS v1 — Engine 1 나머지 배선: Global Guardrails + suppliers 마스터(Engine 5 예약).
-- 068(price_events, reason enum, sku_master 예약 컬럼)에 이어지는 마이그레이션.

-- ── 1. pricing_guardrails — 계약서 레벨 안전장치 (싱글톤 설정) ─────────────
-- bad-data 연쇄를 구조적으로 차단. Engine 1은 매 실행마다 이 행을 읽는다.
CREATE TABLE IF NOT EXISTS pricing_guardrails (
  id                        smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- 싱글톤
  kill_switch               boolean NOT NULL DEFAULT false, -- true = 전체 자동적용 즉시 중단
  daily_max_drop_pct        numeric(5,2) NOT NULL DEFAULT 15.0,  -- SKU당 일일 최대 인하율(%) 초과 → REVIEW
  daily_auto_ratio_cap_pct  numeric(5,2) NOT NULL DEFAULT 20.0,  -- 하루 AUTO 적용 가능 카탈로그 비율(%)
  anomaly_drop_pct          numeric(5,2) NOT NULL DEFAULT 30.0,  -- 경쟁가 직전 대비 급락(%) → REVIEW_PRICE_ANOMALY
  competitor_fresh_hours    integer      NOT NULL DEFAULT 48,    -- 경쟁가 신선도 임계(시간) 초과 → BLOCK_STALE_COMPETITOR
  auto_threshold            numeric(5,3) NOT NULL DEFAULT 0.95,  -- Overall ≥ → AUTO
  review_threshold          numeric(5,3) NOT NULL DEFAULT 0.80,  -- Overall ≥ → REVIEW, 미만 → BLOCK
  rule_version              text         NOT NULL DEFAULT 'engine1-v1.0.0',
  auto_apply_enabled        boolean      NOT NULL DEFAULT false, -- Dry-run GO 기준 통과 전까지 false 고정
  updated_by                text,
  updated_at                timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO pricing_guardrails (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE pricing_guardrails IS
  'Commerce OS v1 Global Guardrails. kill_switch=true면 Engine 1 자동적용 전면 중단. auto_apply_enabled는 Dry-run GO 기준 충족 후에만 true.';

-- ── 2. suppliers 마스터 (Engine 5 예약 — 값은 나중에 축적) ────────────────
-- 주문↔공급처 링크만 지금 걸어두면 마진·품절률·클레임이 자동 축적되기 시작.
CREATE TABLE IF NOT EXISTS suppliers (
  id            bigserial PRIMARY KEY,
  name          varchar(200) NOT NULL,
  channel       varchar(50),              -- 'domeggook' | 'ownerclan' | 'alibaba' | 'direct' 등
  contact       jsonb DEFAULT '{}'::jsonb,
  default_lead_time_days integer,
  reliability   numeric(5,3),             -- 0~1 (품절률·클레임에서 파생, Engine 5가 채움)
  is_active     boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (is_active);

-- sku_master.supplier_id → suppliers FK (068에서 컬럼만 예약됨, 여기서 링크)
DO $$ BEGIN
  ALTER TABLE sku_master
    ADD CONSTRAINT fk_sku_master_supplier
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- purchase_requests ↔ 공급처 링크 예약 (NULL 허용 — 기존 fallback 정책 유지)
ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS supplier_id bigint;
DO $$ BEGIN
  ALTER TABLE purchase_requests
    ADD CONSTRAINT fk_purchase_requests_supplier
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
        WHEN undefined_table THEN NULL; END $$;

-- ── 3. AUTO 일일 카운터 뷰 — 자동변경 비율 상한 검사용 ─────────────────────
-- "오늘 AUTO로 PriceApplied 된 SKU 수" — Engine 1이 cap 검사에 사용.
CREATE OR REPLACE VIEW v_price_auto_applied_today AS
SELECT count(DISTINCT sku) AS auto_applied_skus
FROM price_events
WHERE event_type = 'PriceApplied'
  AND action = 'AUTO'
  AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul';

-- ── 4. BLOCK 데이터 태스크 집계 뷰 — Control Tower "직원 작업 큐" 하향 표시 ──
-- BLOCK 카운트가 줄어드는 것 = 자동화 커버리지가 넓어진다.
CREATE OR REPLACE VIEW v_block_task_queue AS
SELECT reason_code, count(DISTINCT sku) AS sku_count, max(created_at) AS last_seen
FROM price_events
WHERE action = 'BLOCK'
  AND event_type = 'PriceRecommendationCreated'
  AND created_at >= now() - interval '7 days'
GROUP BY reason_code
ORDER BY sku_count DESC;
