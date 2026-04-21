-- Phase 7: TCG 셀러 리드 (미래 B2B 바이어 후보 CRM)
-- status로 단계 구분:
--   cold        → 📋 리스트업 페이지 (아직 연락 안 함)
--   contacted/replied/negotiating → 💬 활성 리드 페이지
--   converted   → b2b_buyers로 복사됐으니 UI에서 숨김
--   dead        → 중단 (기록 보관용, UI에서 숨김)

create table if not exists prospects (
  id serial primary key,
  name varchar(200) not null,
  company varchar(200),
  source_platform varchar(40) not null,       -- tcgplayer | cardmarket | ebay | facebook | instagram | twitter | discord | shopify | youtube | reddit | other
  source_url text,                            -- 그 사람 스토어/프로필 링크
  country varchar(40),
  email varchar(200),
  whatsapp varchar(50),
  dm_handle varchar(100),
  phone varchar(50),
  product_focus varchar(200),
  status varchar(20) not null default 'cold',
  converted_buyer_id varchar(20),             -- b2b_buyers.buyer_id 참조 (FK는 없음 — 독립 관리)
  last_contacted_at date,
  next_follow_up_at date,
  last_message_summary text,
  dead_reason text,
  notes text,
  tags jsonb not null default '[]'::jsonb,
  created_by integer references users(id),
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists prospects_status_idx on prospects (status);
create index if not exists prospects_platform_idx on prospects (source_platform);
create index if not exists prospects_followup_idx on prospects (next_follow_up_at) where status in ('contacted','replied','negotiating');
