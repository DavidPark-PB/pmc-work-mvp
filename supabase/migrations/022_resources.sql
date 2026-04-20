-- Phase 5: 자료실 (구글 드라이브 동기화)
-- admin이 Drive 폴더를 등록하면 주기적으로 파일 목록을 동기화. 태그 기반 검색.

create table if not exists resource_folders (
  id serial primary key,
  drive_folder_id varchar(120) not null unique,   -- Google Drive folder ID
  name varchar(200) not null,                     -- 화면용 이름
  description text,
  tags jsonb not null default '[]'::jsonb,        -- 폴더 수준 기본 태그 (파일에 상속)
  last_synced_at timestamp,
  last_sync_file_count integer,
  active boolean not null default true,
  created_by integer references users(id),
  created_at timestamp not null default now()
);

create table if not exists resources (
  id serial primary key,
  folder_id integer not null references resource_folders(id) on delete cascade,
  drive_file_id varchar(120) not null,
  file_name varchar(500) not null,
  mime_type varchar(200),
  size_bytes bigint,
  web_view_link text,
  modified_at timestamp,
  tags jsonb not null default '[]'::jsonb,        -- 파일별 추가 태그 (폴더 태그와 merge)
  deleted boolean not null default false,         -- Drive에서 사라지면 true (UI에서 숨김)
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  unique (folder_id, drive_file_id)
);

create index if not exists resources_folder_idx on resources (folder_id) where deleted = false;
create index if not exists resources_name_idx on resources (lower(file_name));
create index if not exists resources_tags_idx on resources using gin (tags);
create index if not exists resources_modified_idx on resources (modified_at desc);
