import 'dotenv/config';
import pg from 'pg';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== DB 전체 리셋 ===\n');

  // 모든 테이블 조회
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(`기존 테이블: ${tables.length}개`);
  for (const t of tables) console.log(`  - ${t.table_name}`);

  // CASCADE로 전부 삭제
  console.log('\n--- DROP ALL ---');
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO postgres');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  console.log('public 스키마 리셋 완료');

  // 확인
  const { rows: remaining } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  console.log(`\n남은 테이블: ${remaining.length}개`);

  await pool.end();
  console.log('\n=== 완료 ===');
}

main().catch(e => { console.error(e); process.exit(1); });
