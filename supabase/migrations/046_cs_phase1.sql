-- 046_cs_phase1.sql
--
-- PR CS-G1-B: CS 답변 시스템 1단계 — 템플릿 + 영업 옵션 + 답변 기록.
--
-- 기존 보존 (사장님 짚을 점 1):
--   - cs_templates 데이터 / 라우트 / Gemini /api/cs/suggest 모두 그대로
--   - 새 컬럼 ADD IF NOT EXISTS / 기본값 보정
--
-- 신규 (본 PR):
--   1) cs_templates 확장 — variables jsonb / deleted_at / deleted_by / last_used_at
--   2) cs_sales_options — 영업 옵션 (시드 7 row, ON CONFLICT DO NOTHING)
--   3) cs_responses — 답변 기록 (spec 컬럼 그대로 + soft delete)
--
-- 그룹 2 dep:
--   - cs_responses.suspicious_buyer_id 컬럼만 미리 add. FK 는 그룹 2 (047) 에서 추가.
--
-- 외부 공유 안전선:
--   - 본 PR 에선 외부 노출 X. 그룹 3 의 public-view API 추가 시 활성.
--
-- Pre-state:  045 적용 (attendance payroll_period_id)
-- Post-state: cs_templates 4 컬럼 + cs_sales_options 신규 + cs_responses 신규 + 시드 7
-- Idempotent: ADD COLUMN/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING
-- 무수정: 037~045 / Phase 1 / Safety Foundation / 다른 모든 모듈

-- ──────────────────────────────────────────────────────────────────────────
-- 1) cs_templates 확장
-- ──────────────────────────────────────────────────────────────────────────
alter table cs_templates add column if not exists variables    jsonb;
alter table cs_templates add column if not exists deleted_at   timestamp;
alter table cs_templates add column if not exists deleted_by   integer;     -- user id who performed soft delete (NOT original author; that is created_by)
alter table cs_templates add column if not exists last_used_at timestamp;

-- 기존 row 의 deleted_at NULL = 활성 (default 명확화)
-- (별 update 불필요 — NULL 자체가 활성 의미)

create index if not exists idx_cs_templates_active_deleted
  on cs_templates (is_active, deleted_at)
  where deleted_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) cs_sales_options — 카테고리별 영업 옵션
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists cs_sales_options (
  id               serial primary key,
  category         varchar(40) not null,    -- shipping/refund/stock/thanks/complaint/fraud_suspect/pre_purchase
  label            varchar(120) not null,   -- UI 체크박스 라벨
  content_snippet  text not null,           -- 선택 시 본문에 추가될 문장
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamp not null default now(),
  updated_at       timestamp not null default now(),
  unique (category, label)                  -- ON CONFLICT 시드용
);

create index if not exists idx_cs_sales_options_active
  on cs_sales_options (category, sort_order)
  where is_active = true;

-- 시드 7 row (사장님 spec 6종 + thanks 의 2 옵션 = 7)
-- ON CONFLICT DO NOTHING (사장님 짚을 점 5 — 멱등 패턴, migration 004 참고)
insert into cs_sales_options (category, label, content_snippet, sort_order) values
  ('shipping',     '추가 구매 시 묶음배송 가능',
   'Also, if you add another item to your order, we can ship them together at no extra cost.', 10),
  ('stock',        '다른 멤버/버전 추천',
   'While {product_name} is restocking, we have similar items available — feel free to ask for recommendations.', 10),
  ('refund',       '부분환불 vs 교환 vs 쿠폰 옵션',
   'We can offer a partial refund, exchange for a different item, or a store credit coupon — please let us know which works best for you.', 10),
  ('thanks',       '재구매 할인 코드',
   'As a thank you, here is a 5% discount code for your next purchase: THANKS5', 10),
  ('thanks',       '리뷰 요청',
   'If you have a moment, a positive review would mean a lot to our small team — thank you!', 20),
  ('complaint',    '리뷰 방어용 사과 + 해결안',
   'We sincerely apologize for the inconvenience. Please let us know how you would like us to make it right — refund, replacement, or partial credit.', 10),
  ('pre_purchase', '재고 X개 남았어요 (긴급성)',
   'Just a heads up — we currently have {stock_count} units left, so order soon to secure yours.', 10)
on conflict (category, label) do nothing;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) cs_responses — 답변 기록
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists cs_responses (
  id                       serial primary key,

  customer_message         text not null,

  detected_category        varchar(40),
  manual_category          varchar(40),

  buyer_username           varchar(120),       -- free-form text (사장님 짚을 점 3)
  buyer_platform           varchar(40),
  order_id                 varchar(120),
  product_name             varchar(200),
  tracking_number          varchar(120),

  selected_template_id     integer references cs_templates(id) on delete set null,
  selected_sales_options   jsonb,              -- [sales_option_id, ...]
  final_response_text      text,

  ai_tone_adjusted         boolean not null default false,

  -- 그룹 2 dep — FK 는 047 에서 add
  suspicious_buyer_id      integer,

  -- 의심 케이스 결과 기록 (그룹 3 에서 활성)
  result_status            varchar(40),        -- converted/repurchased/positive_review/refunded/case_opened/confirmed_fraud/blocked
  result_entered_by        integer,
  result_entered_at        timestamp,
  needs_result_entry       boolean not null default false,  -- (manual_category||detected_category) IN ('fraud_suspect','complaint') OR suspicious_buyer_id IS NOT NULL

  created_by               integer not null,
  created_at               timestamp not null default now(),
  updated_at               timestamp not null default now(),

  deleted_at               timestamp,
  deleted_by               integer  -- user id who performed soft delete (NOT original author; that is created_by)
);

create index if not exists idx_cs_responses_creator_active
  on cs_responses (created_by, created_at desc)
  where deleted_at is null;

create index if not exists idx_cs_responses_pending_result
  on cs_responses (needs_result_entry, result_status, created_at desc)
  where deleted_at is null and needs_result_entry = true;

create index if not exists idx_cs_responses_category
  on cs_responses (detected_category, manual_category)
  where deleted_at is null;

-- Rollback (수동):
--   drop index if exists idx_cs_responses_category;
--   drop index if exists idx_cs_responses_pending_result;
--   drop index if exists idx_cs_responses_creator_active;
--   drop table if exists cs_responses;
--   drop index if exists idx_cs_sales_options_active;
--   drop table if exists cs_sales_options;
--   drop index if exists idx_cs_templates_active_deleted;
--   alter table cs_templates drop column if exists last_used_at;
--   alter table cs_templates drop column if exists deleted_by;
--   alter table cs_templates drop column if exists deleted_at;
--   alter table cs_templates drop column if exists variables;
