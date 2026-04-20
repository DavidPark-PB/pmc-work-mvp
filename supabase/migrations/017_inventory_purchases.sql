-- Phase 1 Day 3-B: 카드 매입 (inventory_purchases)
-- 컬렉터/개인한테 현금·계좌이체로 매입하는 포켓몬 카드·상품 기록.
-- 자동으로 expenses 테이블에 '재료비' row를 생성해 지출에도 반영됨 (expense_id FK로 연결).

create table if not exists inventory_purchases (
  id serial primary key,
  purchased_at date not null,
  seller_name varchar(200) not null,
  seller_contact varchar(200),
  payment_method varchar(20) not null default 'cash',  -- cash | bank_transfer | card | other
  bank_ref varchar(200),                                -- 계좌이체 참조
  total_amount numeric(14,2) not null,
  currency varchar(4) not null default 'KRW',
  items jsonb not null default '[]'::jsonb,
  notes text,
  receipt_path text,
  receipt_name varchar(300),
  receipt_mime varchar(120),
  receipt_size integer,
  expense_id integer references expenses(id) on delete set null,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);
create index if not exists inventory_purchases_purchased_at_idx on inventory_purchases (purchased_at desc);
create index if not exists inventory_purchases_seller_idx on inventory_purchases (seller_name);
create index if not exists inventory_purchases_expense_idx on inventory_purchases (expense_id);
create index if not exists inventory_purchases_created_by_idx on inventory_purchases (created_by);
