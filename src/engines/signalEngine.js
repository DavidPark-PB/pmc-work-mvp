'use strict';

/**
 * Hermes Signal Engine v1.
 *
 * Converts a read-only SKU context into deterministic rule-based signals.
 * No AI calls, DB writes, or marketplace write APIs are used here.
 */

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInteger(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  const n = toNumber(value, 0);
  return Math.round(n * 100) / 100;
}

function roundPct(value) {
  const n = toNumber(value, 0);
  return Math.round(n * 100) / 100;
}

function makeSignal(type, severity, value, detectedAt) {
  return {
    type,
    severity,
    value: value || {},
    detected_at: detectedAt,
  };
}

function normalizeCompetitor(competitor) {
  const price = toNumber(competitor?.price, 0);
  const shipping = toNumber(competitor?.shipping, 0);
  const totalPrice = toNumber(competitor?.total_price, price + shipping);

  return {
    seller_id: competitor?.seller_id || '',
    listing_id: competitor?.listing_id || competitor?.ebay_item_id || competitor?.competitor_item_id || '',
    title: competitor?.title || '',
    price,
    shipping,
    total_price: totalPrice,
    status: competitor?.status || '',
  };
}

function activeLowerCompetitors(context) {
  const currentPrice = toNumber(context?.pricing?.current_price || context?.platforms?.ebay?.price, 0);
  if (currentPrice <= 0) return [];

  return (context?.competitors || [])
    .map(normalizeCompetitor)
    .filter(c => {
      const status = String(c.status || '').toLowerCase();
      const active = !status || ['active', 'in_stock', 'available'].includes(status);
      return active && c.total_price > 0 && c.total_price < currentPrice;
    })
    .sort((a, b) => a.total_price - b.total_price);
}

function listingQualityScore(context) {
  const ebay = context?.platforms?.ebay || {};
  const title = String(ebay.title || '').trim();
  let score = 100;
  const reasons = [];

  if (!ebay.listing_id) {
    score -= 40;
    reasons.push('missing_listing_id');
  }
  if (!title) {
    score -= 40;
    reasons.push('missing_title');
  } else if (title.length < 40) {
    score -= 20;
    reasons.push('short_title');
  }
  if (toNumber(ebay.price, 0) <= 0) {
    score -= 20;
    reasons.push('missing_or_zero_price');
  }
  if (String(ebay.status || '').toLowerCase() === 'ended') {
    score -= 30;
    reasons.push('ended_listing');
  }

  return {
    score: Math.max(0, score),
    reasons,
  };
}

function generateSignals(context, options = {}) {
  const detectedAt = options.detectedAt || new Date().toISOString();
  const signals = [];
  const available = toInteger(context?.inventory?.total_available, 0);
  const orders30d = toInteger(context?.sales?.orders_30d, 0);
  const units30d = toInteger(context?.sales?.units_30d, 0);
  const currentPrice = toNumber(context?.pricing?.current_price || context?.platforms?.ebay?.price, 0);

  if (available <= 0) {
    signals.push(makeSignal('stock_risk', 'critical', {
      available_quantity: available,
      stock_status: context?.inventory?.stock_status || 'unknown',
      reason: 'out_of_stock_or_unknown',
    }, detectedAt));
  } else if (available <= 2) {
    signals.push(makeSignal('stock_risk', 'warning', {
      available_quantity: available,
      stock_status: context?.inventory?.stock_status || 'unknown',
      reason: 'low_stock',
    }, detectedAt));
  }

  if (orders30d === 0) {
    signals.push(makeSignal('no_recent_sales', 'info', {
      window_days: 30,
      orders_30d: orders30d,
      units_30d: units30d,
    }, detectedAt));
  }

  if (available > 0 && orders30d === 0) {
    signals.push(makeSignal('dead_stock', 'warning', {
      available_quantity: available,
      window_days: 30,
      orders_30d: orders30d,
    }, detectedAt));
  }

  const lowerCompetitors = activeLowerCompetitors(context);
  if (lowerCompetitors.length > 0) {
    const lowest = lowerCompetitors[0];
    const gap = currentPrice - lowest.total_price;
    const gapPct = currentPrice > 0 ? (gap / currentPrice) * 100 : 0;

    signals.push(makeSignal('competitor_lower_price', 'watch', {
      current_price: roundMoney(currentPrice),
      lowest_competitor_total_price: roundMoney(lowest.total_price),
      gap_amount: roundMoney(gap),
      gap_pct: roundPct(gapPct),
      lower_competitor_count: lowerCompetitors.length,
      lowest_competitor: {
        seller_id: lowest.seller_id,
        listing_id: lowest.listing_id,
      },
    }, detectedAt));

    if (gapPct >= 15 || lowerCompetitors.length >= 3) {
      signals.push(makeSignal('price_attack', 'critical', {
        current_price: roundMoney(currentPrice),
        lowest_competitor_total_price: roundMoney(lowest.total_price),
        gap_amount: roundMoney(gap),
        gap_pct: roundPct(gapPct),
        lower_competitor_count: lowerCompetitors.length,
        trigger: gapPct >= 15 ? 'large_price_gap' : 'multiple_lower_competitors',
      }, detectedAt));
    }
  }

  if (context?.pricing?.needs_cost_data || context?.pricing?.estimated_margin_pct == null) {
    signals.push(makeSignal('missing_cost', 'info', {
      needs_cost_data: Boolean(context?.pricing?.needs_cost_data),
      estimated_margin_pct: context?.pricing?.estimated_margin_pct ?? null,
    }, detectedAt));
  }

  const quality = listingQualityScore(context);
  if (quality.score < 70) {
    signals.push(makeSignal('listing_quality_low', 'warning', {
      score: quality.score,
      reasons: quality.reasons,
    }, detectedAt));
  }

  return signals;
}

module.exports = {
  generateSignals,
  listingQualityScore,
};
