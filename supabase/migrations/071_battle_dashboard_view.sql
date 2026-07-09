-- 071_battle_dashboard_view.sql
--
-- v_battle_dashboard_rows: 전투 상황판 데이터 소스 통합 뷰.
--
-- 배경 (2026-07-09):
--   기존 getBattleDashboard() 는 ebay_products 전체 로드 후 competitor_prices
--   를 500 개씩 배치 조회했다. 매일 크롤 + AI 매칭 (competitor_listings +
--   product_matches) 결과를 여기에 병합하려고 배치 조회를 3~4 개 더 얹었더니
--   Railway 프록시 60 초 타임아웃에 걸려 502 가 발생했다.
--
-- 해결:
--   Supabase (Postgres) 안에서 한 번의 JOIN 으로 필요한 모든 정보를 UNION 해서
--   뷰로 노출한다. 뷰는 인덱스가 걸린 컬럼으로만 JOIN 하므로 조회는 1 초 이내.
--
-- 뷰 컬럼 요약:
--   our_sku / our_item_id / title(우리) / my_price / my_shipping / my_stock /
--   my_last_synced_at
--   competitor_item_id / competitor_seller_id / competitor_title /
--   competitor_price / competitor_shipping / competitor_url /
--   competitor_image / competitor_status / competitor_quantity /
--   tracked_at / competitor_tier / match_confidence / source ('ai'|'manual') /
--   has_override / price_min / price_max / variant_count
--
-- SOURCE 두 갈래:
--   'ai'     — product_matches (status='approved') JOIN competitor_listings
--   'manual' — competitor_prices (셀러 스캔 / 경쟁사 가져오기 버튼으로 등록)
--
--   같은 (our_sku, competitor_item_id) 쌍이 양쪽에 있으면 UNION ALL 로 둘 다
--   나오고, JS 에서 (sku + competitor_item_id) 유니크 처리 (AI 우선).

-- ── 선행 조건 자동 보강 ────────────────────────────────────────────────────
-- migration 070 (셀러 크롤 티어) 이 아직 실행 안 됐어도 71 만 실행하면 뷰가
-- 뜨도록, 71 자체에 competitor_sellers 확장 컬럼을 idempotent 로 추가한다.
-- 070 이 이미 실행됐다면 IF NOT EXISTS 로 스킵.
alter table competitor_sellers
  add column if not exists crawl_tier             text default 'B',
  add column if not exists next_crawl_offset      integer default 0,
  add column if not exists crawl_chunk_size       integer default 500,
  add column if not exists crawl_cycle_started_at timestamptz;

create or replace view v_battle_dashboard_rows as
-- ── AI 매칭 소스 (매일 크롤 + AI approved) ────────────────────────────────
select
  ep.sku                              as our_sku,
  ep.item_id                          as our_item_id,
  coalesce(p.title_ko, ep.title, cl.title, '')::text as title,
  ep.price_usd                        as my_price,
  ep.shipping_usd                     as my_shipping,
  ep.stock                            as my_stock,
  ep.updated_at                       as my_last_synced_at,
  cl.ebay_item_id                     as competitor_item_id,
  cl.seller_id                        as competitor_seller_id,
  cl.title                            as competitor_title,
  cl.price::numeric(12,2)             as competitor_price,
  cl.shipping::numeric(12,2)          as competitor_shipping,
  cl.url                              as competitor_url,
  cl.image_url                        as competitor_image,
  coalesce(cl.status, 'active')::text as competitor_status,
  cl.quantity                         as competitor_quantity,
  cl.last_seen                        as tracked_at,
  coalesce(cs.crawl_tier, 'B')::text  as competitor_tier,
  pm.confidence::numeric(5,3)         as match_confidence,
  'ai'::text                          as source,
  false                               as has_override,
  null::numeric(12,2)                 as price_min,
  null::numeric(12,2)                 as price_max,
  1                                   as variant_count,
  null::uuid                          as manual_row_id
from ebay_products ep
join product_matches pm
  on pm.our_sku = ep.sku
 and pm.status = 'approved'
join competitor_listings cl
  on cl.ebay_item_id = pm.competitor_item_id
left join competitor_sellers cs
  on cs.seller_id = cl.seller_id
left join products p
  on p.sku = ep.sku
where coalesce(ep.status, '') <> 'ended'

union all

-- ── 수동 등록 소스 (competitor_prices — 셀러 스캔 / 경쟁사 가져오기 버튼) ─
select
  ep.sku                              as our_sku,
  ep.item_id                          as our_item_id,
  coalesce(p.title_ko, ep.title, '')::text as title,
  ep.price_usd                        as my_price,
  ep.shipping_usd                     as my_shipping,
  ep.stock                            as my_stock,
  ep.updated_at                       as my_last_synced_at,
  cp.competitor_id                    as competitor_item_id,
  cp.seller_id                        as competitor_seller_id,
  null                                as competitor_title,
  coalesce(cp.manual_price_override, cp.competitor_price)::numeric(12,2) as competitor_price,
  coalesce(cp.manual_shipping_override, cp.competitor_shipping)::numeric(12,2) as competitor_shipping,
  cp.competitor_url                   as competitor_url,
  null                                as competitor_image,
  coalesce(cp.status, 'active')::text as competitor_status,
  cp.quantity_available               as competitor_quantity,
  cp.tracked_at                       as tracked_at,
  coalesce(cs.crawl_tier, 'B')::text  as competitor_tier,
  null::numeric(5,3)                  as match_confidence,
  'manual'::text                      as source,
  (cp.manual_price_override is not null) as has_override,
  cp.price_min::numeric(12,2)         as price_min,
  cp.price_max::numeric(12,2)         as price_max,
  coalesce(cp.variant_count, 1)::int  as variant_count,
  cp.id                               as manual_row_id
from ebay_products ep
join competitor_prices cp
  on cp.sku = ep.sku
left join competitor_sellers cs
  on cs.seller_id = cp.seller_id
left join products p
  on p.sku = ep.sku
where coalesce(ep.status, '') <> 'ended';

comment on view v_battle_dashboard_rows is
  '전투 상황판 데이터 소스. AI 매칭 (product_matches+competitor_listings) 와 수동 등록 (competitor_prices) 을 UNION. JS 에서 (our_sku, competitor_item_id) 유니크 처리, AI 우선.';

-- ── 매칭 없는 내 리스팅 (경쟁사 없음 필터용) ──────────────────────────────
--   전투 상황판에서 "경쟁사 미등록" 필터가 이걸 참조.
create or replace view v_battle_unmatched_listings as
select
  ep.sku                              as our_sku,
  ep.item_id                          as our_item_id,
  coalesce(p.title_ko, ep.title, '')::text as title,
  ep.price_usd                        as my_price,
  ep.shipping_usd                     as my_shipping,
  ep.stock                            as my_stock,
  ep.updated_at                       as my_last_synced_at
from ebay_products ep
left join products p on p.sku = ep.sku
where coalesce(ep.status, '') <> 'ended'
  and not exists (
    select 1 from product_matches pm
    where pm.our_sku = ep.sku and pm.status = 'approved'
  )
  and not exists (
    select 1 from competitor_prices cp
    where cp.sku = ep.sku
  );

comment on view v_battle_unmatched_listings is
  '경쟁사 매칭이 하나도 없는 내 리스팅. 소싱 후보 발굴/전투 상황판 no-comp 필터용.';
