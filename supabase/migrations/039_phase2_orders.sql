-- 039_phase2_orders.sql
-- WMS Phase 2 PR 1 — Order DB foundation. Non-destructive schema only — no app logic, no worker.
--
-- 중요 (이름 결정 — 2026-05-09):
--   기존 public.orders 테이블은 001/002/037 시점부터 운영 중인 eBay 주문 sync 용 테이블이다.
--   본 039 의 신규 WMS 주문 import 테이블은 충돌/오작동 회피를 위해 `wms_` prefix 로 분리한다.
--   기존 public.orders 는 deprecated 가 아니라 별 운영 테이블이다 — 본 039 가 일체 건드리지 않는다.
--
-- Adds:
--   1) wms_orders                       WMS 주문 import 단일 진입점 (mock / csv / api 통합)
--   2) wms_order_lines                  주문 line 단위 + SKU 매칭 결과
--   3) team_tasks.related_order_id FK   wms_orders(id) 참조로 조건부 추가
--                                       (constraint name = fk_team_tasks_related_wms_order)
--
-- Safety:
--   - 모든 CREATE TABLE / CREATE INDEX 에 IF NOT EXISTS — 재실행 안전 (idempotent).
--   - 멱등성: 두 번 실행해도 안전. 이전 시도에서 일부 wms_* 객체가 이미 생성됐어도 OK.
--   - team_tasks.related_order_id FK 는 DO block 으로 conditional add (Postgres 가
--     ADD CONSTRAINT IF NOT EXISTS 를 직접 지원 안 하므로). 정합성 깨진 데이터가 있으면
--     자동 skip + raise notice 로 안내.
--   - 037, 038 migration 무수정.
--   - 008 legacy `tasks` 테이블 (UUID PK, agent 흐름) 무수정.
--   - 기존 public.orders (eBay 주문 sync 용) 무수정 — ALTER / DROP / DELETE / TRUNCATE 일체 없음.
--   - 기존 public.order_lines (있다면, 이전 039 시도에서 생성됐을 가능성) 무수정 — 본 039 는
--     wms_order_lines 만 생성. 빈 order_lines 가 있다면 후속 cleanup 권장 (별 PR).
--   - 기존 products / platform_listings / ebay_products / shopify_products / naver_products /
--     alibaba_products 등 마켓 mirror 테이블 무수정.
--   - 기존 team_tasks 의 38 행 비파괴 (FK 추가만 시도, 컬럼/데이터 변경 없음).
--
-- Phase 2 PR 1 범위 밖 (후속 PR 에서 처리):
--   - mock import backend (PR 2 — DB target = wms_orders / wms_order_lines)
--   - SKU matcher 서비스 (PR 2)
--   - admin UI (PR 3)
--   - sub-app Drizzle sync (PR 1-B 또는 후속 — automation/src/db/schema.ts 별 PR.
--                           wms_orders / wms_order_lines typed 정의 추가 예정)
--   - 실제 마켓 API 연동 (Phase 4 이상)
--   - jobs polling 본격 사용 (Phase 4 후보)
--   - CSV import (PR 5 또는 Phase 3 후보)
--
-- PII 원칙 (PR 2 에서 적용 예정):
--   - buyer_name 은 nullable. mock/CSV 검증 시 마스킹 또는 미저장.
--   - buyer_contact / wms_orders.raw_payload / wms_order_lines.raw_payload 는 PR 2 에서
--     src/lib/redact.js 통과 후 저장. token / api_key / email / phone 마스킹.
--   - 원본 수취인명 / 주소 / 전화번호 는 Phase 4 배송 단계에서 별도 정책으로 다룸.
--   - Phase 2 는 주문 매칭 검증에 필요한 최소 정보만 저장한다.

-- ──────────────────────────────────────────────────────────────────────────
-- 1) wms_orders — WMS 주문 import 진입 (mock / csv / api 통합)
--
-- 기존 public.orders (eBay sync 용) 와 별 테이블. 컬럼 충돌 회피 + 의미 분리.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists wms_orders (
  id                  serial primary key,
  marketplace         varchar(50)  not null,                            -- 'ebay' | 'shopify' | 'shopee' | 'naver' | 'coupang' | 'qoo10' | 'alibaba'
  external_order_id   varchar(200) not null,                            -- 마켓 측 주문번호 (eBay OrderID 등)
  order_status        varchar(50)  not null default 'pending',           -- 'pending' | 'paid' | 'ready_to_ship' | 'shipped' | 'cancelled' | 'refunded'
  buyer_name          varchar(200),                                      -- nullable. PR 2 에서 마스킹/미저장 정책
  buyer_country       varchar(10),                                       -- ISO 2-letter ('US' / 'KR' / 'JP' 등). PII 아님
  buyer_contact       jsonb,                                             -- email / phone 등. PR 2 에서 src/lib/redact.js 통과 후 저장
  ordered_at          timestamptz,                                       -- 마켓 측 원 주문 시각
  total_amount        numeric(12,2),                                     -- 마켓 통화 기준
  currency            varchar(10),                                       -- 'USD' / 'KRW' / 'SGD' 등
  raw_payload         jsonb,                                             -- 원본 주문 payload. PR 2 에서 redact 후 저장
  import_source       varchar(50)  not null default 'mock',               -- 'mock' | 'csv' | 'api:ebay' 등
  imported_by         integer,                                           -- users(id) — loose coupling, no FK
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now(),
  unique (marketplace, external_order_id)                                 -- 같은 마켓 같은 주문번호 중복 차단
);

-- UNIQUE 인덱스는 위 제약으로 자동 생성됨. 추가 인덱스만 명시.
create index if not exists idx_wms_orders_status
  on wms_orders(order_status);

create index if not exists idx_wms_orders_ordered_at
  on wms_orders(ordered_at);

create index if not exists idx_wms_orders_import_source
  on wms_orders(import_source);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) wms_order_lines — 주문 line 단위 + SKU 매칭 결과
--
-- match_status 흐름:
--   pending → matched_link / matched_marketplace_sku / matched_internal_sku / failed
--   (PR 2 의 src/services/skuMatcher.js 가 결정)
--
-- option_id 는 NULL 가능 (옵션 없는 단일 SKU 상품). 매칭 시 IS NOT DISTINCT FROM 으로 비교.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists wms_order_lines (
  id                  serial primary key,
  order_id            integer      not null references wms_orders(id) on delete cascade,
  external_line_id    varchar(200) not null,                            -- 마켓의 line 식별자 (eBay TransactionID 등)
  marketplace_sku     varchar(200),                                      -- 마켓 측 SKU 텍스트
  listing_id          varchar(200),                                      -- eBay ItemID / Shopify ProductID 등
  option_id           varchar(200),                                      -- Variation / Variant ID. NULL 가능
  title               varchar(500),                                      -- 마켓 측 line 제목
  quantity            integer      not null default 1,
  unit_price          numeric(12,2),
  currency            varchar(10),
  matched_sku_id      integer      references sku_master(id) on delete set null,  -- 매칭 결과. sku_master soft delete 시 line 보존
  match_status        varchar(50)  not null default 'pending',            -- 'pending' | 'matched_link' | 'matched_marketplace_sku' | 'matched_internal_sku' | 'failed'
  match_reason        text,                                              -- 실패 사유 또는 매칭 근거 메모
  match_confidence    varchar(20),                                       -- 'high' | 'medium' | 'low'
  raw_payload         jsonb,                                             -- 원본 line payload. PR 2 에서 redact 후 저장
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now(),
  unique (order_id, external_line_id)                                     -- 같은 주문의 같은 line 중복 차단
);

create index if not exists idx_wms_order_lines_order_id
  on wms_order_lines(order_id);

-- partial: matched 되지 않은 row 가 통계상 다수일 수 있으므로 인덱스 부담 최소화
create index if not exists idx_wms_order_lines_matched_sku_id
  on wms_order_lines(matched_sku_id)
  where matched_sku_id is not null;

create index if not exists idx_wms_order_lines_match_status
  on wms_order_lines(match_status);

create index if not exists idx_wms_order_lines_marketplace_sku
  on wms_order_lines(marketplace_sku);

create index if not exists idx_wms_order_lines_listing_option
  on wms_order_lines(listing_id, option_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 3) team_tasks.related_order_id FK — wms_orders 참조로 조건부 추가
--
-- 컬럼명은 그대로 (Phase 1 의 038 에서 도입한 `related_order_id` 유지).
-- FK target = wms_orders(id). constraint 이름 = fk_team_tasks_related_wms_order.
-- 기존 public.orders 와는 무관 — 본 FK 는 WMS Phase 2 의 wms_orders 만 참조.
--
-- 안전 룰:
--   a) 같은 이름 (fk_team_tasks_related_wms_order) constraint 가 있으면 skip
--   b) NULL 또는 모두 wms_orders.id 와 매칭되면 안전 추가
--   c) orphan row 있으면 skip + raise notice (cleanup 후 별 PR 로 수동 추가)
--
-- Postgres 는 ADD CONSTRAINT IF NOT EXISTS 를 직접 지원하지 않으므로 DO block 사용.
-- ON DELETE SET NULL — wms_orders 가 삭제되면 자동 카드의 related_order_id 만 NULL 처리,
-- 카드 자체는 보존 (이력 유지).
-- ──────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'fk_team_tasks_related_wms_order'
  ) then
    raise notice '[039] fk_team_tasks_related_wms_order already exists — skip';
  elsif exists (
    select 1 from team_tasks t
    where t.related_order_id is not null
      and not exists (
        select 1 from wms_orders o where o.id = t.related_order_id
      )
  ) then
    raise notice '[039] fk_team_tasks_related_wms_order SKIPPED: orphan related_order_id rows exist. Run cleanup SQL (set orphan to NULL or insert matching wms_orders) then add FK manually:'
      ' alter table team_tasks add constraint fk_team_tasks_related_wms_order foreign key (related_order_id) references wms_orders(id) on delete set null;';
  else
    alter table team_tasks
      add constraint fk_team_tasks_related_wms_order
      foreign key (related_order_id) references wms_orders(id) on delete set null;
    raise notice '[039] fk_team_tasks_related_wms_order ADDED';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Rollback (수동 실행 — 운영 적용 후 문제 발생 시):
--   alter table team_tasks drop constraint if exists fk_team_tasks_related_wms_order;
--   drop index if exists idx_wms_order_lines_listing_option;
--   drop index if exists idx_wms_order_lines_marketplace_sku;
--   drop index if exists idx_wms_order_lines_match_status;
--   drop index if exists idx_wms_order_lines_matched_sku_id;
--   drop index if exists idx_wms_order_lines_order_id;
--   drop index if exists idx_wms_orders_import_source;
--   drop index if exists idx_wms_orders_ordered_at;
--   drop index if exists idx_wms_orders_status;
--   drop table if exists wms_order_lines;
--   drop table if exists wms_orders;
-- 주의: rollback 시 wms_order_lines 먼저 (wms_orders FK 의존), 그 후 wms_orders.
-- 기존 public.orders / order_lines (eBay sync 용) 는 본 rollback 영향 없음.
-- ──────────────────────────────────────────────────────────────────────────
