'use strict';

/**
 * Hermes Opportunity Candidate Builder v1.
 *
 * Converts SKU Context, Signal Engine output, Recommendation Engine output, and
 * Market Agent-style analysis into deterministic opportunity candidates.
 * No AI calls, DB writes, marketplace writes, price changes, or automatic actions.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { buildSkuContext } = require('../services/skuContextBuilder');
const { writeOpportunityCandidates } = require('../services/opportunityInbox');
const { extractMarketFacts } = require('./marketAgent');

const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const RECOMMENDATION_TO_OPPORTUNITY = {
  restock_review: 'inventory_restock_review',
  dead_stock_review: 'dead_stock_review',
  listing_quality_review: 'listing_quality_review',
  price_or_margin_review: 'price_or_margin_review',
  cost_data_required: 'cost_data_completion',
  competition_watch: 'competition_watch',
  urgent_price_attack_review: 'urgent_price_attack_review',
};

function normalizePriority(priority) {
  const value = String(priority || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, value) ? value : 'medium';
}

function sourceSignalTypes(recommendation) {
  return Array.isArray(recommendation?.source_signals)
    ? recommendation.source_signals.filter(Boolean)
    : [];
}

function sourceRecommendationTypes(recommendations) {
  return (recommendations || []).map(r => r?.type).filter(Boolean);
}

function recommendationTitle(type, sku) {
  const labels = {
    restock_review: 'Restock review needed',
    dead_stock_review: 'Dead stock review needed',
    listing_quality_review: 'Listing quality review needed',
    price_or_margin_review: 'Price or margin review needed',
    cost_data_required: 'Cost data required',
    competition_watch: 'Competition watch needed',
    urgent_price_attack_review: 'Urgent price attack review needed',
  };
  return `${labels[type] || 'Opportunity review needed'} for SKU ${sku}`;
}

function toMarketAnalysis(marketOutput = {}, context = {}) {
  if (marketOutput && marketOutput.market_analysis && typeof marketOutput.market_analysis === 'object') {
    return marketOutput.market_analysis;
  }

  const facts = extractMarketFacts(context);
  return {
    price_position: facts.pricePosition,
    competitor_count: facts.competitorCount,
    lowest_competitor_price: facts.lowestCompetitorPrice,
    price_gap_pct: facts.priceGapPct,
    recommendation: 'hold',
    reasoning: facts.shouldCallAi
      ? 'Price signal exists, but Opportunity Candidate Builder v1 does not call AI. Human review is required.'
      : 'No price pressure signal required Market Agent AI analysis. Rule-based market summary only.',
    source: 'rule_based_no_ai',
  };
}

function makeCandidate({ sku, type, priority, title, reason, sourceSignals, sourceRecommendations, marketAnalysis, createdAt }) {
  return {
    sku,
    type,
    priority: normalizePriority(priority),
    title,
    reason,
    source_signals: sourceSignals || [],
    source_recommendations: sourceRecommendations || [],
    market_analysis: marketAnalysis || {},
    requires_human_review: true,
    created_at: createdAt,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = `${candidate.sku}:${candidate.type}:${candidate.source_recommendations.join(',')}:${candidate.source_signals.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.type.localeCompare(b.type);
  });
}

function generateOpportunityCandidates({ context, marketOutput = {}, marketAnalysis = null } = {}, options = {}) {
  const sku = String(context?.sku || '').trim();
  if (!sku) throw new Error('context.sku is required');

  const createdAt = options.createdAt || new Date().toISOString();
  const analysis = marketAnalysis || toMarketAnalysis(marketOutput, context);
  const recommendations = Array.isArray(context?.recommendations) ? context.recommendations : [];
  const candidates = [];

  for (const recommendation of recommendations) {
    const recType = recommendation?.type;
    const opportunityType = RECOMMENDATION_TO_OPPORTUNITY[recType];
    if (!opportunityType) continue;

    candidates.push(makeCandidate({
      sku,
      type: opportunityType,
      priority: recommendation.priority,
      title: recommendationTitle(recType, sku),
      reason: recommendation.reason || recommendation.suggested_action || `Recommendation ${recType} requires review.`,
      sourceSignals: sourceSignalTypes(recommendation),
      sourceRecommendations: [recType],
      marketAnalysis: analysis,
      createdAt,
    }));
  }

  const recommendationTypes = new Set(sourceRecommendationTypes(recommendations));
  const signalTypes = new Set((context?.signals || []).map(s => s?.type).filter(Boolean));

  if (signalTypes.has('price_attack') && !recommendationTypes.has('urgent_price_attack_review')) {
    candidates.push(makeCandidate({
      sku,
      type: 'urgent_price_attack_review',
      priority: 'critical',
      title: `Urgent price attack review needed for SKU ${sku}`,
      reason: 'A price_attack signal exists and requires immediate human review before any response.',
      sourceSignals: ['price_attack'],
      sourceRecommendations: [],
      marketAnalysis: analysis,
      createdAt,
    }));
  }

  if (signalTypes.has('competitor_lower_price') && !recommendationTypes.has('competition_watch')) {
    candidates.push(makeCandidate({
      sku,
      type: 'competition_watch',
      priority: 'medium',
      title: `Competition watch needed for SKU ${sku}`,
      reason: 'A competitor_lower_price signal exists and should be reviewed for match validity and competitive pressure.',
      sourceSignals: ['competitor_lower_price'],
      sourceRecommendations: [],
      marketAnalysis: analysis,
      createdAt,
    }));
  }

  return sortCandidates(dedupeCandidates(candidates));
}

async function runOpportunityAgent({ sku, marketOutput = null } = {}, options = {}) {
  const targetSku = String(sku || '').trim();
  if (!targetSku) throw new Error('sku is required');

  const context = await buildSkuContext({ sku: targetSku, readOnly: true });
  const resolvedMarketOutput = marketOutput || {
    sku: targetSku,
    market_analysis: toMarketAnalysis({}, context),
  };
  const candidates = generateOpportunityCandidates({
    context,
    marketOutput: resolvedMarketOutput,
  }, options);

  return {
    sku: targetSku,
    count: candidates.length,
    candidates,
    context_summary: {
      signal_count: Array.isArray(context.signals) ? context.signals.length : 0,
      recommendation_count: Array.isArray(context.recommendations) ? context.recommendations.length : 0,
      raw_refs: context.raw_refs || {},
    },
  };
}

async function runOpportunityWriteAgent({ sku, dryRun = true } = {}, options = {}) {
  const targetSku = String(sku || '').trim();
  if (!targetSku) throw new Error('sku is required');

  const opportunityResult = await runOpportunityAgent({ sku: targetSku }, options);
  const writeResult = await writeOpportunityCandidates({
    sku: targetSku,
    candidates: opportunityResult.candidates,
    dryRun,
  });

  return writeResult;
}

module.exports = {
  RECOMMENDATION_TO_OPPORTUNITY,
  generateOpportunityCandidates,
  runOpportunityAgent,
  runOpportunityWriteAgent,
  toMarketAnalysis,
};
