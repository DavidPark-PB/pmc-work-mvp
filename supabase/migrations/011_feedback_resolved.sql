-- Let the admin mark a feedback post as resolved so staff can tell at a glance
-- which items have been handled. Replies are never resolved on their own —
-- the flag only applies to top-level posts (parent_id is null).

alter table feedback
  add column if not exists is_resolved boolean not null default false,
  add column if not exists resolved_by integer,
  add column if not exists resolved_at timestamp;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'feedback_resolved_by_fk'
      and table_name = 'feedback'
  ) then
    alter table feedback
      add constraint feedback_resolved_by_fk
      foreign key (resolved_by) references users(id);
  end if;
end $$;
