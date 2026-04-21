-- B2B 결제 추적 — 부분 입금/연체 지원.
-- payment_status: UNPAID | PARTIAL | PAID (total 대비 paid_amount로 자동 결정)
-- b2b_payments: 입금 이력 (부분 입금 여러 번 가능)

alter table b2b_invoices
  add column if not exists paid_amount numeric(14,2) not null default 0,
  add column if not exists payment_status varchar(20) not null default 'UNPAID';

create table if not exists b2b_payments (
  id serial primary key,
  invoice_no varchar(50) not null references b2b_invoices(invoice_no) on delete cascade,
  paid_at date not null default current_date,
  amount numeric(14,2) not null,
  method varchar(40),               -- bank_transfer | card | paypal | cash | other
  note text,
  created_by integer references users(id),
  created_at timestamptz default now()
);

create index if not exists b2b_payments_invoice_idx on b2b_payments (invoice_no);
create index if not exists b2b_payments_date_idx on b2b_payments (paid_at desc);
