/**
 * attendance.status 컬럼 추가
 * 'regular' | 'late' | 'early_leave' | 'day_off' | 'absence'
 *
 * 사용: node scripts/migrate-attendance-status.js
 */
require('dotenv').config({ path: './config/.env' });
const { Client } = require('pg');

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('DATABASE_URL 또는 SUPABASE_DB_URL 필요');
  process.exit(1);
}

const client = new Client({ connectionString: url });

async function run() {
  await client.connect();
  console.log('[migrate] connected');

  const statements = [
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'regular' NOT NULL`,
    `CREATE INDEX IF NOT EXISTS attendance_status_idx ON attendance (status)`,
  ];

  for (const stmt of statements) {
    const preview = stmt.slice(0, 80);
    try {
      await client.query(stmt);
      console.log('  ✓', preview);
    } catch (e) {
      console.error('  ✗', preview);
      console.error('   →', e.message);
    }
  }

  // 기존 데이터 확인
  const { rows } = await client.query('SELECT status, COUNT(*)::int AS n FROM attendance GROUP BY status');
  console.log('[migrate] status 분포:', rows);

  await client.end();
  console.log('[migrate] done');
}

run().catch(e => { console.error(e); process.exit(1); });
