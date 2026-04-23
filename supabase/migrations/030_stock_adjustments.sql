-- 재고 실사 로그 — 실제 카운트와 시스템 재고의 차이 추적.
-- 기존 inventory_log는 입출고 용도라 reason·session_id·adjusted_by 필드가 부족해서 분리.

create table if not exists stock_adjustments (
  id serial primary key,
  sku varchar(100) not null,
  item_id varchar(100),                      -- eBay itemId (있으면)
  barcode varchar(100),                      -- 스캔된 바코드 (있으면)
  title varchar(500),                        -- 당시 상품명 스냅샷
  previous_stock integer not null,           -- 조정 전 값
  new_stock integer not null,                -- 조정 후 값
  delta integer not null,                    -- new - previous
  reason varchar(200),                       -- 실사 / 파손 / 분실 / 기타
  note text,
  session_id varchar(50),                    -- 같은 실사 세션 그룹핑
  adjusted_by integer references users(id),
  created_at timestamp not null default now()
);

create index if not exists stock_adj_sku_idx on stock_adjustments (sku);
create index if not exists stock_adj_session_idx on stock_adjustments (session_id);
create index if not exists stock_adj_date_idx on stock_adjustments (created_at desc);
