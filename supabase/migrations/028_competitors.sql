-- Phase 7: 경쟁업체 관리 (수동 리스트)
-- ops-competitor는 SKU 단위 자동 가격 크롤링. 이 테이블은 별개 — "어떤 애들이 경쟁 중인지" 명단.
-- 가격 필드는 의도적으로 제외. 메모·강점·약점에 자유롭게 기록.

create table if not exists competitors (
  id serial primary key,
  name varchar(200) not null,
  platform varchar(40) not null,              -- ebay | shopify | naver | alibaba | shopee | tcgplayer | cardmarket | amazon | other
  store_url text,
  country varchar(40),
  product_focus varchar(200),                 -- "Pokemon Japanese sealed"
  strengths text,                             -- 잘하는 점
  weaknesses text,                            -- 빈틈
  threat_level varchar(10) not null default 'medium',  -- low | medium | high
  last_checked_at date,
  tags jsonb not null default '[]'::jsonb,
  notes text,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists competitors_platform_idx on competitors (platform);
create index if not exists competitors_threat_idx on competitors (threat_level);
