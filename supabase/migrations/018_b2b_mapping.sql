-- Phase 1 Day 3-C: B2B 거래처 ↔ 플랫폼 주문 맵핑
-- b2b_buyers.external_ids: 플랫폼별로 이 거래처와 동일인임을 확증하는 식별자들.
--   예: {"ebay":["wholesale_usa","buyer@x.com"], "alibaba":["abc_trade"], "naver":["...@naver.com"]}
-- orders.b2b_buyer_id: 매칭된 B2B 거래처 ID (예: 'B003'). null이면 미매칭(개인 소비자 등).

alter table b2b_buyers
  add column if not exists external_ids jsonb not null default '{}'::jsonb;

alter table orders
  add column if not exists b2b_buyer_id varchar(20);

create index if not exists orders_b2b_buyer_idx on orders (b2b_buyer_id);
create index if not exists orders_buyer_name_lower_idx on orders (lower(buyer_name));
create index if not exists orders_email_lower_idx on orders (lower(email));
