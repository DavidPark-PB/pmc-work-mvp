-- B2B 부분 발송 추적.
-- 한 인보이스에 여러 발송(1:N). 각 발송은 이번에 보낸 SKU·수량 + 송장번호를 가짐.
-- 인보이스 items의 shippedQty는 응답 빌드 시 이 테이블에서 합계로 파생.

create table if not exists b2b_shipments (
  id serial primary key,
  invoice_no varchar(50) not null references b2b_invoices(invoice_no) on delete cascade,
  shipped_at date not null default current_date,
  carrier varchar(40) not null default 'FedEx',      -- FedEx | DHL | UPS | Other
  tracking_number varchar(100) not null,
  items jsonb not null,                              -- [{sku, qty}]
  notes text,
  created_by integer references users(id),
  created_at timestamptz default now()
);

create index if not exists b2b_shipments_invoice_idx on b2b_shipments (invoice_no);
create index if not exists b2b_shipments_date_idx on b2b_shipments (shipped_at desc);
