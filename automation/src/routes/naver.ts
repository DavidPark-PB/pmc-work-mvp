import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { productImages, products } from '../db/schema.js';
import { getUser } from '../lib/user-session.js';

const EXPORT_DIR = path.join(os.tmpdir(), 'pmc-naver-exports');
const DEFAULT_WORKER = 'https://image-upload-worker.calm-base-bdff.workers.dev';
const DEFAULT_R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev';

type CellRow = Record<string, unknown>;

function normalize(v: unknown): string {
  return String(v ?? '').trim();
}

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const normalized = headers.map(h => ({ raw: h, key: h.replace(/\s+/g, '').toLowerCase() }));
  for (const candidate of candidates) {
    const key = candidate.replace(/\s+/g, '').toLowerCase();
    const exact = normalized.find(h => h.key === key);
    if (exact) return exact.raw;
  }
  for (const candidate of candidates) {
    const key = candidate.replace(/\s+/g, '').toLowerCase();
    const partial = normalized.find(h => h.key.includes(key));
    if (partial) return partial.raw;
  }
  return undefined;
}

function splitImageUrls(value: string): string[] {
  return value
    .split(/[|,\n\r]+/)
    .map(v => v.trim())
    .filter(v => /^https?:\/\//i.test(v));
}

async function copyToR2(sku: string, sourceUrl: string, sortOrder: number): Promise<string> {
  const worker = (process.env.IMAGE_WORKER_URL || DEFAULT_WORKER).replace(/\/$/, '');
  const response = await fetch(`${worker}/copy-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sku,
      image_url: sourceUrl,
      image_type: sortOrder === 1 ? 'main' : 'additional',
      sort_order: sortOrder,
      save_supabase: false,
    }),
  });
  const text = await response.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!response.ok) throw new Error(body?.error || body?.message || text || `R2 copy failed (${response.status})`);

  const direct = body.url || body.public_url || body.publicUrl || body.r2_url || body.r2Url || body.image_url;
  if (typeof direct === 'string' && direct.startsWith('http')) return direct;

  const ext = (() => {
    try {
      const pathname = new URL(sourceUrl).pathname;
      const match = pathname.match(/\.(jpe?g|png|webp|gif)$/i);
      return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    } catch { return 'jpg'; }
  })();
  const base = (process.env.R2_PUBLIC_BASE_URL || DEFAULT_R2).replace(/\/$/, '');
  return `${base}/products/${encodeURIComponent(sku)}/${sortOrder === 1 ? 'main-1' : `additional-${sortOrder - 1}`}.${ext}`;
}

function replaceHtmlImages(html: string, mapping: Map<string, string>): string {
  let out = html;
  for (const [from, to] of mapping) out = out.split(from).join(to);
  return out;
}

export async function naverRoutes(app: FastifyInstance) {
  app.get('/naver-import', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.redirect('/');
    return reply.view('naver-import.eta', { step: 14, user });
  });

  app.post('/api/naver/import-xlsx', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.status(403).send({ error: '관리자만 이용할 수 있습니다.' });

    const file = await request.file();
    if (!file) return reply.status(400).send({ error: '엑셀 파일이 없습니다.' });
    if (!/\.xlsx$/i.test(file.filename)) return reply.status(400).send({ error: '.xlsx 파일만 업로드할 수 있습니다.' });

    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(Buffer.from(chunk));
    const input = Buffer.concat(chunks);
    const workbook = XLSX.read(input, { type: 'buffer', cellDates: false, raw: false });
    const sheetName = workbook.SheetNames.includes('일괄등록') ? '일괄등록' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return reply.status(400).send({ error: '엑셀 시트를 찾을 수 없습니다.' });

    const rows = XLSX.utils.sheet_to_json<CellRow>(sheet, { defval: '', raw: false });
    if (!rows.length) return reply.status(400).send({ error: '상품 데이터가 없습니다.' });
    const headers = Object.keys(rows[0]);

    const skuCol = findHeader(headers, ['판매자 상품코드', '판매자상품코드', '상품코드', 'SKU']);
    const titleCol = findHeader(headers, ['상품명', '상품명(필수)', '판매상품명']);
    const priceCol = findHeader(headers, ['판매가', '상품가격', '가격']);
    const brandCol = findHeader(headers, ['브랜드', '브랜드명']);
    const weightCol = findHeader(headers, ['무게', '중량']);
    const mainImageCol = findHeader(headers, ['대표이미지', '대표 이미지', '대표이미지 URL', '대표이미지URL']);
    const extraImageCols = headers.filter(h => /추가.*이미지|이미지.*추가/i.test(h));
    const detailCol = findHeader(headers, ['상세설명', '상품상세', '상세 설명', '상세페이지']);
    const categoryCol = findHeader(headers, ['카테고리번호', '카테고리 ID', '카테고리ID', '카테고리']);

    if (!skuCol) return reply.status(400).send({ error: '판매자 상품코드 컬럼을 찾지 못했습니다.' });

    let created = 0;
    let updated = 0;
    let imagesSaved = 0;
    const warnings: string[] = [];
    const errors: Array<{ row: number; sku: string; error: string }> = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const sku = normalize(row[skuCol]);
      if (!sku) continue;

      try {
        const titleKo = titleCol ? normalize(row[titleCol]) : sku;
        const price = priceCol ? normalize(row[priceCol]).replace(/[^0-9.-]/g, '') : '';
        const category = categoryCol ? normalize(row[categoryCol]) : '';
        if (category === '50000343') warnings.push(`${sku}: 카테고리 50000343은 어린이 인증 대상일 수 있어 네이버 카탈로그 입력이 필요합니다.`);

        const existing = await db.query.products.findFirst({ where: eq(products.sku, sku) });
        const values = {
          sku,
          title: titleKo || sku,
          titleKo: titleKo || null,
          costPrice: price || null,
          brand: brandCol ? normalize(row[brandCol]) || null : null,
          weight: weightCol ? Number(normalize(row[weightCol]).replace(/[^0-9]/g, '')) || null : null,
          sourcePlatform: 'naver',
          status: 'active',
          ownerId: user.id,
          ownerName: user.name,
          metadata: { naverCategoryId: category || null, importedFrom: file.filename },
          updatedAt: new Date(),
        };

        let productId: number;
        if (existing) {
          await db.update(products).set(values).where(eq(products.id, existing.id));
          productId = existing.id;
          updated++;
        } else {
          const inserted = await db.insert(products).values(values).returning({ id: products.id });
          productId = inserted[0].id;
          created++;
        }

        const sourceImages: string[] = [];
        if (mainImageCol) sourceImages.push(...splitImageUrls(normalize(row[mainImageCol])));
        for (const col of extraImageCols) sourceImages.push(...splitImageUrls(normalize(row[col])));
        const uniqueImages = [...new Set(sourceImages)].slice(0, 10);
        const mapping = new Map<string, string>();
        const copied: string[] = [];

        for (let i = 0; i < uniqueImages.length; i++) {
          const source = uniqueImages[i];
          const r2Url = await copyToR2(sku, source, i + 1);
          mapping.set(source, r2Url);
          copied.push(r2Url);
        }

        if (copied.length) {
          await db.delete(productImages).where(eq(productImages.productId, productId));
          await db.insert(productImages).values(copied.map((url, i) => ({
            productId,
            url,
            position: i + 1,
            alt: `${sku}|${i + 1}|${url}`,
          })));
          imagesSaved += copied.length;

          if (mainImageCol && copied[0]) row[mainImageCol] = copied[0];
          let cursor = 1;
          for (const col of extraImageCols) {
            const originalCount = splitImageUrls(normalize(row[col])).length;
            const replacement = copied.slice(cursor, cursor + originalCount);
            if (replacement.length) row[col] = replacement.join('|');
            cursor += originalCount;
          }
          if (detailCol) row[detailCol] = replaceHtmlImages(normalize(row[detailCol]), mapping);
        }
      } catch (error) {
        errors.push({ row: index + 2, sku, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const outputSheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    workbook.Sheets[sheetName] = outputSheet;
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const exportId = randomUUID();
    const baseName = file.filename.replace(/\.xlsx$/i, '');
    const outputName = `${baseName}_PIM_R2_READY.xlsx`;
    const outputPath = path.join(EXPORT_DIR, `${exportId}.xlsx`);
    XLSX.writeFile(workbook, outputPath);

    return {
      ok: true,
      created,
      updated,
      imagesSaved,
      errors,
      warnings: [...new Set(warnings)],
      downloadUrl: `/api/naver/download/${exportId}?name=${encodeURIComponent(outputName)}`,
    };
  });

  app.get<{ Params: { exportId: string }; Querystring: { name?: string } }>('/api/naver/download/:exportId', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.status(403).send({ error: '관리자만 이용할 수 있습니다.' });
    const filePath = path.join(EXPORT_DIR, `${request.params.exportId}.xlsx`);
    if (!fs.existsSync(filePath)) return reply.status(404).send({ error: '다운로드 파일이 없거나 만료되었습니다.' });
    const filename = request.query.name || 'Naver_PIM_R2_READY.xlsx';
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(fs.createReadStream(filePath));
  });
}
