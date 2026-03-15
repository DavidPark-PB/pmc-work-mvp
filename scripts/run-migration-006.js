require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SQL_FILE = path.join(__dirname, '../supabase/migrations/006_product_dimensions.sql');

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error('\n❌ DATABASE_URL이 config/.env에 없습니다.');
    console.error('\nSupabase SQL Editor에서 실행하세요:');
    console.error('  https://supabase.com/dashboard/project/tsqposttkfrvgkyhwade/sql');
    console.error('  → supabase/migrations/006_product_dimensions.sql 내용 붙여넣고 실행\n');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('✅ Supabase 연결 성공');

    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    await client.query(sql);
    console.log('✅ 마이그레이션 완료: 006_product_dimensions.sql');

    const r = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='master_products' AND column_name IN ('box_length','box_width','box_height')"
    );
    console.log(`컬럼 확인: ${r.rows.map(r => r.column_name).join(', ') || '없음'}`);
  } catch (err) {
    console.error('❌ 마이그레이션 실패:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
