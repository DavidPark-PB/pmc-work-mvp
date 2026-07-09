-- 070_seller_crawl_tiers.sql
-- 경쟁 셀러 크롤 우선순위 = 티어 시스템 + 대형 셀러 청크 처리 지원.
--
-- 사장님 지침 (2026-07-09):
--   - 하루 1셀러씩 로테이션 (last_crawled_at 오래된 순)
--   - 리스팅 3000~10000개 대형 셀러는 하루 안에 못 끝냄 → 청크 이어서
--   - 핵심 3~5셀러 (박터지는 상대) 는 매일 크롤 (티어 F/D)
--   - 나머지는 천천히 (소싱 후보 발굴이 주 목적)
--
-- competitor_sellers 에 4개 컬럼 추가:
--   crawl_tier              — 'F'(핵심 매일) | 'D'(우선 매일) | 'C'(주2회) | 'B'(주1회) | 'A'(격주)
--   next_crawl_offset       — 대형 셀러 청크 이어받기용 페이지 오프셋
--   crawl_chunk_size        — 하루 처리 최대 리스팅 수 (기본 500)
--   crawl_cycle_started_at  — 이번 한 바퀴 크롤 시작 시각 (진행률 표시용)

alter table competitor_sellers
  add column if not exists crawl_tier             text default 'B',
  add column if not exists next_crawl_offset      integer default 0,
  add column if not exists crawl_chunk_size       integer default 500,
  add column if not exists crawl_cycle_started_at timestamptz;

-- crawl_tier 값 제약
do $$ begin
  alter table competitor_sellers
    add constraint chk_competitor_sellers_crawl_tier
    check (crawl_tier in ('F','D','C','B','A'));
exception when duplicate_object then null; end $$;

-- 로테이션 조회용 인덱스 (last_crawled_at 오래된 순 스캔)
create index if not exists idx_competitor_sellers_rotation
  on competitor_sellers (active, crawl_tier, last_crawled_at nulls first);

-- 기존 target_sellers.tier 있으면 crawl_tier 로 마이그레이션 (best-effort)
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='target_sellers' and column_name='tier') then
    update competitor_sellers cs
    set crawl_tier = ts.tier
    from target_sellers ts
    where cs.seller_id = ts.seller_name
      and ts.tier in ('F','D','C','B','A')
      and cs.crawl_tier = 'B';  -- default 만 덮어쓰기
  end if;
end $$;

comment on column competitor_sellers.crawl_tier is 'F=핵심매일 D=우선매일 C=주2회 B=주1회(기본) A=격주. runCrawler 우선순위 결정.';
comment on column competitor_sellers.next_crawl_offset is '대형 셀러 청크 이어받기 페이지 오프셋. 완료 시 0 리셋.';
comment on column competitor_sellers.crawl_chunk_size is '하루 처리 최대 리스팅 수 (기본 500). 대형 셀러 rate limit 방어.';
comment on column competitor_sellers.crawl_cycle_started_at is '이번 한 바퀴 시작 시각. 진행률 표시용.';
