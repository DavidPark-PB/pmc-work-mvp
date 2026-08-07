-- 073_purchase_expense_link.sql
--
-- 발주-지출 통합 리팩토링 (2026-08-08 사장님 지침)
--
-- 배경:
--   기존에는 발주 완료 (ordered) 후 지출관리에 별도로 다시 입력해야 했음.
--   이제 발주 ordered 처리 시 expenses row 를 자동 생성해서 중복 입력을 없앤다.
--
-- 방식:
--   - 신규 테이블 만들지 않음
--   - expenses 의 source_type/source_id 컬럼 (Migration 048) 재활용
--   - expenses(source_type,source_id) UNIQUE 인덱스로 중복 방어 (이미 존재)
--   - purchase_requests 에 실제 구매 정보 4 컬럼만 추가 (모두 nullable)
--
-- 기존 데이터 안전성:
--   - 모든 컬럼 nullable 이라 기존 발주 row 는 영향 없음
--   - backfill 안 함 (사장님 지침 6번: 기존 ordered 건은 자동 생성 X)

alter table purchase_requests
  add column if not exists actual_price   numeric(12, 2),
  add column if not exists purchased_at   timestamptz,
  add column if not exists payment_method varchar(50),
  add column if not exists card_last4     varchar(4),
  add column if not exists expense_id     bigint;

-- expense_id 는 자동생성된 expenses.id 역참조 (편의).
-- expenses 테이블 소스는 source_type='purchase_order', source_id=purchase_request.id 이 이미 있어서
-- FK 없이도 조회 가능하지만, 자주 join 하는 편의를 위해 컬럼 유지.
-- 삭제 정책은 SET NULL (expense 삭제되어도 발주는 유지)
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'purchase_requests' and constraint_name = 'purchase_requests_expense_fk'
  ) then
    alter table purchase_requests
      add constraint purchase_requests_expense_fk
      foreign key (expense_id) references expenses(id) on delete set null;
  end if;
end $$;

comment on column purchase_requests.actual_price   is '실제 구매금액 (estimated_price 는 예상가만). 지출 자동생성 시 이 값 사용';
comment on column purchase_requests.purchased_at   is '실제 구매 완료 시각 (ordered_at 은 상태 변경 시각과 별개)';
comment on column purchase_requests.payment_method is '결제수단: 법인카드/현금/계좌이체/기타';
comment on column purchase_requests.card_last4     is '카드 뒷 4자리 (카드 CSV 매칭용)';
comment on column purchase_requests.expense_id     is '자동생성된 expenses.id (SET NULL on delete)';

-- expense_id 조회 인덱스 (편의)
create index if not exists idx_purchase_requests_expense_id
  on purchase_requests (expense_id)
  where expense_id is not null;

-- (source_type, source_id) partial UNIQUE — Migration 048 은 non-unique 였음.
-- 발주-지출 1:1 보장의 DB 레벨 마지막 방어선.
-- 기존 payroll source 데이터는 확인 결과 중복 없음 (2026-08-08 verified).
-- 기존 non-unique idx_expenses_source 는 남겨둠 (INSERT 성능 영향 없음, DROP 시 downtime 우려).
create unique index if not exists idx_expenses_source_uniq
  on expenses (source_type, source_id)
  where source_type is not null and source_id is not null;
