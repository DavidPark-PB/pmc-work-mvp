-- 049_stocktake_phase2.sql
--
-- PR S-1: 재고 실사 화면 개선 (검색 확대 + 승인 워크플로우).
--
-- 사장님 spec:
--   1. 검색 컬럼 확대: products 에 aliases / keywords (text[]) 추가 — 직원 별칭 + 검색 키워드
--   2. 저장 정책 — 검토/승인 워크플로우: stock_adjustments 에 status / applied_at / applied_by 추가
--      · status='pending'           → 실사 기록만, 운영 재고 미반영 (기본)
--      · status='applied'           → 승인되어 products.stock 반영됨
--      · status='review_required'   → 검토 필요 (정상 SKU 매칭 안 됐거나 수치 큰 차이)
--      · status='cancelled'         → 무시 (오기재 등)
--
-- 사장님 spec — 기존 데이터 보존:
--   - products 운영 데이터 손상 X (ADD COLUMN IF NOT EXISTS / default '{}')
--   - stock_adjustments 기존 row 삭제 X. 모두 status='applied' 로 보정
--     (이미 운영 재고에 반영된 거라 가정 — 기존 흐름이 logger 만 했어도, 운영 시점에
--      사장님이 별도로 손으로 반영했을 거란 전제. 기록 자체는 살아있음.)
--
-- Pre-state:  048 적용 (payroll_finalization)
-- Post-state: products 2 컬럼 + 2 GIN 인덱스 / stock_adjustments 3 컬럼 + 1 인덱스
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- 무수정: 037~048 / sku_master / orders / wms_orders / expenses / 다른 모든 모듈

-- ──────────────────────────────────────────────────────────────────────────
-- 1) products 검색 확대 컬럼
-- ──────────────────────────────────────────────────────────────────────────
alter table products add column if not exists aliases  text[] default '{}';
alter table products add column if not exists keywords text[] default '{}';

-- 기존 row 의 NULL 보정 (default 는 새 row 에만 적용됨)
update products set aliases  = '{}' where aliases  is null;
update products set keywords = '{}' where keywords is null;

-- 배열 ANY 검색용 GIN 인덱스
create index if not exists idx_products_aliases_gin
  on products using gin (aliases);
create index if not exists idx_products_keywords_gin
  on products using gin (keywords);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) stock_adjustments 승인 워크플로우 컬럼
-- ──────────────────────────────────────────────────────────────────────────
alter table stock_adjustments add column if not exists status     varchar(20) default 'pending';
alter table stock_adjustments add column if not exists applied_at timestamp;
alter table stock_adjustments add column if not exists applied_by integer;

-- 기존 row 보정 — 이미 운영 흐름에서 처리된 거라 'applied' 로 (사장님 spec)
update stock_adjustments
   set status = 'applied',
       applied_at = coalesce(applied_at, created_at)
 where status is null;

-- pending 검토 화면 가속용 인덱스
create index if not exists idx_stock_adj_status
  on stock_adjustments (status, created_at desc);

-- Rollback (수동):
--   drop index if exists idx_stock_adj_status;
--   alter table stock_adjustments drop column if exists applied_by;
--   alter table stock_adjustments drop column if exists applied_at;
--   alter table stock_adjustments drop column if exists status;
--   drop index if exists idx_products_keywords_gin;
--   drop index if exists idx_products_aliases_gin;
--   alter table products drop column if exists keywords;
--   alter table products drop column if exists aliases;
