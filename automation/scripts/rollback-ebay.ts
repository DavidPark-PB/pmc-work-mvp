import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function rollback() {
  console.log('=== eBay 잘못된 교정 되돌리기 ===\n');

  // 1. verify 스크립트가 최근 30분 내에 ended로 바꾼 eBay 리스팅 → active 복원
  const r1 = await db.execute(sql`
    UPDATE platform_listings SET status = 'active', updated_at = NOW()
    WHERE platform = 'ebay' AND status = 'ended'
    AND updated_at > NOW() - INTERVAL '60 minutes'
  `);
  console.log(`eBay ended→active 복원: ${r1.rowCount}개`);

  // 2. 품절 상품의 eBay listing은 다시 ended로
  const r2 = await db.execute(sql`
    UPDATE platform_listings SET status = 'ended', updated_at = NOW()
    WHERE platform = 'ebay' AND status = 'active'
    AND product_id IN (SELECT id FROM products WHERE status = 'soldout')
  `);
  console.log(`품절 상품 eBay → ended 복원: ${r2.rowCount}개`);

  // 3. products.status 복원
  const r3 = await db.execute(sql`
    UPDATE products SET status = 'active', updated_at = NOW()
    WHERE status = 'ended'
    AND id IN (SELECT DISTINCT product_id FROM platform_listings WHERE status = 'active')
  `);
  console.log(`products ended→active 복원: ${r3.rowCount}개`);

  // 4. 검증
  const ebay = await db.execute(sql`
    SELECT status, count(*)::int as cnt FROM platform_listings
    WHERE platform = 'ebay' GROUP BY status ORDER BY status
  `);
  console.log('\neBay:', ebay.rows);

  const prods = await db.execute(sql`
    SELECT status, count(*)::int as cnt FROM products GROUP BY status ORDER BY status
  `);
  console.log('Products:', prods.rows);

  const all = await db.execute(sql`
    SELECT platform, status, count(*)::int as cnt FROM platform_listings
    GROUP BY platform, status ORDER BY platform, status
  `);
  console.log('\n전체 리스팅:', all.rows);

  await pool.end();
  console.log('\n=== 복원 완료 ===');
}

rollback().catch(e => { console.error(e); process.exit(1); });
