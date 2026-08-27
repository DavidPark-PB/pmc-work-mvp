-- 098_b2c_inventory_distribution.sql
-- Phase B2C-2 · B2C Inventory Distribution OS · Schema foundation
--
-- Owner directives (2026-08-25):
--   · Q1 apply via scripts/apply-098-b2c-inventory.js (dry-run supported)
--   · Q2 V1 auto-Task 대상 채널: coupang, naver, 11st, gmarket 만
--   · Q3 sku_master.id 매칭 실패 시 SKIP + 로그
--   · channel_eligibility NULL 은 "모두 eligible" 이 아님 —
--     별도 config b2c.default_eligibility_mode (0=NONE · 1=KOREA_ALL) 로 제어.
--     V1 default = NONE (기존 SKU 에 자동 대량 Task 생성 방지).
--
-- Scope (additive · no legacy break · idempotent):
--   1) sku_master.channel_eligibility  JSONB (nullable)
--   2) team_tasks 확장 컬럼 9개 (priority_level, priority_score, channel,
--       qc_status, qc_user_id, qc_at, listing_id, listing_url, selling_price)
--   3) team_tasks CHECK constraints (priority_level allowlist · qc_status allowlist)
--   4) team_tasks 인덱스 3개 (status+priority · assignee+status · dedupe partial UNIQUE)
--   5) margin_settings config seed 7개 (b2c.* 네임스페이스)
--   6) 뷰 3개 (v_sku_channel_matrix · v_sku_b2c_scorecard · v_staff_b2c_kpi)
--
-- Probe 결과 반영 (2026-08-25):
--   · team_tasks 총 1073 · related_sku_id=0 (기존 pricing exception 은 SKU-less)
--     → 새 dedupe partial index 는 기존 데이터에 영향 0
--   · team_tasks.priority 100% 'normal' · status 'pending/done/in_progress' 만 사용
--   · exception_type 기존값: SKU_MATCH_FAILED, LANDING_COST_DATA_MISSING (pricing 계열)
--     → B2C 값 (channel_register.*, listing_error, qc) 은 명백히 분리된 namespace
--   · inventory_movements 4행만 (미사용) → stock_qty 는 platform_listings.quantity 우선
--   · sku_master.created_at → stock_age_days fallback (inventory_movements 미완)
--   · platform_listings.status 실 사용값: active/error/ended (ebay/shopify),
--     SALE/OUTOFSTOCK/SUSPENSION (naver), NORMAL (shopee), approved (alibaba)
--   · sku_master 총 9482 · active 2792 · platform_listings.sku ↔ sku_master.internal_sku 조인
--
-- Dependencies: 004 (margin_settings) · 038 (sku_master · team_tasks · sku_listing_link)
--               078-079 (oms_orders · oms_order_items) · 097 (marketplace_identity)
--
-- Rollback: 파일 하단.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) sku_master.channel_eligibility (JSONB · nullable)
-- ═══════════════════════════════════════════════════════════════════════════
-- 의미:
--   NULL  = 미설정 · 자동 Task 생성 여부는 config b2c.default_eligibility_mode 로 결정
--   []    = 명시적 배제 · 어느 채널에도 자동 등록 안 함
--   ["coupang","naver"] = 화이트리스트 · 나열된 채널에만 자동 Task 생성
alter table sku_master
  add column if not exists channel_eligibility jsonb;

comment on column sku_master.channel_eligibility is
  'B2C · 채널 화이트리스트 (nullable). NULL=config default 모드 · []=배제 · [ebay,coupang,...]=명시';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) team_tasks 확장 컬럼
-- ═══════════════════════════════════════════════════════════════════════════
alter table team_tasks
  add column if not exists priority_level    varchar(4),
  add column if not exists priority_score    numeric(5,2),
  add column if not exists channel           varchar(50),
  add column if not exists qc_status         varchar(10),
  add column if not exists qc_user_id        integer,
  add column if not exists qc_at             timestamptz,
  add column if not exists listing_id        varchar(200),
  add column if not exists listing_url       text,
  add column if not exists selling_price     numeric(12,2);

comment on column team_tasks.priority_level  is 'B2C · p0(critical)/p1(high)/p2(normal)/p3(low). NULL=레거시 태스크';
comment on column team_tasks.priority_score  is 'B2C · 0..100 · 같은 priority_level 내 정렬 tie-breaker';
comment on column team_tasks.channel         is 'B2C · 대상 채널 (ebay/shopify/coupang/naver/11st/gmarket 등)';
comment on column team_tasks.qc_status       is 'B2C · pending/pass/fail · qc 대상 태스크만';
comment on column team_tasks.listing_id      is 'B2C · 직원이 등록완료 시 입력한 marketplace listing id';
comment on column team_tasks.listing_url     is 'B2C · 등록된 리스팅 URL';
comment on column team_tasks.selling_price   is 'B2C · 등록 시 판매가 (channel 통화 기준)';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) CHECK constraints (allowlist 강제)
-- ═══════════════════════════════════════════════════════════════════════════
--   IF NOT EXISTS 를 CHECK 에 직접 쓸 수 없으므로 DO 블록 + duplicate_object 처리
do $$ begin
  alter table team_tasks add constraint chk_team_tasks_priority_level
    check (priority_level is null or priority_level in ('p0','p1','p2','p3'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table team_tasks add constraint chk_team_tasks_qc_status
    check (qc_status is null or qc_status in ('pending','pass','fail'));
exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) 인덱스 3개
-- ═══════════════════════════════════════════════════════════════════════════
--   4a. 활성 태스크 정렬 index (My Tasks 리스트 · Owner Dashboard backlog)
--       partial 로 done/failed 제외 → 인덱스 크기 최소
create index if not exists idx_team_tasks_active_priority
  on team_tasks(status, priority_level, priority_score desc nulls last, created_at)
  where status in ('pending','in_progress','qc_pending');

--   4b. 직원별 활성 태스크 (My Tasks 로그인 사용자 필터)
create index if not exists idx_team_tasks_assignee_active
  on team_tasks(assignee_id, priority_level, priority_score desc nulls last)
  where assignee_id is not null and status in ('pending','in_progress','qc_pending');

--   4c. 중복 방지 partial UNIQUE — B2C 채널 등록/에러 태스크 한정
--       조건: (related_sku_id, channel, exception_type) tuple + 활성 status
--             + exception_type IN (B2C 값) → 기존 pricing 태스크 (exception_type=SKU_MATCH_FAILED 등) 미영향
--       이유: 같은 SKU+채널에 이미 WAITING/WORKING/QC_PENDING 태스크가 있으면 새로 생성 금지
create unique index if not exists uq_team_tasks_b2c_active_dedupe
  on team_tasks(related_sku_id, channel, exception_type)
  where related_sku_id is not null
    and channel is not null
    and status in ('pending','in_progress','qc_pending')
    and exception_type in (
      'channel_register.ebay',
      'channel_register.shopify',
      'channel_register.coupang',
      'channel_register.naver',
      'channel_register.11st',
      'channel_register.gmarket',
      'channel_register.auction',
      'listing_error'
    );

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) margin_settings seed (config · setting_value NUMERIC(12,4))
-- ═══════════════════════════════════════════════════════════════════════════
--   setting_value 는 NUMERIC 이라 문자열 enum 은 정수로 인코딩:
--     b2c.default_eligibility_mode:  0=NONE (V1 default) · 1=KOREA_ALL
--     b2c.purchase_gate_mode:        0=OFF   · 1=WARNING (V1 default) · 2=BLOCK
insert into margin_settings(setting_key, setting_value, label, category) values
  ('b2c.default_eligibility_mode',   0,      'channel_eligibility=NULL 인 SKU 처리 (0=NONE · 1=KOREA_ALL)', 'b2c_inventory'),
  ('b2c.old_stock_days',             60,     '재고 나이 기준 (일) · Priority Score stock age 시작값',       'b2c_inventory'),
  ('b2c.very_old_stock_days',        90,     '고령 재고 기준 (일) · Priority Score 100% 부여값',            'b2c_inventory'),
  ('b2c.high_value_threshold_krw',   500000, '고가 재고 임계 (원) · P0 조건',                                'b2c_inventory'),
  ('b2c.sales_validation_days',      90,     'eBay/Shopify 판매 검증 window (일)',                          'b2c_inventory'),
  ('b2c.purchase_gate_coverage_pct', 60,     '발주 경고 coverage 임계 (%)',                                 'b2c_inventory'),
  ('b2c.purchase_gate_mode',         1,      '발주 gate: 0=OFF · 1=WARNING · 2=BLOCK',                     'b2c_inventory')
on conflict (setting_key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) 뷰 3개
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 6a. v_sku_channel_matrix — SKU × 채널 상태 pivot (§4 상세화면 · §6 coverage) ──
--   Source: sku_master (canonical) LEFT JOIN sku_listing_link (매핑) LEFT JOIN platform_listings (상태/가격)
--   Status 정규화 (probe 실측값 기준):
--     LIVE   = ebay/shopify:active · naver:SALE · shopee:NORMAL · alibaba:approved
--     ERROR  = %error%
--     ENDED  = %ended% · OUTOFSTOCK (판매불가)
--     PAUSED = SUSPENSION · %pause% · %hold%
--     READY  = listing_id 있으나 status 매칭 안 되는 경우
--     NONE   = 매핑/리스팅 없음
create or replace view v_sku_channel_matrix as
select
  sm.id                           as sku_master_id,
  sm.internal_sku,
  sm.title,
  coalesce(sll.marketplace, pl.platform)  as channel,
  coalesce(sll.listing_id, pl.platform_item_id)  as listing_id,
  sll.marketplace_sku,
  pl.status                       as raw_status,
  case
    when pl.status is null and sll.listing_id is null                       then 'NONE'
    when lower(pl.status) in ('active','sale','normal','approved')          then 'LIVE'
    when lower(pl.status) like '%error%'                                    then 'ERROR'
    when lower(pl.status) like '%ended%' or upper(pl.status)='OUTOFSTOCK'   then 'ENDED'
    when upper(pl.status)='SUSPENSION' or lower(pl.status) like '%pause%'
      or lower(pl.status) like '%hold%'                                     then 'PAUSED'
    when lower(pl.status) like '%block%'                                    then 'BLOCKED'
    when lower(pl.status) like '%draft%' or lower(pl.status) like '%working%' then 'WORKING'
    when sll.listing_id is not null or pl.platform_item_id is not null      then 'READY'
    else 'NONE'
  end                             as channel_status,
  pl.price                        as selling_price,
  pl.currency                     as selling_currency,
  pl.listing_url,
  coalesce(pl.updated_at, pl.last_synced_at) as last_checked_at
from sku_master sm
left join sku_listing_link sll on sll.sku_id = sm.id
left join platform_listings pl
       on (sll.marketplace is not null
           and pl.platform = sll.marketplace
           and pl.platform_item_id = sll.listing_id)
       or (sll.marketplace is null
           and pl.sku = sm.internal_sku)
where sm.status='active';

comment on view v_sku_channel_matrix is
  'B2C · SKU × 채널 상태 pivot (active SKU 만). channel_status: NONE/READY/WORKING/LIVE/ERROR/ENDED/PAUSED/BLOCKED';

-- ── 6b. v_sku_b2c_scorecard — SKU 당 파생값 한 줄 (§5 · §7 · §8) ──
--   Source (probe 반영):
--     stock_qty   = platform_listings.quantity 중 LIVE-ish 최대값 (ebay/shopify/naver/shopee 실질 재고 mirror)
--                   inventory_movements 미완이라 fallback 아님
--     unit_cost   = sku_master.cost_krw
--     stock_age   = MIN(inventory_movements.occurred_at) FILTER receipt, fallback sku_master.created_at
--     sales_*     = oms_order_items × oms_orders 90d GROUP BY sku_master_id, channel
create or replace view v_sku_b2c_scorecard as
with recent_sales as (
  select
    oi.sku_master_id,
    o.channel,
    sum(oi.quantity)                                                  as qty_sold,
    sum(oi.quantity * oi.unit_price - coalesce(oi.discount, 0))       as gmv
  from oms_order_items oi
  join oms_orders o on o.id = oi.order_id
  where o.ordered_at > now() - interval '90 days'
    and o.cancelled_at is null
    and coalesce(o.order_status, '') <> 'cancelled'
    and oi.sku_master_id is not null
  group by oi.sku_master_id, o.channel
),
recent_sales_30 as (
  select
    oi.sku_master_id,
    sum(oi.quantity) as qty_30d
  from oms_order_items oi
  join oms_orders o on o.id = oi.order_id
  where o.ordered_at > now() - interval '30 days'
    and o.cancelled_at is null
    and coalesce(o.order_status, '') <> 'cancelled'
    and oi.sku_master_id is not null
  group by oi.sku_master_id
),
sales_pivot as (
  select
    sku_master_id,
    sum(qty_sold)                                                    as sales_90d,
    sum(qty_sold) filter (where channel='ebay')                      as ebay_sales_90d,
    sum(qty_sold) filter (where channel='shopify')                   as shopify_sales_90d,
    sum(gmv)                                                          as gmv_90d
  from recent_sales
  group by sku_master_id
),
stock_by_platform as (
  --   Stock source 우선순위 (probe 2026-08-25):
  --     · ebay_products.stock — 항상 유지됨 · 1000 active listings 모두 값 있음 (696 stock=0, 210 <10, 84 10+)
  --     · platform_listings.quantity — naver/shopify 등 확장 소스. 단 sku 컬럼 대량 NULL (naver 666/700)
  --   → greatest 로 두 소스 결합. 어느 한 쪽만 있어도 반영됨.
  --   inventory_movements 는 아직 4행뿐 (미완) 이라 제외.
  select
    sm.id                                                                 as sku_master_id,
    greatest(
      coalesce(max(ep.stock),        0),
      coalesce(max(pl.quantity) filter (where lower(pl.status) in ('active','sale','normal','approved')), 0)
    )                                                                      as stock_qty_max
  from sku_master sm
  left join ebay_products     ep on ep.sku = sm.internal_sku and ep.status='active'
  left join platform_listings pl on pl.sku = sm.internal_sku
  where sm.status='active'
  group by sm.id
),
stock_age_src as (
  --   FIFO 정확도 낮음 (inventory_movements 미완). MIN(receipt) 있으면 사용, 없으면 sku_master.created_at fallback
  select
    sm.id                                                     as sku_master_id,
    coalesce(
      min(im.occurred_at) filter (where im.movement_type='receipt' and im.quantity_delta > 0),
      sm.created_at
    )                                                          as first_stocked_at
  from sku_master sm
  left join inventory_movements im on im.sku_master_id = sm.id
  where sm.status='active'
  group by sm.id, sm.created_at
),
channel_cov as (
  select
    sku_master_id,
    count(*) filter (where channel_status = 'LIVE')                  as live_channels,
    count(*) filter (where channel_status in ('LIVE','PAUSED','WORKING','READY','ERROR'))  as registered_channels,
    count(*)                                                          as observed_channels,
    array_agg(distinct channel) filter (where channel_status = 'NONE') as missing_channels_seen
  from v_sku_channel_matrix
  group by sku_master_id
)
select
  sm.id                                     as sku_master_id,
  sm.internal_sku,
  sm.title,
  sm.cost_krw                                as unit_cost,
  coalesce(sbp.stock_qty_max, 0)             as stock_qty,
  coalesce(sbp.stock_qty_max, 0) * coalesce(sm.cost_krw, 0)   as inventory_value_krw,
  case when sas.first_stocked_at is not null
       then greatest(0, extract(day from now() - sas.first_stocked_at)::int)
       else null end                          as stock_age_days,
  coalesce(rs30.qty_30d, 0)                  as sales_30d,
  coalesce(sp.sales_90d, 0)                  as sales_90d,
  coalesce(sp.ebay_sales_90d, 0)             as ebay_sales_90d,
  coalesce(sp.shopify_sales_90d, 0)          as shopify_sales_90d,
  coalesce(sp.gmv_90d, 0)                    as gmv_90d,
  coalesce(cc.live_channels, 0)              as live_channels,
  coalesce(cc.registered_channels, 0)        as registered_channels,
  coalesce(cc.observed_channels, 0)          as observed_channels,
  cc.missing_channels_seen,
  sm.channel_eligibility
from sku_master sm
left join stock_by_platform sbp on sbp.sku_master_id = sm.id
left join stock_age_src     sas on sas.sku_master_id = sm.id
left join sales_pivot       sp  on sp.sku_master_id  = sm.id
left join recent_sales_30   rs30 on rs30.sku_master_id = sm.id
left join channel_cov       cc  on cc.sku_master_id  = sm.id
where sm.status = 'active';

comment on view v_sku_b2c_scorecard is
  'B2C · SKU 당 재고/판매/coverage 파생값. active SKU only. Priority Engine 입력.';

-- ── 6c. v_staff_b2c_kpi — 직원별 90d KPI (§17) ────────
create or replace view v_staff_b2c_kpi as
select
  tt.assignee_id                             as user_id,
  count(*) filter (where tt.status='done' and tt.qc_status='pass')                    as live_completed,
  count(*) filter (where tt.qc_status='fail')                                          as qc_failed_count,
  count(*) filter (where tt.qc_status in ('pass','fail'))                              as qc_reviewed_count,
  case
    when count(*) filter (where tt.qc_status in ('pass','fail')) > 0
    then round(100.0 * count(*) filter (where tt.qc_status='fail')
               / count(*) filter (where tt.qc_status in ('pass','fail')), 2)
    else null
  end                                                                                  as qc_error_rate_pct,
  avg(extract(epoch from (tt.completed_at - tt.created_at)) / 3600)
        filter (where tt.completed_at is not null and tt.created_at is not null)      as avg_hours_per_task,
  count(*) filter (where tt.priority_level='p0' and tt.status='done')                  as p0_completed_count
from team_tasks tt
where tt.assignee_id is not null
  and tt.exception_type in (
    'channel_register.ebay','channel_register.shopify','channel_register.coupang',
    'channel_register.naver','channel_register.11st','channel_register.gmarket',
    'channel_register.auction','listing_error','qc'
  )
  and tt.created_at > now() - interval '90 days'
group by tt.assignee_id;

comment on view v_staff_b2c_kpi is
  'B2C · 직원별 90d KPI (B2C exception_type 만 집계 · 기존 pricing 태스크 제외)';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (수동 실행):
-- ═══════════════════════════════════════════════════════════════════════════
--   begin;
--   drop view if exists v_staff_b2c_kpi;
--   drop view if exists v_sku_b2c_scorecard;
--   drop view if exists v_sku_channel_matrix;
--   delete from margin_settings where category='b2c_inventory';
--   drop index if exists uq_team_tasks_b2c_active_dedupe;
--   drop index if exists idx_team_tasks_assignee_active;
--   drop index if exists idx_team_tasks_active_priority;
--   alter table team_tasks drop constraint if exists chk_team_tasks_qc_status;
--   alter table team_tasks drop constraint if exists chk_team_tasks_priority_level;
--   alter table team_tasks
--     drop column if exists selling_price,
--     drop column if exists listing_url,
--     drop column if exists listing_id,
--     drop column if exists qc_at,
--     drop column if exists qc_user_id,
--     drop column if exists qc_status,
--     drop column if exists channel,
--     drop column if exists priority_score,
--     drop column if exists priority_level;
--   alter table sku_master drop column if exists channel_eligibility;
--   commit;
