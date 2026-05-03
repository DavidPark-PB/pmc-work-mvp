-- 035_b2b_shipping_fedex.sql
-- FedEx 자동 배송비 계산 + 라벨 생성 지원.
-- 거래처 structured 주소 + 발송 레코드 강화.

-- ── 거래처 structured 주소 ──
-- 기존 b2b_buyers.address (text) 와 country 는 fallback 으로 유지.
alter table b2b_buyers
  add column if not exists address_street text,
  add column if not exists address_city text,
  add column if not exists address_state text,
  add column if not exists address_zip text,
  add column if not exists contact_name text,
  add column if not exists contact_phone text;

-- ── 발송 레코드 ──
alter table b2b_shipments
  add column if not exists shipping_cost numeric(10,2),
  add column if not exists currency varchar(3) default 'USD',
  add column if not exists service_type varchar(40),
  add column if not exists weight_kg numeric(8,2),
  add column if not exists dimensions_cm text,
  add column if not exists package_count int default 1,
  add column if not exists label_storage_path text,
  add column if not exists fedex_shipment_id text;

-- 인덱스: 라벨 미발급 발송 빠른 조회
create index if not exists idx_b2b_shipments_no_label
  on b2b_shipments(invoice_no)
  where label_storage_path is null;

-- ── Storage 버킷 안내 ──
-- Supabase 대시보드 또는 별도 SQL 로 버킷 생성 필요:
--   bucket: b2b-shipping-labels
--   public: false (private)
--   서명 URL 만 발급 (15분 TTL)
-- (이 파일은 스키마만 다룸. 버킷 생성은 supabase storage admin API 또는 콘솔.)
