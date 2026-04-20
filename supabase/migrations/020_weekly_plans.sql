-- Phase 3: 주간 업무 관리
-- 직원이 월요일마다 한 주 계획을 세우고 주중 상태 업데이트, 금요일·주말 회고.
-- 한 직원당 한 주에 하나의 row (unique user+week_start).

create table if not exists weekly_plans (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  week_start date not null,  -- 월요일 날짜 (YYYY-MM-DD)
  items jsonb not null default '[]'::jsonb,
    -- [{ id, title, priority: 'high'|'normal'|'low', status: 'pending'|'in_progress'|'done'|'dropped',
    --    result, createdAt, updatedAt }]
  reflection_wins text,       -- 잘한 일
  reflection_blockers text,   -- 막혔던 일
  reflection_next_week text,  -- 다음주 계획
  status varchar(20) not null default 'draft',  -- draft | submitted
  submitted_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  unique (user_id, week_start)
);

create index if not exists weekly_plans_user_week_idx on weekly_plans (user_id, week_start desc);
create index if not exists weekly_plans_week_idx on weekly_plans (week_start desc);
