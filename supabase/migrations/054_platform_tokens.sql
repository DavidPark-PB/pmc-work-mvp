-- platform_tokens — 플랫폼 OAuth 토큰 DB 영속화 (eBay / Shopee / Alibaba 등).
--
-- 배경 (사장님 보고 2026-06-24):
--   eBay 토큰 자동 갱신이 "되다 안되다" 함. 원인:
--   - src/api/ebayAPI.js constructor 가 process.env 만 읽음
--   - tokenRefresh job 이 갱신 시 process.env 만 set → Railway restart 되면 옛 토큰으로 리셋
--   - refresh 응답의 새 refresh_token 도 저장 안 함 → eBay 가 rotation 하면 다음 갱신 fail
--
-- 해결:
--   토큰을 이 테이블에 영속화. EbayAPI 가 DB 우선 → env 폴백.
--   refresh 시 access_token + refresh_token 모두 DB upsert.
--
-- 주의: automation/src/db/schema.ts 의 drizzle schema 와 동일한 구조 — 이미
-- prod 에 push 되어 있을 가능성 있음. IF NOT EXISTS 로 멱등 보장.

create table if not exists platform_tokens (
  id            serial primary key,
  platform      varchar(50) not null unique,    -- 'ebay', 'shopee', 'alibaba' 등
  access_token  text        not null,
  refresh_token text,
  expires_at    timestamp,
  metadata      jsonb,
  updated_at    timestamp   not null default now()
);

create index if not exists idx_platform_tokens_platform on platform_tokens(platform);
