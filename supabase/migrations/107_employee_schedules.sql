-- 107_employee_schedules.sql
-- Owner Directive (2026-09-04) · 직원 일정 시스템
--
-- 목적:
--   각 직원이 · 개인 일정 (휴가/외근/회의) · 업무 일정 · 등록.
--   메인 대시보드 · 캘린더 view · 모든 직원 일정 통합 표시.
--   근무일정은 · 출퇴근 데이터 (attendance) 와 · 별도 연동 (이 테이블 저장 X).
--
-- 조회 정책: 모두 서로 다 봄 (all employees can view all)
-- 편집 정책: 본인 · 또는 admin

create table if not exists employee_schedules (
  id            bigserial primary key,
  user_id       integer not null,                              -- users(id)
  event_type    varchar(30) not null,                          -- 'vacation'|'half_day'|'outside'|'meeting'|'task'|'other'
  title         varchar(200) not null,
  description   text,
  event_date    date not null,                                 -- 시작일
  end_date      date,                                          -- 종료일 (여러 일 연속 · null 이면 단일 일)
  all_day       boolean not null default true,
  start_time    time,                                          -- all_day=false 인 경우
  end_time      time,
  color         varchar(20),                                   -- 캘린더 표시 색 (직원별 자동 or 이벤트별)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_employee_schedules_date
  on employee_schedules (event_date);

create index if not exists idx_employee_schedules_user_date
  on employee_schedules (user_id, event_date);

create index if not exists idx_employee_schedules_range
  on employee_schedules (event_date, end_date);

comment on table employee_schedules is
  '직원 일정 (개인 · 업무). 근무일정은 attendance 테이블에서 별도 연동 · 여기 저장 안 함. (Owner Directive 2026-09-04)';
comment on column employee_schedules.event_type is
  'vacation(연차) · half_day(반차) · outside(외근) · meeting(회의) · task(업무) · other(기타)';
