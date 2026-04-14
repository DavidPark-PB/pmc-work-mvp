/**
 * 카탈로그 수동 편집용 2개 테이블
 * - catalog_settings: 지정 환율 (USD→KRW/EUR) 등 전역 설정
 * - catalog_image_overrides: 행별 이미지 URL 수동 지정
 */
const path = require('path');
require('dotenv').config({ path: path.join('automation', '.env') });
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const stmts = [
    `CREATE TABLE IF NOT EXISTS catalog_settings (
      key varchar(50) PRIMARY KEY,
      value text,
      updated_at timestamp DEFAULT now() NOT NULL,
      updated_by integer REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS catalog_image_overrides (
      tab varchar(200) NOT NULL,
      row_index integer NOT NULL,
      side varchar(10) NOT NULL,
      image_url text NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL,
      updated_by integer REFERENCES users(id),
      PRIMARY KEY (tab, row_index, side)
    )`,
  ];
  for (const s of stmts) {
    try { await c.query(s); console.log('✓', s.slice(0, 70)); }
    catch (e) { console.log('✗', s.slice(0, 70), '→', e.message); }
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
