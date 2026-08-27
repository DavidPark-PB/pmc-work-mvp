# B2C Inventory Distribution OS — Phase 1 분석 + 통합 계획

> **목적**: 기존 재고를 여러 판매채널로 확장하는 운영 시스템. "직원이 무엇을 등록할지 결정하지 않는다 · 시스템이 우선순위를 정한다."
>
> **Phase 1 결론**: 필요한 스키마의 95% 가 이미 존재. **신규 테이블 0개**, 확장 마이그레이션 1개(098), 신규 뷰 2개, 신규 코드 파일 ~12개.

---

## §1. 현재 시스템 분석 (14 항목 답변)

| # | 조사 항목 | 답 |
|---|---|---|
| 1 | Product/SKU 구조 | `sku_master` (`internal_sku · title · cost_krw · weight_gram · status · automation_enabled`) — [supabase/migrations/038:26-42](supabase/migrations/038_phase1_sku_master_and_exception.sql) |
| 2 | Inventory 구조 | `inventory_movements` (occurred_at · quantity_delta · movement_type · sku_master_id · physical_product_id) — [supabase/migrations/081](supabase/migrations/081_inventory_movements.sql), `sellable_units` + `sellable_unit_components` for bundle |
| 3 | Order/Sales 구조 | `oms_orders` (channel · ordered_at · UNIQUE(channel,external_order_id)) + `oms_order_items` (sku_master_id · quantity · unit_price · unit_cost_snapshot) |
| 4 | User 구조 | `users` (id · username · password_hash · role · display_name · is_active · can_manage_finance) — [src/db/userRepository.js:2-9](src/db/userRepository.js#L2-L9) |
| 5 | Role 구조 | `users.role IN ('admin','staff')` + `can_manage_finance` flag. `req.user.isAdmin` 체크 — [src/middleware/auth.js:181-192](src/middleware/auth.js#L181-L192) |
| 6 | 현재 Dashboard | 단일 SPA `public/index.html` (3714줄) · 사이드바 + `#page-{name}` 컨테이너 방식 · `loadDashboard()` in [public/js/dashboard.js:506](public/js/dashboard.js#L506) |
| 7 | Scheduler | `src/services/scheduler.js` (node-cron · Asia/Seoul TZ) · `server.js:255` 에서 `start()` · 기존 예: `inventoryExceptionsDailyJob` 09:15 KST |
| 8 | eBay 데이터 | `ebay_products` (item_id · sku · title · stock · ebay_api_stock · price_usd · status), `platform_listings` (범용 layer) |
| 9 | Shopify 데이터 | `shopify_products` + `platform_listings` |
| 10 | Marketplace/Channel 테이블 | **이미 4중 층 존재** — `sku_listing_link` (매핑) · `platform_listings` (상태/가격) · `marketplace_identity` (order-line resolver, migration 097) · `product_listing_matrix` (SKU×채널 pivot 뷰) |
| 11 | Task/Workflow | **`team_tasks` 이미 존재** — `assignee_id · assignee_scope · priority · status · exception_type · dedupe_key · severity · related_sku_id · context jsonb · auto_generated` + `team_task_recipients` fan-out |
| 12 | Stack | Node/Express + Supabase (PostgreSQL) + `@supabase/supabase-js` + papaparse + node-cron. Frontend: **Vanilla JS + IIFE 패턴** (`window.pmcXxx = { load }`), CDN scripts, no React/Vue |
| 13 | Migration 방식 | `supabase/migrations/NNN_snake_case.sql` (097 까지), additive (`IF NOT EXISTS` · FK 는 `DO $$ ... EXCEPTION WHEN duplicate_object`), 파일 하단 `-- Rollback:` 주석, `scripts/apply-*.js` 로 apply |
| 14 | Test | **`node:test` 내장** (Jest 아님) · `npm test` → `node --test tests/pricing/*.test.js` · Stub DB 팩토리 (`makeDb({ productsRows })` 방식, 실 Supabase hit 안 함) |

---

## §2. 재사용 결정 매트릭스 (스펙 요구 → 매핑)

| 스펙 요구 (§3-§20) | 기존 자원 | 결정 |
|---|---|---|
| §3 `product_channel_listing` | `sku_listing_link` (매핑) + `platform_listings` (상태/가격) | **재사용** · 뷰 `v_sku_channel_matrix` 추가 |
| §3 채널 enum (EBAY, SHOPIFY, COUPANG, NAVER, 11ST, GMARKET, AUCTION, OTHER) | `sku_listing_link.marketplace` (기존 값: ebay/shopify/naver/shopee/alibaba/coupang/qoo10) + `marketplace_identity` CHECK allowlist | **재사용 · 값만 추가** (11st/gmarket/auction) |
| §3 status enum (NONE/READY/WORKING/LIVE/ERROR/BLOCKED/PAUSED) | `platform_listings.status` (기존 free-form) | **뷰 층에서 정규화** (기존 컬럼 그대로) — status derivation 룰 컨벤션 정립 |
| §4 상세화면 Channel Matrix | `product_listing_matrix` view (이미 pivot 형태) | **재사용 + 확장** (필요시 새 view) |
| §5 stock_qty · unit_cost · inventory_value · stock_age · sales_30d/90d | `sku_master.cost_krw` · `inventory_movements` · `oms_orders`+`oms_order_items` | **모두 계산 가능 · 뷰 신설**: `v_sku_b2c_scorecard` (한 SKU 당 한 행 · 모든 파생값) |
| §6 product_channel_eligibility | 없음 | **sku_master.channel_eligibility JSONB** 추가 (신규 테이블 대신) — 초기값 = 모든 채널, 채널별 exclude 는 배열 저장 |
| §7-§8 Priority Engine + Score | 없음 (Rule V1) | **신규 코드**: `src/services/b2cInventory/priorityEngine.js` (pure function) + config 5개 값 |
| §9 operation_task | `team_tasks` (`assignee_id · priority · status · exception_type · dedupe_key · context jsonb · related_sku_id · severity · auto_generated`) | **재사용** · 컬럼 3개만 추가 (§9 이하) |
| §9 task_type | `team_tasks.exception_type varchar(50)` | **재사용** · 값 컨벤션: `channel_register.coupang` · `listing_error` · `qc` |
| §9 priority_level (P0-P3) | `team_tasks.priority varchar` (기존 `normal/urgent`) | **컬럼 추가**: `priority_level varchar(4)` (p0/p1/p2/p3) · 기존 priority 는 유지 (레거시 non-break) |
| §9 priority_score | 없음 | **컬럼 추가**: `priority_score numeric(5,2)` (0-100) |
| §9 QC 관련 (qc_status · qc_user_id) | 없음 | **컬럼 추가**: `qc_status varchar(10)` (pending/pass/fail) · `qc_user_id integer` · `qc_at timestamptz` · `listing_id varchar(200)` · `listing_url text` · `selling_price numeric(12,2)` |
| §9 status enum (WAITING/WORKING/QC_PENDING/DONE/FAILED/HOLD) | `team_tasks.status` (기존 `pending/in_progress/blocked/done`) | **매핑**: pending=WAITING · in_progress=WORKING · done=DONE · blocked=HOLD · **추가값 2개**: `qc_pending`, `failed` (allowlist 확장) |
| §10 중복 방지 | `team_tasks.dedupe_key varchar(200)` 이미 존재 | **재사용** · UNIQUE partial index 추가: `WHERE status NOT IN ('done','failed')` |
| §11 자동 Task 생성 Job | `src/services/scheduler.js` + `inventoryExceptionsDailyJob` 참고 | **신규**: `src/jobs/b2cChannelTaskGenJob.js` · cron 09:30 KST |
| §12 My Tasks UI | `public/js/tasks.js` 이미 존재 (IIFE 패턴) | **재사용 + 확장** — 또는 별도 페이지 `public/js/b2cMyTasks.js` |
| §13-§14 Task Flow + QC | 없음 | **신규**: `src/services/b2cInventory/taskWorkflow.js` (상태 전이 함수) |
| §15-§16 대표 Dashboard | `public/js/dashboard.js` (기존 KPI 로직) | **재사용 + 섹션 추가**: `public/js/b2cDashboard.js` (사이드바 신규 페이지) |
| §17 직원 KPI | `team_tasks.assignee_id` + completed_at | **뷰 신설**: `v_staff_b2c_kpi` |
| §18 Purchase Warning Gate | 기존 발주 화면 (grep 필요 — Phase 10 에서 확인) | **경고만** (V1) · 기존 화면에 warning 텍스트 삽입 |
| §19 권한 | `requireAdmin` middleware 재사용 | **재사용** · 특정 액션(priority 수정 · qc pass) 만 requireAdmin |
| §20 Config | `margin_settings` (key-value NUMERIC) — 기존 [supabase/migrations/004:44-61](supabase/migrations/004_platform_system.sql#L44-L61) | **재사용** · seed 6 rows: `b2c.old_stock_days=60` · `b2c.very_old_stock_days=90` · `b2c.high_value_threshold_krw=500000` · `b2c.sales_validation_days=90` · `b2c.purchase_gate_coverage_pct=60` · `b2c.purchase_gate_mode=1` |

**신규 테이블: 0개** · 신규 컬럼: 7개 (모두 `team_tasks` + `sku_master.channel_eligibility` 1개) · 신규 뷰: 3개.

---

## §3. Migration 098 초안 (additive · 리뷰용)

```sql
-- 098_b2c_inventory_distribution.sql
-- Phase B2C-1 · B2C Inventory Distribution OS
--
-- Scope (additive only · no legacy break):
--   1) sku_master.channel_eligibility  JSONB — 채널별 판매 가능 목록
--   2) team_tasks 확장 컬럼 6개 (priority_level, priority_score, qc_*, listing_*, selling_price)
--   3) team_tasks.status allowlist 확장 (qc_pending, failed)
--   4) team_tasks 중복방지 UNIQUE partial index
--   5) margin_settings 6개 config row seed
--   6) 뷰 3개 (v_sku_channel_matrix, v_sku_b2c_scorecard, v_staff_b2c_kpi)
--
-- Rollback: 파일 하단.
-- Dependencies: 038 (sku_master · team_tasks · sku_listing_link), 004 (margin_settings),
--               079-088 (oms_*, sellable_units), 081/089 (inventory_movements), 097 (marketplace_identity)

-- ─── 1) sku_master.channel_eligibility ────────────────────────
alter table sku_master
  add column if not exists channel_eligibility jsonb;
--   기본 의미: null 이면 "모든 채널 가능", 배열이면 화이트리스트
--   예: ["ebay","shopify","coupang"] · 배제하려면 ["ebay","shopify"] 로 좁힘

comment on column sku_master.channel_eligibility is
  'B2C · 채널별 판매 가능 화이트리스트. null=모두 · []=모두 배제 · [ebay,shopify,...]';

-- ─── 2) team_tasks 확장 컬럼 ─────────────────────────────────
alter table team_tasks
  add column if not exists priority_level    varchar(4),     -- p0 · p1 · p2 · p3
  add column if not exists priority_score    numeric(5,2),   -- 0..100 · 같은 레벨 안 정렬
  add column if not exists channel           varchar(50),    -- ebay/shopify/coupang/naver/11st/gmarket
  add column if not exists qc_status         varchar(10),    -- pending · pass · fail
  add column if not exists qc_user_id        integer,        -- users(id) loose (auth 계층 확인)
  add column if not exists qc_at             timestamptz,
  add column if not exists listing_id        varchar(200),   -- 직원이 등록완료 시 입력
  add column if not exists listing_url       text,
  add column if not exists selling_price     numeric(12,2);  -- 등록시 판매가

--   priority_level allowlist (data integrity)
alter table team_tasks drop constraint if exists chk_team_tasks_priority_level;
alter table team_tasks add constraint chk_team_tasks_priority_level
  check (priority_level is null or priority_level in ('p0','p1','p2','p3'));

--   qc_status allowlist
alter table team_tasks drop constraint if exists chk_team_tasks_qc_status;
alter table team_tasks add constraint chk_team_tasks_qc_status
  check (qc_status is null or qc_status in ('pending','pass','fail'));

-- ─── 3) team_tasks.status allowlist 확장 (qc_pending, failed) ─
--   기존 status 는 free varchar · 애플리케이션 계층에서 관리 · 여기선 index 만 추가

create index if not exists idx_team_tasks_status_priority
  on team_tasks(status, priority_level, priority_score desc)
  where status in ('pending','in_progress','qc_pending');

create index if not exists idx_team_tasks_assignee_status
  on team_tasks(assignee_id, status)
  where status in ('pending','in_progress','qc_pending');

-- ─── 4) 중복 방지 UNIQUE partial index ──────────────────────
--   같은 (sku, channel, exception_type) 이 active 상태이면 새 task 생성 금지
create unique index if not exists uq_team_tasks_active_dedupe
  on team_tasks(related_sku_id, channel, exception_type)
  where status in ('pending','in_progress','qc_pending')
    and related_sku_id is not null
    and channel is not null
    and exception_type is not null;

-- ─── 5) margin_settings seed (config) ────────────────────────
insert into margin_settings(setting_key, setting_value, label, category) values
  ('b2c.old_stock_days',           60,     '재고 나이 기준 (일)',           'b2c_inventory'),
  ('b2c.very_old_stock_days',      90,     '고령 재고 기준 (일)',           'b2c_inventory'),
  ('b2c.high_value_threshold_krw', 500000, '고가 재고 임계 (원)',           'b2c_inventory'),
  ('b2c.sales_validation_days',    90,     '판매 검증 기간 (일)',           'b2c_inventory'),
  ('b2c.purchase_gate_coverage_pct', 60,   '발주 경고 coverage 임계 (%)',    'b2c_inventory'),
  ('b2c.purchase_gate_mode',       1,      '발주 gate: 0=OFF · 1=WARN · 2=BLOCK', 'b2c_inventory')
on conflict (setting_key) do nothing;

-- ─── 6) 뷰 3개 ────────────────────────────────────────────────

-- 6a. SKU × 채널 matrix (§4 상세화면)
create or replace view v_sku_channel_matrix as
select
  sm.id                       as sku_master_id,
  sm.internal_sku,
  sm.title,
  sll.marketplace             as channel,
  sll.listing_id,
  sll.marketplace_sku,
  pl.status                   as raw_status,
  case
    when pl.status ilike '%active%' or pl.status ilike '%live%' then 'LIVE'
    when pl.status ilike '%draft%' or pl.status ilike '%working%' then 'WORKING'
    when pl.status ilike '%error%' or pl.status ilike '%fail%'   then 'ERROR'
    when pl.status ilike '%pause%' or pl.status ilike '%hold%'   then 'PAUSED'
    when pl.status ilike '%block%'                                then 'BLOCKED'
    when sll.listing_id is not null                              then 'READY'
    else 'NONE'
  end                         as channel_status,
  pl.price                    as selling_price,
  pl.updated_at               as last_checked_at
from sku_master sm
left join sku_listing_link sll on sll.sku_id = sm.id
left join platform_listings pl on pl.platform = sll.marketplace and pl.platform_item_id = sll.listing_id;

-- 6b. SKU B2C scorecard (§5 파생값 all-in-one)
create or replace view v_sku_b2c_scorecard as
with recent_sales as (
  select
    oi.sku_master_id,
    o.channel,
    sum(oi.quantity)                                            as qty_sold,
    sum(oi.quantity * oi.unit_price - coalesce(oi.discount,0))  as gmv,
    max(o.ordered_at)                                            as last_sold_at
  from oms_order_items oi
  join oms_orders o on o.id = oi.order_id
  where o.ordered_at > now() - interval '90 days'
    and o.cancelled_at is null
    and o.order_status <> 'cancelled'
  group by oi.sku_master_id, o.channel
),
stock_current as (
  select
    sku_master_id,
    sum(quantity_delta)                       as stock_qty,
    min(occurred_at) filter (where movement_type='receipt' and quantity_delta > 0)  as first_receipt_at
  from inventory_movements
  where sku_master_id is not null
  group by sku_master_id
),
sales_totals as (
  select
    sku_master_id,
    sum(qty_sold)                                                            as sales_90d,
    sum(qty_sold) filter (where channel='ebay')                              as ebay_sales_90d,
    sum(qty_sold) filter (where channel='shopify')                           as shopify_sales_90d,
    sum(gmv)                                                                 as gmv_90d
  from recent_sales
  group by sku_master_id
),
channel_coverage as (
  select
    sku_master_id,
    count(*) filter (where channel_status = 'LIVE')                          as live_channels,
    count(*)                                                                  as total_channels,
    array_agg(channel) filter (where channel_status = 'NONE')                as missing_channels
  from v_sku_channel_matrix
  group by sku_master_id
)
select
  sm.id                                     as sku_master_id,
  sm.internal_sku,
  sm.title,
  sm.cost_krw                                as unit_cost,
  coalesce(sc.stock_qty, 0)                  as stock_qty,
  coalesce(sc.stock_qty, 0) * coalesce(sm.cost_krw, 0)                            as inventory_value,
  case when sc.first_receipt_at is not null
       then greatest(0, extract(day from now() - sc.first_receipt_at)::int)
       else null end                          as stock_age_days,
  coalesce(st.sales_90d, 0)                  as sales_90d,
  coalesce(st.ebay_sales_90d, 0)             as ebay_sales_90d,
  coalesce(st.shopify_sales_90d, 0)          as shopify_sales_90d,
  coalesce(st.gmv_90d, 0)                    as gmv_90d,
  coalesce(cc.live_channels, 0)              as live_channels,
  coalesce(cc.total_channels, 0)             as total_channels,
  case when coalesce(cc.total_channels,0) > 0
       then round(100.0 * cc.live_channels / cc.total_channels, 1)
       else 0 end                             as channel_coverage_pct,
  cc.missing_channels,
  sm.channel_eligibility
from sku_master sm
left join stock_current sc  on sc.sku_master_id  = sm.id
left join sales_totals st   on st.sku_master_id  = sm.id
left join channel_coverage cc on cc.sku_master_id = sm.id;

-- 6c. 직원 B2C KPI (§17)
create or replace view v_staff_b2c_kpi as
select
  tt.assignee_id                             as user_id,
  count(*) filter (where tt.status='done' and tt.qc_status='pass')                                              as live_completed,
  count(*) filter (where tt.qc_status='fail')::float / nullif(count(*) filter (where tt.qc_status is not null),0)  as qc_error_rate,
  avg(extract(epoch from tt.completed_at - tt.created_at) / 3600)
        filter (where tt.completed_at is not null)                                                              as avg_hours_per_task,
  count(*) filter (where tt.priority_level='p0' and tt.status='done')                                           as p0_completed
from team_tasks tt
where tt.assignee_id is not null
  and tt.exception_type in ('channel_register.ebay','channel_register.shopify','channel_register.coupang',
                            'channel_register.naver','channel_register.11st','channel_register.gmarket',
                            'listing_error','qc')
  and tt.created_at > now() - interval '90 days'
group by tt.assignee_id;

-- ─── Rollback ────────────────────────────────────────────────
-- drop view if exists v_staff_b2c_kpi;
-- drop view if exists v_sku_b2c_scorecard;
-- drop view if exists v_sku_channel_matrix;
-- delete from margin_settings where category='b2c_inventory';
-- drop index if exists uq_team_tasks_active_dedupe;
-- drop index if exists idx_team_tasks_assignee_status;
-- drop index if exists idx_team_tasks_status_priority;
-- alter table team_tasks drop constraint if exists chk_team_tasks_qc_status;
-- alter table team_tasks drop constraint if exists chk_team_tasks_priority_level;
-- alter table team_tasks
--   drop column if exists selling_price,
--   drop column if exists listing_url,
--   drop column if exists listing_id,
--   drop column if exists qc_at,
--   drop column if exists qc_user_id,
--   drop column if exists qc_status,
--   drop column if exists channel,
--   drop column if exists priority_score,
--   drop column if exists priority_level;
-- alter table sku_master drop column if exists channel_eligibility;
```

---

## §4. Phase 2-12 실행 계획 (파일 목록)

| Phase | 파일 | 종류 | LOC 추정 |
|---|---|---|---|
| **P2 Migration** | `supabase/migrations/098_b2c_inventory_distribution.sql` | 신규 | 130 |
| | `scripts/apply-098-b2c-inventory.js` | 신규 (기존 apply-oms-phase1.js 패턴) | 40 |
| **P3 Channel Matrix API** | `src/web/routes/b2cChannelMatrix.js` | 신규 (`GET /api/b2c/sku/:id/matrix`) | 80 |
| | `server.js` (mount 추가 1줄) | 편집 | +1 |
| **P4 Priority Engine** | `src/services/b2cInventory/priorityEngine.js` | 신규 (pure fn, Rule V1) | 150 |
| | `src/services/b2cInventory/config.js` | 신규 (margin_settings 로더 · 캐시 5분) | 40 |
| **P5 Task Queue Ext** | `src/services/b2cInventory/taskWorkflow.js` | 신규 (create · start · complete · qc) | 200 |
| | `src/db/teamTaskRepository.js` | 편집 (helpers for new columns) | +80 |
| **P6 Scheduler Job** | `src/jobs/b2cChannelTaskGenJob.js` | 신규 (매일 09:30 KST) | 150 |
| | `src/services/scheduler.js` (등록 블록 1개) | 편집 | +15 |
| **P7 My Tasks UI** | `public/js/b2cMyTasks.js` | 신규 (IIFE · window.pmcB2cMyTasks) | 250 |
| | `public/index.html` (사이드바 + `#page-b2c-my-tasks` + script tag) | 편집 | +6 |
| | `public/js/dashboard.js` (case in switch) | 편집 | +3 |
| | `src/web/routes/b2cMyTasks.js` | 신규 (직원 GET/PATCH) | 120 |
| **P8 QC UI** | `public/js/b2cQc.js` | 신규 (관리자) | 200 |
| | `public/index.html` (사이드바 + 컨테이너 + script tag) | 편집 | +3 |
| | `src/web/routes/b2cQc.js` | 신규 | 100 |
| **P9 Owner Dashboard** | `public/js/b2cDashboard.js` | 신규 | 250 |
| | `public/index.html` (사이드바 + 컨테이너 + script tag) | 편집 | +3 |
| | `src/web/routes/b2cDashboard.js` | 신규 (KPI 조회) | 150 |
| **P10 Purchase Warning** | `src/services/b2cInventory/purchaseGate.js` | 신규 | 60 |
| | (기존 발주 화면 위치는 P10 시작시 재확인) | 편집 | ~20 |
| **P11 Test** | `tests/b2cInventory/priorityEngine.test.js` | 신규 | 150 |
| | `tests/b2cInventory/taskWorkflow.test.js` | 신규 | 200 |
| | `tests/b2cInventory/dedupe.test.js` | 신규 | 100 |
| | `tests/b2cInventory/channelCoverage.test.js` | 신규 | 80 |

**합계**: 신규 파일 ~14개 + 편집 ~7개, 신규 코드 ~2300 LOC.

---

## §5. Config 값 (margin_settings seed · 관리자 화면에서 조정 가능)

| setting_key | default | 의미 |
|---|---|---|
| `b2c.old_stock_days` | 60 | Priority Score "stock age" 30점 시작 기준 |
| `b2c.very_old_stock_days` | 90 | 100% 부여 기준 |
| `b2c.high_value_threshold_krw` | 500,000 | P0 조건 · inventory_value >= 이 값 |
| `b2c.sales_validation_days` | 90 | eBay/Shopify 판매 검증 window |
| `b2c.purchase_gate_coverage_pct` | 60 | 발주 경고 임계 |
| `b2c.purchase_gate_mode` | 1 | 0=OFF · 1=WARNING · 2=BLOCK |

---

## §6. Task Type / Status / Priority 매핑

**exception_type 값 컨벤션** (스펙 §9 → 기존 컬럼):
```
channel_register.ebay
channel_register.shopify
channel_register.coupang
channel_register.naver
channel_register.11st
channel_register.gmarket
channel_register.auction
listing_error
qc
price_match           (future)
cs                    (future)
order_process         (future)
purchase              (future)
shipping              (future)
```

**status 매핑** (스펙 §9 → team_tasks.status):
```
WAITING     → pending
WORKING     → in_progress
QC_PENDING  → qc_pending     (allowlist 확장)
DONE        → done
FAILED      → failed          (allowlist 확장)
HOLD        → blocked
```

**priority_level**: `p0` · `p1` · `p2` · `p3` (신규 컬럼).

---

## §7. 의사결정 필요 사항 (Owner 승인/선택 항목)

계획 승인 전 확정해주실 3가지:

**Q1. Migration 098 apply 방식**
- (A) `scripts/apply-098-b2c-inventory.js` 만들어서 `--dry-run` → 실제 apply (기존 apply-oms-phase1.js 패턴)
- (B) Supabase SQL Editor 에 직접 붙여넣기
- **추천: (A)** — dry-run 지원 + 로그

**Q2. 판매채널 8개 중 V1 구현 범위**
스펙 §3 에는 `EBAY, SHOPIFY, COUPANG, NAVER, 11ST, GMARKET, AUCTION, OTHER` — 모두 지원하되 실제 리스팅이 없는 채널은 `NONE` 으로 표시. V1 자동 Task 생성은 어떤 채널 대상?
- (A) **6개 전체**: ebay, shopify, coupang, naver, 11st, gmarket (auction/other 제외)
- (B) **한국 채널만**: coupang, naver, 11st, gmarket (eBay/Shopify 는 이미 대부분 등록됨)
- (C) 선택: `___`
- **추천: (B)** — eBay/Shopify 는 이미 채워져 있어 신규 Task 대부분 0건 예상. 한국 4개가 실제 확장 대상.

**Q3. NOT_FOUND / AMBIGUOUS 케이스 처리**
Priority Engine 이 `sku_master.id` 를 못 찾으면 어떻게?
- (A) Task 생성 안 함 · 로그만
- (B) 관리자 review 큐로 별도 예외 태스크 생성
- **추천: (A)** — V1 은 조용히 skip. review 큐는 P3 스코프로 미룸.

---

## §8. 이번 턴 (Phase 1) 결과물

- ✅ 14개 조사 항목 답변
- ✅ 재사용 결정 매트릭스 (신규 테이블 0개 확인)
- ✅ Migration 098 초안 SQL (리뷰용)
- ✅ Phase 2-12 파일 목록 + LOC 추정
- ✅ Config 값 6개 seed
- ✅ Task type/status/priority 매핑

**작성한 파일**: `docs/b2c-inventory-distribution-plan.md` (이 문서)
**작성한 코드**: 없음 (분석만)
**DB 변경**: 없음 (Q1-Q3 답 받은 뒤 Phase 2)

---

## §9. 다음 단계

Owner 가 아래를 확인해주시면 Phase 2 (Migration 098 작성 · dry-run 실행) 착수:

1. §3 Migration 098 SQL 초안 검토 (특히 view 3개 · 컬럼 확장 · dedupe unique index)
2. §7 Q1/Q2/Q3 결정
3. Phase 2 부터 진행 승인 (전체 12 phase 를 한 번에 · 아니면 phase 별 승인)

`전부 승인` 또는 개별 지시 부탁드립니다.
