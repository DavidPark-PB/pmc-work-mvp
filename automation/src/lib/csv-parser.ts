/**
 * CSV 파싱 유틸리티
 * scripts/import-csv.ts에서 추출
 */
import fs from 'fs';

export interface CsvRow {
  image: string;
  url: string;
  name: string;
  price: number;
  rating: number;
  reviewCount: number;
  discountRate: string;
  originalPrice: number;
}

export function parsePrice(text: string): number {
  if (!text) return 0;
  return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
}

function parseReviewCount(text: string): number {
  if (!text) return 0;
  const match = text.match(/(\d[\d,]*)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
}

export function extractProductId(url: string): string {
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

/**
 * CSV 파일을 파싱해서 CsvRow 배열 반환
 */
export function parseCsvFile(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 5) continue;

    const row: CsvRow = {
      image: fields[0] || '',
      url: fields[1] || '',
      name: fields[3] || fields[2] || '',
      price: parsePrice(fields[4]),
      rating: parseFloat(fields[5]) || 0,
      reviewCount: parseReviewCount(fields[6]),
      discountRate: fields[9] || '',
      originalPrice: parsePrice(fields[10]),
    };

    if (!row.name || !row.url) continue;
    rows.push(row);
  }

  return rows;
}
