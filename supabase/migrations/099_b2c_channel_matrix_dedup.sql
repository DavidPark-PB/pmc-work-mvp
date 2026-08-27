-- 099_b2c_channel_matrix_dedup.sql
-- Phase B2C-3 · v_sku_channel_matrix 를 (sku_master_id, channel) 단위로 명시적 dedup.
--
-- Owner directive (2026-08-25):
--   · Channel Matrix view 를 SKU × Channel = 1 row 되도록 ranking/dedup 처리
--   · Deterministic rule:
--       (1) status precedence:  LIVE > READY > WORKING > ERROR > PAUSED > BLOCKED > ENDED > NONE
--       (2) tie-breaker:        updated_at DESC → created_at DESC → id DESC (실제 스키마 반영)
--   · 실제 스키마 매핑:
--       · platform_listings.updated_at   (SoT · status/price/qty 변경 시 갱신)
--       · platform_listings.last_synced_at (보조 · 없으면 updated_at fallback)
--       · sku_listing_link.updated_at    (매핑 자체가 변경된 시각)
--       · sku_listing_link.id, platform_listings.id (final tiebreaker · 최신 row = 큰 id)
--
-- 현재 프로덕션 실측 (2026-08-25 · probe 결과):
--   · v_sku_channel_matrix 2808 rows
--   · 고유 (sku_master_id, channel) 2808 → **이미 unique** (2792 SKU 중 10개 SKU 가 다채널 = 16 extra)
--   · sku_listing_link (sku_id, marketplace) 중복 0건
--   · platform_listings (sku, platform) 중복 4건 — 모두 테스트 SKU (PMC-GLOBAL-DB-TEST-002 등 shopee)
--       현재 sku_master 와 join miss 라 view 에 표시 안 됨
--   · 결론: 현재는 dedup 불필요하나, sku_listing_link/platform_listings 에 미래에 (sku, marketplace)
--          중복이 들어올 가능성 있음 (특히 shopee 테스트 dupe 4건 관찰). 방어적으로 view 에 명시적
--          ROW_NUMBER dedup 삽입.
--
-- Scope (additive · view CREATE OR REPLACE · 컬럼 순서/이름 유지 · v_sku_b2c_scorecard 자동 유효):
--   · v_sku_channel_matrix redefine (CTE + ROW_NUMBER)
--   · downstream (v_sku_b2c_scorecard, v_staff_b2c_kpi) 별도 재정의 불필요 (columns 무변경)
--
-- Rollback: 하단.

begin;

create or replace view v_sku_channel_matrix as
with source as (
  select
    sm.id                                                         as sku_master_id,
    sm.internal_sku,
    sm.title,
    coalesce(sll.marketplace, pl.platform)                        as channel,
    coalesce(sll.listing_id, pl.platform_item_id)                 as listing_id,
    sll.marketplace_sku,
    pl.status                                                     as raw_status,
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
    end                                                            as channel_status,
    pl.price                                                       as selling_price,
    pl.currency                                                    as selling_currency,
    pl.listing_url,
    coalesce(pl.updated_at, pl.last_synced_at, sll.updated_at)     as last_checked_at,
    --   tie-breaker source columns
    coalesce(pl.updated_at, pl.last_synced_at)                     as _pl_updated_at,
    pl.created_at                                                  as _pl_created_at,
    pl.id                                                          as _pl_id,
    sll.updated_at                                                 as _sll_updated_at,
    sll.created_at                                                 as _sll_created_at,
    sll.id                                                         as _sll_id
  from sku_master sm
  left join sku_listing_link sll on sll.sku_id = sm.id
  left join platform_listings pl
         on (sll.marketplace is not null
             and pl.platform = sll.marketplace
             and pl.platform_item_id = sll.listing_id)
         or (sll.marketplace is null
             and pl.sku = sm.internal_sku)
  where sm.status='active'
),
ranked as (
  select
    source.*,
    row_number() over (
      partition by sku_master_id, channel
      order by
        case channel_status
          when 'LIVE'    then 1
          when 'READY'   then 2
          when 'WORKING' then 3
          when 'ERROR'   then 4
          when 'PAUSED'  then 5
          when 'BLOCKED' then 6
          when 'ENDED'   then 7
          when 'NONE'    then 8
          else 9
        end                                asc,
        _pl_updated_at                     desc nulls last,
        _pl_created_at                     desc nulls last,
        _pl_id                             desc nulls last,
        _sll_updated_at                    desc nulls last,
        _sll_created_at                    desc nulls last,
        _sll_id                            desc nulls last
    )                                                            as rn
  from source
)
select
  sku_master_id,
  internal_sku,
  title,
  channel,
  listing_id,
  marketplace_sku,
  raw_status,
  channel_status,
  selling_price,
  selling_currency,
  listing_url,
  last_checked_at
from ranked
where rn = 1;

comment on view v_sku_channel_matrix is
  'B2C · SKU × 채널 상태 pivot (active SKU only · (sku,channel) 당 정확히 1 row 보장). '
  'Ranking: status precedence (LIVE>READY>WORKING>ERROR>PAUSED>BLOCKED>ENDED>NONE), '
  'tie-breaker: pl.updated_at DESC → pl.created_at DESC → pl.id DESC → sll.* 동일.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (수동):
-- ═══════════════════════════════════════════════════════════════════════════
--   Migration 098 의 v_sku_channel_matrix 원본 정의를 다시 apply:
--   begin;
--   [098 파일의 v_sku_channel_matrix 블록 다시 실행];
--   commit;
