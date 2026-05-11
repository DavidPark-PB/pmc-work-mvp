-- 047_suspicious_buyers.sql
--
-- PR CS-G2-B: 진상/사기 바이어 DB + 사건 기록.
--
-- 사장님 spec 의 외부 공유 안전선:
--   - 내부용 필드 (real_name / email / phone / address / platform_ids / evidence_urls)
--   - 공개 가능 필드 (anonymized_id / country / region / suspicion_level / incident_types
--                   / pattern_description / red_flags / is_public_shareable)
--   - 응답 shape helper (internalShape vs publicShape) 가 노출 분리. 본 마이그레이션은 컬럼만 분리.
--
-- 권한 (route 단에서 enforce):
--   - 등록 / 사건 기록 / patternDescription 수정 = 모든 직원
--   - 삭제 (soft) / suspicion_level 변경 / anonymized_id·country·region·is_public_shareable 편집 = admin only
--   - public-view API (그룹 3) 는 isPublicShareable=true 만 노출
--
-- 그룹 3 dep:
--   - public-view / case-study-preview API 는 본 PR 에 미포함. 컬럼 / 필드 모두 미리 등록.
--
-- Pre-state:  046 적용 (cs_phase1)
-- Post-state: suspicious_buyers + suspicious_incidents + cs_responses.suspicious_buyer_id FK
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, FK 는 pg_constraint 조회 후 conditional ALTER
-- 무수정: 037~046 / 다른 모든 모듈

-- ──────────────────────────────────────────────────────────────────────────
-- 1) suspicious_buyers
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists suspicious_buyers (
  id                       serial primary key,

  -- 내부용 필드 (외부 노출 절대 X — publicShape() 가 차단)
  real_name                varchar(120),
  email                    varchar(200),
  phone                    varchar(50),
  address                  text,
  platform_ids             jsonb,            -- { ebay: "...", shopify: "...", qoo10: "...", coupang: "...", smartstore: "...", alibaba: "..." }

  -- 공개 가능 필드 (마케팅 에이전트 사용 가능, 그룹 3 의 public-view 노출 대상)
  anonymized_id            varchar(60),      -- 예: "J.S."
  country                  varchar(60),
  region                   varchar(60),      -- 북미/유럽/동남아/중국 등 권역
  suspicion_level          varchar(20) not null default '의심',  -- '의심' | '주의' | '블랙리스트'
  incident_types           jsonb,            -- ['사기','파손사기','협박','저격feedback','카드도용','재포장반품', ...]
  pattern_description      text,             -- 익명화된 케이스 스터디용 수법 설명
  red_flags                jsonb,            -- 위험 신호 키워드 배열
  evidence_urls            jsonb,            -- 캡처 이미지 URL — 내부용. 외부 공유 시 마스킹 필요
  notes                    text,

  reported_by              integer not null,
  is_verified_by_admin     boolean not null default false,
  community_vote_count     integer not null default 0,    -- 향후 커뮤니티 기능 대비
  is_public_shareable      boolean not null default false, -- 공개 콘텐츠 활용 동의 여부

  -- 6 platform 차단 플래그 (각각 admin only 토글)
  is_blocked_on_ebay         boolean not null default false,
  is_blocked_on_shopify      boolean not null default false,
  is_blocked_on_qoo10        boolean not null default false,
  is_blocked_on_coupang      boolean not null default false,
  is_blocked_on_smartstore   boolean not null default false,
  is_blocked_on_alibaba      boolean not null default false,

  created_at               timestamp not null default now(),
  updated_at               timestamp not null default now(),

  deleted_at               timestamp,
  deleted_by               integer  -- user id who performed soft delete (NOT 원 신고자; that is reported_by)
);

create index if not exists idx_susp_buyers_active
  on suspicious_buyers (suspicion_level, created_at desc)
  where deleted_at is null;

create index if not exists idx_susp_buyers_email
  on suspicious_buyers (lower(email))
  where deleted_at is null and email is not null;

create index if not exists idx_susp_buyers_realname
  on suspicious_buyers (lower(real_name))
  where deleted_at is null and real_name is not null;

create index if not exists idx_susp_buyers_country
  on suspicious_buyers (country, region)
  where deleted_at is null;

create index if not exists idx_susp_buyers_public
  on suspicious_buyers (is_public_shareable)
  where deleted_at is null and is_public_shareable = true;

-- platform_ids jsonb 검색용 GIN 인덱스 (예: WHERE platform_ids @> '{"ebay":"badbuyer123"}')
create index if not exists idx_susp_buyers_platform_ids
  on suspicious_buyers using gin (platform_ids)
  where deleted_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) suspicious_incidents
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists suspicious_incidents (
  id                serial primary key,
  buyer_id          integer not null,         -- FK 는 아래 DO 블록
  date              date,                     -- 사건 발생일 (없으면 created_at 사용)
  platform          varchar(40),              -- ebay/shopify/qoo10/coupang/smartstore/alibaba/...
  order_number      varchar(120),
  incident_type     varchar(60),              -- 사기 / 파손사기 / 협박 / 저격feedback / 카드도용 / 재포장반품 / 기타
  description       text,
  amount            numeric(14,2),            -- 피해액
  resolution        varchar(60),              -- 환불됨 / 거절됨 / 케이스승소 / 케이스패배 / 미결
  screenshot_urls   jsonb,                    -- 캡처 이미지 (내부용)

  created_by        integer not null,
  created_at        timestamp not null default now(),
  updated_at        timestamp not null default now(),

  deleted_at        timestamp,
  deleted_by        integer  -- user id who performed soft delete (NOT original creator)
);

create index if not exists idx_susp_incidents_buyer
  on suspicious_incidents (buyer_id, date desc nulls last, created_at desc)
  where deleted_at is null;

create index if not exists idx_susp_incidents_platform
  on suspicious_incidents (platform, incident_type)
  where deleted_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) FK constraints (conditional)
-- ──────────────────────────────────────────────────────────────────────────

-- suspicious_incidents.buyer_id → suspicious_buyers(id) on delete cascade
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_susp_incidents_buyer') then
    raise notice '[047] fk_susp_incidents_buyer already exists — skip';
  else
    alter table suspicious_incidents
      add constraint fk_susp_incidents_buyer
      foreign key (buyer_id) references suspicious_buyers(id) on delete cascade;
    raise notice '[047] fk_susp_incidents_buyer ADDED';
  end if;
end $$;

-- cs_responses.suspicious_buyer_id → suspicious_buyers(id) on delete set null
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_cs_responses_susp_buyer') then
    raise notice '[047] fk_cs_responses_susp_buyer already exists — skip';
  else
    alter table cs_responses
      add constraint fk_cs_responses_susp_buyer
      foreign key (suspicious_buyer_id) references suspicious_buyers(id) on delete set null;
    raise notice '[047] fk_cs_responses_susp_buyer ADDED';
  end if;
end $$;

-- Rollback (수동):
--   alter table cs_responses drop constraint if exists fk_cs_responses_susp_buyer;
--   alter table suspicious_incidents drop constraint if exists fk_susp_incidents_buyer;
--   drop index if exists idx_susp_incidents_platform;
--   drop index if exists idx_susp_incidents_buyer;
--   drop table if exists suspicious_incidents;
--   drop index if exists idx_susp_buyers_platform_ids;
--   drop index if exists idx_susp_buyers_public;
--   drop index if exists idx_susp_buyers_country;
--   drop index if exists idx_susp_buyers_realname;
--   drop index if exists idx_susp_buyers_email;
--   drop index if exists idx_susp_buyers_active;
--   drop table if exists suspicious_buyers;
