-- 044_purchase_requests_phase1a.sql
--
-- PR P-1A-B: 발주 관리 1-A 단계 — DB 단단하게.
--
-- 추가 컬럼 (purchase_requests):
--   sku                       varchar(100)  — sku_master.internal_sku 와 link (FK 미설정 — fallback 정책 보호)
--   unit                      varchar(20)   default '개' — 개/박스/세트
--   normalized_product_name   text          — DuplicatePurchaseDetector.normalize() 결과
--   current_stock             integer       — 요청 시점 현재 재고 (직원 수동 입력)
--   memo                      text          — reason 과 별개. 보조 메모
--   deleted_at                timestamp     — soft delete (NULL = 활성)
--   deleted_by                integer       — soft delete 수행자 (users.id, FK 생략)
--
-- 인덱스:
--   idx_pr_sku_active                 — autocomplete 가중치 / 중복 검사 (sku where active)
--   idx_pr_normalized_active          — 중복 검사 (복합: normalized + deleted_at)
--   idx_pr_deleted                    — soft delete 필터 가속
--
-- 정책 (사장님 5개 짚은점 반영):
--   1. status varchar 컬럼은 enum 이 아니라 코드 화이트리스트로 관리.
--      1-A 시점에서 reviewed/arrived 는 UI 미사용이지만, route validation 화이트리스트에 미리 등록.
--      → 1-D 마이그레이션 재실행 불필요.
--   2. sku 는 sku_master.internal_sku 와 의미적 link 이지만 FK 안 검. SKU 미입력/마스터 미존재도 저장 허용.
--      UI 에서 sku=null OR sku !exists in sku_master → "SKU 미연결" 뱃지.
--   3. 중복 검사 시 본인 row 제외 = excludeId 파라미터로 처리 (service layer 책임).
--   4. soft-deleted 발주는 중복 검사 대상 X — 모든 active 인덱스가 WHERE deleted_at IS NULL.
--
-- Pre-state:  043 적용 (team_task_comments)
-- Post-state: purchase_requests 7 컬럼 추가 + 3 인덱스
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- 무수정: 037~043 / Phase 1 컬럼 / Safety Foundation / opportunity_inbox / opportunity_drafts / team_task_comments

alter table purchase_requests add column if not exists sku                     varchar(100);
alter table purchase_requests add column if not exists unit                    varchar(20) default '개';
alter table purchase_requests add column if not exists normalized_product_name text;
alter table purchase_requests add column if not exists current_stock           integer;
alter table purchase_requests add column if not exists memo                    text;
alter table purchase_requests add column if not exists deleted_at              timestamp;
alter table purchase_requests add column if not exists deleted_by              integer;

-- 기존 row 의 unit NULL 보정 (default 는 새 row 에만 적용됨)
update purchase_requests set unit = '개' where unit is null;

-- 인덱스
create index if not exists idx_pr_sku_active
  on purchase_requests (sku) where deleted_at is null;

create index if not exists idx_pr_normalized_active
  on purchase_requests (normalized_product_name, deleted_at);

create index if not exists idx_pr_deleted
  on purchase_requests (deleted_at);

-- Rollback (수동):
--   drop index if exists idx_pr_deleted;
--   drop index if exists idx_pr_normalized_active;
--   drop index if exists idx_pr_sku_active;
--   alter table purchase_requests drop column if exists deleted_by;
--   alter table purchase_requests drop column if exists deleted_at;
--   alter table purchase_requests drop column if exists memo;
--   alter table purchase_requests drop column if exists current_stock;
--   alter table purchase_requests drop column if exists normalized_product_name;
--   alter table purchase_requests drop column if exists unit;
--   alter table purchase_requests drop column if exists sku;
