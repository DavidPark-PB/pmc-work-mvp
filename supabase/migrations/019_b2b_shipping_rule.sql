-- Phase 1 Day 5: 거래처별 배송비 규칙 (자동 인보이스용)
-- 예: { "perBoxes": 30, "rate": 120, "currency": "USD" }
-- 기본값(컬럼 미설정): { "perBoxes": 30, "rate": 120, "currency": "USD" }

alter table b2b_buyers
  add column if not exists shipping_rule jsonb not null default '{}'::jsonb;
