-- PR-A 안전장치 (2026-10-21) · product_matches 스냅샷 백업.
--
-- 사용:
--   Supabase SQL Editor 에서 전체 실행. 데이터 전환 스크립트
--   (scripts/pr-a-reset-approved-matches.js --live) 돌리기 전에 반드시 실행.
--
-- 결과:
--   product_matches_backup_20261021 테이블이 product_matches 와 동일한
--   컬럼 + 데이터로 생성됨. 2,592 approved 건 포함 전체 스냅샷.
--   필요 시 scripts/pr-a-restore-from-backup.js 로 복원.

-- 이미 있으면 멱등 (실수로 두 번 실행해도 두 번째는 NOTICE 만)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='product_matches_backup_20261021') THEN
    RAISE NOTICE '[backup] product_matches_backup_20261021 이미 존재 — 재생성 건너뜀.';
    RAISE NOTICE '[backup] 기존 백업 삭제가 필요하면: DROP TABLE product_matches_backup_20261021;';
  ELSE
    CREATE TABLE product_matches_backup_20261021 AS
      TABLE product_matches;

    -- 인덱스는 없는 상태 (CREATE TABLE AS 는 데이터만 복사).
    -- 복구 조회는 id 기준이라 인덱스 하나만 추가.
    CREATE INDEX idx_pm_bkup_20261021_id ON product_matches_backup_20261021(id);

    -- 백업 당시 통계를 주석 테이블에 남김 (후속 검증용)
    COMMENT ON TABLE product_matches_backup_20261021 IS
      'PR-A 2026-10-21 백업 · product_matches 전체 스냅샷 · ' ||
      'approved 2592 + pending 2541 + rejected 121 포함.';

    RAISE NOTICE '[backup] product_matches_backup_20261021 생성 완료.';
  END IF;
END $$;

-- 백업 결과 집계 (확인용)
SELECT
  (SELECT COUNT(*) FROM product_matches)                 AS live_total,
  (SELECT COUNT(*) FROM product_matches_backup_20261021) AS backup_total,
  (SELECT COUNT(*) FROM product_matches_backup_20261021 WHERE status='approved') AS backup_approved,
  (SELECT COUNT(*) FROM product_matches_backup_20261021 WHERE status='pending')  AS backup_pending,
  (SELECT COUNT(*) FROM product_matches_backup_20261021 WHERE status='rejected') AS backup_rejected;
