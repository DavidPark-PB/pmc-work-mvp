-- Migration 055: repricing_rules SKU 예외 규칙 확장
-- 목적: "Rocket Glory는 $1 비싸도 유지" 같은 상품별 홀드/예외 규칙 지원
--
-- 기존 컬럼 (004_platform_system):
--   sku, platform, strategy, undercut_amount, min_price, max_price, min_margin_pct, is_active, created_at
--
-- 추가 컬럼:
--   action_type     : reprice(기본) | hold | raise_only | drop_only | skip
--   price_premium   : 내 가격이 경쟁사보다 N달러 비싸도 허용 (양수 = 비싸도 ok)
--   notes           : 규칙 설명 ("재고 부족, 가격 인하 금지" 등)
--   competitor_whitelist : 특정 셀러만 추적 (빈 배열이면 전체)
--   competitor_blacklist : 특정 셀러 무시 (덤핑 셀러 제외)
--   max_drop_pct    : 최대 인하 허용 비율 (기본 20%)
--   max_raise_pct   : 최대 인상 허용 비율 (기본 30%)
--   updated_at      : 최종 수정일

ALTER TABLE repricing_rules
  ADD COLUMN IF NOT EXISTS action_type TEXT NOT NULL DEFAULT 'reprice'
    CHECK (action_type IN ('reprice','hold','raise_only','drop_only','skip')),
  ADD COLUMN IF NOT EXISTS price_premium NUMERIC(8,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS competitor_whitelist TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS competitor_blacklist TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS max_drop_pct NUMERIC(5,1) DEFAULT 20,
  ADD COLUMN IF NOT EXISTS max_raise_pct NUMERIC(5,1) DEFAULT 30,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 기존 rows updated_at 채우기
UPDATE repricing_rules SET updated_at = created_at WHERE updated_at IS NULL;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_repricing_rules_sku ON repricing_rules(sku) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_repricing_rules_global ON repricing_rules(platform) WHERE sku IS NULL AND is_active = true;

-- action_type 설명 뷰 (읽기 전용 참고용)
COMMENT ON COLUMN repricing_rules.action_type IS
  'reprice: 전략대로 조정 | hold: 변경 금지 | raise_only: 올리기만 | drop_only: 내리기만 | skip: 파이프라인 완전 제외';
COMMENT ON COLUMN repricing_rules.price_premium IS
  '경쟁사보다 N달러 비싸도 허용. 양수=비싸도ok, 음수=반드시 N달러 저렴해야함';
COMMENT ON COLUMN repricing_rules.competitor_whitelist IS
  '이 셀러만 기준으로 삼음. 빈 배열이면 전체 셀러 대상';
COMMENT ON COLUMN repricing_rules.competitor_blacklist IS
  '이 셀러는 가격 기준에서 제외 (덤핑/이상 셀러 차단)';
