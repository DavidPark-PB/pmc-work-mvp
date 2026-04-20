-- Phase 6: 주간 회의 (2주 주기) + AI 액션아이템 자동 분배
-- 관리자가 회의록을 정리하면 Gemini가 직원별 할 일로 분배, weekly_plans에 자동 삽입.

create table if not exists weekly_meetings (
  id serial primary key,
  meeting_date date not null,                      -- 회의한 날 (보통 월요일)
  cycle_weeks smallint not null default 2,         -- 주간 플랜에 배포할 주 수 (1 or 2)
  title varchar(200),
  summary text,
  raw_notes text,
  action_items jsonb not null default '[]'::jsonb,
    -- [{ id, userId, userName, title, priority, notes, applied: bool }]
  status varchar(20) not null default 'draft',    -- draft | extracted | distributed
  extracted_at timestamp,
  distributed_at timestamp,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists weekly_meetings_date_idx on weekly_meetings (meeting_date desc);
create index if not exists weekly_meetings_status_idx on weekly_meetings (status);
