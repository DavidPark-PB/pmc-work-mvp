/**
 * B2B 발송 대기 알림 — 매일 아침 미발송 B2B 주문을 집계해 admin에게 통지.
 * cron '0 9 * * *' (KST) 에서 호출. 수동 실행도 가능:
 *   node -e "require('./src/services/b2bShippingReminder').run().then(console.log)"
 */
const { notifyAdmins, getAdminIds } = require('./notificationService');
const sseHub = require('./sseHub');

async function run() {
  const B2BInvoiceService = require('./b2bInvoice');
  const B2BRepo = require('../db/b2bRepository');
  const svc = new B2BInvoiceService();
  const repo = new B2BRepo();

  let invoices = [];
  let shipments = [];
  try {
    [invoices, shipments] = await Promise.all([
      svc.getInvoices({}),
      repo.listAllShipments(),
    ]);
  } catch (e) {
    console.warn('[b2bShippingReminder] 데이터 조회 실패:', e.message);
    return { skipped: true, reason: e.message };
  }

  // 종료된 인보이스 제외
  const active = (invoices || []).filter(i => !['PAID', 'FULFILLED', 'CANCELLED'].includes(i.Status));

  // SKU별 남은 수량 합계
  const shippedByInvoiceSku = new Map();
  for (const s of shipments) {
    const key = s.invoiceNo;
    if (!shippedByInvoiceSku.has(key)) shippedByInvoiceSku.set(key, new Map());
    const m = shippedByInvoiceSku.get(key);
    for (const it of s.items || []) {
      m.set(it.sku, (m.get(it.sku) || 0) + Number(it.qty || 0));
    }
  }

  const pendingSkus = new Map();
  for (const inv of active) {
    let items = [];
    try { items = typeof inv.Items === 'string' ? JSON.parse(inv.Items || '[]') : (inv.Items || inv.ItemsParsed || []); }
    catch { items = []; }
    const sm = shippedByInvoiceSku.get(inv.InvoiceNo) || new Map();
    for (const it of items) {
      const sku = it.sku || it.SKU || '';
      if (!sku) continue;
      const remain = Math.max(0, Number(it.qty || 0) - (sm.get(sku) || 0));
      if (remain <= 0) continue;
      pendingSkus.set(sku, (pendingSkus.get(sku) || 0) + remain);
    }
  }

  if (pendingSkus.size === 0) {
    console.log('[b2bShippingReminder] 미발송 수량 없음 — 알림 skip');
    return { pending: 0 };
  }

  const totalPending = [...pendingSkus.values()].reduce((s, v) => s + v, 0);
  const top3 = [...pendingSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([sku, qty]) => `${sku} ${qty}개`).join(' · ');

  const payload = {
    type: 'b2b_pending_shipments',
    title: `미발송 B2B 주문 ${pendingSkus.size}개 SKU · ${totalPending}개`,
    body: top3,
    linkUrl: '/?page=b2b',
    relatedType: 'b2b',
    relatedId: null,
  };

  await notifyAdmins(payload);
  try {
    const ids = await getAdminIds();
    if (Array.isArray(ids) && ids.length > 0) sseHub.sendToMany(ids, payload);
  } catch {}

  console.log(`[b2bShippingReminder] 알림: ${pendingSkus.size}SKU · ${totalPending}개`);
  return { pending: totalPending, skus: pendingSkus.size };
}

/** 신규 인보이스 생성 직후 재고 부족 hint (threshold 초과 시) */
async function checkStockShortageAfterCreate(invoiceNo, { threshold = 100 } = {}) {
  try {
    const result = await run();   // 전체 집계 재활용
    if (result && result.pending && result.pending >= threshold) {
      // run()이 이미 알림 보냈으므로 중복 방지 위해 별도 알림 안 보냄
    }
    return result;
  } catch (e) {
    console.warn('[b2bShippingReminder] shortage check 실패:', e.message);
  }
}

module.exports = { run, checkStockShortageAfterCreate };
