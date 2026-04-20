-- Phase 1: 재무 기반 — 지출(expenses) + 정기결제(recurring_payments) + 카테고리 학습 캐시.
-- 수동 입력, CSV 업로드, 정기결제 자동 발행이 모두 이 테이블로 모여 순이익 계산의 기초가 된다.

create table if not exists expenses (
  id serial primary key,
  paid_at date not null,
  amount numeric(14,2) not null,
  currency varchar(4) not null default 'KRW',
  category varchar(60) not null,
  merchant varchar(200),
  memo text,
  source varchar(20) not null default 'manual',  -- 'manual' | 'csv' | 'recurring'
  card_last4 varchar(4),
  task_id integer references team_tasks(id) on delete set null,
  recurring_id integer,
  created_by integer references users(id),
  created_at timestamp not null default now()
);
create index if not exists expenses_paid_at_idx on expenses (paid_at desc);
create index if not exists expenses_category_idx on expenses (category, paid_at desc);
create index if not exists expenses_task_idx on expenses (task_id);
create index if not exists expenses_source_idx on expenses (source);

create table if not exists recurring_payments (
  id serial primary key,
  name varchar(200) not null,
  amount numeric(14,2) not null,
  currency varchar(4) not null default 'KRW',
  category varchar(60) not null,
  cycle varchar(20) not null default 'monthly',  -- monthly | yearly
  day_of_cycle smallint not null default 1,      -- 매달/매년 N일
  next_due_at date not null,
  card_last4 varchar(4),
  memo text,
  active boolean not null default true,
  created_by integer references users(id),
  created_at timestamp not null default now()
);
create index if not exists recurring_payments_due_idx on recurring_payments (next_due_at) where active = true;

-- FK (expenses.recurring_id → recurring_payments.id) — 순환 참조 때문에 alter로 분리
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'expenses_recurring_fk' and table_name = 'expenses'
  ) then
    alter table expenses
      add constraint expenses_recurring_fk
      foreign key (recurring_id) references recurring_payments(id) on delete set null;
  end if;
end $$;

-- 머천트 → 카테고리 학습 캐시. CSV 업로드에서 Gemini 호출로 분류한 결과를 저장해서
-- 다음부터 같은 머천트는 공짜로 즉시 분류.
create table if not exists expense_category_rules (
  id serial primary key,
  merchant_pattern varchar(200) not null,   -- substring 매칭 (lowercase)
  category varchar(60) not null,
  confidence smallint not null default 100, -- 0~100 (수동=100, AI=70~90)
  hit_count integer not null default 0,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);
create unique index if not exists expense_category_rules_merchant_uniq
  on expense_category_rules (merchant_pattern);
create index if not exists expense_category_rules_category_idx
  on expense_category_rules (category);
