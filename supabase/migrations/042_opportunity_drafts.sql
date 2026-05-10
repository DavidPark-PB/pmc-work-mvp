-- 042_opportunity_drafts.sql
--
-- AI Draft Generator (PR R1 Phase 4) — opportunity_inbox 1건당 platform/language 별
-- AI 생성 draft 를 다수 보관 (1:N).
--
-- 정책:
--   - draft 본문 (title/description) 은 redact 통과 X — AI 가 만든 콘텐츠라 마스킹 불필요
--   - cost_usd / token 추적은 운영 비용 통제 + audit 용
--   - rollback: draft 삭제는 cascade (opportunity_inbox 가 archived/rejected 시 자동 정리 X — manual)
--
-- Pre-state:  041 적용 (opportunity_inbox)
-- Post-state: opportunity_drafts 테이블 + 4 인덱스 + 2 FK
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS +
--             FK 는 pg_constraint 조회 후 conditional ALTER (DO 블록 2개)
-- 무수정: 037~041 / 다른 Phase 1·2 테이블

-- ──────────────────────────────────────────────────────────────────────────
-- 1) opportunity_drafts 테이블
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists opportunity_drafts (
  id                serial primary key,
  opportunity_id    integer not null,                   -- opportunity_inbox(id), FK 는 아래 DO 블록
  platform          varchar(50) not null,               -- ebay/shopify/qoo10/...
  language          varchar(10) not null,               -- ko/en/ja/zh

  title             text,
  description       text,
  hashtags          text[],

  prompt_version    varchar(20),                        -- 'v1.0' 등
  ai_provider       varchar(50)  not null,              -- 'anthropic' | 'openai' | 'mock'
  ai_model          varchar(50),                        -- 'claude-sonnet-4-6' 등
  input_tokens      integer,
  output_tokens     integer,
  cost_usd          numeric(10,4),

  generated_by      integer,                            -- users(id), FK 는 아래 DO 블록
  generated_at      timestamp not null default now(),

  status            varchar(30) not null default 'generated',
  -- 허용: generated | approved | rejected | published

  approved_by       integer,                            -- users(id) — 본 PR 은 FK 생략 (운영 부담 최소화)
  approved_at       timestamp,

  metadata          jsonb,

  created_at        timestamp not null default now(),
  updated_at        timestamp not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Indexes
-- ──────────────────────────────────────────────────────────────────────────
create index if not exists idx_od_opportunity_generated
  on opportunity_drafts (opportunity_id, generated_at);

create index if not exists idx_od_status_generated
  on opportunity_drafts (status, generated_at);

create index if not exists idx_od_platform_language
  on opportunity_drafts (platform, language);

create index if not exists idx_od_generated_by_at
  on opportunity_drafts (generated_by, generated_at);

-- ──────────────────────────────────────────────────────────────────────────
-- 3) FK constraints (conditional)
-- ──────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_od_opportunity') then
    raise notice '[042] fk_od_opportunity already exists — skip';
  else
    alter table opportunity_drafts
      add constraint fk_od_opportunity
      foreign key (opportunity_id) references opportunity_inbox(id) on delete cascade;
    raise notice '[042] fk_od_opportunity ADDED';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_od_generated_by') then
    raise notice '[042] fk_od_generated_by already exists — skip';
  else
    alter table opportunity_drafts
      add constraint fk_od_generated_by
      foreign key (generated_by) references users(id) on delete set null;
    raise notice '[042] fk_od_generated_by ADDED';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Rollback (수동):
--   alter table opportunity_drafts drop constraint if exists fk_od_generated_by;
--   alter table opportunity_drafts drop constraint if exists fk_od_opportunity;
--   drop index if exists idx_od_generated_by_at;
--   drop index if exists idx_od_platform_language;
--   drop index if exists idx_od_status_generated;
--   drop index if exists idx_od_opportunity_generated;
--   drop table if exists opportunity_drafts;
-- ──────────────────────────────────────────────────────────────────────────
