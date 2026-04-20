-- Phase 4: CS 답변 템플릿
-- eBay/Alibaba 메시지에 자주 보내는 답변을 템플릿화. body 안의 {placeholder}는
-- AI 또는 사용자가 채운다. usage_count로 사용 빈도 집계.

create table if not exists cs_templates (
  id serial primary key,
  title varchar(200) not null,                    -- 관리용 제목
  language varchar(10) not null default 'en',     -- en | ko | ja | zh | ...
  category varchar(40) not null default 'general',-- shipping | order | refund | product | restock | general
  body text not null,                             -- 답변 본문 (placeholder 포함 가능)
  usage_count integer not null default 0,
  is_active boolean not null default true,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);
create index if not exists cs_templates_active_idx on cs_templates (is_active) where is_active = true;
create index if not exists cs_templates_category_idx on cs_templates (category, language);

-- 시드 템플릿 (영어 + 한국어 샘플)
insert into cs_templates (title, language, category, body) values
  ('Order received - English', 'en', 'order',
   'Hi {buyer_name},\n\nThank you for your order! We have received it and will ship within 1-2 business days. You will receive a tracking number once shipped.\n\nBest regards,\nPMC'),
  ('Shipping delay apology - English', 'en', 'shipping',
   'Hi {buyer_name},\n\nSorry for the delay on your order {order_id}. Due to {reason}, we expect to ship within {days} business days. We apologize for the inconvenience.\n\nBest regards,\nPMC'),
  ('Tracking number - English', 'en', 'shipping',
   'Hi {buyer_name},\n\nYour order {order_id} has shipped! Tracking number: {tracking_number}. Estimated delivery: {eta}.\n\nBest regards,\nPMC'),
  ('Return accepted - English', 'en', 'refund',
   'Hi {buyer_name},\n\nWe have received your return request for {order_id}. Please ship the item back to:\n\n{return_address}\n\nOnce we receive it, we will process your refund within 3-5 business days.\n\nBest regards,\nPMC'),
  ('Out of stock restock - English', 'en', 'restock',
   'Hi {buyer_name},\n\nThank you for your interest in {product_name}. We are currently out of stock but expect to restock within {days} days. Would you like us to notify you when it is available?\n\nBest regards,\nPMC'),
  ('상품 문의 답변 - 한국어', 'ko', 'product',
   '안녕하세요 {buyer_name}님,\n\n문의주신 {product_name}에 대해 안내드립니다.\n\n{details}\n\n추가 문의 있으시면 말씀해주세요.\n\n감사합니다.\nPMC'),
  ('주문 확인 - 한국어', 'ko', 'order',
   '안녕하세요 {buyer_name}님,\n\n주문 {order_id}이 정상 접수되었습니다. 영업일 1~2일 내 발송 예정이며, 송장번호는 발송 후 별도 안내드립니다.\n\n감사합니다.\nPMC');
