-- Task completion attachments: files that staff upload when marking a task done.
-- Actual bytes live in Supabase Storage bucket `task-attachments` (private).
-- This table stores metadata and the storage path only.

create table if not exists team_task_attachments (
  id serial primary key,
  task_id integer not null references team_tasks(id) on delete cascade,
  user_id integer not null references users(id),
  file_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes integer,
  uploaded_at timestamp not null default now()
);

create index if not exists team_task_attachments_task_idx
  on team_task_attachments (task_id);
create index if not exists team_task_attachments_user_idx
  on team_task_attachments (user_id);
