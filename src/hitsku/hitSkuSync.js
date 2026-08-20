'use strict';
/**
 * Google Sheets → hitSkuService 동기화
 * - 최종 Dashboard + eBay Products 시트에서 salesCount 읽기
 * - 스냅샷 저장 → 집계
 */
const path = require('path');
const hitSkuService = require('./hitSkuService');

const credentialsPath = path.join(__dirname, '../../config/credentials.json');
const SPREADSHEET_ID  = process.env.GOOGLE_SPREADSHEET_ID;

function getSheets() {
  const GoogleSheetsAPI = require('../api/googleSheetsAPI');
  return new GoogleSheetsAPI(credentialsPath);
}

/**
 * Google Sheets 데이터를 읽어 스냅샷 저장 후 집계.
 * @returns {object[]} 최신 SkuStats 배열
 */
async function syncAndAggregate() {
  const sheets = getSheets();
  await sheets.authenticate();

  const rows = [];

  // ── 최종 Dashboard (마스터 데이터, salesCount = 열O / index14) ──
  try {
    const dashRows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:S');
    if (dashRows && dashRows.length) {
      for (const row of dashRows) {
        const sku = (row[1] || '').trim();
        if (!sku) continue;
        rows.push({
          sku,
          title:      (row[2] || '').trim(),
          platform:   'dashboard',
          salesCount: parseInt(row[14]) || 0,
        });
      }
    }
  } catch (e) {
    console.error('[HitSKU] 최종 Dashboard 읽기 실패:', e.message);
  }

  // ── eBay Products (별도 salesCount, index7) ──────────────────
  try {
    const ebayRows = await sheets.readData(SPREADSHEET_ID, 'eBay Products!A2:N');
    if (ebayRows && ebayRows.length) {
      for (const row of ebayRows) {
        const sku = (row[0] || '').trim();
        if (!sku) continue;
        const existing = rows.find(r => r.sku === sku);
        const sc = parseInt(row[7]) || 0;
        if (existing) {
          // 이미 dashboard 에 있으면 eBay count 로 보정
          existing.salesCount = Math.max(existing.salesCount, sc);
          existing.platform   = 'eBay';
        } else {
          rows.push({ sku, title: (row[1] || '').trim(), platform: 'eBay', salesCount: sc });
        }
      }
    }
  } catch (e) {
    console.error('[HitSKU] eBay Products 읽기 실패:', e.message);
  }

  if (!rows.length) {
    console.log('[HitSKU] 시트 데이터 없음 — 집계 스킵');
    return [];
  }

  hitSkuService.takeSnapshot(rows);
  const result = hitSkuService.aggregateFromSnapshots();
  const hits   = result.filter(s => s.status !== 'normal');
  console.log(`[HitSKU] 집계 완료 — 전체 ${result.length}개 SKU, 히트 ${hits.length}개`);
  return result;
}

module.exports = { syncAndAggregate };
