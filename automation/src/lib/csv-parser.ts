/**
 * CSV 파싱 유틸리티
 *
 * 헤더 기반 파싱: 한글/영문 헤더 자동 매핑
 * 헤더 매칭 실패 시 기존 쿠팡 인덱스 기반 폴백
 */
import fs from 'fs';
import type { ShippingQuoteSnapshot, SalePriceOverrideHistoryEntry } from '../services/shipping-pricing.js';
import { describeQuoteReason, isAlternativeEligible, isRecoverableQuoteFailure, normalizeQuoteReason, resolveChargeableWeight } from './shipping-quote-status.js';

export type PriceCurrency = 'USD' | 'KRW';

export interface RowIssue {
  code: string;
  level: 'error' | 'warning';
  message: string;
}

export interface CsvRow {
  image: string;
  url: string;
  name: string;
  /** salePriceUsd when mapped (priceCurrency=USD), otherwise KRW price */
  price: number;
  rating: number;
  reviewCount: number;
  discountRate: string;
  originalPrice: number;
  category?: string;
  brand?: string;
  /** grams — chargeableWeightG when mapped */
  weight?: number;
  description?: string;

  // 고정 헤더 CSV(toybox) 필드 — 매핑된 경우에만 존재, 파싱 실패 시 null
  priceCurrency?: PriceCurrency;
  sourceRowNumber?: number;       // CSV 데이터 행 번호 (1부터)
  sourceProductCode?: string;
  nameKo?: string;
  salePriceUsd?: number | null;
  purchaseCostKrw?: number | null;
  retailPriceKrw?: number | null;
  marginKrw?: number | null;
  marginRate?: number | null;     // 35.0% → 0.35
  actualWeightG?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  volumetricWeightG?: number | null;
  chargeableWeightG?: number | null;
  originalImageUrl?: string;
  sourcePage?: number | null;
  unitsPerBox?: number | null;
  /** 원본 CSV 헤더 → 셀 값 (매핑 여부와 무관하게 전체 컬럼) */
  sourceColumns?: Record<string, string>;
  issues?: RowIssue[];

  // 검수 화면에서 지정 (Phase 2)
  selectedShippingProvider?: 'KPL' | 'eGS';
  shippingQuote?: ShippingQuoteSnapshot | null;
  /** 선택 배송사 실패 시 다른 배송사 견적 (자동 적용하지 않음) */
  shippingQuoteAlternative?: ShippingQuoteSnapshot | null;
  salePriceOverrideUsd?: number | null;
  salePriceOverrideHistory?: SalePriceOverrideHistoryEntry[];
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
  return parseCsvRawText(fs.readFileSync(filePath, 'utf-8'));
}

/** CSV 텍스트를 raw 필드 배열로 파싱 */
export function parseCsvRawText(content: string): string[][] {
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

// ============================================================
// 고정 헤더 CSV (toybox 원본/축약 포맷)
// ============================================================

/** 고정 헤더 → 시스템 필드. '상품명'은 Product Name (EN)이 있으면 nameKo로 매핑 */
const FIXED_HEADER_FIELDS: [header: string, field: string][] = [
  ['페이지', 'sourcePage'],
  ['상품코드', 'sourceProductCode'],
  ['상품명', 'name'],
  ['Product Name (EN)', 'name'],
  ['입수량(박스)', 'unitsPerBox'],
  ['원가(toybox 판매가)', 'purchaseCostKrw'],
  ['판매가(toybox 정가)', 'retailPriceKrw'],
  ['환산가(USD)', 'salePriceUsd'],
  ['마진(원)', 'marginKrw'],
  ['마진율', 'marginRate'],
  ['실측무게(g)', 'actualWeightG'],
  ['가로(cm)', 'lengthCm'],
  ['세로(cm)', 'widthCm'],
  ['높이(cm)', 'heightCm'],
  ['부피무게(g)', 'volumetricWeightG'],
  ['적용무게(g)', 'chargeableWeightG'],
  ['R2 이미지', 'image'],
  ['상품링크', 'url'],
  ['원본 이미지', 'originalImageUrl'],
];

export const FIXED_HEADERS = FIXED_HEADER_FIELDS.map(([header]) => header);

function normalizeFixedHeader(header: string): string {
  return (header || '').normalize('NFC').replace(/^\uFEFF/, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 고정 헤더 CSV 감지 → 결정적 매핑 (AI/키워드 매핑보다 우선)
 * `환산가(USD)` 또는 `Product Name (EN)` 헤더가 있을 때만 적용, 아니면 null
 */
export function detectFixedHeaderMapping(headers: string[]): Record<string, number> | null {
  const indexByHeader = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = normalizeFixedHeader(h);
    if (key && !indexByHeader.has(key)) indexByHeader.set(key, i);
  });

  const hasEnglishName = indexByHeader.has(normalizeFixedHeader('Product Name (EN)'));
  const hasUsdPrice = indexByHeader.has(normalizeFixedHeader('환산가(USD)'));
  if (!hasEnglishName && !hasUsdPrice) return null;

  const mapping: Record<string, number> = {};
  for (const [header, defaultField] of FIXED_HEADER_FIELDS) {
    const col = indexByHeader.get(normalizeFixedHeader(header));
    if (col === undefined) continue;
    const field = header === '상품명' && hasEnglishName ? 'nameKo' : defaultField;
    if (mapping[field] === undefined) mapping[field] = col;
  }
  return mapping;
}

/** 매핑 확정 전 검증 — 오류 메시지 또는 null */
export function validateColumnMapping(mapping: Record<string, number>): string | null {
  if (!mapping || typeof mapping !== 'object') return 'mapping이 필요합니다';
  for (const [field, col] of Object.entries(mapping)) {
    if (!Number.isInteger(col) || col < 0) return `잘못된 컬럼 인덱스: ${field}`;
  }
  const has = (key: string) => mapping[key] !== undefined;
  if (!has('name')) return '상품명 매핑이 필요합니다';
  if (!has('url') && !has('price') && !has('salePriceUsd')) {
    return '상품명 + (상품URL 또는 가격) 매핑이 필요합니다';
  }
  if (has('price') && has('salePriceUsd')) {
    return '가격(원)과 판매가(USD)를 동시에 매핑할 수 없습니다';
  }
  if (has('weight') && has('chargeableWeightG')) {
    return '무게와 적용무게(g)를 동시에 매핑할 수 없습니다';
  }
  return null;
}

/**
 * 숫자 셀 파싱: "25.4" → 25.4, "19,500" → 19500, "$60.10" → 60.1, "19,500원" → 19500
 * 빈 값/"#REF!" 등 숫자가 아니면 null (소수점은 보존)
 */
export function parseDecimal(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).trim().replace(/usd|krw/gi, '').replace(/[\s,$₩원]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** 무게 셀 파싱 (그램): "1,023" → 1023, "300g" → 300, "1.2kg" → 1200 */
export function parseWeightG(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  if (/kg$/i.test(trimmed)) {
    const kg = parseDecimal(trimmed.replace(/kg$/i, ''));
    return kg === null ? null : Math.round(kg * 1000);
  }
  return parseDecimal(trimmed.replace(/g$/i, ''));
}

/** 길이 셀 파싱 (cm): "16" → 16, "16cm" → 16 */
export function parseLengthCm(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  return parseDecimal(String(text).trim().replace(/cm$/i, ''));
}

/** 퍼센트 셀 파싱 → 비율: "35.0%" → 0.35, "0.35" → 0.35, "35" → 0.35 */
export function parsePercent(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  const hasPercentSign = trimmed.endsWith('%');
  const value = parseDecimal(trimmed.replace(/%$/, ''));
  if (value === null) return null;
  const ratio = hasPercentSign || Math.abs(value) > 1 ? value / 100 : value;
  return Number(ratio.toFixed(6));
}

function isHttpUrl(value: string | undefined): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

/** 여러 이미지가 '|||'로 합쳐진 image 필드의 대표(첫) 이미지 */
function primaryImage(value: string | undefined): string {
  return (value || '').split('|||')[0].trim();
}

const NUMERIC_FIELD_PARSERS: Record<string, (text: string) => number | null> = {
  purchaseCostKrw: parseDecimal,
  retailPriceKrw: parseDecimal,
  marginKrw: parseDecimal,
  marginRate: parsePercent,
  actualWeightG: parseWeightG,
  lengthCm: parseLengthCm,
  widthCm: parseLengthCm,
  heightCm: parseLengthCm,
  volumetricWeightG: parseWeightG,
  sourcePage: parseDecimal,
  unitsPerBox: parseDecimal,
};

const TEXT_FIELDS = ['sourceProductCode', 'nameKo', 'originalImageUrl'] as const;

/** 원본 헤더 → 셀 값 (빈/중복 헤더는 컬럼 번호로 구분) */
function buildSourceColumns(headers: string[], fields: string[]): Record<string, string> {
  const columns: Record<string, string> = {};
  const width = Math.max(headers.length, fields.length);
  for (let i = 0; i < width; i++) {
    let key = (headers[i] || '').replace(/^\uFEFF/, '').trim() || `column_${i + 1}`;
    if (key in columns) key = `${key}#${i + 1}`;
    columns[key] = fields[i] ?? '';
  }
  return columns;
}

/** 행 데이터 검증 — 매핑된 필드만 검사. error가 있으면 기본 선택에서 제외 */
export function validateCsvRow(row: CsvRow, mapping: Record<string, number>): RowIssue[] {
  const issues: RowIssue[] = [];
  const has = (key: string) => mapping[key] !== undefined;
  const positive = (v: number | null | undefined) => typeof v === 'number' && v > 0;

  if (!row.name) {
    issues.push({ code: 'name_missing', level: 'error', message: '상품명 없음' });
  }
  if (has('salePriceUsd') && !positive(row.salePriceUsd)) {
    issues.push({ code: 'sale_price_invalid', level: 'error', message: '판매가(USD) 없음 또는 잘못된 값' });
  }
  if (has('chargeableWeightG') && !positive(row.chargeableWeightG)) {
    //   실측/부피무게가 있으면 복구 가능 → 경고만 (기본 선택 유지), 둘 다 없으면 오류
    const recovered = resolveChargeableWeight(row);
    if (recovered.weightG !== null) {
      issues.push({ code: 'chargeable_weight_recovered', level: 'warning', message: `적용무게 자동복구: ${formatWeightG(recovered.weightG)}` });
    } else {
      issues.push({ code: 'chargeable_weight_invalid', level: 'error', message: '적용무게(g) 없음 또는 잘못된 값 · 실측/부피무게도 없음' });
    }
  }
  if (has('image') && !isHttpUrl(primaryImage(row.image))) {
    issues.push({ code: 'image_missing', level: 'warning', message: '이미지 URL 없음' });
  }
  if (has('url') && !isHttpUrl(row.url)) {
    issues.push({ code: 'url_missing', level: 'warning', message: '상품 링크 없음' });
  }
  if (has('actualWeightG') && !positive(row.actualWeightG)) {
    issues.push({ code: 'actual_weight_missing', level: 'warning', message: '실측무게(g) 없음 또는 잘못된 값' });
  }
  const dimensionFields = ['lengthCm', 'widthCm', 'heightCm'] as const;
  if (dimensionFields.some(has) && dimensionFields.some(f => !positive(row[f]))) {
    issues.push({ code: 'dimensions_missing', level: 'warning', message: '가로/세로/높이 누락' });
  }
  if (positive(row.chargeableWeightG)) {
    const measured = Math.max(row.actualWeightG ?? 0, row.volumetricWeightG ?? 0);
    if (measured > row.chargeableWeightG!) {
      issues.push({ code: 'chargeable_weight_below_measured', level: 'warning', message: '적용무게가 실측/부피무게보다 작음' });
    }
  }
  return issues;
}

/**
 * 확정된 매핑으로 rawFields → CsvRow[] 변환
 */
export function applyMapping(rawFields: string[][], mapping: Record<string, number>): CsvRow[] {
  const rows: CsvRow[] = [];
  const headers = rawFields[0] || [];
  const has = (key: string) => mapping[key] !== undefined;
  const get = (fields: string[], key: string): string => {
    const idx = mapping[key];
    return idx !== undefined && idx < fields.length ? fields[idx] : '';
  };

  // rawFields[0] = 헤더, [1:] = 데이터
  for (let i = 1; i < rawFields.length; i++) {
    const fields = rawFields[i];
    const name = get(fields, 'name');
    if (!name) continue;

    // Collect all image URLs from mapped + unmapped columns
    // (고정 헤더 CSV의 원본 이미지 컬럼은 originalImageUrl로 따로 보존 — 리스팅 이미지에 섞지 않음)
    const originalImageCol = mapping.originalImageUrl;
    const allImages: string[] = [];
    const mainImage = get(fields, 'image');
    if (mainImage) allImages.push(mainImage);
    for (let imgIdx = 2; imgIdx <= 10; imgIdx++) {
      const extra = get(fields, `image${imgIdx}`);
      if (extra && /\.(jpg|jpeg|png|gif|webp)/i.test(extra)) allImages.push(extra);
    }
    if (allImages.length <= 1) {
      for (let c = 0; c < fields.length; c++) {
        if (c === originalImageCol) continue;
        const v = fields[c]?.trim() || '';
        if (v && !allImages.includes(v) && /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|PNG|JPEG)/i.test(v)) {
          allImages.push(v);
          if (allImages.length >= 5) break;
        }
      }
    }

    // 판매가(USD)가 매핑되면 price에 USD 값을 그대로 저장 (KRW parsePrice 사용 금지)
    const salePriceUsd = has('salePriceUsd') ? parseDecimal(get(fields, 'salePriceUsd')) : undefined;

    const row: CsvRow = {
      image: allImages.join('|||'),
      url: get(fields, 'url'),
      name,
      price: salePriceUsd !== undefined ? (salePriceUsd ?? 0) : parsePrice(get(fields, 'price')),
      rating: parseFloat(get(fields, 'rating')) || 0,
      reviewCount: parseReviewCount(get(fields, 'reviewCount')),
      discountRate: get(fields, 'discountRate'),
      originalPrice: parsePrice(get(fields, 'originalPrice')),
    };

    if (salePriceUsd !== undefined) {
      row.priceCurrency = 'USD';
      row.salePriceUsd = salePriceUsd;
    } else if (has('price')) {
      row.priceCurrency = 'KRW';
    }

    const category = get(fields, 'category');
    if (category) row.category = category;
    const brand = get(fields, 'brand');
    if (brand) row.brand = brand;
    const desc = get(fields, 'description');
    if (desc) row.description = desc;

    if (has('chargeableWeightG')) {
      row.chargeableWeightG = parseWeightG(get(fields, 'chargeableWeightG'));
      if (row.chargeableWeightG !== null && row.chargeableWeightG > 0) {
        row.weight = Math.round(row.chargeableWeightG);
      }
    } else {
      const weight = parseWeightG(get(fields, 'weight'));
      if (weight !== null && weight > 0) row.weight = Math.round(weight);
    }

    for (const [field, parse] of Object.entries(NUMERIC_FIELD_PARSERS)) {
      if (has(field)) (row as unknown as Record<string, unknown>)[field] = parse(get(fields, field));
    }
    for (const field of TEXT_FIELDS) {
      if (has(field)) row[field] = get(fields, field);
    }

    row.sourceRowNumber = i;
    row.sourceColumns = buildSourceColumns(headers, fields);
    row.issues = validateCsvRow(row, mapping);

    rows.push(row);
  }

  return rows;
}

// ============================================================
// 업로드 → 선택 → import batch
// ============================================================

/**
 * 선택된 행만 추출. selectedIndices 미전달 시 전체 (하위 호환)
 * 잘못된 인덱스/빈 선택은 Error
 */
export function selectRowsForImport<T>(rows: T[], selectedIndices?: unknown): { index: number; row: T }[] {
  if (selectedIndices === undefined || selectedIndices === null) {
    return rows.map((row, index) => ({ index, row }));
  }
  if (!Array.isArray(selectedIndices)) {
    throw new Error('selectedIndices는 배열이어야 합니다');
  }
  const unique = new Set<number>();
  for (const value of selectedIndices) {
    if (!Number.isInteger(value) || value < 0 || value >= rows.length) {
      throw new Error(`잘못된 선택 인덱스: ${value}`);
    }
    unique.add(value);
  }
  if (unique.size === 0) {
    throw new Error('선택된 상품이 없습니다');
  }
  return [...unique].sort((a, b) => a - b).map(index => ({ index, row: rows[index] }));
}

const CSV_IMPORT_FIELDS = [
  'sourceProductCode', 'name', 'nameKo', 'priceCurrency', 'salePriceUsd',
  'purchaseCostKrw', 'retailPriceKrw', 'marginKrw', 'marginRate',
  'actualWeightG', 'lengthCm', 'widthCm', 'heightCm', 'volumetricWeightG', 'chargeableWeightG',
  'image', 'url', 'originalImageUrl', 'sourcePage', 'unitsPerBox',
  'selectedShippingProvider', 'salePriceOverrideUsd', 'salePriceOverrideHistory',
] as const;

/** crawl_results.raw_data 생성 — 기존 키 유지 + CSV 원본/정규화 값 보존 */
export function buildImportRawData(
  row: CsvRow,
  meta: { uploadId: string; rowIndex: number },
): Record<string, any> {
  const rawData: Record<string, any> = {
    rating: row.rating,
    reviewCount: row.reviewCount,
    discountRate: row.discountRate,
    originalPrice: row.originalPrice,
    images: row.image ? row.image.split('|||').filter((u: string) => u.trim()) : [],
  };
  if (row.category) rawData.category = row.category;
  if (row.brand) rawData.brand = row.brand;
  if (row.weight !== undefined) rawData.weight = row.weight;
  if (row.description) rawData.description = row.description;

  const fields: Record<string, unknown> = {};
  for (const key of CSV_IMPORT_FIELDS) {
    if (row[key] !== undefined) fields[key] = row[key];
  }

  rawData.csvImport = {
    uploadId: meta.uploadId,
    rowIndex: meta.rowIndex,
    sourceRowNumber: row.sourceRowNumber ?? null,
    fields,
    sourceColumns: row.sourceColumns ?? {},
    issues: row.issues ?? [],
    shippingQuote: row.shippingQuote ?? null,
  };
  return rawData;
}

export type QuoteCategory = 'OK' | 'RECOVERED' | 'ALTERNATIVE' | 'REVIEW' | 'NONE';

export interface RowAlternativeView {
  provider: 'KPL' | 'eGS';
  /** "eGS 20kg 구간 가능 · 배송비 418,600원" */
  label: string;
  shippingLabel: string;
  listingPriceLabel: string;
  buyerTotalLabel: string;
  /** eGS 대체는 브랜드 상품 확인 필요 */
  warning: string;
}

export interface ImportPreviewRow {
  index: number;
  code: string;
  name: string;
  image: string;
  url: string;
  priceLabel: string;
  weightLabel: string;
  issues: RowIssue[];
  errorCount: number;
  warningCount: number;
  defaultSelected: boolean;
  // 배송 (USD CSV 업로드에서만 사용)
  shippingProvider: 'KPL' | 'eGS' | null;
  canQuote: boolean;
  quoteStatus: 'OK' | 'BLOCKED' | 'NONE' | 'WEIGHT_INVALID';
  /** 상단 요약 분류: 정상 / 자동복구 / 대체 가능 / 확인 필요 / 미계산 */
  quoteCategory: QuoteCategory;
  shippingLabel: string;
  listingPriceLabel: string;
  /** 표시 전용: eBay 등록가 + 배송정책 구매자 배송비 (예 $38.60 + $7.90 = $46.50) */
  buyerTotalLabel: string;
  /** 한 줄 요약 (정상: 서비스·구간 / 실패: 원인) */
  quoteMessage: string;
  reasonCode: string | null;
  /** "원인: 배송비 서버 응답 지연 · 자동 재시도 실패" 의 원인 문구 */
  reasonLabel: string;
  /** "3회 자동 재시도 완료" */
  retryNote: string;
  /** "적용무게 자동복구: 1,023g" */
  weightRecoveryLabel: string;
  alternative: RowAlternativeView | null;
  /** 대체 배송사도 실패한 경우 최종 사유 */
  alternativeFailureLabel: string;
  /** title tooltip (여러 줄) */
  quoteTitle: string;
  /** 미완료 배송비 자동 계산 대상 */
  quoteUnfinished: boolean;
}

type RowShippingView = Pick<ImportPreviewRow,
  'shippingProvider' | 'canQuote' | 'quoteStatus' | 'quoteCategory' | 'shippingLabel' | 'listingPriceLabel' | 'buyerTotalLabel'
  | 'quoteMessage' | 'reasonCode' | 'reasonLabel' | 'retryNote' | 'weightRecoveryLabel' | 'alternative' | 'alternativeFailureLabel' | 'quoteTitle'>;

function buyerTotal(snapshot: ShippingQuoteSnapshot): string {
  return typeof snapshot.buyerShippingUsd === 'number' && typeof snapshot.listingPriceUsd === 'number'
    ? formatUsd((Math.round(snapshot.listingPriceUsd * 100) + Math.round(snapshot.buyerShippingUsd * 100)) / 100)
    : '';
}

/** 검수 화면 배송 칸 상태 (snapshot은 선택 배송사·적용무게와 일치할 때만 표시) */
export function describeRowShipping(row: CsvRow): RowShippingView {
  const empty: RowShippingView = {
    shippingProvider: null, canQuote: false, quoteStatus: 'NONE', quoteCategory: 'NONE', shippingLabel: '—', listingPriceLabel: '—', buyerTotalLabel: '',
    quoteMessage: '', reasonCode: null, reasonLabel: '', retryNote: '', weightRecoveryLabel: '', alternative: null, alternativeFailureLabel: '', quoteTitle: '',
  };
  if (row.priceCurrency !== 'USD') return empty;

  const provider = row.selectedShippingProvider ?? 'KPL';
  const weight = resolveChargeableWeight(row);
  const priceOk = typeof row.salePriceUsd === 'number' && row.salePriceUsd > 0;
  const weightRecoveryLabel = weight.recovered && weight.weightG !== null ? `적용무게 자동복구: ${formatWeightG(weight.weightG)}` : '';
  const base = { ...empty, shippingProvider: provider, canQuote: priceOk && weight.weightG !== null, weightRecoveryLabel };

  const failed = (reasonCode: string, extra: Partial<RowShippingView> = {}): RowShippingView => {
    const reasonLabel = describeQuoteReason(reasonCode);
    const view: RowShippingView = {
      ...base, quoteStatus: 'BLOCKED', quoteCategory: 'REVIEW', shippingLabel: '계산 실패', listingPriceLabel: '—',
      reasonCode: normalizeQuoteReason(reasonCode), reasonLabel, quoteMessage: `원인: ${reasonLabel}`, ...extra,
    };
    view.quoteTitle = [
      '예상 국제배송비: 계산 실패',
      `원인: ${view.reasonLabel}`,
      view.retryNote ? `처리: ${view.retryNote}` : '',
      view.alternative ? `대체: ${view.alternative.label}${view.alternative.warning ? ' (' + view.alternative.warning + ')' : ''}` : '',
      view.alternativeFailureLabel ? `대체: ${view.alternativeFailureLabel}` : '',
      view.weightRecoveryLabel,
    ].filter(Boolean).join('\n');
    return view;
  };

  if (weight.weightG === null) {
    return failed('INVALID_WEIGHT', { quoteStatus: 'WEIGHT_INVALID', canQuote: false });
  }
  const snapshot = row.shippingQuote;
  const current = snapshot && snapshot.provider === provider && snapshot.chargeableWeightG === weight.weightG ? snapshot : null;
  if (!current) {
    return { ...base, shippingLabel: '미계산', quoteMessage: '배송비 계산 필요', quoteTitle: weightRecoveryLabel };
  }

  const retryNote = current.retries ? `${current.retries}회 자동 재시도 완료` : '';
  if (current.status !== 'OK' || current.shippingUsd === null || current.listingPriceUsd === null) {
    const alt = row.shippingQuoteAlternative;
    const altCurrent = alt && alt.provider !== provider && alt.chargeableWeightG === weight.weightG ? alt : null;
    if (altCurrent && altCurrent.status === 'OK' && altCurrent.shippingUsd !== null && altCurrent.listingPriceUsd !== null) {
      return failed(current.blockedReason || 'QUOTE_REQUEST_FAILED', {
        retryNote,
        quoteCategory: 'ALTERNATIVE',
        alternative: {
          provider: altCurrent.provider,
          label: `${altCurrent.provider} ${altCurrent.bracketWeightKg}kg 구간 가능 · 배송비 ${(altCurrent.shippingKrw ?? 0).toLocaleString('ko-KR')}원`,
          shippingLabel: formatUsd(altCurrent.shippingUsd),
          listingPriceLabel: formatUsd(altCurrent.listingPriceUsd),
          buyerTotalLabel: buyerTotal(altCurrent),
          warning: altCurrent.provider === 'eGS' ? 'eGS는 브랜드 상품에 사용하지 않습니다' : '',
        },
      });
    }
    const alternativeFailureLabel = altCurrent
      ? `${altCurrent.provider}도 불가 · ${describeQuoteReason(altCurrent.blockedReason).replace(/^선택 배송사/, altCurrent.provider)}`
      : '';
    return failed(current.blockedReason || 'QUOTE_REQUEST_FAILED', { retryNote, alternativeFailureLabel });
  }

  const okMessage = `${current.serviceCode} · ${current.bracketWeightKg}kg 구간`;
  return {
    ...base,
    quoteStatus: 'OK',
    quoteCategory: weight.recovered ? 'RECOVERED' : 'OK',
    shippingLabel: formatUsd(current.shippingUsd),
    listingPriceLabel: formatUsd(current.listingPriceUsd),
    buyerTotalLabel: buyerTotal(current),
    quoteMessage: okMessage,
    retryNote: current.retries ? `${current.retries}회 재시도 후 정상` : '',
    quoteTitle: [okMessage, weightRecoveryLabel, current.retries ? `${current.retries}회 재시도 후 정상` : ''].filter(Boolean).join('\n'),
  };
}

/**
 * 미완료 배송비 행 — "미완료 배송비 자동 계산" 한 번으로 처리할 대상 (서버가 최신 parsed_rows로 판정)
 * - 견적 없음/무게·배송사 변경으로 무효/무게 복구 후 미계산/중단된 작업
 * - 다시 계산하면 해결될 수 있는 실패 (timeout·network·5xx·설정 오류)
 * - 대체 배송사를 아직 확인하지 않은 배송사 특정 실패
 * 완료(제외): 정상 · 자동복구 · 대체 가능 · 복구 불가 무게 · 대체 배송사까지 확인한 영구 실패 · 입력/계약 오류
 */
export function isQuoteRowUnfinished(row: CsvRow): boolean {
  if (row.priceCurrency !== 'USD') return false;
  const view = describeRowShipping(row);
  if (view.quoteCategory === 'OK' || view.quoteCategory === 'RECOVERED' || view.quoteCategory === 'ALTERNATIVE') return false;
  if (view.quoteStatus === 'WEIGHT_INVALID') return false;
  if (view.quoteCategory === 'NONE') return true;

  const primaryReason = row.shippingQuote?.blockedReason ?? null;
  if (isRecoverableQuoteFailure(primaryReason)) return true;
  if (!isAlternativeEligible(primaryReason)) return false;
  const weightG = resolveChargeableWeight(row).weightG;
  const alt = row.shippingQuoteAlternative;
  const altCurrent = alt && alt.provider !== view.shippingProvider && alt.chargeableWeightG === weightG ? alt : null;
  if (!altCurrent) return true;                                  // 대체 배송사 미확인
  return altCurrent.status !== 'OK' && isRecoverableQuoteFailure(altCurrent.blockedReason);
}

export interface QuoteSummary {
  ok: number;
  recovered: number;
  alternative: number;
  review: number;
  /** 미계산 */
  pending: number;
  /** 배송 견적 대상 전체 (= ok + recovered + alternative + review + pending) */
  total: number;
  /** 미완료 배송비 자동 계산 대상 */
  unfinished: number;
}

/** 상단 요약 — 분류는 서로 겹치지 않고 합계는 항상 전체 행수와 같다 */
export function summarizeQuoteRows(rows: CsvRow[]): QuoteSummary {
  const summary: QuoteSummary = { ok: 0, recovered: 0, alternative: 0, review: 0, pending: 0, total: 0, unfinished: 0 };
  for (const row of rows) {
    if (row.priceCurrency !== 'USD') continue;
    const view = describeRowShipping(row);
    summary.total++;
    if (view.quoteCategory === 'OK') summary.ok++;
    else if (view.quoteCategory === 'RECOVERED') summary.recovered++;
    else if (view.quoteCategory === 'ALTERNATIVE') summary.alternative++;
    else if (view.quoteCategory === 'REVIEW') summary.review++;
    else summary.pending++;
    if (isQuoteRowUnfinished(row)) summary.unfinished++;
  }
  return summary;
}

export function formatUsd(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatWeightG(value: number): string {
  return Math.round(value).toLocaleString('en-US') + 'g';
}

/** /import 검수 화면 view model */
export function buildImportPreview(rows: CsvRow[]): {
  rows: ImportPreviewRow[];
  priceHeader: string;
  defaultSelectedCount: number;
  errorRowCount: number;
  showShipping: boolean;
} {
  const hasUsd = rows.some(r => r.priceCurrency === 'USD');
  const previewRows = rows.map((row, index): ImportPreviewRow => {
    const issues = row.issues ?? [];
    const errorCount = issues.filter(i => i.level === 'error').length;
    const priceValue = row.priceCurrency === 'USD' ? row.salePriceUsd : row.price;
    let priceLabel = '—';
    if (typeof priceValue === 'number' && priceValue > 0) {
      priceLabel = row.priceCurrency === 'USD' ? formatUsd(priceValue) : '₩' + priceValue.toLocaleString('ko-KR');
    }
    const weightValue = resolveChargeableWeight(row).weightG ?? row.weight;
    return {
      index,
      code: row.sourceProductCode || '',
      name: row.name,
      image: isHttpUrl(primaryImage(row.image)) ? primaryImage(row.image) : '',
      url: isHttpUrl(row.url) ? row.url : '',
      priceLabel,
      weightLabel: typeof weightValue === 'number' && weightValue > 0 ? formatWeightG(weightValue) : '—',
      issues,
      errorCount,
      warningCount: issues.length - errorCount,
      defaultSelected: errorCount === 0,
      ...describeRowShipping(row),
      quoteUnfinished: isQuoteRowUnfinished(row),
    };
  });

  return {
    rows: previewRows,
    priceHeader: hasUsd ? '판매가(USD)' : '가격(KRW)',
    defaultSelectedCount: previewRows.filter(r => r.defaultSelected).length,
    errorRowCount: previewRows.filter(r => r.errorCount > 0).length,
    showShipping: hasUsd,
  };
}
