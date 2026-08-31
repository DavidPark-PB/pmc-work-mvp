-- 105_sku_enrichment_loop.sql
-- Owner Directive (2026-08-31) · SKU Enrichment Loop V1
--
-- Goal: 배송관리에서 직원이 한 번 입력한 SKU 정보 (무게 · 치수 · 원가 · 소싱처) 를
--       다음 동일 SKU 주문에서 자동으로 불러와 · 재입력 없이 재사용.
--
-- Principles:
--   1. Additive only — 기존 컬럼/테이블 DROP / RENAME / TYPE CHANGE 없음.
--   2. Existing rows unaffected — 모든 신규 컬럼 NULLABLE default 없음.
--   3. Provenance (source tracking) — 어떤 데이터가 어디서 왔는지 (측정 · 수기 · 매입) 남긴다.
--   4. History preservation — 원가 · 소싱처 변경 시 이전값 잃지 않음 (audit).
--   5. Existing production automation 은 그대로.
--
-- Related files:
--   - src/web/routes/api.js  /orders/save-weight (weight_gram 만 저장중 → dims + source 확장)
--   - src/web/routes/shippingRecommendations.js  (신규 필드 join)
--   - public/js/shippingRecs.js  (신규 뱃지/입력폼)

-- ══════════════════════════════════════════════════════════════════════════
-- 1. sku_master · source provenance columns (additive · NULLABLE)
-- ══════════════════════════════════════════════════════════════════════════
-- source enum (loose · 자유텍스트):
--   'shipping_measured'  · 배송 과정에서 실측 (직원)
--   'shipping_manual'    · 배송 과정에서 수기 입력 (측정 없이 추정)
--   'purchase_import'    · 매입 데이터 (inventory_purchases · 자동)
--   'owner_correction'   · 사장님 직접 수정
--   'legacy_import'      · CSV / 초기 시딩

alter table sku_master
  add column if not exists weight_source          varchar(30),
  add column if not exists weight_source_ref      text,
  add column if not exists weight_measured_at     timestamptz,

  add column if not exists dims_source            varchar(30),
  add column if not exists dims_source_ref        text,
  add column if not exists dims_measured_at       timestamptz,

  add column if not exists cost_source            varchar(30),
  add column if not exists cost_source_ref        text,
  add column if not exists cost_updated_at        timestamptz;

comment on column sku_master.weight_source    is 'weight_gram 출처. e.g. shipping_measured / shipping_manual / purchase_import / owner_correction / legacy_import';
comment on column sku_master.weight_source_ref is 'weight 저장을 유발한 참조 (order_no · purchase_id 등)';
comment on column sku_master.dims_source      is 'length/width/height_cm 출처.';
comment on column sku_master.cost_source      is 'cost_krw 출처.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. sku_cost_history — 원가 변경 audit (append-only)
-- ══════════════════════════════════════════════════════════════════════════
-- 원가 변경 시 이전값을 잃지 않는다. sku_master.cost_krw 는 최신값만 · 이력은 여기.
--
-- 정책:
--   - INSERT only. UPDATE/DELETE 금지 (트리거로 방지는 phase 2 · 지금은 앱단 규율).
--   - previous_cost NULL 허용 (첫 입력).
--   - reason 은 자유텍스트 (loose · 하드 enum 안 함 · 새 source 추가 마찰 최소).
create table if not exists sku_cost_history (
  id                bigserial primary key,
  sku_master_id     integer not null references sku_master(id) on delete restrict,
  previous_cost_krw numeric(12,2),
  new_cost_krw      numeric(12,2) not null,
  currency          varchar(10) not null default 'KRW',
  source            varchar(30),
  source_ref        text,
  reason            text,
  changed_by        integer,
  changed_at        timestamptz not null default now()
);

create index if not exists idx_sku_cost_history_sku_time
  on sku_cost_history (sku_master_id, changed_at desc);

comment on table sku_cost_history is 'SKU 원가 변경 이력 (append-only · sku_master.cost_krw 이전값 보존).';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. sku_supplier_history — 소싱처 이력 (append-only)
-- ══════════════════════════════════════════════════════════════════════════
-- sku_master.supplier_id 는 '현재/대표 소싱처' 만 저장 (069 이미 있음).
-- 소싱처는 시간에 따라 바뀔 수 있으므로 여기에 이력을 남긴다.
--
-- inventory_purchases (017) 재사용 검토 결과:
--   - seller_name 자유텍스트 · items jsonb · SKU 컬럼 없음 · expense 연동 특화.
--   - 카드/컬렉터 매입 전용 구조 · 범용 SKU 소싱처 이력으로 부적합.
--   - 별도 sku_supplier_history 신설.
create table if not exists sku_supplier_history (
  id                 bigserial primary key,
  sku_master_id      integer not null references sku_master(id) on delete restrict,
  supplier_id        bigint references suppliers(id) on delete set null,
  supplier_name      varchar(200),
  purchase_price     numeric(12,2),
  currency           varchar(10),
  quantity           integer,
  purchased_at       date,
  source             varchar(30),
  source_ref         text,
  note               text,
  is_preferred       boolean not null default false,
  created_by         integer,
  created_at         timestamptz not null default now()
);

create index if not exists idx_sku_supplier_history_sku_time
  on sku_supplier_history (sku_master_id, created_at desc);

create index if not exists idx_sku_supplier_history_supplier
  on sku_supplier_history (supplier_id)
  where supplier_id is not null;

comment on table sku_supplier_history is 'SKU 소싱처 이력 (append-only · sku_master.supplier_id 는 현재값만).';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Backfill · 기존 sku_master.weight_gram 값에 source='legacy_import' 표시
-- ══════════════════════════════════════════════════════════════════════════
-- 기존 값은 어디서 왔는지 모르므로 legacy_import 로 태그. 새 입력은 정확한 source 로.
update sku_master
   set weight_source     = 'legacy_import',
       weight_measured_at = coalesce(weight_measured_at, updated_at)
 where weight_gram is not null
   and weight_source is null;

update sku_master
   set dims_source     = 'legacy_import',
       dims_measured_at = coalesce(dims_measured_at, updated_at)
 where (length_cm is not null or width_cm is not null or height_cm is not null)
   and dims_source is null;

update sku_master
   set cost_source     = 'legacy_import',
       cost_updated_at = coalesce(cost_updated_at, updated_at)
 where cost_krw is not null
   and cost_source is null;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. View · v_sku_enrichment_status · 배송관리 뱃지 helper (optional)
-- ══════════════════════════════════════════════════════════════════════════
-- 앱은 sku_master 를 직접 join 하는 것이 가장 단순 · 이 뷰는 미래 대시보드/리포트 용.
create or replace view v_sku_enrichment_status as
select
  sm.id,
  sm.internal_sku,
  sm.title,
  case when sm.weight_gram is not null and sm.weight_gram > 0 then true else false end as has_weight,
  case when sm.length_cm is not null and sm.width_cm is not null and sm.height_cm is not null then true else false end as has_dims,
  case when sm.cost_krw is not null and sm.cost_krw > 0 then true else false end as has_cost,
  case when sm.supplier_id is not null then true else false end as has_supplier,
  sm.weight_source,
  sm.dims_source,
  sm.cost_source,
  (case when sm.weight_gram > 0 then 1 else 0 end
 + case when sm.length_cm is not null and sm.width_cm is not null and sm.height_cm is not null then 1 else 0 end
 + case when sm.cost_krw > 0 then 1 else 0 end
 + case when sm.supplier_id is not null then 1 else 0 end) as enrichment_score,
  sm.updated_at
from sku_master sm;

comment on view v_sku_enrichment_status is
  'SKU enrichment 완성도. enrichment_score = 무게/치수/원가/소싱처 각 +1 (0~4).';

-- Rollback (참고 · 실 rollback 안 함 — additive 이라 무영향):
--   drop view if exists v_sku_enrichment_status;
--   drop table if exists sku_supplier_history;
--   drop table if exists sku_cost_history;
--   alter table sku_master
--     drop column if exists weight_source, drop column if exists weight_source_ref, drop column if exists weight_measured_at,
--     drop column if exists dims_source,   drop column if exists dims_source_ref,   drop column if exists dims_measured_at,
--     drop column if exists cost_source,   drop column if exists cost_source_ref,   drop column if exists cost_updated_at;
