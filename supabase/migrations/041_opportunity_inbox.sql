-- 041_opportunity_inbox.sql
--
-- Opportunity Inbox (PR R0) — 직원/알바가 발견한 상품 후보 / 콘텐츠 소재 /
-- 경쟁셀러 / 번개장터·마트 소싱 / Qoo10·Shopify·Alibaba 등록 후보 /
-- Proxy Shipping 문제를 한 곳에 모으는 inbox.
--
-- 운영 원칙:
--   - Telegram = 사장님이 외부에서 AI/시스템에 업무 지시 (직접 연동은 미구현)
--   - KakaoTalk = 국내 직원/알바에게 업무 전달, 직원이 모바일 링크로 제출
--   - 본 migration 은 카카오/텔레그램 직접 연동 X — 향후를 위해 input_channel 컬럼만 둠
--
-- 본 PR 범위:
--   - 후보 등록 / 목록 조회 / 상태 변경 / 담당자·제출자 기록 / 후보 유형 분류
--   - Phase 0~2 entity (sku_master / wms_orders / team_tasks) 와 연결할 수 있는 FK
--
-- 본 PR 제외:
--   - AI 생성 / 플랫폼 등록 / 가격 크롤링 / 외부 API 발행 / 텔레그램 / 카카오 연동
--
-- Pre-state:  040 적용 (Safety Foundation)
-- Post-state: opportunity_inbox 테이블 신설 + 9 인덱스 + 6 FK
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS +
--             FK 는 pg_constraint 조회 후 conditional ALTER (DO 블록 6개)
-- 무수정: 037~040 / public.orders / 다른 Phase 1·2 테이블

-- ──────────────────────────────────────────────────────────────────────────
-- 1) opportunity_inbox 테이블
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists opportunity_inbox (
  id                       serial primary key,

  opportunity_type         varchar(50)  not null,
  -- 허용: product_sourcing | content_idea | competitor_product | b2b_buyer |
  --       qoo10_candidate | shopee_candidate | shopify_candidate | alibaba_candidate |
  --       proxy_shipping_issue | price_attack_candidate

  source_type              varchar(50),
  -- 허용 (null 가능): bunjang | mart | competitor | staff_idea | buyer_request |
  --       alibaba_inquiry | qoo10 | shopee | shopify | instagram | x | tiktok |
  --       youtube_shorts | xiaohongshu | wechat | discord | naver_blog

  input_channel            varchar(50)  default 'web',
  -- 허용: web | mobile | telegram | kakao_share | api

  source_url               text,
  source_name              varchar(200),

  title                    varchar(255),
  title_ko                 varchar(255),
  title_en                 varchar(255),
  title_ja                 varchar(255),
  title_zh                 varchar(255),

  brand                    varchar(100),
  category                 varchar(100),  -- sku_master.category 와 동일 형식 (자유 텍스트)

  expected_buy_price_krw   numeric,
  expected_sell_price_krw  numeric,
  expected_sell_price_usd  numeric,
  estimated_margin_rate    numeric,

  estimated_demand         varchar(30),   -- low | medium | high | unknown
  target_platforms         text[],        -- 각 원소: shopify|ebay|alibaba|qoo10|shopee|naver_smartstore|coupang|x|instagram|tiktok|youtube_shorts|xiaohongshu|wechat|discord|naver_blog

  priority                 varchar(30)  default 'normal',
  -- 허용: low | normal | high | urgent

  status                   varchar(30)  default 'new',
  -- 허용: new | reviewing | approved | auto_handled | rejected | draft_ready |
  --       assigned | published | archived

  assigned_to              integer,       -- users(id), FK 는 아래 DO 블록
  submitted_by             integer,       -- users(id), FK 는 아래 DO 블록
  approved_by              integer,       -- users(id), FK 는 아래 DO 블록
  approved_at              timestamp,
  rejection_reason         text,

  linked_sku_id            integer,       -- sku_master(id), FK 는 아래 DO 블록
  linked_order_id          integer,       -- wms_orders(id) — 사전 조사 C: integer 확정
  linked_task_id           integer,       -- team_tasks(id) — 사전 조사 C: integer 확정

  notes                    text,
  image_urls               text[],        -- 외부 URL 배열. 업로드 인프라 미구현. URL 만 받음.
  metadata                 jsonb,

  created_at               timestamp not null default now(),
  updated_at               timestamp not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Indexes (전부 IF NOT EXISTS)
-- ──────────────────────────────────────────────────────────────────────────
create index if not exists idx_oi_status_priority_created
  on opportunity_inbox (status, priority, created_at);

create index if not exists idx_oi_type_created
  on opportunity_inbox (opportunity_type, created_at);

create index if not exists idx_oi_assigned_status
  on opportunity_inbox (assigned_to, status);

create index if not exists idx_oi_submitted_created
  on opportunity_inbox (submitted_by, created_at);

create index if not exists idx_oi_source_created
  on opportunity_inbox (source_type, created_at);

create index if not exists idx_oi_input_channel_created
  on opportunity_inbox (input_channel, created_at);

-- partial indexes — linked_* 는 대부분 null 일 가능성 높아 partial 로
create index if not exists idx_oi_linked_sku
  on opportunity_inbox (linked_sku_id) where linked_sku_id is not null;

create index if not exists idx_oi_linked_order
  on opportunity_inbox (linked_order_id) where linked_order_id is not null;

create index if not exists idx_oi_linked_task
  on opportunity_inbox (linked_task_id) where linked_task_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) FK constraints (conditional — pg_constraint 조회 후 add)
--    DO 블록 6개. 각 블록은 두 번 실행해도 안전.
-- ──────────────────────────────────────────────────────────────────────────

-- 3-1. linked_sku_id → sku_master(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_linked_sku') then
    raise notice '[041] fk_oi_linked_sku already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_linked_sku
      foreign key (linked_sku_id) references sku_master(id) on delete set null;
    raise notice '[041] fk_oi_linked_sku ADDED';
  end if;
end $$;

-- 3-2. linked_order_id → wms_orders(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_linked_order') then
    raise notice '[041] fk_oi_linked_order already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_linked_order
      foreign key (linked_order_id) references wms_orders(id) on delete set null;
    raise notice '[041] fk_oi_linked_order ADDED';
  end if;
end $$;

-- 3-3. linked_task_id → team_tasks(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_linked_task') then
    raise notice '[041] fk_oi_linked_task already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_linked_task
      foreign key (linked_task_id) references team_tasks(id) on delete set null;
    raise notice '[041] fk_oi_linked_task ADDED';
  end if;
end $$;

-- 3-4. assigned_to → users(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_assigned_to') then
    raise notice '[041] fk_oi_assigned_to already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_assigned_to
      foreign key (assigned_to) references users(id) on delete set null;
    raise notice '[041] fk_oi_assigned_to ADDED';
  end if;
end $$;

-- 3-5. submitted_by → users(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_submitted_by') then
    raise notice '[041] fk_oi_submitted_by already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_submitted_by
      foreign key (submitted_by) references users(id) on delete set null;
    raise notice '[041] fk_oi_submitted_by ADDED';
  end if;
end $$;

-- 3-6. approved_by → users(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_oi_approved_by') then
    raise notice '[041] fk_oi_approved_by already exists — skip';
  else
    alter table opportunity_inbox
      add constraint fk_oi_approved_by
      foreign key (approved_by) references users(id) on delete set null;
    raise notice '[041] fk_oi_approved_by ADDED';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Rollback (수동 — 운영 적용 후 문제 발생 시):
--   alter table opportunity_inbox drop constraint if exists fk_oi_linked_sku;
--   alter table opportunity_inbox drop constraint if exists fk_oi_linked_order;
--   alter table opportunity_inbox drop constraint if exists fk_oi_linked_task;
--   alter table opportunity_inbox drop constraint if exists fk_oi_assigned_to;
--   alter table opportunity_inbox drop constraint if exists fk_oi_submitted_by;
--   alter table opportunity_inbox drop constraint if exists fk_oi_approved_by;
--   drop index if exists idx_oi_linked_task;
--   drop index if exists idx_oi_linked_order;
--   drop index if exists idx_oi_linked_sku;
--   drop index if exists idx_oi_input_channel_created;
--   drop index if exists idx_oi_source_created;
--   drop index if exists idx_oi_submitted_created;
--   drop index if exists idx_oi_assigned_status;
--   drop index if exists idx_oi_type_created;
--   drop index if exists idx_oi_status_priority_created;
--   drop table if exists opportunity_inbox;
-- ──────────────────────────────────────────────────────────────────────────
