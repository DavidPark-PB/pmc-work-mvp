/**
 * run-migration-005.js
 * Supabase SQL Editor 대신 pg 클라이언트로 직접 마이그레이션 실행
 *
 * 실행: node scripts/run-migration-005.js
 *
 * 필요: SUPABASE_URL + SUPABASE_SERVICE_KEY (config/.env)
 *
 * Supabase connection pooler 주소 = db.[ref].supabase.co:5432
 * service_role key를 DB 비밀번호로 사용하는 방식은 지원되지 않으므로,
 * Supabase 대시보드 > Project Settings > Database > Connection string 에서
 * DATABASE_URL 을 config/.env에 추가해야 합니다.
 *
 * 또는 아래 방법 중 하나로 실행하세요:
 * 1. Supabase SQL Editor: https://supabase.com/dashboard/project/tsqposttkfrvgkyhwade/sql
 * 2. npx supabase login && npx supabase db push
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SQL_FILE = path.join(__dirname, '../supabase/migrations/005_dashboard_improvements.sql');

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error('\n❌ DATABASE_URL이 config/.env에 없습니다.');
    console.error('\n아래 방법 중 하나로 마이그레이션을 실행하세요:\n');
    console.error('방법 1 — Supabase SQL Editor (권장):');
    console.error('  https://supabase.com/dashboard/project/tsqposttkfrvgkyhwade/sql');
    console.error('  → 아래 파일 내용을 붙여넣고 실행:');
    console.error('  → supabase/migrations/005_dashboard_improvements.sql\n');
    console.error('방법 2 — DATABASE_URL 추가 후 재실행:');
    console.error('  Supabase Dashboard > Settings > Database > Connection string (URI)');
    console.error('  config/.env 에 추가: DATABASE_URL=postgresql://...\n');
    process.exit(1);
  }

  console.log('Supabase에 연결 중...');
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('✅ 연결 성공');

    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    console.log('\n마이그레이션 실행 중...');

    await client.query(sql);
    console.log('✅ 마이그레이션 완료: 005_dashboard_improvements.sql\n');

    // Verify key tables
    const checks = [
      "SELECT column_name FROM information_schema.columns WHERE table_name='products' AND column_name='workflow_status'",
      "SELECT table_name FROM information_schema.tables WHERE table_name='inventory'",
      "SELECT table_name FROM information_schema.tables WHERE table_name='automation_logs'",
    ];

    const labels = ['products.workflow_status 컬럼', 'inventory 테이블', 'automation_logs 테이블'];
    for (let i = 0; i < checks.length; i++) {
      const r = await client.query(checks[i]);
      console.log(`${r.rows.length > 0 ? '✅' : '❌'} ${labels[i]}`);
    }

    // Check indexes
    const idxCheck = await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='products' AND indexname IN ('idx_products_sku_btree','idx_products_workflow_status','idx_products_title_trgm')"
    );
    console.log(`\n인덱스 생성 확인: ${idxCheck.rows.map(r => r.indexname).join(', ') || '없음'}`);

  } catch (err) {
    console.error('❌ 마이그레이션 실패:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
