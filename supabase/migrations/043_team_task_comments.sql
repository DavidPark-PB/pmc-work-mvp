-- 043_team_task_comments.sql
--
-- PR T-1: 업무 카드 한줄 댓글 + 파일 첨부 (jsonb 단일 컬럼)
--
-- 정책:
--   - 댓글 본문 + attachments(jsonb) 만 보관. 별도 attachments 테이블 X.
--   - attachments 는 [{file_path, file_name, mime_type, size}] 배열, 최대 3개.
--   - 실 파일은 기존 'task-attachments' bucket 의 ${taskId}/comments/* 에 저장.
--   - author_id 는 의도적으로 FK 생략 (운영 부담 최소화 — opportunity_drafts.approved_by 동일 정책).
--
-- Pre-state:  042 적용 (opportunity_drafts)
-- Post-state: team_task_comments 테이블 + 2 인덱스 + 1 FK
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + FK 는 pg_constraint 조회 후 conditional ALTER
-- 무수정: 037~042 / Phase 1 컬럼 / Safety Foundation

create table if not exists team_task_comments (
  id          serial primary key,
  task_id     integer not null,
  author_id   integer not null,
  content     text    not null,
  attachments jsonb,
  created_at  timestamp not null default now()
);

create index if not exists idx_ttc_task_created on team_task_comments (task_id, created_at desc);
create index if not exists idx_ttc_author       on team_task_comments (author_id, created_at);

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_ttc_task') then
    raise notice '[043] fk_ttc_task already exists — skip';
  else
    alter table team_task_comments
      add constraint fk_ttc_task
      foreign key (task_id) references team_tasks(id) on delete cascade;
    raise notice '[043] fk_ttc_task ADDED';
  end if;
end $$;

-- Rollback (수동):
--   alter table team_task_comments drop constraint if exists fk_ttc_task;
--   drop index if exists idx_ttc_author;
--   drop index if exists idx_ttc_task_created;
--   drop table if exists team_task_comments;
