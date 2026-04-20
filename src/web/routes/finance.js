/**
 * 재무 요약 API (/api/finance/summary?month=YYYY-MM)
 *
 * 한 번의 호출로 재무 대시보드 카드에 필요한 데이터를 모아 반환.
 * - 이번달 지출 카테고리별 합계
 * - 정기결제 다가오는 7일
 * - 이번달 B2B vs 일반 매출 분리
 * - 이번달 카드 매입 합계
 *
 * 매출 자체(Shopify/eBay/Shopee/Naver)는 기존 /api/revenue/summary가 무거우므로
 * 여기선 호출 안 함; 프론트엔드가 이미 가지고 있는 매출 데이터와 조합해 순이익을 계산.
 */
const express = require('express');
const expenseRepo = require('../../db/expenseRepository');
const recurringRepo = require('../../db/recurringRepository');
const inventoryRepo = require('../../db/inventoryPurchaseRepository');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

function requireFinance(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 권한이 필요합니다' });
  next();
}

router.use(requireFinance);

router.get('/summary', async (req, res) => {
  try {
    const now = new Date();
    const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : defMonth;
    const [y, m] = month.split('-').map(n => parseInt(n, 10));
    const lastDay = new Date(y, m, 0).getDate();
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    // 1. 지출 카테고리별
    const expenseSummary = await expenseRepo.summaryByMonth(month).catch(() => ({ totals: {}, byCategory: {} }));

    // 2. 정기결제 다가오는 7일 + 이번달 전체
    const upcoming = await (async () => {
      try {
        const all = await recurringRepo.list({ activeOnly: true });
        const today = new Date();
        const sevenDaysLater = new Date();
        sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
        return all.filter(r => {
          if (!r.nextDueAt) return false;
          const due = new Date(r.nextDueAt + 'T00:00:00');
          return due >= today && due <= sevenDaysLater;
        }).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
      } catch { return []; }
    })();

    // 3. B2B vs 일반 매출 분리 (orders 테이블 직접 조회, 이번달)
    let b2bShare = { b2bByCurrency: {}, totalByCurrency: {}, orderCount: 0, b2bOrderCount: 0 };
    try {
      const db = getClient();
      // 이번달 주문 (order_date 기반)
      const { data: rows, error } = await db.from('orders')
        .select('payment_amount, currency, b2b_buyer_id')
        .gte('order_date', monthStart)
        .lte('order_date', monthEnd + 'T23:59:59');
      if (!error && rows) {
        for (const r of rows) {
          const ccy = (r.currency || 'USD').toUpperCase();
          const amt = Number(r.payment_amount) || 0;
          b2bShare.totalByCurrency[ccy] = (b2bShare.totalByCurrency[ccy] || 0) + amt;
          b2bShare.orderCount++;
          if (r.b2b_buyer_id) {
            b2bShare.b2bByCurrency[ccy] = (b2bShare.b2bByCurrency[ccy] || 0) + amt;
            b2bShare.b2bOrderCount++;
          }
        }
      }
    } catch (e) {
      console.warn('[finance] b2b share fail:', e.message);
    }

    // 4. 이번달 카드 매입 합계
    const purchaseSummary = await inventoryRepo.summaryByMonth(month).catch(() => ({ totals: {}, bySeller: [], byMethod: {} }));

    res.json({
      month,
      expenses: expenseSummary,              // { totals: {KRW: N}, byCategory: {...} }
      upcomingRecurring: upcoming,           // [{id, name, amount, currency, nextDueAt, category}]
      b2bShare,                              // { b2bByCurrency, totalByCurrency, orderCount, b2bOrderCount }
      inventoryPurchases: purchaseSummary,   // { totals: {KRW: N}, bySeller, byMethod }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
