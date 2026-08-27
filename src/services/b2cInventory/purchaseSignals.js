'use strict';
/**
 * purchaseSignals.js — B2C · Phase 5 · READ-ONLY signals.
 *
 * Owner directive:
 *   · 자동 Purchase Task 생성 금지.
 *   · Priority evaluation / 별도 service 에서 purchase_signal 반환 · Dashboard 향후 활용.
 *   · signal: OUT_OF_STOCK_WITH_SALES  ← stock_qty=0 AND sales_90d >= 3
 */

async function loadAll(db, table, select) {
  const out = []; let off = 0;
  while (true) {
    const { data, error } = await db.from(table).select(select).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return out;
}

//   Pure signal computation · scorecard row 하나
//   Owner Phase 6 §14-§16: recommended_action 추가 (자동 실행 안 함 · 추천일 뿐)
function detectPurchaseSignals(scorecard, threshold = 3) {
  const signals = [];
  const stock = Number(scorecard.stock_qty) || 0;
  const sales90 = (Number(scorecard.ebay_sales_90d) || 0) + (Number(scorecard.shopify_sales_90d) || 0);
  if (stock === 0 && sales90 >= threshold) {
    const severity = sales90 >= 10 ? 'high' : 'medium';
    //   opportunity score V1 · sales_90d 기반 단순 · high/medium 반영
    const opportunity_score = severity === 'high' ? Math.min(100, 60 + Math.min(40, Math.floor(sales90 / 10))) : 40;
    signals.push({
      signal: 'OUT_OF_STOCK_WITH_SALES',
      severity,
      sales_90d: sales90,
      threshold,
      opportunity_score,
      reason: `재고 0 · 최근 90일 판매 ${sales90}건 (임계 ${threshold}건 이상) · 재입고 검토`,
      recommended_action: 'REVIEW_RESTOCK',       //   Owner spec §16 · 추천 · 자동 실행 안 함
    });
  }
  return signals;
}

async function listPurchaseSignals({ db, threshold = 3 } = {}) {
  const sc = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id, internal_sku, title, stock_qty, sales_90d, ebay_sales_90d, shopify_sales_90d, live_channels');
  const out = [];
  for (const s of sc) {
    const signals = detectPurchaseSignals(s, threshold);
    if (signals.length > 0) {
      out.push({
        sku_master_id: s.sku_master_id,
        internal_sku:  s.internal_sku,
        title:         s.title,
        stock_qty:     s.stock_qty,
        sales_90d:     s.sales_90d,
        ebay_sales_90d: s.ebay_sales_90d,
        shopify_sales_90d: s.shopify_sales_90d,
        signals,
      });
    }
  }
  //   Sort · high severity 먼저 · sales DESC
  out.sort((a, b) => {
    const ha = a.signals.some(s => s.severity === 'high') ? 0 : 1;
    const hb = b.signals.some(s => s.severity === 'high') ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return (Number(b.sales_90d) || 0) - (Number(a.sales_90d) || 0);
  });
  return { threshold, count: out.length, items: out };
}

module.exports = {
  detectPurchaseSignals,
  listPurchaseSignals,
};
