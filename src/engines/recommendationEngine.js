'use strict';

/**
 * Hermes Recommendation Engine v1.
 *
 * Converts SKU Context + Signal Engine output into deterministic recommendations.
 * This module consumes context.signals; it does not generate signals.
 * No AI calls, DB writes, marketplace writes, or automatic actions are used here.
 */

const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function signalTypes(context) {
  return new Set((context?.signals || []).map(s => s?.type).filter(Boolean));
}

function signalsOf(context, types) {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  return (context?.signals || []).filter(s => wanted.has(s?.type));
}

function signalValue(context, type) {
  const signal = (context?.signals || []).find(s => s?.type === type);
  return signal?.value || {};
}

function makeRecommendation(type, priority, reason, sourceSignals, suggestedAction, createdAt) {
  return {
    type,
    priority,
    reason,
    source_signals: sourceSignals,
    suggested_action: suggestedAction,
    requires_human_review: true,
    created_at: createdAt,
  };
}

function sortRecommendations(recommendations) {
  return [...recommendations].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.type.localeCompare(b.type);
  });
}

function generateRecommendations(context, options = {}) {
  const createdAt = options.createdAt || new Date().toISOString();
  const types = signalTypes(context);
  const recommendations = [];

  if (types.has('stock_risk')) {
    const stockSignals = signalsOf(context, 'stock_risk');
    const critical = stockSignals.some(s => s?.severity === 'critical');
    const value = signalValue(context, 'stock_risk');
    recommendations.push(makeRecommendation(
      'restock_review',
      critical ? 'critical' : 'high',
      `Inventory risk detected for SKU ${context?.sku || '(unknown)'}: available quantity is ${value.available_quantity ?? 'unknown'}.`,
      ['stock_risk'],
      'Review current stock, supplier availability, and restock timing before taking any inventory action.',
      createdAt,
    ));
  }

  if (types.has('dead_stock')) {
    const value = signalValue(context, 'dead_stock');
    recommendations.push(makeRecommendation(
      'dead_stock_review',
      'medium',
      `SKU has ${value.available_quantity ?? 'available'} units available but no recent orders in the ${value.window_days || 30}-day window.`,
      ['dead_stock', ...(types.has('no_recent_sales') ? ['no_recent_sales'] : [])],
      'Review sell-through, listing attractiveness, inventory age, and promotion/clearance options. Do not change price automatically.',
      createdAt,
    ));
  } else if (types.has('no_recent_sales')) {
    recommendations.push(makeRecommendation(
      'dead_stock_review',
      'low',
      'No recent sales were detected in the 30-day window.',
      ['no_recent_sales'],
      'Review whether the SKU needs listing improvements, demand validation, or monitoring only.',
      createdAt,
    ));
  }

  if (types.has('listing_quality_low')) {
    const value = signalValue(context, 'listing_quality_low');
    const reasons = Array.isArray(value.reasons) && value.reasons.length > 0 ? value.reasons.join(', ') : 'low listing quality score';
    recommendations.push(makeRecommendation(
      'listing_quality_review',
      'medium',
      `Listing quality score is ${value.score ?? 'low'} due to: ${reasons}.`,
      ['listing_quality_low'],
      'Review title, listing data completeness, price presence, and listing status. Prepare improvements for human approval.',
      createdAt,
    ));
  }

  if (types.has('missing_cost')) {
    recommendations.push(makeRecommendation(
      'cost_data_required',
      'medium',
      'Cost or margin data is missing, so margin-aware recommendations cannot be trusted yet.',
      ['missing_cost'],
      'Add or verify SKU cost data before approving price, margin, or promotion decisions.',
      createdAt,
    ));
  }

  if (types.has('competitor_lower_price')) {
    const value = signalValue(context, 'competitor_lower_price');
    recommendations.push(makeRecommendation(
      'competition_watch',
      'medium',
      `${value.lower_competitor_count ?? 'One or more'} mapped competitor listing(s) are below current price by up to ${value.gap_pct ?? 'unknown'}%.`,
      ['competitor_lower_price'],
      'Monitor competitor listing details and verify SKU match confidence before any price or listing response.',
      createdAt,
    ));
  }

  if (types.has('price_attack')) {
    const value = signalValue(context, 'price_attack');
    recommendations.push(makeRecommendation(
      'urgent_price_attack_review',
      'critical',
      `Potential price attack detected: lowest competitor total price is ${value.gap_pct ?? 'unknown'}% below current price.`,
      ['price_attack', ...(types.has('competitor_lower_price') ? ['competitor_lower_price'] : [])],
      'Urgently review competitor validity, margin floor, and response options. Human approval is required before any action.',
      createdAt,
    ));
  }

  if (types.has('competitor_lower_price') || types.has('price_attack') || types.has('missing_cost')) {
    const sourceSignals = [];
    if (types.has('price_attack')) sourceSignals.push('price_attack');
    if (types.has('competitor_lower_price')) sourceSignals.push('competitor_lower_price');
    if (types.has('missing_cost')) sourceSignals.push('missing_cost');
    recommendations.push(makeRecommendation(
      'price_or_margin_review',
      types.has('price_attack') ? 'high' : 'medium',
      'Pricing or margin review is needed because competitive price pressure or incomplete cost data is present.',
      sourceSignals,
      'Review current price, competitor total price, cost data, and margin floor. Create only a human-reviewed recommendation, not an automatic price change.',
      createdAt,
    ));
  }

  return sortRecommendations(recommendations);
}

module.exports = {
  generateRecommendations,
};
