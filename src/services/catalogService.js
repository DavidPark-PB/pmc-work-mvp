/**
 * 카탈로그 시트 관리
 *
 * 시트 구조:
 *   - 3개 시트(USD/KRW/EURO)가 동일 구조로 미러링
 *   - 탭별 상품군 (Pokemon / One Piece / ...)
 *   - 데이터 시작 행: 19 (16행 = 카테고리 제목 "BOOSTER BOX" 등, 17행 = 컬럼 헤더)
 *   - 좌우 2컬럼 레이아웃:
 *       left:  B=#, C=IMAGE, D=NAME, E=SET CODE, F=PRICE USD, G=UPC, H=DESC
 *       right: I=#, J=IMAGE, K=NAME, L=SET CODE, M=PRICE USD, N=UPC
 *   - 카테고리 헤더는 B열(또는 C열)에 "BOOSTER BOX" / "SPECIAL SET" / "PROMO PACK" 등으로 존재,
 *     다음 카테고리 헤더를 만나기 전까지 같은 카테고리로 간주
 */
const axios = require('axios');

const SHEET_IDS = {
  USD: process.env.SHEET_ID_USD || '1O6a7tSHmIHiFSmX0qLXN7Ab624viR-sEENmrGtXfQ_0',
  KRW: process.env.SHEET_ID_KRW || '1cw9ss_mImxeQes4OF0hRop5iQ2r0B5YjKYBiZIz2MHY',
  EURO: process.env.SHEET_ID_EURO || '1h_96W_dnQsfof2Ain4Jdpur4z7q-0h3yeMR_5442spw',
};

const DATA_START_ROW = 19;
const READ_RANGE = 'A1:N300'; // 충분히 넉넉하게
const CATEGORY_HEADERS = ['BOOSTER BOX', 'SPECIAL SET', 'PROMO PACK', 'STARTER DECK', 'DECK', 'ACCESSORY', 'SLEEVE', 'BINDER', 'ETC'];

// ── 싱글톤 ──
let _sheets = null;
async function getSheets() {
  if (_sheets) return _sheets;
  const GSAPI = require('../api/googleSheetsAPI');
  _sheets = new GSAPI();
  await _sheets.authenticate();
  return _sheets;
}

// ── 환율 (frankfurter.app) — 메모리 캐시 1시간 ──
// 환차익 보호용 마진: 시장환율에서 일정액 차감 → 지정환율로 사용
//   KRW: 기본 -50원   (FX_MARGIN_KRW 로 덮어쓰기)
//   EUR: 기본 -0.03€  (FX_MARGIN_EUR 로 덮어쓰기)  ≈ KRW 50원과 비슷한 3%대 쿠션
function getMargins() {
  return {
    krw: Number(process.env.FX_MARGIN_KRW || 50),
    eur: Number(process.env.FX_MARGIN_EUR || 0.03),
  };
}

let _fxCache = { at: 0 };
async function getRates() {
  if (Date.now() - _fxCache.at < 60 * 60 * 1000 && _fxCache.usdToKrw) return _fxCache;

  let market = { krw: 1380, eur: 0.92 };
  try {
    const r = await axios.get('https://api.frankfurter.app/latest?from=USD&to=KRW,EUR', { timeout: 8000 });
    market.krw = Number(r.data?.rates?.KRW) || market.krw;
    market.eur = Number(r.data?.rates?.EUR) || market.eur;
  } catch (e) {
    // 실패 시 직전 마켓 유지 (없으면 폴백)
    if (_fxCache.marketKrw) { market.krw = _fxCache.marketKrw; market.eur = _fxCache.marketEur; }
  }

  const m = getMargins();
  _fxCache = {
    at: Date.now(),
    marketKrw: market.krw,
    marketEur: market.eur,
    marginKrw: m.krw,
    marginEur: m.eur,
    usdToKrw: Math.max(0, market.krw - m.krw),   // 적용 환율 (지정환율)
    usdToEur: Math.max(0, market.eur - m.eur),
  };
  return _fxCache;
}

// ── 탭 목록 조회 ──
async function listTabs() {
  const s = await getSheets();
  const meta = await s.sheets.spreadsheets.get({ spreadsheetId: SHEET_IDS.USD });
  return meta.data.sheets
    .map(x => x.properties.title)
    .filter(t => !t.startsWith('*In Progress') && !t.startsWith('*In progress'));
}

function parseUsdPrice(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[$,\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isCategoryHeader(row) {
  if (!row) return null;
  // 16행 구조: col B(index 1) 또는 C(index 2)에 대문자 카테고리명
  for (let ci = 0; ci < Math.min(row.length, 4); ci++) {
    const v = String(row[ci] || '').trim().toUpperCase();
    if (CATEGORY_HEADERS.some(h => v === h || v.replace(/\s+/g, '') === h.replace(/\s+/g, ''))) {
      return v.replace(/\s+/g, ' ');
    }
  }
  return null;
}

/**
 * 탭 전체 파싱 → 카테고리별 아이템 배열
 * 각 아이템에 { rowIndex(1-based sheet row), side: 'left'|'right', name, setCode, image, upc, usdPrice }
 */
async function parseTab(tabName) {
  const s = await getSheets();
  const rows = await s.readData(SHEET_IDS.USD, `${tabName}!${READ_RANGE}`);
  const items = [];
  let currentCategory = 'UNCATEGORIZED';

  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 1; // 1-based
    const row = rows[i] || [];

    // 카테고리 헤더 감지 (16행 근처)
    if (sheetRow < DATA_START_ROW) {
      const cat = isCategoryHeader(row);
      if (cat) currentCategory = cat;
      continue;
    }
    // 데이터 영역에서도 섹션 변경 감지
    const maybeCat = isCategoryHeader(row);
    if (maybeCat) { currentCategory = maybeCat; continue; }

    // left item (B~H, index 1~7). 가격은 F = index 5
    const leftName = String(row[3] || '').trim();
    const leftPrice = parseUsdPrice(row[5]);
    if (leftName) {
      items.push({
        category: currentCategory,
        rowIndex: sheetRow,
        side: 'left',
        num: String(row[1] || '').trim(),
        name: leftName,
        setCode: String(row[4] || '').trim(),
        image: String(row[2] || '').trim(),
        upc: String(row[6] || '').trim(),
        description: String(row[7] || '').trim(),
        usdPrice: leftPrice,
      });
    }

    // right item (I~N, index 8~13). 가격은 M = index 12
    const rightName = String(row[10] || '').trim();
    const rightPrice = parseUsdPrice(row[12]);
    if (rightName) {
      items.push({
        category: currentCategory,
        rowIndex: sheetRow,
        side: 'right',
        num: String(row[8] || '').trim(),
        name: rightName,
        setCode: String(row[11] || '').trim(),
        image: String(row[9] || '').trim(),
        upc: String(row[13] || '').trim(),
        description: '',
        usdPrice: rightPrice,
      });
    }
  }

  return items;
}

// ── 이미지 매칭: platform_listings에서 SET CODE로 검색 (1h 캐시) ──
const _imgCache = new Map(); // key: setCode (lowercase) → { at, url }
const IMG_TTL = 60 * 60 * 1000;

async function findImageForCode(code) {
  if (!code) return '';
  const key = String(code).toLowerCase().trim();
  const cached = _imgCache.get(key);
  if (cached && Date.now() - cached.at < IMG_TTL) return cached.url;

  try {
    const { getClient } = require('../db/supabaseClient');
    const db = getClient();
    // ILIKE + 여러 우선순위: 정확 SKU 매칭 → title 포함
    const { data } = await db
      .from('platform_listings')
      .select('image_url, sku, title, platform')
      .or(`sku.ilike.%${key}%,title.ilike.%${key}%`)
      .not('image_url', 'is', null)
      .neq('image_url', '')
      .limit(1);

    const url = data?.[0]?.image_url || '';
    _imgCache.set(key, { at: Date.now(), url });
    return url;
  } catch (e) {
    return '';
  }
}

async function attachImages(items) {
  // 중복 제거된 set code 목록
  const uniqueCodes = [...new Set(items.map(it => it.setCode).filter(Boolean))];
  // 병렬로 조회 (캐시 히트는 즉시)
  const pairs = await Promise.all(uniqueCodes.map(async c => [c.toLowerCase(), await findImageForCode(c)]));
  const map = new Map(pairs);

  // setCode 없는 경우: 상품명 앞 20자로 검색 시도
  for (const it of items) {
    const codeKey = (it.setCode || '').toLowerCase();
    if (map.has(codeKey) && map.get(codeKey)) {
      it.image = map.get(codeKey);
    } else if (!it.image && it.name) {
      // name 기반 fallback — 처음 한 번만
      const nameKey = it.name.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      if (nameKey.length > 5) {
        const byName = await findImageForCode(nameKey);
        if (byName) it.image = byName;
      }
    }
  }
  return items;
}

/**
 * 카탈로그 전체 조회 — 탭별 아이템 + 환율 + 계산된 KRW/EUR + 이미지 매칭
 */
async function getCatalog(tabName) {
  const tabs = await listTabs();
  const defaultTab = tabs.find(t => t.includes('POKEMON')) || tabs[0];
  const tab = tabName || defaultTab;

  const [items, rates] = await Promise.all([parseTab(tab), getRates()]);
  await attachImages(items);

  const enriched = items.map(it => ({
    ...it,
    krwPrice: it.usdPrice != null ? Math.round(it.usdPrice * rates.usdToKrw) : null,
    euroPrice: it.usdPrice != null ? Math.round(it.usdPrice * rates.usdToEur * 100) / 100 : null,
  }));

  return {
    tab,
    tabs,
    rates: {
      usdToKrw: rates.usdToKrw,
      usdToEur: rates.usdToEur,
      marketKrw: rates.marketKrw,
      marketEur: rates.marketEur,
      marginKrw: rates.marginKrw,
      marginEur: rates.marginEur,
      at: rates.at,
    },
    items: enriched,
  };
}

/**
 * 3개 시트 동시 가격 업데이트
 * side=left → F{row}, side=right → M{row}
 * USD 가격만 받고, KRW/EUR은 live rate로 자동 계산
 */
async function updatePrice({ tab, rowIndex, side, usdPrice }) {
  if (!tab || !rowIndex || !['left', 'right'].includes(side)) {
    throw new Error('tab, rowIndex, side(left|right) 필수');
  }
  const usd = Number(usdPrice);
  if (!Number.isFinite(usd) || usd < 0) throw new Error('usdPrice는 0 이상의 숫자');

  const col = side === 'left' ? 'F' : 'M';
  const range = `${tab}!${col}${rowIndex}`;
  const s = await getSheets();
  const rates = await getRates();

  const krw = Math.round(usd * rates.usdToKrw);
  const eur = Math.round(usd * rates.usdToEur * 100) / 100;

  const fmt = {
    USD: `$${usd}`,
    KRW: `₩${krw.toLocaleString('en-US')}`,
    EURO: `€${eur}`,
  };

  // 3개 시트 병렬 업데이트
  const results = await Promise.all([
    s.writeData(SHEET_IDS.USD, range, [[fmt.USD]]),
    s.writeData(SHEET_IDS.KRW, range, [[fmt.KRW]]),
    s.writeData(SHEET_IDS.EURO, range, [[fmt.EURO]]),
  ]);

  return {
    tab, rowIndex, side, range,
    updated: { usd, krw, eur },
    formatted: fmt,
    rates: { usdToKrw: rates.usdToKrw, usdToEur: rates.usdToEur },
  };
}

module.exports = { getCatalog, updatePrice, listTabs, getRates, SHEET_IDS };
