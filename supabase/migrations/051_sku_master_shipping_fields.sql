-- SKU 마스터에 배송비 계산용 5개 컬럼 추가
-- Phase 1 of 배송비 계산/배송추천 리디자인 (사장님 spec 2026-05-12).
--
-- 사용 흐름: 마스터에 한 번 입력 → 주문 매칭 시 자동 무게 조회 →
-- 배송추천 화면에서 자동 계산 결과 검토 + 예외만 수정.
--
-- 기존 weight_gram 컬럼은 단품 실무게(item_weight_g) 의미로 그대로 유지.
-- (이름 변경 안 함 — 다른 코드 다 깨짐. concept 만 정렬)

alter table sku_master
  add column if not exists default_packaging_weight_g integer,
  add column if not exists width_cm  numeric(6,1),
  add column if not exists height_cm numeric(6,1),
  add column if not exists length_cm numeric(6,1),
  add column if not exists shipping_group varchar(30),
  add column if not exists weight_status varchar(20) not null default 'unknown';

-- weight_status: 'unknown' | 'estimated' | 'measured'
-- - unknown:   weight_gram 미입력 (배송추천에서 '입력 필요'로 표시)
-- - estimated: 그룹 평균 등 추정치 (CSV 일괄 입력·자동 추정 시)
-- - measured:  실측 (사용자가 직접 입력)
comment on column sku_master.weight_status is '단품무게 신뢰도: unknown|estimated|measured';
comment on column sku_master.default_packaging_weight_g is '기본 포장재 무게 (g). 미설정 시 shipping_group 기본값 사용';
comment on column sku_master.shipping_group is '배송 그룹 키 (예: card, photocard, album, figure, general)';

-- 기존 row 의 weight_status 정합화 — weight_gram 있으면 measured, 없으면 unknown.
update sku_master
   set weight_status = case
     when weight_gram is not null and weight_gram > 0 then 'measured'
     else 'unknown'
   end
 where weight_status is null or weight_status = 'unknown';

-- weight_status 별 인덱스 — '무게 입력 필요' SKU 빠른 필터링용
create index if not exists idx_sku_master_weight_status_unknown
  on sku_master(updated_at desc)
  where weight_status = 'unknown';

-- shipping_group 별 조회 인덱스 (배송그룹별 기본 포장무게 lookup 등)
create index if not exists idx_sku_master_shipping_group
  on sku_master(shipping_group)
  where shipping_group is not null;
