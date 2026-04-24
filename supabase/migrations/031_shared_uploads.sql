-- 자료실 직접 업로드 — 공지·양식 등 일반 자료. 중요 파일은 Drive 사용.
-- 용량에 따라 자동 만료: < 10MB → 30일, ≥ 10MB → 7일. 업로드 시 override 가능.

create table if not exists shared_uploads (
  id serial primary key,
  storage_path varchar(500) not null,         -- Supabase Storage 내부 경로
  original_name varchar(300) not null,
  mime_type varchar(100),
  size_bytes bigint not null,
  description text,
  tags text[] default '{}',
  uploaded_by integer references users(id),
  uploaded_at timestamp not null default now(),
  expires_at timestamp not null               -- cleanup 크론이 이 시각 지난 파일 삭제
);

create index if not exists shared_uploads_expires_idx on shared_uploads (expires_at);
create index if not exists shared_uploads_uploaded_at_idx on shared_uploads (uploaded_at desc);
create index if not exists shared_uploads_uploader_idx on shared_uploads (uploaded_by);
