-- B2B 인보이스 무효화(void) — 잘못 만든 인보이스를 soft-delete.
-- voided_at IS NOT NULL인 row는 기본 리스트·매출 합계에서 제외.

alter table b2b_invoices
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by integer references users(id),
  add column if not exists void_reason text;

create index if not exists b2b_invoices_active_idx
  on b2b_invoices (invoice_date desc) where voided_at is null;
