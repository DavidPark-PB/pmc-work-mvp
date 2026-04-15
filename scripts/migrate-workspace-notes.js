/**
 * workspace_notes — 직원 개인 워크스페이스 노트/링크 아카이브
 * 본인 것만 읽고 쓸 수 있음 (RLS는 서비스 레이어에서)
 */
const path = require('path');
require('dotenv').config({ path: path.join('automation', '.env') });
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const stmts = [
    `CREATE TABLE IF NOT EXISTS workspace_notes (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title varchar(300),
      content text,
      tag varchar(50),
      pinned boolean DEFAULT false NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS workspace_notes_user_idx ON workspace_notes (user_id, pinned DESC, updated_at DESC)`,
  ];
  for (const s of stmts) {
    try { await c.query(s); console.log('✓', s.slice(0, 70)); }
    catch (e) { console.log('✗', s.slice(0, 70), '→', e.message); }
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
