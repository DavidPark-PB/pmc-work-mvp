-- 050_cs_tone_cost.sql
--
-- PR CS-G3 후속: cs_responses 에 AI 톤 다듬기 cost 추적 컬럼 추가.
--
-- 사장님 spec (이전 plan):
--   - 실 호출 활성 시 cs_responses.cost_usd 컬럼 + daily cap query 추가 (후속 PR)
--   - aiDraftGenerator 와 동일 패턴: cap 도달 시 429 응답
--
-- 신규 컬럼:
--   ai_tone_cost_usd  numeric(10,4)  — Anthropic 호출 실 비용 (mock=0)
--   ai_tone_provider  varchar(50)    — 'anthropic' | 'mock' | 'openai' 등
--   ai_tone_model     varchar(50)    — 'claude-sonnet-4-6' 등
--   ai_tone_at        timestamp      — 다듬기 호출 시각 (cap query 의 윈도우)
--
-- Pre-state:  049 적용 (stocktake_phase2)
-- Post-state: cs_responses 4 컬럼 + 1 인덱스
-- Idempotent: ADD COLUMN IF NOT EXISTS
-- 무수정: 037~049 / Safety / 다른 모든 모듈

alter table cs_responses add column if not exists ai_tone_cost_usd numeric(10,4);
alter table cs_responses add column if not exists ai_tone_provider varchar(50);
alter table cs_responses add column if not exists ai_tone_model    varchar(50);
alter table cs_responses add column if not exists ai_tone_at       timestamp;

-- daily cap query 가속용 인덱스 (provider != 'mock' AND ai_tone_at >= today)
create index if not exists idx_cs_responses_ai_tone_at
  on cs_responses (ai_tone_at desc)
  where ai_tone_provider is not null and ai_tone_provider <> 'mock';

-- Rollback (수동):
--   drop index if exists idx_cs_responses_ai_tone_at;
--   alter table cs_responses drop column if exists ai_tone_at;
--   alter table cs_responses drop column if exists ai_tone_model;
--   alter table cs_responses drop column if exists ai_tone_provider;
--   alter table cs_responses drop column if exists ai_tone_cost_usd;
