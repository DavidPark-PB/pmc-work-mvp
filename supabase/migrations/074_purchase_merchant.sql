-- 074_purchase_merchant.sql
--
-- 상품 구매 UX 재설계 (2026-08-08 사장님 지침 후속):
--   구매·지출 관리 → 상품 구매 탭 의 필수 입력 필드 '구매처' 를 저장.
--   기존 expenses.merchant (텍스트) 와 동일 개념 — purchase_requests 에도 신설해서
--   목록에서 즉시 표시 + autoCreateExpense() 가 expenses.merchant 로 그대로 복사.
--
-- 왜 supplier_id (069 예약된 FK) 안 쓰나:
--   supplier_id 는 정규화된 공급업체 마스터 참조용. 지금 UX 는 free text ("쿠팡", "네이버")
--   중심이라 정규화 오버헤드 없이 텍스트 컬럼 하나로 처리. 향후 매핑 자동화 여지 남김.
--
-- 안전성: nullable + IF NOT EXISTS. 기존 발주 데이터에 무영향.

alter table purchase_requests
  add column if not exists merchant varchar(200);

comment on column purchase_requests.merchant is '구매처 (쿠팡/네이버/이베이/알리바바 등 free text). 지출 자동생성 시 expenses.merchant 로 복사.';
