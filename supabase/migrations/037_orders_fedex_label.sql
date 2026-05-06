-- 037_orders_fedex_label.sql
-- 배송관리 FedEx 즉시 라벨 발급 지원.
-- orders 테이블에 라벨/비용/서비스 컬럼 추가.

alter table orders
  add column if not exists label_storage_path text,
  add column if not exists shipping_cost numeric(10,2),
  add column if not exists shipping_currency varchar(3) default 'USD',
  add column if not exists service_type varchar(40);

-- 라벨 미발급 주문 빠른 조회용
create index if not exists idx_orders_no_label
  on orders(order_no)
  where label_storage_path is null and status = 'NEW';

-- ── Storage 버킷 안내 ──
-- Supabase 콘솔 또는 admin API 로 버킷 생성 필요:
--   bucket: shipping-labels
--   public: false (private)
--   서명 URL 만 발급 (15분 TTL)
