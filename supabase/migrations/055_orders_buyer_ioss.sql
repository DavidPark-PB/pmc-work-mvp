-- orders.buyer_ioss — EU 주문의 바이어(판매처) IOSS 넘버 저장.
--
-- 배경 (사장님 보고 2026-07-02):
--   우체국 라벨 발급 시 EU 주문에 IOSS 가 안 들어감. carrierSheets 는 상수
--   YUNEXPRESS_IOSS 를 쓰지만 우체국은 별도 IOSS 계약. 그리고 eBay/Shopify
--   가 order 별로 IOSS 를 부여하는 경우도 있음 (eBay 의 marketplace IOSS).
--
-- 해결:
--   1. order 마다 buyer_ioss 컬럼에 IOSS 저장 (eBay/Shopify sync 시 채움)
--   2. 라벨 발급 시 order.buyer_ioss 우선, 없으면 env KOREAPOST_IOSS_NO fallback
--
-- 컬럼은 nullable — 비 EU 주문 / IOSS 없는 주문은 그대로 NULL.

alter table orders
  add column if not exists buyer_ioss varchar(40);

create index if not exists idx_orders_buyer_ioss on orders(buyer_ioss) where buyer_ioss is not null;
