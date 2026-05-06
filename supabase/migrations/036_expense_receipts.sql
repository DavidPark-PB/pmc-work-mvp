-- 036_expense_receipts.sql
-- 지출 영수증 다중 첨부 지원.
-- 이전: expenses.receipt_path (단일) → 두 번째 업로드 시 첫 번째 덮어씀.
-- 이후: 별도 테이블에 N개 영수증 보관, 기존 단일 컬럼은 backward compat 위해 유지 (첫 번째 미러).

create table if not exists expense_receipts (
  id bigserial primary key,
  expense_id int not null references expenses(id) on delete cascade,
  storage_path text not null,
  file_name text,
  mime_type text,
  file_size bigint,
  uploaded_by int references users(id),
  uploaded_at timestamptz default now()
);

create index if not exists idx_expense_receipts_expense_id on expense_receipts(expense_id);
create index if not exists idx_expense_receipts_uploaded_at on expense_receipts(uploaded_at desc);

-- 기존 expenses.receipt_path 의 단일 영수증을 새 테이블로 마이그레이션.
-- (안전: ON CONFLICT 없이 삽입, 중복 우려는 NULL 체크로 회피)
insert into expense_receipts (expense_id, storage_path, file_name, mime_type, file_size, uploaded_at)
select e.id, e.receipt_path, e.receipt_name, e.receipt_mime, e.receipt_size, coalesce(e.created_at, now())
from expenses e
where e.receipt_path is not null
  and not exists (
    select 1 from expense_receipts r
    where r.expense_id = e.id and r.storage_path = e.receipt_path
  );
