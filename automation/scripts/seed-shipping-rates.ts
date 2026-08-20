import 'dotenv/config';
import XLSX from 'xlsx';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { shippingRates } from '../src/db/schema.js';

const XLSX_PATH = 'C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx';

async function main() {
  console.log('=== Shipping Rates 적재 ===\n');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  // 엑셀에서 읽기
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets['Shipping Rates'];
  if (!ws) {
    console.error('Shipping Rates 시트 없음');
    await pool.end();
    return;
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
  console.log(`엑셀 행: ${rows.length - 1}개 (헤더 제외)`);

  // 파싱
  const values: {
    carrier: string;
    minWeight: number;
    maxWeight: number;
    rate: string;
    destination: string;
    isActive: boolean;
  }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const carrier = String(r[0] || '').trim();
    const destination = String(r[1] || 'US').trim();
    const weightStr = String(r[2] || '').trim();
    const rateStr = String(r[3] || '').trim();

    if (!carrier || !weightStr || !rateStr) continue;

    const weightG = parseFloat(weightStr);
    const rate = parseFloat(rateStr.replace(/,/g, ''));
    if (isNaN(weightG) || isNaN(rate)) continue;

    // 그램 단위로 변환 (원본이 kg이면 *1000, g이면 그대로)
    const weightGrams = weightG < 100 ? Math.round(weightG * 1000) : Math.round(weightG);

    values.push({
      carrier,
      minWeight: weightGrams,
      maxWeight: weightGrams,
      rate: String(rate),
      destination,
      isActive: true,
    });
  }

  console.log(`파싱된 행: ${values.length}개`);

  if (values.length > 0) {
    // 샘플 출력
    console.log('\n샘플 (처음 5개):');
    for (const v of values.slice(0, 5)) {
      console.log(`  ${v.carrier} | ${v.minWeight}g | ${v.rate} KRW | ${v.destination}`);
    }

    // INSERT
    await db.insert(shippingRates).values(values);
    console.log(`\n${values.length}개 INSERT 완료`);
  }

  // 검증
  const result = await pool.query('SELECT COUNT(*) as cnt FROM shipping_rates');
  console.log(`DB 확인: ${result.rows[0].cnt}개`);

  await pool.end();
  console.log('\n=== 완료 ===');
}

main().catch(e => { console.error(e); process.exit(1); });
