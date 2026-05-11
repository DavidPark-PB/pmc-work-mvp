-- 045_attendance_payroll_link.sql
--
-- PR W-G1: attendance ↔ payroll_periods 연결을 위한 컬럼 미리 등록.
--   그룹 1 시점엔 UI 미활성. 그룹 2 (PR W-G2-B) 에서 payroll_periods 테이블 + service 가 채움.
--   미리 add 하는 이유 = 시급 재계산 / 이상 뱃지 함수가 `payroll_period_id IS NULL` 필터 사용 (잠긴 기록 보호).
--
-- 추가 컬럼 (attendance):
--   payroll_period_id   integer NULL  — 확정된 PayrollPeriod 의 id. 미확정 = NULL.
--   is_payroll_locked   boolean default false  — 명시적 잠금 플래그 (UI 빠른 체크)
--
-- 인덱스:
--   idx_attendance_payroll_period_active — 확정된 기록만 빠른 join (WHERE payroll_period_id IS NOT NULL)
--
-- 정책:
--   - FK 는 그룹 2 의 payroll_periods 생성 후 추가 (본 마이그레이션은 미설정 — 의존 순환 회피)
--   - 시급 재계산 / 시급 변경 영향 X: payroll_period_id IS NOT NULL 인 row 는 모든 변경에서 자동 제외
--
-- Pre-state:  044 적용 (purchase_requests phase1a)
-- Post-state: attendance 2 컬럼 + 1 인덱스
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- 무수정: 037~044 / Phase 1 컬럼 / Safety Foundation / opportunity_inbox / drafts / team_task_comments

alter table attendance add column if not exists payroll_period_id integer;
alter table attendance add column if not exists is_payroll_locked boolean default false;

-- 기존 row 의 is_payroll_locked NULL 보정 (default 는 새 row 에만 적용됨)
update attendance set is_payroll_locked = false where is_payroll_locked is null;

create index if not exists idx_attendance_payroll_period_active
  on attendance (payroll_period_id) where payroll_period_id is not null;

-- Rollback (수동):
--   drop index if exists idx_attendance_payroll_period_active;
--   alter table attendance drop column if exists is_payroll_locked;
--   alter table attendance drop column if exists payroll_period_id;
