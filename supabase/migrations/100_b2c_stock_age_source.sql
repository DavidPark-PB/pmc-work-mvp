-- 100_b2c_stock_age_source.sql
-- Phase B2C-4 · v_sku_b2c_scorecard 에 stock_age_source 컬럼 최소 추가.
--
-- Owner directive (2026-08-25):
--   · Priority Engine 이 stock_age_days 를 신뢰할 수 있는지 판단할 수 있게 최소 변경만.
--   · 실측: inventory_movements 4행만 존재 (receipt 는 1 SKU 만) · 2791 SKU 는 sku_master.created_at proxy
--   · low-confidence aging 단독으로 P0 승격 금지 (규칙에 반영)
--
-- Scope (CREATE OR REPLACE VIEW · 컬럼 순서/이름 무변경 · 마지막에 stock_age_source 만 추가):
--   · v_sku_b2c_scorecard 재정의 · stock_age_source varchar 신규 컬럼 마지막에 append
--     - 'inventory_movement' : first_stocked_at 이 inventory_movements.receipt 에서 왔음 (신뢰)
--     - 'sku_created_at'     : fallback (sku_master.created_at)
--     - NULL                 : stock_age_days 자체가 NULL 인 경우
--
-- Rollback: 하단.

begin;

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
  --   MIN(receipt) 이 있으면 신뢰 · 없으면 sku_master.created_at proxy
  select
    sm.id                                                                                                    as sku_master_id,
    min(im.occurred_at) filter (where im.movement_type='receipt' and im.quantity_delta > 0)                  as first_receipt_at,
    sm.created_at                                                                                            as sku_created_at
  from sku_master sm
  left join inventory_movements im on im.sku_master_id = sm.id
  where sm.status='active'
  group by sm.id, sm.created_at
),
channel_cov as (
  select
    sku_master_id,
    count(*) filter (where channel_status = 'LIVE')                                                          as live_channels,
    count(*) filter (where channel_status in ('LIVE','PAUSED','WORKING','READY','ERROR'))                    as registered_channels,
    count(*)                                                                                                  as observed_channels,
    array_agg(distinct channel) filter (where channel_status = 'NONE')                                       as missing_channels_seen
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
  case
    when sas.first_receipt_at is not null
      then greatest(0, extract(day from now() - sas.first_receipt_at)::int)
    when sas.sku_created_at is not null
      then greatest(0, extract(day from now() - sas.sku_created_at)::int)
    else null
  end                                        as stock_age_days,
  coalesce(rs30.qty_30d, 0)                  as sales_30d,
  coalesce(sp.sales_90d, 0)                  as sales_90d,
  coalesce(sp.ebay_sales_90d, 0)             as ebay_sales_90d,
  coalesce(sp.shopify_sales_90d, 0)          as shopify_sales_90d,
  coalesce(sp.gmv_90d, 0)                    as gmv_90d,
  coalesce(cc.live_channels, 0)              as live_channels,
  coalesce(cc.registered_channels, 0)        as registered_channels,
  coalesce(cc.observed_channels, 0)          as observed_channels,
  cc.missing_channels_seen,
  sm.channel_eligibility,
  --   ── NEW · Phase 4 ────────────────────────────────────────
  case
    when sas.first_receipt_at is not null then 'inventory_movement'
    when sas.sku_created_at is not null   then 'sku_created_at'
    else null
  end                                        as stock_age_source
from sku_master sm
left join stock_by_platform sbp on sbp.sku_master_id = sm.id
left join stock_age_src     sas on sas.sku_master_id = sm.id
left join sales_pivot       sp  on sp.sku_master_id  = sm.id
left join recent_sales_30   rs30 on rs30.sku_master_id = sm.id
left join channel_cov       cc  on cc.sku_master_id  = sm.id
where sm.status = 'active';

comment on view v_sku_b2c_scorecard is
  'B2C · SKU 당 재고/판매/coverage 파생값. active SKU only. Priority Engine 입력. '
  'stock_age_source: inventory_movement (신뢰) | sku_created_at (proxy · low confidence).';

commit;

-- Rollback:
--   Migration 098 의 v_sku_b2c_scorecard 원본 정의를 다시 apply.
