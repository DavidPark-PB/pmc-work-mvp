-- 영수증 첨부. 한 지출당 영수증 1개 (단순화). 파일 자체는 Supabase Storage
-- 'expense-receipts' 버킷(private)에 저장, 이 테이블엔 경로·메타만.

alter table expenses
  add column if not exists receipt_path text,
  add column if not exists receipt_name varchar(300),
  add column if not exists receipt_mime varchar(120),
  add column if not exists receipt_size integer;
