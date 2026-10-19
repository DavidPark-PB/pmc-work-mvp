-- Migration 118 (2026-10-20) — product_matches 승인 무결성 Part 1 (PR-A)
--
-- 이 마이그는 비파괴 변경만:
--   1. status enum 확장 ('suggested', 'pending_review' 추가)
--   2. review_priority 컬럼 추가
--   3. 운영 모니터링 뷰
--
-- CHECK 제약 (approved_by NOT NULL, non-human 금지) 은 Migration 119 에서
-- 데이터 정리 (approved 2,592 → suggested) 가 끝난 후에 추가됨.
-- 지금 순서로 CHECK 를 걸면 기존 데이터가 즉시 위반해 마이그 실패.

-- 1. status enum 확장 ──────────────────────────────────────────
--    기존: pending/approved/rejected/ignored
--    새  : + suggested, + pending_review
--    pending/ignored 는 하위호환 유지. 데이터 전환은 코드 커밋에서.
ALTER TABLE product_matches
  DROP CONSTRAINT IF EXISTS product_matches_status_check;

ALTER TABLE product_matches
  ADD CONSTRAINT product_matches_status_check
  CHECK (status IN ('suggested','pending','approved','rejected','pending_review','ignored'));

-- 2. review_priority 컬럼 ──────────────────────────────────────
--    사장님 지침: "깨끗함 1,135건에는 review_priority=1 표시 (재승인 1순위)".
--    1=깨끗함/1순위 · 2=일반 · NULL=미분류/신규
ALTER TABLE product_matches
  ADD COLUMN IF NOT EXISTS review_priority smallint;

CREATE INDEX IF NOT EXISTS idx_prod_matches_review_priority
  ON product_matches(review_priority)
  WHERE review_priority IS NOT NULL;

COMMENT ON COLUMN product_matches.review_priority IS
  '검수 우선순위 (1=깨끗함/1순위, 2=일반, NULL=미분류). PR-A 2026-10-20.';

-- 3. 사후 확인용 뷰 ────────────────────────────────────────────
DROP VIEW IF EXISTS v_product_matches_integrity;
CREATE VIEW v_product_matches_integrity AS
SELECT
  (SELECT COUNT(*) FROM product_matches WHERE status='approved' AND approved_by IS NULL)                                                        AS approved_no_approver,
  (SELECT COUNT(*) FROM product_matches WHERE status='approved' AND lower(approved_by) ~ '^(claude_code|admin|system|service_role|bot|auto)(_|$)') AS approved_non_human,
  (SELECT COUNT(*) FROM product_matches WHERE status='approved')       AS approved_total,
  (SELECT COUNT(*) FROM product_matches WHERE status='suggested')      AS suggested_total,
  (SELECT COUNT(*) FROM product_matches WHERE status='pending')        AS pending_total,
  (SELECT COUNT(*) FROM product_matches WHERE status='pending_review') AS pending_review_total,
  (SELECT COUNT(*) FROM product_matches WHERE status='rejected')       AS rejected_total,
  (SELECT COUNT(*) FROM product_matches WHERE review_priority = 1)     AS priority_1_count;

COMMENT ON VIEW v_product_matches_integrity IS
  'PR-A 2026-10-20 · 승인 무결성 실시간 집계 (전투 상황판/Slack 리포트용).';

-- rollback (수동):
--   DROP VIEW IF EXISTS v_product_matches_integrity;
--   ALTER TABLE product_matches DROP COLUMN IF EXISTS review_priority;
--   ALTER TABLE product_matches DROP CONSTRAINT product_matches_status_check;
--   ALTER TABLE product_matches ADD CONSTRAINT product_matches_status_check
--     CHECK (status IN ('pending','approved','rejected','ignored'));
