import path from 'path';
import { describe, it, expect } from 'vitest';
import { Eta } from 'eta';
import {
  parseCsvRawText,
  detectFixedHeaderMapping,
  detectMappingByKeyword,
  validateColumnMapping,
  applyMapping,
  parseDecimal,
  parseWeightG,
  parsePercent,
  selectRowsForImport,
  buildImportRawData,
  buildImportPreview,
  FIXED_HEADERS,
} from '../src/lib/csv-parser.js';
import {
  createSelection,
  defaultSelectedIndices,
  buildImportPayload,
  formatSelectionSummary,
} from '../public/js/import-selection.js';

const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';

const FULL_HEADER = '﻿페이지,상품코드,상품명,Product Name (EN),입수량(박스),원가(toybox 판매가),판매가(toybox 정가),환산가(USD),마진(원),마진율,실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지';
const FULL_CSV = [
  FULL_HEADER,
  `1,43037,유희왕 시너지팩3탄-히어로즈 유니버스,Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,64,"19,500","30,000",25.4,"10,500",35.0%,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,https://toybox.kr/shopimages/toybox119/0011220000822.jpg`,
  `1,77589,토미카 프라레일 JR 마리오 트레인,Tomica Plarail JR Mario Train,6,"42,600","71,000",60.1,"28,400",40.0%,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,https://toybox.kr/shopimages/toybox119/0010610007332.jpg`,
  `9,33043,하츄핑 베이비체어,Season 6 Princess Teenieping Baby Chair Series Random Figure - Random Shipment,12,"6,000","10,000",10.2,"4,000",40.0%,300,16,12,8,307,#REF!,${R2}/TOYBOX-33043/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10934609,https://toybox.kr/shopimages/toybox119/0010050004472.jpg`,
  `9,32893,티니핑 텀블러,Teenieping X Aespa_Tumbler Deco Set,6,"13,400","20,000",22.8,"6,600",33.0%,"1,200",,,,,"1,200",,https://toybox.kr/shop/shopdetail.html?branduid=10934606,`,
].join('\n');

const SHORT_CSV = [
  '상품명,환산가(USD),실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지',
  `Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,25.4,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,https://toybox.kr/shopimages/toybox119/0011220000822.jpg`,
  `Tomica Plarail JR Mario Train,60.1,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,https://toybox.kr/shopimages/toybox119/0010610007332.jpg`,
].join('\n');

function parseFixed(csv: string) {
  const raw = parseCsvRawText(csv);
  const mapping = detectFixedHeaderMapping(raw[0])!;
  return { raw, mapping, rows: applyMapping(raw, mapping) };
}

describe('1-3. 고정 헤더 자동 매핑', () => {
  it('전체 19개 헤더를 모두 시스템 필드로 매핑한다', () => {
    const raw = parseCsvRawText(FULL_CSV);
    expect(raw[0]).toHaveLength(19);
    const mapping = detectFixedHeaderMapping(raw[0]);
    expect(mapping).toEqual({
      sourcePage: 0,
      sourceProductCode: 1,
      nameKo: 2,
      name: 3,
      unitsPerBox: 4,
      purchaseCostKrw: 5,
      retailPriceKrw: 6,
      salePriceUsd: 7,
      marginKrw: 8,
      marginRate: 9,
      actualWeightG: 10,
      lengthCm: 11,
      widthCm: 12,
      heightCm: 13,
      volumetricWeightG: 14,
      chargeableWeightG: 15,
      image: 16,
      url: 17,
      originalImageUrl: 18,
    });
    expect(new Set(Object.values(mapping!)).size).toBe(19);
    expect(validateColumnMapping(mapping!)).toBeNull();
  });

  it('축약 11개 헤더를 매핑하고 상품명을 name으로 사용한다', () => {
    const raw = parseCsvRawText(SHORT_CSV);
    const mapping = detectFixedHeaderMapping(raw[0]);
    expect(mapping).toEqual({
      name: 0,
      salePriceUsd: 1,
      actualWeightG: 2,
      lengthCm: 3,
      widthCm: 4,
      heightCm: 5,
      volumetricWeightG: 6,
      chargeableWeightG: 7,
      image: 8,
      url: 9,
      originalImageUrl: 10,
    });
  });

  it('전체 CSV에서는 Product Name (EN)을 상품명으로 우선 사용한다', () => {
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[0].name).toBe('Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe');
    expect(rows[0].nameKo).toBe('유희왕 시너지팩3탄-히어로즈 유니버스');
    expect(rows[0].sourceProductCode).toBe('43037');
  });

  it('매핑 화면 드롭다운에 고정 헤더의 모든 시스템 필드 옵션이 있다', async () => {
    const fs = await import('fs');
    const view = fs.readFileSync(path.join(process.cwd(), 'views/step1b-mapping.eta'), 'utf-8');
    const mapping = detectFixedHeaderMapping(parseCsvRawText(FULL_CSV)[0])!;
    for (const field of Object.keys(mapping)) {
      expect(view).toContain(`<option value="${field}">`);
    }
    expect(FIXED_HEADERS).toHaveLength(19);
  });

  it('가격(원)과 판매가(USD) 동시 매핑을 거부한다', () => {
    expect(validateColumnMapping({ name: 0, price: 1, salePriceUsd: 2 })).toMatch(/동시에/);
    expect(validateColumnMapping({ name: 0, url: 3, weight: 1, chargeableWeightG: 2 })).toMatch(/동시에/);
    expect(validateColumnMapping({ name: 0, salePriceUsd: 2 })).toBeNull();
  });
});

describe('4-8. 숫자·통화·무게 파싱', () => {
  it('USD 소수점을 보존한다 (25.4 → 25.4, 254 아님)', () => {
    expect(parseDecimal('25.4')).toBe(25.4);
    expect(parseDecimal('60.1')).toBe(60.1);
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[0].price).toBe(25.4);
    expect(rows[0].salePriceUsd).toBe(25.4);
    expect(rows[0].priceCurrency).toBe('USD');
    expect(rows[1].price).toBe(60.1);
  });

  it('KRW 천단위 쉼표를 파싱하고 판매가 USD와 섞지 않는다', () => {
    expect(parseDecimal('19,500')).toBe(19500);
    expect(parseDecimal('19,500원')).toBe(19500);
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[0].purchaseCostKrw).toBe(19500);
    expect(rows[0].retailPriceKrw).toBe(30000);
    expect(rows[0].marginKrw).toBe(10500);
    expect(rows[0].price).not.toBe(19500);
  });

  it('무게 1,000 → 1000g, 1,023 → 1023g', () => {
    expect(parseWeightG('1,000')).toBe(1000);
    expect(parseWeightG('1,023')).toBe(1023);
    expect(parseWeightG('#REF!')).toBeNull();
    expect(parseWeightG('')).toBeNull();
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[1].actualWeightG).toBe(1000);
    expect(rows[1].volumetricWeightG).toBe(1023);
    expect(rows[1].chargeableWeightG).toBe(1023);
    expect(rows[1].weight).toBe(1023);
  });

  it('마진율 35.0% → 0.35', () => {
    expect(parsePercent('35.0%')).toBe(0.35);
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[0].marginRate).toBe(0.35);
  });

  it('R2 이미지가 image 필드로, 상품링크가 url로 전달된다', () => {
    const { rows } = parseFixed(SHORT_CSV);
    expect(rows[0].image).toBe(`${R2}/TOYBOX-43037/main-1.jpg`);
    expect(rows[0].url).toBe('https://toybox.kr/shop/shopdetail.html?branduid=10941010');
    expect(rows[0].originalImageUrl).toBe('https://toybox.kr/shopimages/toybox119/0011220000822.jpg');
  });

  it('#REF! 적용무게는 실측/부피무게로 복구 가능하면 warning, 복구 불가면 error (원본 적용무게는 null 유지)', () => {
    const { rows } = parseFixed(FULL_CSV);
    expect(rows[0].issues).toEqual([]);
    expect(rows[2].chargeableWeightG).toBeNull();
    //   Phase 2.2: 실측 300g · 부피 307g → 적용무게 자동복구 307g (기존: error)
    expect(rows[2].issues).toEqual([{ code: 'chargeable_weight_recovered', level: 'warning', message: '적용무게 자동복구: 307g' }]);
    const broken = parseFixed(FULL_CSV.replace(',300,16,12,8,307,#REF!,', ',,16,12,8,,#REF!,')).rows[2];
    expect(broken.issues!.map(i => [i.code, i.level])).toContainEqual(['chargeable_weight_invalid', 'error']);
    expect(rows[3].issues!.map(i => i.code)).toEqual(expect.arrayContaining(['image_missing', 'dimensions_missing']));
    expect(rows[3].issues!.every(i => i.level === 'warning')).toBe(true);
  });
});

describe('9. 원본 데이터 raw_data 보존', () => {
  it('19개 원본 컬럼 전체와 정규화 값을 raw_data.csvImport에 보존한다', () => {
    const { raw, rows } = parseFixed(FULL_CSV);
    const rawData = buildImportRawData(rows[1], { uploadId: 'u-1', rowIndex: 1 });

    // 기존 키 유지
    expect(rawData.images).toEqual([`${R2}/TOYBOX-77589/main-1.jpg`]);
    expect(rawData.weight).toBe(1023);

    const sourceColumns = rawData.csvImport.sourceColumns as Record<string, string>;
    expect(Object.keys(sourceColumns)).toHaveLength(19);
    raw[0].forEach((header, i) => {
      expect(sourceColumns[header.replace(/^﻿/, '')]).toBe(raw[2][i]);
    });
    expect(sourceColumns['적용무게(g)']).toBe('1,023');

    expect(rawData.csvImport).toMatchObject({
      uploadId: 'u-1',
      rowIndex: 1,
      sourceRowNumber: 2,
      fields: {
        sourceProductCode: '77589',
        name: 'Tomica Plarail JR Mario Train',
        nameKo: '토미카 프라레일 JR 마리오 트레인',
        priceCurrency: 'USD',
        salePriceUsd: 60.1,
        purchaseCostKrw: 42600,
        retailPriceKrw: 71000,
        marginKrw: 28400,
        marginRate: 0.4,
        actualWeightG: 1000,
        lengthCm: 43,
        widthCm: 17,
        heightCm: 7,
        volumetricWeightG: 1023,
        chargeableWeightG: 1023,
        sourcePage: 1,
        unitsPerBox: 6,
      },
    });
  });
});

describe('10-12. 상품 선택', () => {
  it('정상 상품은 기본 선택, 오류 상품은 제외한다', () => {
    const { rows } = parseFixed(FULL_CSV);
    const preview = buildImportPreview(rows);
    //   Phase 2.2: #REF! 행(2)은 무게 복구 가능 → 기본 선택 (기존: [0, 1, 3])
    expect(defaultSelectedIndices(preview.rows)).toEqual([0, 1, 2, 3]);
    expect(preview.defaultSelectedCount).toBe(4);
    expect(preview.errorRowCount).toBe(0);
    expect(preview.rows[2]).toMatchObject({ weightLabel: '307g', weightRecoveryLabel: '적용무게 자동복구: 307g' });
  });

  it('개별 선택/해제', () => {
    const selection = createSelection([0, 1, 2, 3], [0, 1, 3]);
    selection.set(1, false);
    selection.set(2, true);
    selection.toggle(3);
    selection.set(99, true); // 존재하지 않는 행은 무시
    expect(selection.selectedIndices()).toEqual([0, 2]);
    expect(formatSelectionSummary(selection)).toBe('선택 2 / 전체 4개');
  });

  it('전체 선택/해제는 모든 행(오류 행 포함)에 적용된다', () => {
    const all = Array.from({ length: 693 }, (_, i) => i);
    const selection = createSelection(all, [0]);
    selection.selectAll();
    expect(selection.count()).toBe(693);
    selection.clearAll();
    expect(selection.count()).toBe(0);
    expect(selection.total()).toBe(693);
  });

  it('선택된 상품만 import batch로 전달된다', () => {
    const { rows } = parseFixed(FULL_CSV);
    const selection = createSelection([0, 1, 2, 3], [3, 0]);
    const payload = buildImportPayload('u-1', selection);
    expect(payload).toEqual({ uploadId: 'u-1', selectedIndices: [0, 3] });

    const picked = selectRowsForImport(rows, payload.selectedIndices);
    expect(picked.map(p => p.index)).toEqual([0, 3]);
    expect(picked.map(p => p.row.sourceProductCode)).toEqual(['43037', '32893']);
  });

  it('selectedIndices 검증: 미전달=전체, 빈 배열/범위 밖/비정수는 거부', () => {
    const rows = ['a', 'b', 'c'];
    expect(selectRowsForImport(rows).map(p => p.row)).toEqual(['a', 'b', 'c']);
    expect(() => selectRowsForImport(rows, [])).toThrow('선택된 상품이 없습니다');
    expect(() => selectRowsForImport(rows, [3])).toThrow();
    expect(() => selectRowsForImport(rows, [1.5])).toThrow();
    expect(() => selectRowsForImport(rows, '0')).toThrow();
    expect(selectRowsForImport(rows, [2, 2, 0]).map(p => p.index)).toEqual([0, 2]);
  });
});

describe('13 + 화면. 검수 화면 렌더링', () => {
  const eta = new Eta({ views: path.join(process.cwd(), 'views') });

  function renderImport(csv: string) {
    const { rows } = parseFixed(csv);
    const preview = buildImportPreview(rows);
    return {
      preview,
      html: eta.render('./step2-import', {
        uploadId: 'u-1',
        rows: preview.rows,
        rowCount: preview.rows.length,
        priceHeader: preview.priceHeader,
        defaultSelectedCount: preview.defaultSelectedCount,
        errorRowCount: preview.errorRowCount,
      }),
    };
  }

  it('판매가(USD)·전체 선택·전체 해제·선택 개수·행별 체크박스·썸네일을 표시한다', () => {
    const { html, preview } = renderImport(FULL_CSV);
    expect(html).toContain('판매가(USD)');
    expect(html).not.toContain('가격 (원)');
    expect(html).toContain('전체 선택');
    expect(html).toContain('전체 해제');
    expect(html).toContain('선택 4 / 전체 4개');
    expect(html.match(/class="import-row-check"/g)).toHaveLength(4);
    expect(html.match(/class="thumb import-thumb"/g)).toHaveLength(3);
    expect(html).toContain(`src="${R2}/TOYBOX-43037/main-1.jpg"`);

    expect(preview.rows[0].priceLabel).toBe('$25.40');
    expect(preview.rows[1].priceLabel).toBe('$60.10');
    expect(preview.rows[0].weightLabel).toBe('307g');
    expect(preview.rows[1].weightLabel).toBe('1,023g');
    expect(html).toContain('$25.40');
    expect(html).toContain('1,023g');

    // 무게 복구 행은 체크 상태 + 복구 표시 / 복구 불가 오류 행은 체크 해제
    const recoveredRowCheckbox = html.match(/<input type="checkbox" class="import-row-check" data-index="2"[^>]*>/)![0];
    expect(recoveredRowCheckbox).toContain('checked');
    const broken = renderImport(FULL_CSV.replace(',300,16,12,8,307,#REF!,', ',,16,12,8,,#REF!,')).html;
    expect(broken.match(/<input type="checkbox" class="import-row-check" data-index="2"[^>]*>/)![0]).not.toContain('checked');
    const okRowCheckbox = html.match(/<input type="checkbox" class="import-row-check" data-index="0"[^>]*>/)![0];
    expect(okRowCheckbox).toContain('checked');
  });

  it('이미지가 없으면 placeholder를 표시한다', () => {
    const { html, preview } = renderImport(FULL_CSV);
    expect(preview.rows[3].image).toBe('');
    const row3 = html.match(/<tr class="import-row[^"]*" data-index="3"[^>]*>[\s\S]*?<\/tr>/)![0];
    expect(row3).toContain('thumb-placeholder');
    expect(row3).not.toContain('<img');
    // 깨진 이미지 대비 fallback
    expect(html).toContain('onerror=');
  });
});

describe('14. 기존 일반 CSV 매핑 회귀', () => {
  const COUPANG_CSV = [
    '이미지,상품URL,상품명,가격,리뷰수,무게',
    'https://thumbnail.coupangcdn.com/a.jpg,https://www.coupang.com/vp/products/123,포켓몬 카드 151,"19,900원","(1,234)",500',
    'https://thumbnail.coupangcdn.com/b.jpg,https://www.coupang.com/vp/products/456,디지몬 카드,"9,900원",(12),"1,000"',
  ].join('\n');

  it('고정 헤더가 아니면 결정적 매핑을 적용하지 않고 키워드 매핑이 그대로 동작한다', () => {
    const raw = parseCsvRawText(COUPANG_CSV);
    expect(detectFixedHeaderMapping(raw[0])).toBeNull();
    const mapping = detectMappingByKeyword(raw);
    expect(mapping).toMatchObject({ name: 2, price: 3, url: 1, image: 0, weight: 5 });
    expect(validateColumnMapping(mapping)).toBeNull();

    const rows = applyMapping(raw, mapping);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      image: 'https://thumbnail.coupangcdn.com/a.jpg',
      url: 'https://www.coupang.com/vp/products/123',
      name: '포켓몬 카드 151',
      price: 19900,
      priceCurrency: 'KRW',
      weight: 500,
    });
    expect(rows[1].weight).toBe(1000); // 기존 parseInt("1,000")=1 버그 수정
    expect(rows[0].salePriceUsd).toBeUndefined();
    expect(rows[0].issues).toEqual([]);

    const preview = buildImportPreview(rows);
    expect(preview.priceHeader).toBe('가격(KRW)');
    expect(preview.rows[0].priceLabel).toBe('₩19,900');
  });

  it('기존 raw_data 키(rating/reviewCount/discountRate/originalPrice/images)를 유지한다', () => {
    const raw = parseCsvRawText(COUPANG_CSV);
    const rows = applyMapping(raw, detectMappingByKeyword(raw));
    const rawData = buildImportRawData(rows[0], { uploadId: 'u-2', rowIndex: 0 });
    expect(rawData).toMatchObject({
      rating: 0,
      reviewCount: 1234,
      discountRate: '',
      originalPrice: 0,
      images: ['https://thumbnail.coupangcdn.com/a.jpg'],
    });
  });
});
