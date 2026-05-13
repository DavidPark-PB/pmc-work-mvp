-- 주문별 배송 무게·예상비·실비 데이터
-- Phase 2 of 배송비 계산/배송추천 리디자인 (사장님 spec 2026-05-12).
--
-- 정책:
--   - 한 주문(wms_orders.id) 당 한 행 — order_id 가 UNIQUE
--   - 무게 컬럼은 모두 g 단위 (numeric — 0.5g 정밀도 필요 시 대응)
--   - is_weight_overridden=true 인 행은 사용자가 수동 수정한 케이스
--   - master_weight_updated=true 면 그 수정이 sku_master.weight_gram 까지 전파됨
--   - FK CASCADE — 주문 삭제 시 함께 정리 (현재 wms_orders 도 hard delete 거의 없음)
--
-- 레거시 orders 테이블 (UUID PK) 은 본 PR 범위 X.

create table if not exists order_shipments (
  id   serial primary key,
  order_id  integer not null unique
            references wms_orders(id) on delete cascade,

  -- 무게 계산값 (Phase 3 계산 서비스가 채움)
  product_weight_g     numeric(10,2),   -- sum(line.qty × sku.weight_gram)
  packaging_weight_g   numeric(10,2),   -- sku.default_packaging_weight_g 또는 그룹 기본값
  final_weight_g       numeric(10,2),   -- product + packaging
  volumetric_weight_g  numeric(10,2),   -- (L×W×H)/divisor — divisor 는 carrier 별
  chargeable_weight_g  numeric(10,2),   -- max(final, volumetric)

  -- 배송 추천 결과 (Phase 3 계산 서비스 + Phase 4 UI 가 갱신)
  recommended_carrier   varchar(40),    -- 'koreapost' | 'shipter' | 'kpl' | 'fedex' | 'yun' | 'kpacket' | 'review'
  recommended_service   varchar(60),    -- carrier 내 service 이름 (예: 'FedEx International Economy')
  estimated_shipping_cost numeric(12,2),
  estimated_shipping_currency varchar(8) default 'KRW',

  -- 실제 배송 후 정산 (Phase 4~ 운영 단계에서 채움)
  actual_shipping_cost   numeric(12,2),
  shipping_margin        numeric(12,2), -- sale - cost - fee - estimated_shipping  (계산은 application 레이어)

  -- 사용자 수동 수정 흔적 (Phase 4 인라인 수정 시)
  is_weight_overridden   boolean not null default false,
  overridden_weight_g    numeric(10,2),
  override_reason        text,
  master_weight_updated  boolean not null default false,
            -- true 면 본 수정이 sku_master.weight_gram 까지 반영됐음. UI 에 표시.

  created_at  timestamp without time zone not null default now(),
  updated_at  timestamp without time zone not null default now()
);

comment on table order_shipments is '주문별 배송 무게·예상비·실비. 한 주문 당 한 행 (order_id UNIQUE).';
comment on column order_shipments.is_weight_overridden is '사용자가 인라인으로 무게를 수정하면 true. 자동 계산 결과를 신뢰하지 않음.';
comment on column order_shipments.master_weight_updated is '수동 수정이 sku_master 까지 반영됐는지. Phase 4 의 "SKU 마스터 반영" 옵션.';

-- 인덱스
create index if not exists idx_order_shipments_recommended_carrier
  on order_shipments(recommended_carrier)
  where recommended_carrier is not null;
create index if not exists idx_order_shipments_updated_at
  on order_shipments(updated_at desc);
create index if not exists idx_order_shipments_overridden
  on order_shipments(updated_at desc)
  where is_weight_overridden = true;
