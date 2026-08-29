-- Migration 104 · AI Workflow publication monitoring
--
-- Purpose: Owner-approved (2026-08-30) — when a listing is published via the
-- AI 상품 제작 workflow, remember which competitor eBay item it was cloned from
-- so that a periodic sweep can alert (via team_tasks bell) whenever the source
-- competitor drops their price within 30 days of our publish.
--
-- Alert policy (Owner spec):
--   · Channel   : Owner bell only  (assignee_scope='operators' → active admins)
--   · Threshold : ANY drop below rolling low-water mark (competitor_min_seen_price)
--   · Window    : 30 days after published_at (monitor_until)
--
-- Additive · idempotent · re-runnable. Uses IF NOT EXISTS / DO $$ EXCEPTION.

CREATE TABLE IF NOT EXISTS ai_workflow_publications (
  id                          BIGSERIAL PRIMARY KEY,
  my_ebay_item_id             TEXT        NOT NULL,
  my_publish_price            NUMERIC(12,2),
  competitor_item_id          TEXT        NOT NULL,
  competitor_price_at_publish NUMERIC(12,2),
  competitor_min_seen_price   NUMERIC(12,2),
  last_competitor_price       NUMERIC(12,2),
  last_checked_at             TIMESTAMPTZ,
  last_alerted_at             TIMESTAMPTZ,
  ended_at                    TIMESTAMPTZ,
  published_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  monitor_until               TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_by                  BIGINT REFERENCES users(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (my_ebay_item_id, competitor_item_id) 유일 — 같은 pair 중복 등록 방지.
--   re-publish 시 upsert 로 baseline 을 새로 갱신하려면 이 unique 필요.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public'
       AND indexname='ai_workflow_publications_pair_uidx'
  ) THEN
    CREATE UNIQUE INDEX ai_workflow_publications_pair_uidx
      ON ai_workflow_publications (my_ebay_item_id, competitor_item_id);
  END IF;
END $$;

-- 활성 sweep 대상만 빠르게 조회 (30일 이내 · 종료되지 않음).
CREATE INDEX IF NOT EXISTS ai_workflow_publications_active_idx
  ON ai_workflow_publications (monitor_until)
  WHERE ended_at IS NULL;

-- Sweep 시 오래된 것부터 처리 (rate limit 안분 배분).
CREATE INDEX IF NOT EXISTS ai_workflow_publications_lastchecked_idx
  ON ai_workflow_publications (last_checked_at NULLS FIRST);
