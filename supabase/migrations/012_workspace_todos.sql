-- 직원 개인 워크스페이스 할 일 체크리스트.
-- 메모(workspace_notes)와 분리된 별도 테이블 — 구조가 달라서 합치면 스키마가 지저분해짐.

create table if not exists workspace_todos (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  text varchar(500) not null,
  done boolean not null default false,
  done_at timestamp,
  due_date date,
  sort_order integer not null default 0,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists workspace_todos_user_idx
  on workspace_todos (user_id, done, sort_order, created_at desc);
