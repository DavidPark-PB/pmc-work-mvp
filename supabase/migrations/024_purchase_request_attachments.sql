-- Phase 6: 발주요청 이미지 첨부
-- 구매 참고용 사진 (공급자 스샷, 직원이 찍은 샘플 등) 저장.
-- 파일은 기존 'task-attachments' 버킷에 purchase-request-{id}/ prefix로 저장.
-- Sharp로 1600px, JPEG q=85 압축 후 업로드 (장당 ~400KB).

create table if not exists purchase_request_attachments (
  id serial primary key,
  request_id integer not null references purchase_requests(id) on delete cascade,
  uploaded_by integer references users(id),
  file_path varchar(500) not null,              -- 버킷 내 경로
  file_name varchar(300) not null,              -- 원본 파일명 (표시·다운로드용)
  mime_type varchar(100) not null,
  size_bytes integer not null,                  -- 압축 후 크기
  width integer,                                -- 압축 후 가로
  height integer,                               -- 압축 후 세로
  created_at timestamp not null default now()
);

create index if not exists pra_request_idx on purchase_request_attachments (request_id);
