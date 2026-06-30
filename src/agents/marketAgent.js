'use strict';

/**
 * Hermes Market Agent v1.
 *
 * Reads SKU Context, gates Claude usage by price signals, and sends only a
 * compact signal/price payload to AI. This module performs no writes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { buildSkuContext } = require('../services/skuContextBuilder');

const CLAUDE_MODEL = 'claude-haiku-4-5';
const PRICE_SIGNAL_TYPES = new Set(['competitor_lower_price', 'price_attack']);
const VALID_RECOMMENDATIONS = new Set(['lower_price', 'hold', 'raise_price']);

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function roundPct(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function priceSignals(signals) {
  return (signals || []).filter(signal => PRICE_SIGNAL_TYPES.has(signal?.type));
}

function hasPriceSignal(signals) {
  return priceSignals(signals).length > 0;
}

function activeCompetitors(context) {
  return (context?.competitors || [])
    .map(c => {
      const price = toNumber(c?.price, 0);
      const shipping = toNumber(c?.shipping, 0);
      return {
        total_price: toNumber(c?.total_price, price + shipping),
        status: String(c?.status || '').toLowerCase(),
      };
    })
    .filter(c => {
      const active = !c.status || ['active', 'in_stock', 'available'].includes(c.status);
      return active && c.total_price > 0;
    });
}

function valueFromSignal(signals, field) {
  for (const signal of priceSignals(signals)) {
    if (signal?.value?.[field] != null) return signal.value[field];
  }
  return null;
}

function lowestCompetitorPrice(context, signals) {
  const fromSignal = valueFromSignal(signals, 'lowest_competitor_total_price');
  if (fromSignal != null) return roundMoney(fromSignal);

  const competitors = activeCompetitors(context);
  if (competitors.length === 0) return 0;
  return roundMoney(Math.min(...competitors.map(c => c.total_price)));
}

function competitorCount(context, signals) {
  const fromSignal = valueFromSignal(signals, 'lower_competitor_count');
  if (fromSignal != null) return Math.max(0, Math.trunc(toNumber(fromSignal, 0)));
  return activeCompetitors(context).length;
}

function priceGapPct(currentPrice, lowestPrice) {
  if (currentPrice <= 0 || lowestPrice <= 0) return 0;
  return roundPct(((currentPrice - lowestPrice) / currentPrice) * 100);
}

function pricePosition(currentPrice, lowestPrice) {
  if (currentPrice <= 0 || lowestPrice <= 0) return 'at_market';
  const gap = ((currentPrice - lowestPrice) / currentPrice) * 100;
  if (gap > 1) return 'above_market';
  if (gap < -1) return 'below_market';
  return 'at_market';
}

function compactSignals(signals) {
  return (signals || []).map(signal => ({
    type: signal.type,
    severity: signal.severity,
    value: signal.value || {},
    detected_at: signal.detected_at,
  }));
}

function extractMarketFacts(context) {
  const signals = context?.signals || [];
  const currentPrice = roundMoney(context?.pricing?.current_price || context?.platforms?.ebay?.price || 0);
  const lowestPrice = lowestCompetitorPrice(context, signals);
  const gapPct = priceGapPct(currentPrice, lowestPrice);

  return {
    sku: String(context?.sku || ''),
    signals,
    aiSignals: compactSignals(signals),
    currentPrice,
    lowestCompetitorPrice: lowestPrice,
    priceGapPct: gapPct,
    competitorCount: competitorCount(context, signals),
    pricePosition: pricePosition(currentPrice, lowestPrice),
    shouldCallAi: hasPriceSignal(signals),
  };
}

function baseAnalysis(facts, recommendation, reasoning, source) {
  return {
    sku: facts.sku,
    market_analysis: {
      price_position: facts.pricePosition,
      competitor_count: facts.competitorCount,
      lowest_competitor_price: facts.lowestCompetitorPrice,
      price_gap_pct: facts.priceGapPct,
      recommendation,
      reasoning,
      source,
    },
  };
}

function createClaudeClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function stripJsonBlock(text) {
  return String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

function normalizeAiResult(parsed) {
  const recommendation = VALID_RECOMMENDATIONS.has(parsed?.recommendation)
    ? parsed.recommendation
    : 'hold';

  return {
    recommendation,
    reasoning: String(parsed?.reasoning || 'Claude returned no reasoning.').slice(0, 1000),
  };
}

function extractClaudeText(response) {
  return (response?.content || [])
    .map(part => part?.text || '')
    .join('\n')
    .trim();
}

async function callClaudeMarketAnalysis(facts, options = {}) {
  const client = options.claudeClient || createClaudeClient();
  const payload = {
    signals: facts.aiSignals,
    current_price: facts.currentPrice,
    lowest_competitor_price: facts.lowestCompetitorPrice,
    price_gap_pct: facts.priceGapPct,
  };

  const userPrompt = [
    'Analyze this compact marketplace signal payload.',
    'Return only JSON with this shape:',
    '{"recommendation":"lower_price|hold|raise_price","reasoning":"short explanation"}',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: [
      'You are a cautious marketplace pricing analyst.',
      'Use only the provided signals and price fields.',
      'Do not suggest automatic writes or marketplace changes.',
      'Choose exactly one recommendation: lower_price, hold, or raise_price.',
    ].join(' '),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = stripJsonBlock(extractClaudeText(response));
  return normalizeAiResult(JSON.parse(raw));
}

async function analyzeMarketContext(context, options = {}) {
  const facts = extractMarketFacts(context);

  if (!facts.shouldCallAi) {
    return baseAnalysis(
      facts,
      'hold',
      'No competitor_lower_price or price_attack signal was detected, so the Market Agent skipped AI and held the price.',
      'rule_based',
    );
  }

  const aiResult = await callClaudeMarketAnalysis(facts, options);
  return baseAnalysis(facts, aiResult.recommendation, aiResult.reasoning, 'ai');
}

async function runMarketAgent({ sku }, options = {}) {
  const targetSku = String(sku || '').trim();
  if (!targetSku) throw new Error('sku is required');

  const context = await buildSkuContext({ sku: targetSku });
  return analyzeMarketContext(context, options);
}

module.exports = {
  CLAUDE_MODEL,
  PRICE_SIGNAL_TYPES,
  analyzeMarketContext,
  callClaudeMarketAnalysis,
  extractMarketFacts,
  hasPriceSignal,
  runMarketAgent,
};
