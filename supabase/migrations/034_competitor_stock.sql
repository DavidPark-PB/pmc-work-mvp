-- 전투 상황판 정확도 개선 — 변형 가격 범위 + 재고/품절 + 수동 가격 고정.
-- 기존 competitor_price/competitor_shipping 은 그대로 (대표값/최저값 용).

alter table competitor_prices
  add column if not exists quantity_available integer,         -- null = unknown
  add column if not exists status varchar(20) default 'active',-- active | out_of_stock | ended | error
  add column if not exists price_min numeric(12,2),            -- 변형 중 최저가
  add column if not exists price_max numeric(12,2),            -- 변형 중 최고가
  add column if not exists variant_count integer default 1,    -- 변형 개수
  add column if not exists manual_price_override numeric(12,2),-- 사장님이 픽한 추적 가격
  add column if not exists manual_shipping_override numeric(8,2),
  add column if not exists last_refreshed_at timestamp;

create index if not exists comp_prices_status_idx on competitor_prices(status);
