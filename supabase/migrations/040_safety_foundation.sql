-- 040_safety_foundation.sql
--
-- Safety Foundation (Phase 3 PR S) — extend automation_runs to be the canonical
-- execution audit log for ALL user-initiated actions (mock import, future price
-- change, shipping, label, manual SKU link) AND existing automated workflows.
--
-- Strategy: extend (NOT new tables). Phase 1 's automation_runs already covers
-- ~60% of the audit requirement. This migration adds query-able executor /
-- target / rollback metadata.
--
-- Pre-state:  039 applied (wms_orders / wms_order_lines + FK).
-- Post-state: automation_runs has 10 new nullable columns + 4 new indexes.
--             All existing rows (likely 0 — Phase 1 schema only) keep NULLs.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
--
-- Plan:  docs/phase-3-safety-foundation-plan.md
-- Scope: 4 files (this SQL + safetyExec.js + mockOrderImport.js + Drizzle sync)

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Extend automation_runs
-- ──────────────────────────────────────────────────────────────────────────
alter table automation_runs
  -- 1a. Query-able executor (denormalized from triggered_by 'user:{id}')
  --     NULLABLE: legacy admin (userId=0) and cron-only runs leave this NULL.
  --     For legacy admin, helper writes 'legacy_admin' to existing triggered_by.
  add column if not exists executed_by_user_id integer
    references users(id) on delete set null,

  -- 1b. Specific action name (more granular than automation_type).
  --     Examples: 'mock_order_import', 'price_change', 'shipping_create',
  --               'label_create', 'sku_link_manual', 'rollback'
  add column if not exists action_name varchar(100),

  -- 1c. Target row pointer (table_name + integer id; flexible across tables).
  --     For 'mock_order_import' this is ('wms_orders', N).
  --     For 'rollback' this is the same as the original run's target.
  add column if not exists target_table varchar(100),
  add column if not exists target_id    integer,

  -- 1d. Rollback metadata (set at runAction time, BEFORE the action runs)
  --     'auto'         — rollback can be performed by a known SQL/API call
  --     'manual'       — admin must inspect rollback_hint and act manually
  --     'irreversible' — cannot be undone (e.g., external email sent)
  add column if not exists rollback_method varchar(20),
  add column if not exists rollback_hint   text,

  -- 1e. Rollback execution record (set when rollbackAction is called)
  --
  --     rollback_run_id 의미 (단방향 포인터):
  --       - 원본 run row     → 이 컬럼 = 자신을 되돌린 rollback run 의 id
  --       - rollback run row → 이 컬럼 = NULL
  --                            input_snapshot.original_run_id 에 원본 id 저장
  --     즉 "원본 → rollback" 방향만 가리키며, 역방향 추적은 input_snapshot 으로.
  add column if not exists rolled_back_at  timestamp without time zone,
  add column if not exists rolled_back_by  integer
    references users(id) on delete set null,
  add column if not exists rollback_run_id integer
    references automation_runs(id) on delete set null,
  add column if not exists rollback_reason text;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Indexes for canonical query paths
-- ──────────────────────────────────────────────────────────────────────────
create index if not exists idx_automation_runs_executed_by
  on automation_runs(executed_by_user_id);

create index if not exists idx_automation_runs_action_status
  on automation_runs(action_name, status);

create index if not exists idx_automation_runs_target
  on automation_runs(target_table, target_id);

-- Partial index — only rows that need attention
create index if not exists idx_automation_runs_rollback_required
  on automation_runs(action_name) where status = 'rollback_required';

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Status enum extension (varchar — no DB constraint change, doc only)
-- ──────────────────────────────────────────────────────────────────────────
comment on column automation_runs.status is
  'pending | started | succeeded | failed | aborted | cancelled | rollback_required | rolled_back';

comment on column automation_runs.action_name is
  'mock_order_import | price_change | shipping_create | label_create | sku_link_manual | rollback | ...';

comment on column automation_runs.rollback_method is
  'auto | manual | irreversible';
