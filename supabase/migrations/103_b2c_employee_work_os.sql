-- 103_b2c_employee_work_os.sql
-- Phase B2C-7 · Employee Work OS V1 · Task lifecycle timestamps + block/qc reasons + channel capability.
--
-- Owner directive (2026-08-26):
--   · team_tasks 에 lifecycle timestamp / reason 컬럼 additive 추가
--   · users.b2c_channels JSONB · Assignment V2 대비 (NULL=all B2C channels · []=none · [ch...]=whitelist)
--   · 실제 Pilot execute 는 여전히 금지 · Scheduler/Auto assign OFF 유지 · Migration 만 apply
--
-- Scope (additive · idempotent · CHECK 명시적 allowlist · 기존 데이터 무영향):
--   1) team_tasks.started_at           timestamptz  · task START 시각
--   2) team_tasks.submitted_at         timestamptz  · 직원 결과 SUBMIT (qc_pending 진입) 시각
--   3) team_tasks.blocked_reason       varchar(50)  · BLOCKED 사유 enum
--   4) team_tasks.blocked_at           timestamptz  · BLOCKED 처리 시각
--   5) team_tasks.qc_fail_reason       varchar(50)  · QC FAIL 사유 enum
--   6) team_tasks.qc_resubmit_count    int not null default 0 · 재제출 횟수
--   7) users.b2c_channels              jsonb        · channel capability (nullable)
--   8) CHECK: blocked_reason allowlist · qc_fail_reason allowlist
--
-- Rollback: 하단.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) team_tasks 확장 컬럼
-- ═══════════════════════════════════════════════════════════════════════════
alter table team_tasks
  add column if not exists started_at         timestamptz,
  add column if not exists submitted_at       timestamptz,
  add column if not exists blocked_reason     varchar(50),
  add column if not exists blocked_at         timestamptz,
  add column if not exists qc_fail_reason     varchar(50),
  add column if not exists qc_resubmit_count  integer not null default 0;

comment on column team_tasks.started_at        is 'B2C · 직원 START 시각 (pending → in_progress)';
comment on column team_tasks.submitted_at      is 'B2C · 직원 SUBMIT 시각 (in_progress → qc_pending)';
comment on column team_tasks.blocked_reason    is 'B2C · BLOCKED enum (BRAND_RESTRICTION 등)';
comment on column team_tasks.blocked_at        is 'B2C · BLOCKED 처리 시각';
comment on column team_tasks.qc_fail_reason    is 'B2C · QC FAIL enum';
comment on column team_tasks.qc_resubmit_count is 'B2C · QC FAIL 후 재제출 횟수 · V1 은 총 카운트만';

-- CHECK: blocked_reason allowlist
do $$ begin
  alter table team_tasks add constraint chk_team_tasks_blocked_reason
    check (blocked_reason is null or blocked_reason in (
      'BRAND_RESTRICTION','CATEGORY_UNKNOWN','MISSING_CERTIFICATION',
      'MISSING_PRODUCT_INFO','PLATFORM_ERROR','ACCOUNT_PERMISSION','PRICE_PROBLEM','OTHER'
    ));
exception when duplicate_object then null; end $$;

-- CHECK: qc_fail_reason allowlist
do $$ begin
  alter table team_tasks add constraint chk_team_tasks_qc_fail_reason
    check (qc_fail_reason is null or qc_fail_reason in (
      'WRONG_PRODUCT','WRONG_PRICE','BROKEN_URL','WRONG_CHANNEL',
      'MISSING_REQUIRED_DATA','LISTING_NOT_LIVE','OTHER'
    ));
exception when duplicate_object then null; end $$;

-- index: My Tasks 화면 (assignee + status + priority) · Phase 5 index 는 assignee only 이었음.
--   NEXT TASK 는 (assignee, status IN active, priority_level ASC, priority_score DESC) 로 조회.
--   기존 idx_team_tasks_assignee_active 로 충분하지만 status=qc_pending 은 별도 처리 필요.
--   여기서는 skip (기존 index 재사용).

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) users.b2c_channels (Assignment V2 대비)
-- ═══════════════════════════════════════════════════════════════════════════
--   NULL  = all B2C channels (default · b2c_operator=true 만 로도 대상)
--   []    = no channel · 명시적 배제
--   [...] = whitelist
alter table users
  add column if not exists b2c_channels jsonb;

comment on column users.b2c_channels is
  'B2C · channel capability (Assignment V2). NULL=all · []=none · [coupang,naver,...]=whitelist. b2c_operator=true 와 AND 조건.';

commit;

-- Rollback:
--   begin;
--   alter table users drop column if exists b2c_channels;
--   alter table team_tasks drop constraint if exists chk_team_tasks_qc_fail_reason;
--   alter table team_tasks drop constraint if exists chk_team_tasks_blocked_reason;
--   alter table team_tasks
--     drop column if exists qc_resubmit_count,
--     drop column if exists qc_fail_reason,
--     drop column if exists blocked_at,
--     drop column if exists blocked_reason,
--     drop column if exists submitted_at,
--     drop column if exists started_at;
--   commit;
