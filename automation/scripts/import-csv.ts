/**
 * 외부 크롤러 CSV → crawl_results DB 임포트
 *
 * 사용법: npx tsx scripts/import-csv.ts <csv-path> [source-name]
 *
 * CSV 컬럼 (고객 크롤러 출력 형식):
 *   Image, URL, Description, ProductUnit_productNameV2__cV9cw, Price,
 *   ProductRating_star__RGSlV, Rating, Description, UnitPrice_unitPrice__R_ZcA,
 *   PriceInfo_discountRate__EsQ8I, PriceInfo_basePrice__8BQ32
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { crawlResults, crawlSources } from '../src/db/schema.js';

interface CsvRow {
  image: string;
  url: string;
  name: string;
  price: number;
  rating: number;
  reviewCount: number;
  discountRate: string;
  originalPrice: number;
}

function parsePrice(text: string): number {
  if (!text) return 0;
  return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
}

function parseReviewCount(text: string): number {
  if (!text) return 0;
  const match = text.match(/(\d[\d,]*)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
}

function extractProductId(url: string): string {
  const match = url.match(/products\/(\d+)/);
  return match ? match[1] : url;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function ensureSourceId(sourceName: string, baseUrl: string): Promise<number> {
  const crawlerType = sourceName.toLowerCase().replace(/\s+/g, '_');

  const existing = await db.query.crawlSources.findFirst({
    where: eq(crawlSources.crawlerType, crawlerType),
  });

  if (existing) return existing.id;

  const [inserted] = await db.insert(crawlSources).values({
    name: sourceName,
    baseUrl,
    crawlerType,
    config: {},
    isActive: true,
  }).returning();

  return inserted.id;
}

async function main() {
  const csvPath = process.argv[2];
  const sourceName = process.argv[3] || '쿠팡';

  if (!csvPath) {
    console.log('사용법: npx tsx scripts/import-csv.ts <csv-path> [source-name]');
    console.log('  예: npx tsx scripts/import-csv.ts data/crawl.csv 쿠팡');
    process.exit(1);
  }

  const absolutePath = path.resolve(csvPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`파일 없음: ${absolutePath}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log(`CSV 임포트: ${path.basename(absolutePath)}`);
  console.log(`소스: ${sourceName}`);
  console.log('='.repeat(60));

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    console.error('CSV에 데이터가 없습니다');
    process.exit(1);
  }

  // 헤더 파싱
  const headers = parseCsvLine(lines[0]);
  console.log(`\n헤더: ${headers.length}개 컬럼`);
  console.log(`데이터: ${lines.length - 1}개 행\n`);

  // 소스 ID 확보
  const baseUrl = sourceName === '쿠팡' ? 'https://www.coupang.com' : 'https://unknown.com';
  const sourceId = await ensureSourceId(sourceName, baseUrl);
  console.log(`소스 ID: ${sourceId}\n`);

  // 데이터 파싱 + DB 저장
  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 5) continue;

    const row: CsvRow = {
      image: fields[0] || '',
      url: fields[1] || '',
      name: fields[3] || fields[2] || '', // ProductUnit_productNameV2 또는 Description
      price: parsePrice(fields[4]),
      rating: parseFloat(fields[5]) || 0,
      reviewCount: parseReviewCount(fields[6]),
      discountRate: fields[9] || '',
      originalPrice: parsePrice(fields[10]),
    };

    if (!row.name || !row.url) continue;

    const externalId = extractProductId(row.url);

    try {
      const existing = await db.query.crawlResults.findFirst({
        where: and(
          eq(crawlResults.sourceId, sourceId),
          eq(crawlResults.externalId, externalId),
        ),
      });

      const rawData = {
        rating: row.rating,
        reviewCount: row.reviewCount,
        discountRate: row.discountRate,
        originalPrice: row.originalPrice,
        images: [row.image],
      };

      if (existing) {
        await db.update(crawlResults)
          .set({
            title: row.name,
            price: String(row.price),
            url: row.url,
            imageUrl: row.image,
            rawData,
            crawledAt: new Date(),
          })
          .where(eq(crawlResults.id, existing.id));
        updated++;
      } else {
        await db.insert(crawlResults).values({
          sourceId,
          externalId,
          title: row.name,
          price: String(row.price),
          currency: 'KRW',
          url: row.url,
          imageUrl: row.image,
          rawData,
          status: 'new',
        });
        imported++;
      }
    } catch (e) {
      errors++;
      console.error(`  행 ${i}: ${(e as Error).message}`);
    }
  }

  console.log(`\n결과:`);
  console.log(`  신규: ${imported}개`);
  console.log(`  업데이트: ${updated}개`);
  console.log(`  오류: ${errors}개`);
  console.log(`  합계: ${imported + updated}개 저장됨`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
