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
 */
async function lookupSkuMasterMap(skus) {
  const unique = [...new Set(skus.filter(s => s && String(s).trim()).map(s => String(s).trim()))];
  if (unique.length === 0) return new Map();
  const { data, error } = await getClient().from('sku_master')
    .select('internal_sku, title, weight_gram, status')
    .in('internal_sku', unique);
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) map.set(r.internal_sku, r);
  return map;
}

// 캐리어 순서대로 정렬할 group helper
function _initialGroups() {
  const order = [
    recommender.CARRIERS.KOREA_POST,
    recommender.CARRIERS.SHIPTER,
    recommender.CARRIERS.KPL,
    recommender.CARRIERS.FEDEX,
    recommender.CARRIERS.YUN_EXPRESS,
    recommender.CARRIERS.K_PACKET,
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
    const skus = orders.map(o => o.sku);
    const skuMap = await lookupSkuMasterMap(skus);

    const groups = _initialGroups();
    const carrierIndex = new Map();
    for (let i = 0; i < groups.length; i++) carrierIndex.set(groups[i].carrier.key, i);

    for (const o of orders) {
      const matched = skuMap.get(o.sku ? String(o.sku).trim() : '');
      const matchInfo = recommender.buildMatchInfo(o.sku, matched);
      const weightGram = matched ? matched.weight_gram : null;
      const countryCode = o.country_code || null;

      const rec = recommender.recommend({ weightGram, countryCode, matchInfo });

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
        internal_sku:   matched ? matched.internal_sku : null,
        matched:        !!matched,
        match_attempt:  matchInfo.attemptedSku || '',
        match_reason:   matchInfo.reason || null,
        recommendation: {
          carrier_key:  rec.carrier?.key,
          carrier_label: rec.carrier?.label,
          carrier_color: rec.carrier?.color,
          reason:       rec.reason,
          review:       rec.review || null,
        },
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

module.exports = router;
