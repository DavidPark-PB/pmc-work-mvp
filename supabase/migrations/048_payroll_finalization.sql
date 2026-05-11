-- 048_payroll_finalization.sql
--
-- PR W-G2-B: 2주 급여 확정 + 주휴수당 + 지출관리 자동 연결.
--
-- 사장님 spec 짚을 점 (모두 enforce):
--   1. 시급 미등록 직원 skip + 카운트 (preview/finalize 응답)
--   2. 잠긴 기록 (payroll_period_id IS NOT NULL) 보호 — 이미 045 의 인덱스로 처리
--   3. 주휴수당 수동 OFF: amount=0 + isExcluded=true + excludedBy/excludedAt 보존 (감사)
--   4. 확정 취소 시 expense status='취소됨' (삭제 X — 감사)
--   5. 2주 기간 prefill: 마지막 endDate+1 = 다음 startDate (route 단)
--   6. expenseItemId 중복 방지: cancelled 된 expense 는 새 period 가 새로 만듦. 이력 보존.
--   7. 이상 데이터 무시 가능: ignoreAnomalies=true 면 RPC 호출 (route 단 검증)
--   8. 재확정 = 새 period (cancelled 무시). 기존 employee_payrolls/weekly_holiday_allowances 는 이력 보존
--   9. RPC 단일 트랜잭션: payroll_finalize_period / payroll_cancel_period
--   10. preview 풍부화 = route 단 (anomalies + nullSnapshot + perEmployee + total)
--   11. startDate 월요일 강제 = route 단 validation (KST 기준)
--
-- 신규 테이블:
--   payroll_periods            — 2주 급여 기간 마스터
--   employee_payrolls          — 직원별 정산 결과
--   weekly_holiday_allowances  — 주별 주휴수당 (수동 OFF 가능)
--
-- 추가 컬럼:
--   expenses 에 status / source_type / source_id / paid_by (W-G3 dep, UI 활성은 G3)
--
-- 추가 FK:
--   attendance.payroll_period_id → payroll_periods(id) (045 의 컬럼에 FK 추가)
--
-- Postgres functions:
--   payroll_finalize_period(...) returns int  — 단일 트랜잭션
--   payroll_cancel_period(...)   returns void — 단일 트랜잭션
--
-- Pre-state:  047 적용 (suspicious_buyers)
-- Post-state: 3 신규 테이블 + 4 expenses 컬럼 + 1 attendance FK + 2 functions
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--             FK/Function 은 conditional (DO 블록 / OR REPLACE FUNCTION)
-- 무수정: 037~047 / 다른 모든 모듈 / Safety Foundation

-- ──────────────────────────────────────────────────────────────────────────
-- 1) payroll_periods — 2주 급여 기간 마스터
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists payroll_periods (
  id              serial primary key,
  start_date      date not null,        -- 월요일 (route validation)
  end_date        date not null,        -- 일요일 (start + 13 일)
  payment_date    date not null,        -- 지급 예정일
  status          varchar(20) not null default '계산중',  -- '계산중' | '확정됨' | '지급완료'
  total_amount    numeric(14,2) not null default 0,       -- 확정 시 한 번 계산해서 저장 (일급 합 + 주휴수당 합)
  expense_item_id integer,                                -- 자동 생성된 expense.id (FK 는 그룹 3 dep)
  confirmed_at    timestamp,
  confirmed_by    integer,
  paid_at         timestamp,
  paid_by         integer,
  cancelled_at    timestamp,
  cancelled_by    integer,
  created_at      timestamp not null default now(),
  updated_at      timestamp not null default now()
);

create index if not exists idx_payroll_periods_status_start
  on payroll_periods (status, start_date desc);

create index if not exists idx_payroll_periods_dates
  on payroll_periods (start_date, end_date);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) employee_payrolls — 직원별 정산 결과
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists employee_payrolls (
  id                       serial primary key,
  payroll_period_id        integer not null,
  employee_id              integer not null,
  total_work_hours         numeric(10,2) not null default 0,
  work_days                integer not null default 0,
  wage_total               numeric(14,2) not null default 0,    -- 일급 합
  holiday_allowance_total  numeric(14,2) not null default 0,    -- 주휴수당 합
  total_wage               numeric(14,2) not null default 0,    -- wage_total + holiday_allowance_total
  attendance_record_ids    integer[] not null default '{}',     -- 사장님 짚을 점 8 — 재확정 시 새 period 에서 새로 채움
  created_at               timestamp not null default now(),
  updated_at               timestamp not null default now()
);

create index if not exists idx_employee_payrolls_period
  on employee_payrolls (payroll_period_id);

create index if not exists idx_employee_payrolls_employee
  on employee_payrolls (employee_id, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- 3) weekly_holiday_allowances — 주별 주휴수당 (수동 OFF 가능)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists weekly_holiday_allowances (
  id                   serial primary key,
  employee_id          integer not null,
  payroll_period_id    integer not null,
  week_start_date      date not null,        -- 월요일
  week_end_date        date not null,        -- 일요일
  total_work_hours     numeric(10,2) not null default 0,
  work_days            integer not null default 0,           -- 정상/지각/조퇴 카운트 (휴무/결근 제외)
  average_daily_hours  numeric(10,2) not null default 0,     -- min(8, total_work_hours / work_days)
  hourly_wage_used     numeric(14,2) not null default 0,     -- 주중 평균 hourly_rate_snapshot
  amount               numeric(14,2) not null default 0,     -- average_daily_hours × hourly_wage_used
  is_excluded          boolean not null default false,       -- 사장님 짚을 점 3 — 수동 OFF
  exclude_reason       text,
  excluded_by          integer,
  excluded_at          timestamp,
  created_at           timestamp not null default now(),
  updated_at           timestamp not null default now()
);

create index if not exists idx_weekly_holiday_period
  on weekly_holiday_allowances (payroll_period_id, employee_id);

create index if not exists idx_weekly_holiday_employee_week
  on weekly_holiday_allowances (employee_id, week_start_date desc);

-- ──────────────────────────────────────────────────────────────────────────
-- 4) expenses 에 status/source_type/source_id/paid_by 컬럼 추가 (W-G3 dep)
--   - status: '예정' | '지급완료' | '취소됨'
--   - source_type: 'payroll' (현재) / 향후 다른 source 도 가능
--   - source_id: payroll_periods.id 등 외부 모듈 ID
--   - paid_by: 지급 처리한 user id (paid_at 이미 있음 — 결제일/지급일 의미 통합)
-- ──────────────────────────────────────────────────────────────────────────
alter table expenses add column if not exists status      varchar(20);
alter table expenses add column if not exists source_type varchar(40);
alter table expenses add column if not exists source_id   integer;
alter table expenses add column if not exists paid_by     integer;  -- user id who marked as paid (NULL = 아직 미지급)

-- 기존 expenses 의 status NULL → '지급완료' (기존 데이터는 모두 결제 완료된 거라 가정)
update expenses set status = '지급완료' where status is null;

create index if not exists idx_expenses_source
  on expenses (source_type, source_id)
  where source_type is not null;

create index if not exists idx_expenses_status
  on expenses (status)
  where status is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) FK constraints (conditional)
-- ──────────────────────────────────────────────────────────────────────────

-- attendance.payroll_period_id → payroll_periods(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_attendance_payroll_period') then
    raise notice '[048] fk_attendance_payroll_period already exists — skip';
  else
    alter table attendance
      add constraint fk_attendance_payroll_period
      foreign key (payroll_period_id) references payroll_periods(id) on delete set null;
    raise notice '[048] fk_attendance_payroll_period ADDED';
  end if;
end $$;

-- employee_payrolls.payroll_period_id → payroll_periods(id) on delete cascade
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_employee_payrolls_period') then
    raise notice '[048] fk_employee_payrolls_period already exists — skip';
  else
    alter table employee_payrolls
      add constraint fk_employee_payrolls_period
      foreign key (payroll_period_id) references payroll_periods(id) on delete cascade;
    raise notice '[048] fk_employee_payrolls_period ADDED';
  end if;
end $$;

-- weekly_holiday_allowances.payroll_period_id → payroll_periods(id) on delete cascade
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_weekly_holiday_period') then
    raise notice '[048] fk_weekly_holiday_period already exists — skip';
  else
    alter table weekly_holiday_allowances
      add constraint fk_weekly_holiday_period
      foreign key (payroll_period_id) references payroll_periods(id) on delete cascade;
    raise notice '[048] fk_weekly_holiday_period ADDED';
  end if;
end $$;

-- payroll_periods.expense_item_id → expenses(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_payroll_periods_expense') then
    raise notice '[048] fk_payroll_periods_expense already exists — skip';
  else
    alter table payroll_periods
      add constraint fk_payroll_periods_expense
      foreign key (expense_item_id) references expenses(id) on delete set null;
    raise notice '[048] fk_payroll_periods_expense ADDED';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) Postgres function: payroll_finalize_period
--   사장님 짚을 점 9 — 단일 트랜잭션. Node 의 service 가 계산한 결과를 args 로 받아 INSERT.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function payroll_finalize_period(
  p_start_date         date,
  p_end_date           date,
  p_payment_date       date,
  p_executed_by        integer,
  p_total_amount       numeric,
  p_employee_payrolls  jsonb,           -- [{employee_id, total_work_hours, work_days, wage_total, holiday_allowance_total, total_wage, attendance_record_ids[]}]
  p_weekly_allowances  jsonb,           -- [{employee_id, week_start_date, week_end_date, total_work_hours, work_days, average_daily_hours, hourly_wage_used, amount}]
  p_attendance_ids     integer[]        -- 잠글 attendance ids (모든 employee 의 record 합산)
) returns integer
language plpgsql
as $$
declare
  v_period_id integer;
  v_expense_id integer;
  v_ep jsonb;
  v_wa jsonb;
begin
  -- 1) payroll_periods INSERT
  insert into payroll_periods (
    start_date, end_date, payment_date, status, total_amount,
    confirmed_at, confirmed_by
  ) values (
    p_start_date, p_end_date, p_payment_date, '확정됨', p_total_amount,
    now(), p_executed_by
  ) returning id into v_period_id;

  -- 2) employee_payrolls INSERT
  for v_ep in select * from jsonb_array_elements(p_employee_payrolls)
  loop
    insert into employee_payrolls (
      payroll_period_id, employee_id, total_work_hours, work_days,
      wage_total, holiday_allowance_total, total_wage, attendance_record_ids
    ) values (
      v_period_id,
      (v_ep->>'employee_id')::integer,
      (v_ep->>'total_work_hours')::numeric,
      (v_ep->>'work_days')::integer,
      (v_ep->>'wage_total')::numeric,
      (v_ep->>'holiday_allowance_total')::numeric,
      (v_ep->>'total_wage')::numeric,
      coalesce(
        array(select jsonb_array_elements_text(v_ep->'attendance_record_ids'))::integer[],
        '{}'::integer[]
      )
    );
  end loop;

  -- 3) weekly_holiday_allowances INSERT
  for v_wa in select * from jsonb_array_elements(p_weekly_allowances)
  loop
    insert into weekly_holiday_allowances (
      employee_id, payroll_period_id,
      week_start_date, week_end_date,
      total_work_hours, work_days, average_daily_hours,
      hourly_wage_used, amount
    ) values (
      (v_wa->>'employee_id')::integer,
      v_period_id,
      (v_wa->>'week_start_date')::date,
      (v_wa->>'week_end_date')::date,
      (v_wa->>'total_work_hours')::numeric,
      (v_wa->>'work_days')::integer,
      (v_wa->>'average_daily_hours')::numeric,
      (v_wa->>'hourly_wage_used')::numeric,
      (v_wa->>'amount')::numeric
    );
  end loop;

  -- 4) attendance 잠금: payroll_period_id 채우고 is_payroll_locked=true
  if array_length(p_attendance_ids, 1) > 0 then
    update attendance
      set payroll_period_id = v_period_id,
          is_payroll_locked = true,
          updated_at = now()
      where id = any(p_attendance_ids)
        and payroll_period_id is null;  -- race condition 방어 (이미 잠긴 건 skip)
  end if;

  -- 5) expenses 자동 생성 (status='예정', source_type='payroll', source_id=period_id)
  insert into expenses (
    paid_at, amount, currency, category, merchant, memo,
    source, source_type, source_id, status, created_by, created_at
  ) values (
    p_payment_date, p_total_amount, 'KRW', '인건비',
    '급여 ' || to_char(p_start_date, 'YYYY-MM-DD') || ' ~ ' || to_char(p_end_date, 'YYYY-MM-DD'),
    '자동 생성 — payroll_period_id=' || v_period_id::text,
    'manual',                  -- 기존 source 컬럼 (manual/csv/recurring) 호환
    'payroll',                 -- 신규 source_type
    v_period_id,               -- 신규 source_id
    '예정',                     -- 신규 status
    p_executed_by,
    now()
  ) returning id into v_expense_id;

  -- 6) payroll_periods 에 expense_item_id 연결
  update payroll_periods
    set expense_item_id = v_expense_id,
        updated_at = now()
    where id = v_period_id;

  return v_period_id;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7) Postgres function: payroll_cancel_period
--   사장님 짚을 점 4 — expense status='취소됨' (삭제 X). 사장님 짚을 점 9 — 단일 트랜잭션.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function payroll_cancel_period(
  p_period_id    integer,
  p_executed_by  integer
) returns void
language plpgsql
as $$
declare
  v_expense_id integer;
  v_status     varchar(20);
begin
  -- 1) period 존재 + status 검증
  select status, expense_item_id into v_status, v_expense_id
    from payroll_periods where id = p_period_id;
  if not found then
    raise exception 'payroll_periods id=% not found', p_period_id;
  end if;
  if v_status = '계산중' then
    raise exception 'payroll_period id=% 는 이미 계산중 (취소 불필요)', p_period_id;
  end if;

  -- 2) attendance 잠금 해제
  update attendance
    set payroll_period_id = null,
        is_payroll_locked = false,
        updated_at = now()
    where payroll_period_id = p_period_id;

  -- 3) period 상태 변경
  update payroll_periods
    set status = '계산중',
        cancelled_at = now(),
        cancelled_by = p_executed_by,
        confirmed_at = null,    -- 재확정 시 새 confirmed_at
        confirmed_by = null,
        paid_at = null,
        paid_by = null,
        updated_at = now()
    where id = p_period_id;

  -- 4) expense status='취소됨' (삭제 X)
  if v_expense_id is not null then
    update expenses
      set status = '취소됨', memo = coalesce(memo, '') || E'\n[취소: ' || to_char(now(), 'YYYY-MM-DD') || ']'
      where id = v_expense_id;
  end if;

  -- 5) employee_payrolls / weekly_holiday_allowances 는 보관 (이력)
  --    재확정 시엔 새 period_id 로 새로 INSERT (사장님 짚을 점 8)
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 8) Postgres function: payroll_mark_paid
--   확정된 period → 지급완료. expense status='지급완료' + paid_by 채움.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function payroll_mark_paid(
  p_period_id    integer,
  p_executed_by  integer
) returns void
language plpgsql
as $$
declare
  v_expense_id integer;
  v_status     varchar(20);
begin
  select status, expense_item_id into v_status, v_expense_id
    from payroll_periods where id = p_period_id;
  if not found then
    raise exception 'payroll_periods id=% not found', p_period_id;
  end if;
  if v_status <> '확정됨' then
    raise exception 'payroll_period id=% 는 확정됨 상태가 아님 (%)', p_period_id, v_status;
  end if;

  update payroll_periods
    set status = '지급완료',
        paid_at = now(),
        paid_by = p_executed_by,
        updated_at = now()
    where id = p_period_id;

  if v_expense_id is not null then
    update expenses
      set status = '지급완료',
          paid_at = current_date,
          paid_by = p_executed_by
      where id = v_expense_id;
  end if;
end;
$$;

-- Rollback (수동):
--   drop function if exists payroll_mark_paid(integer, integer);
--   drop function if exists payroll_cancel_period(integer, integer);
--   drop function if exists payroll_finalize_period(date, date, date, integer, numeric, jsonb, jsonb, integer[]);
--   alter table payroll_periods drop constraint if exists fk_payroll_periods_expense;
--   alter table weekly_holiday_allowances drop constraint if exists fk_weekly_holiday_period;
--   alter table employee_payrolls drop constraint if exists fk_employee_payrolls_period;
--   alter table attendance drop constraint if exists fk_attendance_payroll_period;
--   drop index if exists idx_expenses_status;
--   drop index if exists idx_expenses_source;
--   alter table expenses drop column if exists paid_by;
--   alter table expenses drop column if exists source_id;
--   alter table expenses drop column if exists source_type;
--   alter table expenses drop column if exists status;
--   drop table if exists weekly_holiday_allowances;
--   drop table if exists employee_payrolls;
--   drop table if exists payroll_periods;
