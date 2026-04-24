-- B2B 수기 인보이스 — PDF/이미지 업로드 → Claude 파싱 → 목록 등록.
-- is_manual=true 면 Excel 자동 생성 안 함, original_file_path 로 원본 다운로드.

alter table b2b_invoices
  add column if not exists is_manual boolean not null default false,
  add column if not exists original_file_path varchar(500),
  add column if not exists original_mime_type varchar(100);

create index if not exists b2b_invoices_is_manual_idx on b2b_invoices (is_manual) where is_manual = true;
