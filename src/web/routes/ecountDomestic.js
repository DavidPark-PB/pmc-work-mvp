'use strict';

/**
 * /api/ecount-domestic — ecountERP 의 국내 쇼핑몰 (네이버/쿠팡) 주문을 모아
 * 배송 관리 화면에 표시 + 우체국 자동 송장 발급.
 *
 * 사장님 spec (2026-06-23):
 *   - ecountERP 의 국내 쇼핑몰 (naver, coupang 등) 주문만 골라 별도 섹션으로 표시
 *   - 출력 = 우체국 API 자동 송장 발급 (createParcel domestic=true)
 *
 * Phase 1: 진단 + 미리보기
 * Phase 2: 화면 표시 + list
 * Phase 3: 우체국 라벨 발급
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const EcountAPI = require('../../api/ecountAPI');
const { getKoreaPostAPI } = require('../../api/koreaPostAPI');

const router = express.Router();
router.use(requireAdmin);

// ecount platform 코드 중 '국내' 로 분류할 것 — 사장님 spec.
const DOMESTIC_PLATFORMS = ['naver', 'coupang'];

// ════════════════════════════════════════════════════════════════════════════
// GET /api/ecount-domestic/diag — Phase 1 진단
//   ecount 자격증명, 우체국 자격증명, 발송인 정보, 국내 주문 분포 한 번에 확인
// ════════════════════════════════════════════════════════════════════════════
router.get('/diag', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));

    // ── ecount 자격증명 ──
    const ecountEnv = {
      ECOUNT_COM_CODE:  !!process.env.ECOUNT_COM_CODE,
      ECOUNT_USER_ID:   !!process.env.ECOUNT_USER_ID,
      ECOUNT_API_KEY:   !!process.env.ECOUNT_API_KEY,
      ECOUNT_ZONE:      !!process.env.ECOUNT_ZONE,
    };
    const ecountConfigured = ecountEnv.ECOUNT_COM_CODE && ecountEnv.ECOUNT_USER_ID && ecountEnv.ECOUNT_API_KEY;

    let ecountSession = null;
    if (ecountConfigured) {
      try {
        const api = new EcountAPI();
        await api.getSession();
        ecountSession = { ok: true };
      } catch (e) {
        ecountSession = { ok: false, error: e.message };
      }
    }

    // ── 우체국 자격증명 ──
    const koreapostEnv = {
      KOREAPOST_API_KEY:               !!process.env.KOREAPOST_API_KEY,
      KOREAPOST_CUSTNO:                !!process.env.KOREAPOST_CUSTNO,
      KOREAPOST_DOMESTIC_LABEL_URL:    !!process.env.KOREAPOST_DOMESTIC_LABEL_URL,  // 기본값 있으니 선택
      KOREAPOST_SHIPPER_NAME:          !!process.env.KOREAPOST_SHIPPER_NAME,
      KOREAPOST_SHIPPER_TEL:           !!process.env.KOREAPOST_SHIPPER_TEL,
      KOREAPOST_SHIPPER_ZIP:           !!process.env.KOREAPOST_SHIPPER_ZIP,
      KOREAPOST_SHIPPER_ADDR:          !!process.env.KOREAPOST_SHIPPER_ADDR,
    };
    const kp = getKoreaPostAPI();
    const koreapostConfigured = kp.isConfigured();

    // ── ecount 국내 (naver/coupang) 주문 분포 ──
    let domesticOrders = null;
    if (ecountConfigured && ecountSession?.ok) {
      try {
        const api = new EcountAPI();
        const startDate = EcountAPI.daysAgo(days);
        const endDate = EcountAPI.today();
        const breakdown = {};
        let totalRaw = 0;
        const samples = [];
        for (const platform of DOMESTIC_PLATFORMS) {
          const rows = await api.getOrders({ startDate, endDate, platform });
          breakdown[platform] = rows.length;
          totalRaw += rows.length;
          // 첫 3개씩 sample (normalize 후)
          for (let i = 0; i < Math.min(3, rows.length); i++) {
            const o = api.normalizeOrder(rows[i]);
            samples.push({ platform, raw_OrderNo: rows[i].ORDER_NO || rows[i].MALL_ORDER_NO, ...o });
          }
        }
        domesticOrders = {
          days,
          startDate, endDate,
          breakdown,
          totalRaw,
          samples,
        };
      } catch (e) {
        domesticOrders = { error: e.message };
      }
    }

    const missingEcount = Object.entries(ecountEnv).filter(([k, v]) => !v && k !== 'ECOUNT_ZONE').map(([k]) => k);
    const missingKoreapost = Object.entries(koreapostEnv).filter(([k, v]) => !v && k !== 'KOREAPOST_DOMESTIC_LABEL_URL').map(([k]) => k);

    res.json({
      ecount: {
        configured: ecountConfigured,
        env: ecountEnv,
        sessionTest: ecountSession,
        missing: missingEcount,
      },
      koreapost: {
        configured: koreapostConfigured,
        env: koreapostEnv,
        missing: missingKoreapost,
      },
      domesticOrders,
      hint: !ecountConfigured
        ? `Railway 환경변수에 [${missingEcount.join(', ')}] 설정 필요`
        : !koreapostConfigured
          ? `Railway 환경변수에 [${missingKoreapost.join(', ')}] 설정 필요`
          : '✅ 모두 정상 — Phase 2 (화면 표시) + Phase 3 (라벨 발급) 진행 가능',
    });
  } catch (e) {
    console.error('[ecount-domestic/diag] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/ecount-domestic/orders — Phase 2 화면용 list
//   ecount naver + coupang 주문 정규화해서 한 배열로 반환
// ════════════════════════════════════════════════════════════════════════════
router.get('/orders', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
    const api = new EcountAPI();
    const startDate = EcountAPI.daysAgo(days);
    const endDate = EcountAPI.today();

    const all = [];
    const errors = [];
    for (const platform of DOMESTIC_PLATFORMS) {
      try {
        const rows = await api.getOrders({ startDate, endDate, platform });
        for (const r of rows) {
          const norm = api.normalizeOrder(r);
          all.push({
            ...norm,
            ecountPlatform: platform,
            ecountRaw: { ORDER_NO: r.ORDER_NO, MALL_ORDER_NO: r.MALL_ORDER_NO, WRT_DATE: r.WRT_DATE },
          });
        }
      } catch (e) {
        errors.push(`${platform}: ${e.message}`);
      }
    }

    // 최신 순 정렬
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({
      ok: true,
      days, startDate, endDate,
      count: all.length,
      errors,
      orders: all,
    });
  } catch (e) {
    console.error('[ecount-domestic/orders] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
