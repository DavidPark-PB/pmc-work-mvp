#!/usr/bin/env node
'use strict';

/**
 * Hermes Recommendation Engine CLI.
 *
 * Examples:
 *   node scripts/hermes-recommendations.js --sku=202551129453
 *   node scripts/hermes-recommendations.js sample --limit=5
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name, fallback = null) {
  const value = arg(name, null);
  if (value == null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printUsage() {
  console.error([
    'Usage:',
    '  npm run hermes:recommendations -- --sku=<SKU>',
    '  npm run hermes:recommendations -- sample --limit=5',
    '',
    'Phase 2A is read-only: output is Recommendation Engine JSON; no DB writes, marketplace writes, AI calls, or automatic actions.',
  ].join('\n'));
}

function pickRecommendationOutput(context) {
  return {
    sku: context.sku,
    recommendations: context.recommendations || [],
    recommendation_count: Array.isArray(context.recommendations) ? context.recommendations.length : 0,
    signals: context.signals || [],
    signal_count: Array.isArray(context.signals) ? context.signals.length : 0,
    raw_refs: context.raw_refs,
  };
}

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  const sku = arg('sku', null);
  const builder = require('../src/services/skuContextBuilder');

  if (sku) {
    const context = await builder.buildSkuContext({ sku });
    console.log(JSON.stringify(pickRecommendationOutput(context), null, 2));
    return;
  }

  if (cmd === 'sample') {
    const limit = intArg('limit', 5);
    const contexts = await builder.buildSkuContexts({ limit });
    const data = contexts.map(pickRecommendationOutput);
    console.log(JSON.stringify({ count: data.length, data }, null, 2));
    return;
  }

  printUsage();
  throw new Error(`Unsupported command: ${cmd || '(missing)'}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
