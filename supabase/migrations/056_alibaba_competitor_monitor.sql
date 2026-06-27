-- Migration 056: Alibaba 경쟁사 공급가 모니터링 테이블
-- 목적: 키워드 기반 Alibaba.com 크롤링으로 공급가/MOQ 변동 추적

-- === 추적 키워드/상품 테이블 ===
CREATE TABLE IF NOT EXISTS alibaba_competitor_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword         TEXT NOT NULL,                     -- 검색 키워드 (영문)
  sku             TEXT,                              -- 연결된 내 상품 SKU (옵션)
  category        TEXT DEFAULT '',                   -- 상품 카테고리 메모
  last_price      NUMERIC(12,2),                    -- 최근 크롤링 최저가
  last_moq        INTEGER,                           -- 최근 MOQ
  last_supplier   TEXT DEFAULT '',                   -- 최근 최저가 공급업체
  top_results     JSONB DEFAULT '[]'::jsonb,         -- 최근 검색 결과 (상위 5개)
  alert_threshold_pct NUMERIC(5,1) DEFAULT 3,       -- 변동 알림 임계값 (%)
  is_active       BOOLEAN DEFAULT true,
  notes           TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- === 변동 알림 테이블 ===
CREATE TABLE IF NOT EXISTS alibaba_competitor_alerts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type            TEXT NOT NULL,                     -- price_drop | price_raise | moq_change
  keyword         TEXT NOT NULL,
  sku             TEXT,
  prev_price      NUMERIC(12,2),
  new_price       NUMERIC(12,2),
  prev_moq        INTEGER,
  new_moq         INTEGER,
  supplier        TEXT DEFAULT '',
  message         TEXT DEFAULT '',
  data            JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_alibaba_comp_products_active ON alibaba_competitor_products(is_active, updated_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_alibaba_comp_products_sku ON alibaba_competitor_products(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alibaba_comp_alerts_created ON alibaba_competitor_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alibaba_comp_alerts_keyword ON alibaba_competitor_alerts(keyword);

COMMENT ON TABLE alibaba_competitor_products IS 'Alibaba.com 크롤링 대상 키워드/상품. keyword로 검색 → MOQ/단가 추적.';
COMMENT ON TABLE alibaba_competitor_alerts IS 'Alibaba 공급가 변동 알림 이력.';
