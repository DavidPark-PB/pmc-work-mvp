-- 102_b2c_execution_engine.sql
-- Phase B2C-6 · Execution Engine V1 · Scheduler + Auto Assignment · 모두 DEFAULT OFF.
--
-- Owner directive (2026-08-25):
--   · Scheduler / Auto Assignment 구현하되 default OFF.
--   · Owner 명시적 활성화 전까지 자동 실행 금지.
--   · "임의로 모든 user 에게 배정 금지" → users.b2c_operator boolean 신규 컬럼 · admin 이 활성.
--
-- Scope (additive · idempotent):
--   1) users.b2c_operator boolean not null default false
--   2) margin_settings seed 3개 (모두 0=OFF)
--        · b2c.scheduler_enabled
--        · b2c.auto_assignment_enabled
--        · b2c.data_quality_auto_enabled
--   3) Scheduler cron expression 은 코드에 default '30 9 * * *' · env B2C_SCHEDULER_CRON 로 override
--      (margin_settings 는 NUMERIC 이라 string 저장 불가 · 새 KV 테이블 만들지 않음 · Owner 지침 준수)
--
-- Rollback: 하단.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) users.b2c_operator (auto assignment 대상 지정)
-- ═══════════════════════════════════════════════════════════════════════════
--   default false → 명시 opt-in 안 하면 auto assignment 대상 아님.
--   admin 이 관리자 UI 또는 UPDATE users SET b2c_operator=true WHERE id=... 로 활성.
alter table users
  add column if not exists b2c_operator boolean not null default false;

comment on column users.b2c_operator is
  'B2C · Auto Assignment 대상 여부. admin 이 명시적 opt-in. default false.';

--   index — assignment 쿼리 최적화 (매번 refill 시 eligible users 조회)
create index if not exists idx_users_b2c_operator
  on users(id) where b2c_operator = true and is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) margin_settings seed · 모두 0=OFF
-- ═══════════════════════════════════════════════════════════════════════════
insert into margin_settings(setting_key, setting_value, label, category) values
  ('b2c.scheduler_enabled',           0, 'B2C · Scheduler 자동 실행 (0=OFF default · 1=ON)',           'b2c_inventory'),
  ('b2c.auto_assignment_enabled',     0, 'B2C · Auto assignment 활성 (0=OFF default · 1=ON)',         'b2c_inventory'),
  ('b2c.data_quality_auto_enabled',   0, 'B2C · DATA_QUALITY scheduler 자동 refill (0=OFF · 1=ON)',   'b2c_inventory')
on conflict (setting_key) do nothing;

commit;

-- Rollback:
--   begin;
--   delete from margin_settings where setting_key in (
--     'b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled'
--   );
--   drop index if exists idx_users_b2c_operator;
--   alter table users drop column if exists b2c_operator;
--   commit;
