-- 101_b2c_queue_config.sql
-- Phase B2C-5 · Controlled Task Queue · Config seeds + data_quality dedup index.
--
-- Owner directive (2026-08-25):
--   · 7,234 후보를 한 번에 team_tasks 에 INSERT 하지 말 것.
--   · active queue 를 target 300 / threshold 200 / max_per_refill 150 로 통제.
--   · DATA_QUALITY task 는 별도 · channel=NULL · SKU 당 1개.
--   · include_p3 default false.
--
-- Scope (additive · idempotent):
--   1) margin_settings seed 5개
--   2) team_tasks · data_quality.cost_missing 전용 partial UNIQUE index (기존 dedupe 와 별개)
--      · 기존 uq_team_tasks_b2c_active_dedupe 는 channel NOT NULL 조건이라 data_quality (channel=NULL) 미커버
--
-- Rollback: 하단.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) margin_settings config seed
-- ═══════════════════════════════════════════════════════════════════════════
--   숫자 인코딩:
--     b2c.include_p3          : 0=false (default) · 1=true
--
insert into margin_settings(setting_key, setting_value, label, category) values
  ('b2c.active_queue_target',            300, 'B2C · 활성 CHANNEL_REGISTER task 목표 수 (Queue refill target)',       'b2c_inventory'),
  ('b2c.active_queue_refill_threshold',  200, 'B2C · 활성 task 이 이 값 미만이면 refill 실행',                          'b2c_inventory'),
  ('b2c.max_tasks_per_refill',           150, 'B2C · refill 1회당 최대 생성 task 수 (7000 대량 생성 방어)',            'b2c_inventory'),
  ('b2c.cost_missing_sales_threshold',   3,   'B2C · sales_90d >= 이 값 AND cost NULL 이면 DATA_QUALITY task 후보',    'b2c_inventory'),
  ('b2c.include_p3',                     0,   'B2C · Queue refill 에 P3 포함 여부 (0=false default · 1=true)',        'b2c_inventory')
on conflict (setting_key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) DATA_QUALITY dedup UNIQUE partial index
--    기존 uq_team_tasks_b2c_active_dedupe 는 channel NOT NULL 이라 data_quality 미커버.
--    새 index 는 channel 없이 (related_sku_id, exception_type) 로 dedup.
-- ═══════════════════════════════════════════════════════════════════════════
create unique index if not exists uq_team_tasks_b2c_data_quality_dedupe
  on team_tasks(related_sku_id, exception_type)
  where related_sku_id is not null
    and status in ('pending','in_progress','qc_pending')
    and exception_type in (
      'data_quality.cost_missing',
      'data_quality.title_missing',
      'data_quality.sku_mapping_missing'
    );

commit;

-- Rollback:
--   begin;
--   drop index if exists uq_team_tasks_b2c_data_quality_dedupe;
--   delete from margin_settings where setting_key in (
--     'b2c.active_queue_target','b2c.active_queue_refill_threshold',
--     'b2c.max_tasks_per_refill','b2c.cost_missing_sales_threshold','b2c.include_p3'
--   );
--   commit;
