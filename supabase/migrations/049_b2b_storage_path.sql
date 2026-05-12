-- B2B 인보이스 파일 저장소를 Google Drive 에서 Supabase Storage 로 이관.
-- service account Drive 가 누적 XLSX 로 15GB 한도 초과되는 문제 영구 해결.
--
-- 별도로 Supabase 대시보드에서 'b2b-invoices' 버킷을 Public 모드로 생성해야 함.
-- (Dashboard → Storage → New bucket → name: b2b-invoices → Public: ON)
--
-- 기존 drive_file_id / drive_url 컬럼은 legacy 인보이스 호환을 위해 유지.

alter table b2b_invoices add column if not exists storage_path text;

comment on column b2b_invoices.storage_path is
  'Supabase Storage 의 b2b-invoices 버킷 내부 경로. 신규 인보이스용. NULL 이면 legacy(Drive) 또는 재생성 fallback.';
