-- Migration 119 (2026-10-20) — product_matches 승인 무결성 Part 2 (PR-A)
--
-- 전제: Migration 118 적용 + 데이터 정리 스크립트 실행 완료.
--   scripts/pr-a-reset-approved-matches.js 가 2,592 approved → suggested
--   (의심/깨끗함/기타 전부 전환) + 애매함 17 pending → pending_review 완료.
--   정리 후 approved 상태의 row 는 전부 approved_by 가 실제 사람 (users.username).
--
-- 이 마이그는 그 상태를 DB 가 영구히 지킴:
--   1. status='approved' 이면 approved_by NOT NULL
--   2. approved_by 는 non-human sentinel 금지 (claude_code*/admin/system/
--      service_role/bot/auto)
--
-- 적용 전 반드시 다음 쿼리로 위반 row 가 0 임을 확인:
--   SELECT * FROM v_product_matches_integrity;
--     → approved_no_approver = 0
--     → approved_non_human   = 0

-- 1. status='approved' 이면 approved_by NOT NULL ────────────────
ALTER TABLE product_matches
  DROP CONSTRAINT IF EXISTS product_matches_approved_by_required_when_approved;

ALTER TABLE product_matches
  ADD CONSTRAINT product_matches_approved_by_required_when_approved
  CHECK (status <> 'approved' OR approved_by IS NOT NULL);

-- 2. non-human sentinel 금지 ─────────────────────────────────────
--    사장님 지침: "'claude_code%', 'admin', 'system'은 금지하는 CHECK".
--    운영에서 발견된 모든 sentinel 포함:
--      claude_code / claude_code_bulk / claude_code_bulk_title /
--      claude_code_auto / claude_code_vg_full / claude_code_onmom_full /
--      admin / system / service_role / bot / auto
ALTER TABLE product_matches
  DROP CONSTRAINT IF EXISTS product_matches_approved_by_human_only;

ALTER TABLE product_matches
  ADD CONSTRAINT product_matches_approved_by_human_only
  CHECK (
    approved_by IS NULL
    OR (
      lower(approved_by) !~ '^(claude_code|admin|system|service_role|bot|auto)(_|$)'
      AND lower(approved_by) NOT IN ('claude_code','admin','system','service_role','bot','auto')
    )
  );

-- rollback (수동):
--   ALTER TABLE product_matches DROP CONSTRAINT IF EXISTS product_matches_approved_by_required_when_approved;
--   ALTER TABLE product_matches DROP CONSTRAINT IF EXISTS product_matches_approved_by_human_only;
