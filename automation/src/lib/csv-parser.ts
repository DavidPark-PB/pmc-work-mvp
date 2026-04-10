/**
 * CSV 파싱 유틸리티
 *
 * 헤더 기반 파싱: 한글/영문 헤더 자동 매핑
 * 헤더 매칭 실패 시 기존 쿠팡 인덱스 기반 폴백
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
  category?: string;
  brand?: string;
  weight?: number;
  description?: string;
}

/** 정규화 키 → 매칭 가능한 헤더명 목록 */
const HEADER_ALIASES: Record<string, string[]> = {
  name:          ['name', '상품명', '제목', 'title', 'product_name', '품명', 'prd-name', 'prd_name'],
  price:         ['price', '가격', '판매가', '현재가', '할인가', 'sale_price'],
  url:           ['url', '상품url', 'link', '상품링크', 'product_url'],
  image:         ['image', '이미지', 'image_url', '썸네일', 'thumbnail', '대표이미지'],
  category:      ['category', '카테고리', 'product_type', '상품유형', '분류'],
  brand:         ['brand', '브랜드', '제조사', 'vendor', '판매자'],
  weight:        ['weight', '무게', '중량', 'weight_g'],
  description:   ['description', '설명', '상세설명', '상품설명'],
  rating:        ['rating', '평점', '별점', 'score'],
  reviewCount:   ['review_count', '리뷰수', '리뷰', 'reviews'],
  discountRate:  ['discount_rate', '할인율', 'discount'],
  originalPrice: ['original_price', '원가', '정가', '원래가격', 'strike'],
};

/** 퍼지 매칭: CSS 클래스 해시 제거 후 키워드 포함 여부 체크 */
const FUZZY_KEYWORDS: Record<string, string[]> = {
  name:          ['productname', 'prdname', 'itemname'],
  price:         ['price', 'saleprice'],
  discountRate:  ['discountrate'],
  originalPrice: ['baseprice', 'originalprice', 'orgprice'],
  rating:        ['rating', 'star'],
  reviewCount:   ['review'],
};

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
 * 헤더 행에서 정규화 키 → 컬럼 인덱스 매핑 생성
 *
 * 1단계: 정확한 alias 매칭
 * 2단계: CSS 클래스 해시 제거 후 퍼지 매칭 (ProductUnit_productNameV2__cV9cw → productname)
 * 3단계: name 없으면 description을 name으로 대체
 */
function buildHeaderMap(headerFields: string[]): Map<string, number> | null {
  const normalized = headerFields.map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
  const map = new Map<string, number>();
  const usedIndices = new Set<number>();

  // 1단계: 정확한 alias 매칭 (첫 번째 매칭만 사용 — 중복 헤더 대응)
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (let i = 0; i < normalized.length; i++) {
      if (usedIndices.has(i)) continue;
      if (aliases.includes(normalized[i])) {
        map.set(key, i);
        usedIndices.add(i);
        break;
      }
    }
  }

  // 2단계: 퍼지 매칭 — CSS 클래스 해시(__xxxx) 제거 후 키워드 포함 체크
  for (const [key, keywords] of Object.entries(FUZZY_KEYWORDS)) {
    if (map.has(key)) continue;
    for (let i = 0; i < normalized.length; i++) {
      if (usedIndices.has(i)) continue;
      // CSS 해시 제거: productunit_productnamev2__cv9cw → productunit_productnamev2
      const cleaned = normalized[i].replace(/__[a-z0-9]+$/i, '').replace(/[-_]/g, '');
      if (keywords.some(kw => cleaned.includes(kw))) {
        map.set(key, i);
        usedIndices.add(i);
        break;
      }
    }
  }

  // 3단계: name이 없으면 description을 name으로 대체
  if (!map.has('name') && map.has('description')) {
    map.set('name', map.get('description')!);
    map.delete('description');
  }

  // 최소 필수: name + (url 또는 price)
  if (!map.has('name') || (!map.has('url') && !map.has('price'))) {
    return null;
  }

  return map;
}

/**
 * 헤더 매칭 후 누락된 price/discountRate를 데이터 내용으로 보완
 * (동일 헤더명이 여러 컬럼에 사용될 때 — 예: Strong이 할인율/판매가 둘 다)
 */
function supplementFromContent(
  headerMap: Map<string, number>,
  lines: string[],
): void {
  if (headerMap.has('price') && headerMap.has('discountRate')) return;

  const usedCols = new Set(headerMap.values());
  const sampleCount = Math.min(5, lines.length - 1);
  const samples: string[][] = [];
  for (let i = 1; i <= sampleCount; i++) {
    samples.push(parseCsvLine(lines[i]));
  }
  if (samples.length === 0) return;

  const colCount = samples[0].length;

  for (let col = 0; col < colCount; col++) {
    if (usedCols.has(col)) continue;
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    if (values.length === 0) continue;

    const allPercent = values.every(v => /^\d+\s*%$/.test(v));
    const allPrice = values.every(v => /[\d,]+\s*원/.test(v));

    if (allPercent && !headerMap.has('discountRate')) {
      headerMap.set('discountRate', col);
      usedCols.add(col);
    } else if (allPrice && !headerMap.has('price')) {
      headerMap.set('price', col);
      usedCols.add(col);
    }
  }
}

/**
 * 데이터 내용 기반 컬럼 자동 감지 (최후 폴백)
 *
 * 샘플 데이터를 분석해서 각 컬럼이 이미지URL, 상품URL, 가격, 상품명 등
 * 어떤 역할인지 자동 판별
 */
function detectColumnsFromContent(lines: string[]): Map<string, number> | null {
  const sampleCount = Math.min(5, lines.length - 1);
  const samples: string[][] = [];
  for (let i = 1; i <= sampleCount; i++) {
    samples.push(parseCsvLine(lines[i]));
  }
  if (samples.length === 0 || samples[0].length < 3) return null;

  const colCount = samples[0].length;
  const map = new Map<string, number>();
  const priceColumns: { col: number; avgPrice: number }[] = [];

  for (let col = 0; col < colCount; col++) {
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    if (values.length === 0) continue;

    const isUrl = values.every(v => /^https?:\/\//.test(v));
    const isImageUrl = isUrl && values.every(v =>
      /\.(jpg|jpeg|png|gif|webp)/i.test(v) || /image|thumbnail|cdn|arumnet/i.test(v));
    const isProductUrl = isUrl && !isImageUrl;
    const isPricelike = values.every(v => /[\d,]+\s*원/.test(v) || (/^[\d,]+$/.test(v) && parseInt(v.replace(/,/g, '')) > 0));
    const isPercentlike = values.every(v => /\d+\s*%/.test(v));

    if (isImageUrl && !map.has('image')) {
      map.set('image', col);
    } else if (isProductUrl && !map.has('url')) {
      map.set('url', col);
    } else if (isPercentlike && !map.has('discountRate')) {
      map.set('discountRate', col);
    } else if (isPricelike) {
      const avg = values.reduce((s, v) => s + parsePrice(v), 0) / values.length;
      priceColumns.push({ col, avgPrice: avg });
    }
  }

  // 가격 컬럼 처리: 마지막 = 판매가(할인가), 그 앞 = 정가
  if (priceColumns.length >= 2) {
    map.set('originalPrice', priceColumns[0].col);
    map.set('price', priceColumns[priceColumns.length - 1].col);
  } else if (priceColumns.length === 1) {
    map.set('price', priceColumns[0].col);
  }

  // 상품명: 매핑 안 된 컬럼 중 가장 긴 텍스트
  const usedCols = new Set(map.values());
  let bestNameCol = -1;
  let bestNameLen = 0;

  for (let col = 0; col < colCount; col++) {
    if (usedCols.has(col)) continue;
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    // URL이나 짧은 숫자는 건너뛰기
    const isText = values.every(v => v.length > 2 && !/^https?:\/\//.test(v) && !/^\d+\s*%$/.test(v));
    if (!isText) continue;
    const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
    if (avgLen > bestNameLen) {
      bestNameLen = avgLen;
      bestNameCol = col;
    }
  }
  if (bestNameCol >= 0) map.set('name', bestNameCol);

  if (!map.has('name') || (!map.has('url') && !map.has('price'))) return null;

  console.log(`[csv-parser] 데이터 내용 기반 감지 (매핑: ${[...map.entries()].map(([k, v]) => `${k}→col${v}`).join(', ')})`);
  return map;
}

/** 헤더 기반 파싱 */
function parseWithHeaders(lines: string[], headerMap: Map<string, number>): CsvRow[] {
  const rows: CsvRow[] = [];
  const get = (fields: string[], key: string): string => {
    const idx = headerMap.get(key);
    return idx !== undefined && idx < fields.length ? fields[idx] : '';
  };

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);

    const name = get(fields, 'name');
    if (!name) continue;

    const row: CsvRow = {
      image: get(fields, 'image'),
      url: get(fields, 'url'),
      name,
      price: parsePrice(get(fields, 'price')),
      rating: parseFloat(get(fields, 'rating')) || 0,
      reviewCount: parseReviewCount(get(fields, 'reviewCount')),
      discountRate: get(fields, 'discountRate'),
      originalPrice: parsePrice(get(fields, 'originalPrice')),
    };

    // 옵션 필드
    const category = get(fields, 'category');
    if (category) row.category = category;

    const brand = get(fields, 'brand');
    if (brand) row.brand = brand;

    const weight = get(fields, 'weight');
    if (weight) row.weight = parseInt(weight, 10) || undefined;

    const desc = get(fields, 'description');
    if (desc) row.description = desc;

    rows.push(row);
  }

  return rows;
}

/**
 * 인덱스 기반 파싱 (쿠팡 포맷 폴백)
 *
 * 두 가지 포맷 자동 감지:
 * A) 12컬럼 웹스크래핑 형식: [이미지, 로고, URL, 상품명, 적립금, 리뷰수, ..., 정가, 할인율, 할인가]
 * B) 레거시 형식: [이미지, URL, ???, 상품명, 가격, ...]
 */
function parseWithIndex(lines: string[]): CsvRow[] {
  const rows: CsvRow[] = [];

  // 첫 데이터행으로 포맷 감지: URL이 몇 번째 컬럼에 있는지
  const sampleFields = parseCsvLine(lines[1]);
  const isWebScrapedFormat = sampleFields.length >= 10
    && sampleFields[2]?.includes('/vp/products/');

  if (isWebScrapedFormat) {
    console.log('[csv-parser] 12컬럼 웹스크래핑 포맷 감지');
  }

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 5) continue;

    let row: CsvRow;

    if (isWebScrapedFormat) {
      // [0]=이미지, [1]=로고(무시), [2]=URL, [3]=상품명
      // [5]=리뷰수, [9]=정가, [10]=할인율, [11]=할인가
      const price = parsePrice(fields[11]) || parsePrice(fields[9]) || parsePrice(fields[7]) || 0;
      row = {
        image: fields[0] || '',
        url: fields[2] || '',
        name: fields[3] || '',
        price,
        rating: 0,
        reviewCount: parseReviewCount(fields[5]),
        discountRate: fields[10] || '',
        originalPrice: parsePrice(fields[9]) || price,
      };
    } else {
      // 레거시 포맷
      row = {
        image: fields[0] || '',
        url: fields[1] || '',
        name: fields[3] || fields[2] || '',
        price: parsePrice(fields[4]),
        rating: parseFloat(fields[5]) || 0,
        reviewCount: parseReviewCount(fields[6]),
        discountRate: fields[9] || '',
        originalPrice: parsePrice(fields[10]),
      };
    }

    if (!row.name || !row.url) continue;
    rows.push(row);
  }

  return rows;
}

/**
 * CSV 파일을 파싱해서 CsvRow 배열 반환
 *
 * 1. 헤더 행 분석 → 한글/영문 헤더 자동 매핑 시도
 * 2. 매핑 실패 시 기존 인덱스 기반(쿠팡 포맷) 폴백
 */
export function parseCsvFile(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  // 1. 헤더 매핑 시도 (alias + 퍼지 매칭)
  const headerFields = parseCsvLine(lines[0]);
  const headerMap = buildHeaderMap(headerFields);

  if (headerMap) {
    // 누락된 price/discountRate를 데이터 내용으로 보완
    supplementFromContent(headerMap, lines);
    console.log(`[csv-parser] 헤더 기반 파싱 (매핑: ${[...headerMap.entries()].map(([k, v]) => `${k}→col${v}`).join(', ')})`);
    return parseWithHeaders(lines, headerMap);
  }

  // 2. 데이터 내용 기반 자동 감지
  const contentMap = detectColumnsFromContent(lines);
  if (contentMap) {
    return parseWithHeaders(lines, contentMap);
  }

  // 3. 최후 폴백: 인덱스 기반 (레거시 쿠팡 포맷)
  console.log('[csv-parser] 헤더/내용 감지 실패 → 인덱스 기반 폴백');
  return parseWithIndex(lines);
}

// ============================================================
// 매핑 UI용 함수들
// ============================================================

/**
 * CSV 파일을 raw 필드 배열로 파싱 (매핑 적용 전 원본 데이터)
 * 반환: string[][] — [0]은 헤더, [1:]은 데이터
 */
export function parseCsvRawFields(filePath: string): string[][] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  return lines.map(line => parseCsvLine(line));
}

/**
 * 키워드 기반 매핑 감지 (Gemini 폴백용)
 * 기존 buildHeaderMap + supplementFromContent + detectColumnsFromContent 재사용
 */
export function detectMappingByKeyword(rawFields: string[][]): Record<string, number> {
  if (rawFields.length < 2) return {};

  const headerFields = rawFields[0];

  // 1. 헤더 기반 매칭
  const headerMap = buildHeaderMap(headerFields);
  if (headerMap) {
    // supplementFromContent는 lines(string[])을 받으므로 rawFields에서 재구성
    supplementFromContentRaw(headerMap, rawFields);
    return Object.fromEntries(headerMap);
  }

  // 2. 데이터 내용 기반 감지
  const contentMap = detectColumnsFromContentRaw(rawFields);
  if (contentMap) return Object.fromEntries(contentMap);

  return {};
}

/** supplementFromContent의 rawFields 버전 */
function supplementFromContentRaw(
  headerMap: Map<string, number>,
  rawFields: string[][],
): void {
  if (headerMap.has('price') && headerMap.has('discountRate')) return;

  const usedCols = new Set(headerMap.values());
  const samples = rawFields.slice(1, 6);
  if (samples.length === 0) return;

  const colCount = rawFields[0].length;

  for (let col = 0; col < colCount; col++) {
    if (usedCols.has(col)) continue;
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    if (values.length === 0) continue;

    const allPercent = values.every(v => /^\d+\s*%$/.test(v));
    const allPrice = values.every(v => /[\d,]+\s*원/.test(v));

    if (allPercent && !headerMap.has('discountRate')) {
      headerMap.set('discountRate', col);
      usedCols.add(col);
    } else if (allPrice && !headerMap.has('price')) {
      headerMap.set('price', col);
      usedCols.add(col);
    }
  }
}

/** detectColumnsFromContent의 rawFields 버전 */
function detectColumnsFromContentRaw(rawFields: string[][]): Map<string, number> | null {
  const samples = rawFields.slice(1, 6);
  if (samples.length === 0 || samples[0].length < 3) return null;

  const colCount = rawFields[0].length;
  const map = new Map<string, number>();
  const priceColumns: { col: number; avgPrice: number }[] = [];

  for (let col = 0; col < colCount; col++) {
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    if (values.length === 0) continue;

    const isUrl = values.every(v => /^https?:\/\//.test(v));
    const isImageUrl = isUrl && values.every(v =>
      /\.(jpg|jpeg|png|gif|webp)/i.test(v) || /image|thumbnail|cdn|arumnet/i.test(v));
    const isProductUrl = isUrl && !isImageUrl;
    const isPricelike = values.every(v => /[\d,]+\s*원/.test(v) || (/^[\d,]+$/.test(v) && parseInt(v.replace(/,/g, '')) > 0));
    const isPercentlike = values.every(v => /\d+\s*%/.test(v));

    if (isImageUrl && !map.has('image')) {
      map.set('image', col);
    } else if (isProductUrl && !map.has('url')) {
      map.set('url', col);
    } else if (isPercentlike && !map.has('discountRate')) {
      map.set('discountRate', col);
    } else if (isPricelike) {
      const avg = values.reduce((s, v) => s + parsePrice(v), 0) / values.length;
      priceColumns.push({ col, avgPrice: avg });
    }
  }

  if (priceColumns.length >= 2) {
    map.set('originalPrice', priceColumns[0].col);
    map.set('price', priceColumns[priceColumns.length - 1].col);
  } else if (priceColumns.length === 1) {
    map.set('price', priceColumns[0].col);
  }

  const usedCols = new Set(map.values());
  let bestNameCol = -1;
  let bestNameLen = 0;

  for (let col = 0; col < colCount; col++) {
    if (usedCols.has(col)) continue;
    const values = samples.map(s => (s[col] || '').trim()).filter(v => v);
    const isText = values.every(v => v.length > 2 && !/^https?:\/\//.test(v) && !/^\d+\s*%$/.test(v));
    if (!isText) continue;
    const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
    if (avgLen > bestNameLen) {
      bestNameLen = avgLen;
      bestNameCol = col;
    }
  }
  if (bestNameCol >= 0) map.set('name', bestNameCol);

  if (!map.has('name') || (!map.has('url') && !map.has('price'))) return null;
  return map;
}

/**
 * 확정된 매핑으로 rawFields → CsvRow[] 변환
 */
export function applyMapping(rawFields: string[][], mapping: Record<string, number>): CsvRow[] {
  const rows: CsvRow[] = [];
  const get = (fields: string[], key: string): string => {
    const idx = mapping[key];
    return idx !== undefined && idx < fields.length ? fields[idx] : '';
  };

  // rawFields[0] = 헤더, [1:] = 데이터
  for (let i = 1; i < rawFields.length; i++) {
    const fields = rawFields[i];
    const name = get(fields, 'name');
    if (!name) continue;

    const row: CsvRow = {
      image: get(fields, 'image'),
      url: get(fields, 'url'),
      name,
      price: parsePrice(get(fields, 'price')),
      rating: parseFloat(get(fields, 'rating')) || 0,
      reviewCount: parseReviewCount(get(fields, 'reviewCount')),
      discountRate: get(fields, 'discountRate'),
      originalPrice: parsePrice(get(fields, 'originalPrice')),
    };

    const category = get(fields, 'category');
    if (category) row.category = category;
    const brand = get(fields, 'brand');
    if (brand) row.brand = brand;
    const weight = get(fields, 'weight');
    if (weight) row.weight = parseInt(weight, 10) || undefined;
    const desc = get(fields, 'description');
    if (desc) row.description = desc;

    rows.push(row);
  }

  return rows;
}
