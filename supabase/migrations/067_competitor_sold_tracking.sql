-- 067_competitor_sold_tracking.sql
-- 경쟁사 리스팅에 판매수(누적) + 판매속도(크롤 간 증가분) 추적 컬럼 추가.
-- 누적 판매수 = "팔리는가"(시장 존재), 속도 = "지금 뜨는가"(타이밍).

ALTER TABLE competitor_listings
  ADD COLUMN IF NOT EXISTS quantity_sold   integer,      -- 누적 판매수
  ADD COLUMN IF NOT EXISTS sold_velocity   integer,      -- 직전 크롤 대비 증가분(≈ 크롤 주기당 판매)
  ADD COLUMN IF NOT EXISTS sold_measured_at timestamptz; -- 판매수 측정 시각

-- 판매속도 랭킹 조회 최적화
CREATE INDEX IF NOT EXISTS idx_competitor_listings_sold_velocity
  ON competitor_listings (sold_velocity DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_competitor_listings_quantity_sold
  ON competitor_listings (quantity_sold DESC NULLS LAST);
