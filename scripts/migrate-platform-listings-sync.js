/**
 * platform_listings에 외부 플랫폼 동기화용 컬럼 추가
 * - last_modified_at: 플랫폼 기준 최종 수정 시각 (증분 동기화용)
 * - detail_fetched:   상세 정보 (SKU/이미지 등) 가져왔는지 (네이버 enrichment용)
 */
const path = require('path');
require('dotenv').config({ path: path.join('automation', '.env') });
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const stmts = [
    `ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS last_modified_at timestamp`,
    `ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS detail_fetched boolean DEFAULT false NOT NULL`,
    `CREATE INDEX IF NOT EXISTS platform_listings_detail_idx ON platform_listings (platform, detail_fetched)`,
    `CREATE INDEX IF NOT EXISTS platform_listings_last_modified_idx ON platform_listings (platform, last_modified_at)`,
  ];
  for (const s of stmts) {
    try { await c.query(s); console.log('✓', s.slice(0, 80)); }
    catch (e) { console.log('✗', s.slice(0, 80), '→', e.message); }
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
