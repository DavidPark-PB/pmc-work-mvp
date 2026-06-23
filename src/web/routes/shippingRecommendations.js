/**
 * /api/shipping/recommendations — Phase 2B
 *
 * 사장님 spec:
 *   - NEW 주문 기본. 상태 필터 확장 구조 (READY/SHIPPED/ALL 후속).
 *   - 룰 단순. SKU 매칭 실패 시 정확한 사유 표기.
 *   - 추천 결과 DB 저장 X (매번 계산).
 *
 * 응답 shape:
 *   {
 *     filter: { status, days, from, to },
 *     counts: { koreapost, shipter, kpl, fedex, yun, kpacket, review },
 *     groups: [
 *       { carrier: { key, label, color, emoji, order }, count, items: [...] },
 *       ...,
 *       { carrier: REVIEW, count, items: [...] }
 *     ],
 *     totalOrders: int,
 *   }
 *
 *   item: {
 *     order_id, order_no, platform, ordered_at,
 *     buyer_name, country_code,
 *     sku (orders.sku 원본), title, quantity,
 *     weight_gram, internal_sku, matched,  // matched=false 면 review
 *     recommendation: { carrier, reason, review? { code, message } },
 *   }
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');
const recommender = require('../../services/shippingRecommender');
const orderShipmentRepo = require('../../db/orderShipmentRepository');
const shippingCalc = require('../../services/shippingWeightCalculator');

const router = express.Router();
router.use(requireAdmin);

// 상태 필터 화이트리스트 (사장님 추가 조건 1 — 확장 구조)
// 추후 READY / SHIPPED / ALL 추가 시 본 상수에만 추가 + 아래 listOrdersByStatus 의 case 만 확장.
const ALLOWED_STATUSES = ['NEW', 'READY', 'SHIPPED', 'ALL'];
const DEFAULT_STATUS = 'NEW';

/**
 * orders 테이블에서 status + 기간 필터로 가져옴.
 *
 * status='NEW' → status = 'NEW' (사장님 운영 데이터의 status 컬럼)
 * status='ALL' → status 필터 없음
 * status='READY' / 'SHIPPED' → 본 시점엔 동일하게 단일 eq (운영 정착 시 확장 가능)
 */
async function listOrdersByStatus({ status, fromDate, toDate }) {
  let q = getClient().from('orders')
    .select(`
      id, order_no, platform, order_date, status,
      sku, title, quantity, buyer_name, country, country_code, carrier
    `)
    .order('order_date', { ascending: false })
    .limit(1000);

  if (fromDate) q = q.gte('order_date', fromDate);
  if (toDate) q = q.lte('order_date', toDate);

  if (status === 'ALL') {
    // no status filter
  } else if (ALLOWED_STATUSES.includes(status)) {
    q = q.eq('status', status);
  } else {
    q = q.eq('status', DEFAULT_STATUS);
  }

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/**
 * orders.sku 의 unique list → sku_master 의 internal_sku 와 매칭.
 * 매칭 성공: Map<sku, sku_master row>
 *
 * 정책: orders.sku === sku_master.internal_sku 의 정확 매칭만 (단순화). 부분 매칭 / fuzzy X.
 * sku_master 의 box_length/width/height 도 함께 가져옴 — 견적 엔진의 부피중량 계산용.
 */
async function lookupSkuMasterMap(skus) {
  const unique = [...new Set(skus.filter(s => s && String(s).trim()).map(s => String(s).trim()))];
  if (unique.length === 0) return new Map();
  const { data, error } = await getClient().from('sku_master')
    .select('internal_sku, title, weight_gram, status, length_cm, width_cm, height_cm')
    .in('internal_sku', unique);
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) map.set(r.internal_sku, r);
  return map;
}

// 캐리어 순서대로 정렬할 group helper — 견적 엔진의 5개 배송사 + REVIEW
function _initialGroups() {
  const order = [
    recommender.CARRIERS.KPACKET,
    recommender.CARRIERS.KPL,
    recommender.CARRIERS.SHIPTER,
    recommender.CARRIERS.YUN_EXPRESS,
    recommender.CARRIERS.EMS_PREMIUM,
    recommender.REVIEW,
  ];
  return order.map(c => ({ carrier: c, count: 0, items: [] }));
}

// GET /api/shipping/recommendations?status=NEW&days=7
router.get('/', async (req, res) => {
  try {
    const statusInput = String(req.query.status || DEFAULT_STATUS).toUpperCase();
    const status = ALLOWED_STATUSES.includes(statusInput) ? statusInput : DEFAULT_STATUS;
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 90));

    // 기간 계산 (KST 기준 today - days)
    const now = new Date();
    const toDate = now.toISOString().slice(0, 10);
    const fromDate = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);

    const orders = await listOrdersByStatus({ status, fromDate, toDate });
    const skuMap = await lookupSkuMasterMap(orders.map(o => o.sku));

    const groups = _initialGroups();
    const carrierIndex = new Map();
    for (let i = 0; i < groups.length; i++) carrierIndex.set(groups[i].carrier.key, i);

    for (const o of orders) {
      const matched = skuMap.get(o.sku ? String(o.sku).trim() : '');
      const matchInfo = recommender.buildMatchInfo(o.sku, matched);
      const weightGram = matched ? matched.weight_gram : null;
      const countryCode = o.country_code || null;

      // 부피중량 계산용 — sku_master 치수 우선
      const dimensions = matched ? {
        lengthCm: Number(matched.length_cm) || 0,
        widthCm:  Number(matched.width_cm)  || 0,
        heightCm: Number(matched.height_cm) || 0,
      } : null;

      const rec = recommender.recommend({ weightGram, countryCode, matchInfo, dimensions });

      const item = {
        order_id:       o.id,
        order_no:       o.order_no,
        platform:       o.platform,
        order_date:     o.order_date,
        status:         o.status,
        existing_carrier: o.carrier || null,
        buyer_name:     o.buyer_name,
        country:        o.country,
        country_code:   o.country_code,
        sku:            o.sku,            // orders.sku 원본
        title:          o.title,
        quantity:       o.quantity,
        weight_gram:    weightGram,
        dimensions_cm:  dimensions && (dimensions.lengthCm || dimensions.widthCm || dimensions.heightCm)
                          ? { l: dimensions.lengthCm, w: dimensions.widthCm, h: dimensions.heightCm }
                          : null,
        internal_sku:   matched ? matched.internal_sku : null,
        matched:        !!matched,
        match_attempt:  matchInfo.attemptedSku || '',
        match_reason:   matchInfo.reason || null,
        recommendation: {
          carrier_key:   rec.carrier?.key,
          carrier_label: rec.carrier?.label,
          carrier_color: rec.carrier?.color,
          reason:        rec.reason,
          review:        rec.review || null,
        },
        // 견적 비교 — 5개 배송사 가격 (최저가 정렬). 직원 화면에서 펼쳐 보기.
        quotes: Array.isArray(rec.quotes) ? rec.quotes : null,
      };

      const idx = carrierIndex.get(rec.carrier.key);
      if (idx != null) {
        groups[idx].items.push(item);
        groups[idx].count++;
      } else {
        // 안전망 — 정의되지 않은 carrier key 가 나오면 REVIEW 로
        const reviewIdx = carrierIndex.get(recommender.REVIEW.key);
        groups[reviewIdx].items.push({ ...item, recommendation: { ...item.recommendation, review: { code: 'no_rule', message: '룰 미적용 — 코드 검토 필요' } } });
        groups[reviewIdx].count++;
      }
    }

    const counts = {};
    for (const g of groups) counts[g.carrier.key] = g.count;

    res.json({
      filter: { status, days, from: fromDate, to: toDate, allowedStatuses: ALLOWED_STATUSES },
      counts,
      totalOrders: orders.length,
      groups,
    });
  } catch (e) {
    console.error('[shipping/recommendations] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/shipping/recommendations/export — 추천 결과를 배송사 구글시트에 일괄 입력
// ════════════════════════════════════════════════════════════════════════════
//
// 사장님 spec (2026-06):
//   배송 추천 화면에서 "구글시트 자동입력" 버튼 → 같은 색(=같은 배송사) 묶음을
//   해당 배송사 시트에 한 번에 추가. 직원이 carrierSheets 화면을 따로 열 필요 X.
//
// body:
//   { orderIds: number[] }
//     또는
//   { orderIds: number[], carrierKey: 'shipter'|'kpl'|'yun' }
//       carrierKey 가 있으면 그 배송사로 강제. 없으면 recommend() 결과 따름.
//
// 응답:
//   { ok: number, fail: number, skipped: number, results: [...] }
//
// 매핑: recommender carrier_key → carrierSheets 한글 배송사명
//   shipter → 쉽터, kpl → KPL, yun → 윤익스프레스
//   koreapost / fedex / kpacket / review → 시트 미지원 (skipped)

// recommender key → carrierSheets 한글명
const CARRIER_KEY_TO_SHEET_NAME = {
  shipter: '쉽터',
  kpl: 'KPL',
  yun: '윤익스프레스',
};

const SHEET_SUPPORTED_KEYS = new Set(Object.keys(CARRIER_KEY_TO_SHEET_NAME));

router.post('/export', async (req, res) => {
  try {
    const body = req.body || {};
    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.map(n => parseInt(n, 10)).filter(Number.isFinite)
      : [];
    if (orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds 가 필요합니다' });
    }
    const forcedCarrierKey = body.carrierKey ? String(body.carrierKey).toLowerCase() : null;
    if (forcedCarrierKey && !SHEET_SUPPORTED_KEYS.has(forcedCarrierKey)) {
      return res.status(400).json({
        error: `carrierKey '${forcedCarrierKey}' 는 시트 미지원. 지원: ${[...SHEET_SUPPORTED_KEYS].join(', ')}`,
      });
    }

    // 1) orders + sku_master 일괄 조회
    const db = getClient();
    const { data: orders, error: e1 } = await db.from('orders')
      .select(`
        id, order_no, platform, sku, title, quantity,
        buyer_name, street, city, province, zip_code,
        country, country_code, phone, email,
        weight_kg, box_length, box_width, box_height,
        payment_amount, currency
      `)
      .in('id', orderIds);
    if (e1) throw e1;

    const skuMap = await lookupSkuMasterMap((orders || []).map(o => o.sku));

    // 2) CarrierSheets lazy init (실패 시 빠르게 응답)
    const CarrierSheets = require('../../services/carrierSheets');
    let cs;
    try {
      cs = new CarrierSheets();
    } catch (initErr) {
      return res.status(503).json({ error: `구글시트 연결 실패: ${initErr.message}` });
    }

    const results = [];
    let ok = 0, fail = 0, skipped = 0;

    for (const o of orders || []) {
      const matched = skuMap.get(o.sku ? String(o.sku).trim() : '');
      const matchInfo = recommender.buildMatchInfo(o.sku, matched);
      const weightGramFromMaster = matched ? Number(matched.weight_gram) : null;
      const countryCode = o.country_code || null;

      let carrierKey = forcedCarrierKey;
      let recReason = forcedCarrierKey ? `사용자 지정: ${forcedCarrierKey}` : null;
      if (!carrierKey) {
        const dimensions = matched ? {
          lengthCm: Number(matched.length_cm) || 0,
          widthCm:  Number(matched.width_cm)  || 0,
          heightCm: Number(matched.height_cm) || 0,
        } : null;
        const rec = recommender.recommend({
          weightGram: weightGramFromMaster,
          countryCode,
          matchInfo,
          dimensions,
        });
        carrierKey = rec.carrier?.key;
        recReason = rec.reason;
      }

      if (!carrierKey || !SHEET_SUPPORTED_KEYS.has(carrierKey)) {
        skipped++;
        results.push({
          order_id: o.id, order_no: o.order_no,
          status: 'skipped',
          reason: carrierKey === 'review'
            ? `검토 필요: ${recReason || ''}`
            : `${carrierKey || 'unknown'} 시트 자동입력 미지원`,
        });
        continue;
      }

      const sheetCarrierName = CARRIER_KEY_TO_SHEET_NAME[carrierKey];

      // orders 무게 우선, 없으면 sku_master 무게 → kg 변환
      const weightG = (Number(o.weight_kg) > 0)
        ? Number(o.weight_kg) * 1000
        : weightGramFromMaster;
      const weightKg = weightG ? Math.round((weightG / 1000) * 1000) / 1000 : null;

      const orderPayload = {
        orderId: o.order_no,
        buyerName: o.buyer_name || '',
        countryCode: o.country_code || '',
        country: o.country || '',
        street: o.street || '',
        city: o.city || '',
        province: o.province || '',
        zipCode: o.zip_code || '',
        phone: o.phone || '',
        email: o.email || '',
        weightKg,
        dimL: Number(o.box_length) || null,
        dimW: Number(o.box_width) || null,
        dimH: Number(o.box_height) || null,
        sku: o.sku || '',
        title: o.title || '',
        quantity: Number(o.quantity) || 1,
        paymentAmount: o.payment_amount ? Number(o.payment_amount) : null,
        currency: o.currency || null,
      };

      try {
        const sheetResult = await cs.addToCarrierSheet(sheetCarrierName, orderPayload, {});
        ok++;
        results.push({
          order_id: o.id, order_no: o.order_no,
          status: 'ok',
          carrier: sheetCarrierName,
          sheetTab: sheetResult.sheetTab,
          reason: recReason,
        });
        // orders 테이블 — carrier + status='READY' 업데이트 (set-carrier 와 동일 정책)
        try {
          await db.from('orders').update({ carrier: sheetCarrierName, status: 'READY' }).eq('id', o.id);
        } catch (uErr) {
          console.warn(`[shipping/export] orders 업데이트 실패 (무시) order_id=${o.id}:`, uErr.message);
        }
      } catch (sheetErr) {
        fail++;
        results.push({
          order_id: o.id, order_no: o.order_no,
          status: 'fail',
          carrier: sheetCarrierName,
          error: sheetErr.message,
        });
        console.error(`[shipping/export] 시트 추가 실패 order_no=${o.order_no}:`, sheetErr.message);
      }
    }

    res.json({ ok, fail, skipped, total: (orders || []).length, results });
  } catch (e) {
    console.error('[shipping/recommendations/export] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/shipping/recommendations/fedex-quote — FedEx 라이브 견적 (단일 주문)
// ════════════════════════════════════════════════════════════════════════════
//
// 사장님 spec (2026-06-23):
//   FedEx 는 라이브 API 호출 (1건당 1~3초) 이라 배송 추천 화면에서 자동 호출 X.
//   사용자가 주문별 'FedEx 견적' 버튼 클릭 시만 호출. 견적 받고 5개와 비교 → 라벨 발급.
//
// body: { orderId }
// 응답: { ok, orderNo, weightKg, dims, services: [{serviceType, serviceName, cost, etaDays}], cheapest }
//
// 라벨 발급은 기존 POST /api/orders/:orderNo/fedex-label 그대로 사용.

// GET /api/shipping/recommendations/fedex-status — admin 진단용
// production / 로컬에서 FedEx 환경변수가 제대로 세팅됐는지 확인.
// 비밀값은 노출 안 함 — 채워졌는지 여부만.
router.get('/fedex-status', async (req, res) => {
  try {
    const { getFedexAPI } = require('../../api/fedexAPI');
    const fedex = getFedexAPI();
    const isConfigured = fedex.isConfigured();
    const apiBase = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    const isProd = apiBase.includes('apis.fedex.com') && !apiBase.includes('sandbox');

    const credentials = {
      FEDEX_CLIENT_ID:       !!process.env.FEDEX_CLIENT_ID,
      FEDEX_CLIENT_SECRET:   !!process.env.FEDEX_CLIENT_SECRET,
      FEDEX_ACCOUNT_NUMBER:  !!process.env.FEDEX_ACCOUNT_NUMBER,
    };
    const origin = {
      FEDEX_ORIGIN_NAME:    !!process.env.FEDEX_ORIGIN_NAME,
      FEDEX_ORIGIN_PHONE:   !!process.env.FEDEX_ORIGIN_PHONE,
      FEDEX_ORIGIN_STREET:  !!process.env.FEDEX_ORIGIN_STREET,
      FEDEX_ORIGIN_CITY:    !!process.env.FEDEX_ORIGIN_CITY,
      FEDEX_ORIGIN_STATE:   !!process.env.FEDEX_ORIGIN_STATE,
      FEDEX_ORIGIN_ZIP:     !!process.env.FEDEX_ORIGIN_ZIP,
      FEDEX_ORIGIN_COUNTRY: !!process.env.FEDEX_ORIGIN_COUNTRY,
    };
    const allOriginSet = Object.values(origin).every(v => v);
    const missingCredentials = Object.entries(credentials).filter(([k, v]) => !v).map(([k]) => k);
    const missingOrigin = Object.entries(origin).filter(([k, v]) => !v).map(([k]) => k);

    // 토큰 발급까지 실제로 시도해서 자격증명이 실제로 유효한지 확인 (선택적)
    let tokenTest = null;
    if (isConfigured && req.query.test === '1') {
      try {
        await fedex.getAccessToken();
        tokenTest = { ok: true };
      } catch (e) {
        tokenTest = { ok: false, error: e.message };
      }
    }

    res.json({
      isConfigured,             // 자격증명 3개 모두 세팅됐는지
      mode: isProd ? 'production' : 'sandbox',
      apiBase,
      credentials,
      origin,
      allOriginSet,
      missingCredentials,
      missingOrigin,
      tokenTest,                // ?test=1 시에만 실제 토큰 발급 시도 결과
      hint: !isConfigured
        ? `Railway 환경변수에 [${missingCredentials.join(', ')}] 설정 필요`
        : (!allOriginSet ? `출발지 정보 누락: [${missingOrigin.join(', ')}]` : '✅ 모든 환경변수 OK'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/fedex-quote', async (req, res) => {
  try {
    // orderId (배송 추천 화면) 또는 orderNo (배송 관리 화면) — 양방향 lookup 지원
    const orderId = req.body?.orderId != null ? parseInt(req.body.orderId, 10) : null;
    const orderNo = req.body?.orderNo ? String(req.body.orderNo).trim() : null;
    if (!Number.isFinite(orderId) && !orderNo) {
      return res.status(400).json({ ok: false, error: 'orderId 또는 orderNo 가 필요합니다' });
    }

    const { getFedexAPI } = require('../../api/fedexAPI');
    const fedex = getFedexAPI();
    if (!fedex.isConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'FedEx 자격증명이 설정되지 않았습니다 (config/.env 의 FEDEX_CLIENT_ID/SECRET/ACCOUNT_NUMBER 필요)',
      });
    }

    const db = getClient();
    let oq = db.from('orders').select(`
      id, order_no, sku, quantity,
      street, city, province, zip_code, country_code,
      weight_kg, box_length, box_width, box_height,
      payment_amount, currency
    `);
    oq = Number.isFinite(orderId) ? oq.eq('id', orderId) : oq.eq('order_no', orderNo);
    const { data: order, error } = await oq.maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ ok: false, error: `주문 ${orderId || orderNo} 없음` });

    if (!order.street || !order.zip_code || !order.country_code) {
      return res.status(400).json({
        ok: false,
        error: '주소 불완전 — street/zip_code/country_code 필요',
      });
    }

    // 무게/치수 — orders 우선, sku_master fallback
    let weightKg = Number(order.weight_kg) || 0;
    let dimL = Number(order.box_length) || 0;
    let dimW = Number(order.box_width) || 0;
    let dimH = Number(order.box_height) || 0;
    if (weightKg <= 0 && order.sku) {
      const { data: m } = await db.from('sku_master')
        .select('weight_gram, length_cm, width_cm, height_cm')
        .eq('internal_sku', String(order.sku).trim())
        .maybeSingle();
      if (m) {
        if (m.weight_gram > 0) weightKg = Number(m.weight_gram) / 1000;
        if (m.length_cm) dimL = Number(m.length_cm);
        if (m.width_cm)  dimW = Number(m.width_cm);
        if (m.height_cm) dimH = Number(m.height_cm);
      }
    }
    if (weightKg <= 0) {
      return res.status(400).json({ ok: false, error: '무게 미등록 — sku_master.weight_gram 입력 필요' });
    }

    // FedEx Rate API 호출
    const qty = Number(order.quantity) || 1;
    weightKg = weightKg * qty;
    const dims = (dimL && dimW && dimH) ? { length: dimL, width: dimW, height: dimH } : null;
    const customsValue = Number(order.payment_amount) || 1;
    const currency = order.currency || 'USD';

    const destination = {
      street: order.street, city: order.city, state: order.province,
      zip: order.zip_code, country: order.country_code,
    };
    let services = [];
    try {
      services = await fedex.getRates({
        destination,
        packages: [{ weightKg, dimensions: dims }],
        customsValue,
        currency,
      });
    } catch (fedexErr) {
      // 진단 정보 포함 — Railway 로그 + 사용자 화면 양쪽에 가시화
      return res.status(502).json({
        ok: false,
        error: fedexErr.message,
        debug: {
          destination,
          weightKg,
          dims,
          hint: '주소 누락/잘못 형식 가능성 — orders.street/city/province/zip_code/country_code 확인',
        },
      });
    }

    if (!Array.isArray(services) || services.length === 0) {
      return res.json({ ok: true, orderNo: order.order_no, weightKg, dims, services: [], cheapest: null });
    }

    services.sort((a, b) => a.cost - b.cost);
    const cheapest = services[0];

    res.json({
      ok: true,
      orderNo: order.order_no,
      weightKg,
      dims,
      services,    // 가격순 정렬
      cheapest,    // { serviceType, serviceName, cost, currency, etaDays }
      customsValue,
      currency,
    });
  } catch (e) {
    console.error('[shipping/fedex-quote] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WMS 기반 라우트 (Phase 4 of 배송비 계산/배송추천 리디자인)
// ════════════════════════════════════════════════════════════════════════════
// 기존 /api/shipping/recommendations 는 레거시 orders 테이블 기반으로 유지.
// 신규 /api/shipping/recommendations/wms/* 는 wms_orders + order_shipments 기반.

// ±50% 이상 차이는 경고 표시 — 배송추천 화면 spec 의 '차이 큰 경우 경고'.
const WEIGHT_DEVIATION_WARNING_PCT = 0.5;

const WMS_ALLOWED_STATUS = ['pending', 'paid', 'ready_to_ship', 'shipped', 'cancelled', 'refunded', 'ALL'];

// GET /api/shipping/recommendations/wms
//   query:
//     days=14              — 최근 며칠 (default 14)
//     status=paid          — wms_orders.order_status 또는 ALL
//     carrier=fedex        — order_shipments.recommended_carrier 필터
//     weight_status=missing — '무게 입력 필요' 주문만 (계산 안됨 또는 review)
router.get('/wms', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 14, 90));
    const statusInput = String(req.query.status || 'ALL');
    const status = WMS_ALLOWED_STATUS.includes(statusInput) ? statusInput : 'ALL';
    const carrier = req.query.carrier ? String(req.query.carrier).toLowerCase() : null;
    const weightFilter = req.query.weight_status === 'missing' ? 'missing' : null;

    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    // 1) 주문 + line + matched SKU + shipment 일괄 조회 (N+1 회피)
    const db = getClient();
    let oq = db.from('wms_orders')
      .select(`
        id, marketplace, external_order_id, order_status, buyer_country,
        buyer_name, ordered_at, total_amount, currency,
        lines:wms_order_lines (
          id, marketplace_sku, listing_id, option_id,
          title, quantity, unit_price, currency,
          matched_sku_id, match_status, match_reason,
          sku:matched_sku_id ( id, internal_sku, weight_gram, weight_status,
                               default_packaging_weight_g, shipping_group )
        )
      `)
      .gte('ordered_at', sinceIso)
      .order('ordered_at', { ascending: false })
      .limit(500);
    if (status !== 'ALL') oq = oq.eq('order_status', status);
    const { data: orders, error: e1 } = await oq;
    if (e1) throw e1;

    const orderIds = (orders || []).map(o => o.id);
    const shipmentMap = await orderShipmentRepo.listByOrderIds(orderIds);

    // 2) 행 빌드
    const rows = (orders || []).map(o => {
      const shipment = shipmentMap.get(o.id) || null;
      const lines = (o.lines || []).map(l => {
        const sku = Array.isArray(l.sku) ? l.sku[0] : l.sku; // supabase nested select 호환
        return {
          lineId: l.id,
          marketplaceSku: l.marketplace_sku,
          internalSku: sku?.internal_sku || null,
          title: l.title,
          quantity: l.quantity,
          unitPrice: l.unit_price ? Number(l.unit_price) : null,
          currency: l.currency || o.currency || null,
          matchStatus: l.match_status,
          matchReason: l.match_reason || null,
          weightG: sku?.weight_gram != null ? Number(sku.weight_gram) : null,
          weightStatus: sku?.weight_status || 'unknown',
          shippingGroup: sku?.shipping_group || null,
        };
      });

      const missingSkus = lines.filter(l => l.weightG == null || !(l.weightG > 0));

      // 경고 계산 — 수동 수정값이 자동 계산 final_weight_g 와 50% 이상 차이
      const warnings = [];
      if (shipment?.isWeightOverridden && shipment.overriddenWeightG && shipment.finalWeightG) {
        const dev = Math.abs(shipment.overriddenWeightG - shipment.finalWeightG) / shipment.finalWeightG;
        if (dev >= WEIGHT_DEVIATION_WARNING_PCT) {
          warnings.push({
            code: 'large_weight_deviation',
            message: `수동 수정 무게(${shipment.overriddenWeightG}g) 가 자동 계산(${shipment.finalWeightG}g) 보다 ${Math.round(dev * 100)}% 차이`,
          });
        }
      }
      if (missingSkus.length > 0) {
        warnings.push({
          code: 'weight_input_required',
          message: `${missingSkus.length}개 SKU 의 무게가 등록되지 않음 — SKU 마스터에서 입력 필요`,
        });
      }

      return {
        orderId: o.id,
        marketplace: o.marketplace,
        externalOrderId: o.external_order_id,
        orderStatus: o.order_status,
        buyerCountry: o.buyer_country,
        buyerName: o.buyer_name,
        orderedAt: o.ordered_at,
        totalAmount: o.total_amount ? Number(o.total_amount) : null,
        currency: o.currency,
        lines,
        shipment,                // null 이면 미계산 상태
        missingSkus,
        warnings,
        needsCalc: !shipment,
      };
    });

    // 3) 필터 적용 (carrier / weight_status=missing)
    let filtered = rows;
    if (carrier) {
      filtered = filtered.filter(r => r.shipment?.recommendedCarrier === carrier);
    }
    if (weightFilter === 'missing') {
      filtered = filtered.filter(r => r.needsCalc || r.shipment?.recommendedCarrier === 'review' || r.missingSkus.length > 0);
    }

    // 4) 통계 — recommended_carrier 별 count
    const counts = {};
    let calculated = 0;
    let pending = 0;
    for (const r of filtered) {
      const key = r.shipment?.recommendedCarrier || 'pending';
      counts[key] = (counts[key] || 0) + 1;
      if (r.shipment) calculated++;
      else pending++;
    }

    res.json({
      filter: { days, status, carrier, weight_status: weightFilter, allowedStatuses: WMS_ALLOWED_STATUS },
      counts,
      summary: { total: filtered.length, calculated, pending },
      orders: filtered,
    });
  } catch (e) {
    console.error('[shipping/wms] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/shipping/recommendations/wms/:orderId/weight
//   주문별 무게 인라인 수정.
//   body: {
//     overriddenWeightG: number,   // 필수 — 적용할 무게 (g)
//     overrideReason: string?,     // 사유 (선택)
//     applyToMaster: boolean?,     // true 면 단일 SKU 주문에 한해 sku_master.weight_gram 까지 업데이트
//   }
router.patch('/wms/:orderId/weight', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);
    if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'orderId invalid' });

    const overriddenWeightG = Number(req.body?.overriddenWeightG);
    if (!Number.isFinite(overriddenWeightG) || overriddenWeightG <= 0) {
      return res.status(400).json({ error: 'overriddenWeightG 는 양수여야 합니다' });
    }
    const overrideReason = req.body?.overrideReason ? String(req.body.overrideReason).slice(0, 500) : null;
    const applyToMaster = req.body?.applyToMaster === true;

    // 1) override 저장
    const shipment = await orderShipmentRepo.setOverride({ orderId, overriddenWeightG, overrideReason });

    // 2) applyToMaster=true 시 — wms_order_lines 중 matched_sku_id 가 정확히 1개여야 안전하게 SKU 마스터 업데이트.
    //    다중 line 주문은 어느 SKU 에 반영해야 할지 모호 → 거절.
    let masterUpdate = null;
    if (applyToMaster) {
      const db = getClient();
      const { data: lines, error: e1 } = await db
        .from('wms_order_lines')
        .select('id, quantity, matched_sku_id')
        .eq('order_id', orderId);
      if (e1) throw e1;
      const matched = (lines || []).filter(l => l.matched_sku_id);
      if (matched.length !== 1) {
        masterUpdate = {
          ok: false,
          reason: matched.length === 0
            ? '매칭된 SKU 가 없어 마스터 반영 불가'
            : `다중 SKU 주문 — 마스터 반영은 단일 SKU 주문에서만 가능 (현재 ${matched.length}개)`,
        };
      } else {
        const line = matched[0];
        const qty = Number(line.quantity) || 1;
        // 마스터 반영 시 단품무게 = (override - packaging) / qty.
        // packaging 은 shipment.packagingWeightG 가 있으면 그 값, 아니면 50g fallback.
        const pkg = shipment?.packagingWeightG != null ? Number(shipment.packagingWeightG) : 50;
        const inferredItemWeight = Math.max(1, Math.round(((overriddenWeightG - pkg) / qty) * 100) / 100);
        const { data: updated, error: e2 } = await db
          .from('sku_master')
          .update({
            weight_gram: inferredItemWeight,
            weight_status: 'measured',
            updated_at: new Date().toISOString(),
          })
          .eq('id', line.matched_sku_id)
          .select('id, internal_sku, weight_gram, weight_status')
          .single();
        if (e2) {
          masterUpdate = { ok: false, reason: `sku_master 업데이트 실패: ${e2.message}` };
        } else {
          masterUpdate = {
            ok: true,
            sku: updated,
            inferredItemWeight,
            packagingApplied: pkg,
            qty,
          };
          await orderShipmentRepo.markMasterUpdated(orderId, true);
          // 캐시 무효화: 다른 주문의 무게 자동 계산도 새 마스터값으로 다시 잡혀야 함 — 후속 자동 재계산은 운영 트리거(POST /recalculate) 가 담당
        }
      }
    }

    // 3) 최신 shipment 반환 (markMasterUpdated 호출됐으면 그 값 반영)
    const finalShipment = await orderShipmentRepo.getByOrderId(orderId);
    res.json({ shipment: finalShipment, masterUpdate });
  } catch (e) {
    console.error('[shipping/wms/weight] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shipping/recommendations/wms/recalculate
//   body: { orderIds?: [...], days?: 14, all?: false }
//   - orderIds 우선. 없으면 days 안의 wms_orders 전체.
//   - 각 주문에 대해 calculateForOrder() 다시 호출 — 새 무게/추천/예상비로 갱신.
router.post('/wms/recalculate', async (req, res) => {
  try {
    const body = req.body || {};
    let ids = [];

    if (Array.isArray(body.orderIds) && body.orderIds.length > 0) {
      ids = body.orderIds.map(n => parseInt(n, 10)).filter(Number.isFinite);
    } else {
      const days = Math.max(1, Math.min(parseInt(body.days, 10) || 14, 90));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      const { data, error } = await getClient()
        .from('wms_orders').select('id').gte('ordered_at', sinceIso)
        .order('ordered_at', { ascending: false }).limit(200);
      if (error) throw error;
      ids = (data || []).map(r => r.id);
    }
    if (ids.length === 0) return res.json({ ran: 0, results: [] });

    const results = await shippingCalc.calculateForOrders(ids);
    const ok = results.filter(r => r.ok).length;
    const review = results.filter(r => !r.ok && !r.error).length;
    const errors = results.filter(r => r.error).length;
    res.json({
      ran: results.length,
      ok, review, errors,
      results: results.map(r => ({
        orderId: r.orderId,
        ok: r.ok,
        carrier: r.shipment?.recommendedCarrier || null,
        chargeable: r.shipment?.chargeableWeightG ?? null,
        missingSkuCount: (r.missingSkus || []).length,
        error: r.error || null,
      })),
    });
  } catch (e) {
    console.error('[shipping/wms/recalculate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
