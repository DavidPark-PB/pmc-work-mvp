#!/usr/bin/env node
'use strict';

/**
 * Hermes Signal Engine CLI.
 *
 * Examples:
 *   node scripts/hermes-signals.js --sku=202551129453
 *   node scripts/hermes-signals.js sample --limit=5
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
    '  npm run hermes:signals -- --sku=<SKU>',
    '  npm run hermes:signals -- sample --limit=5',
    '',
    'Phase 1C is read-only: output is Signal Engine JSON; no DB writes and no marketplace writes.',
  ].join('\n'));
}

function pickSignalOutput(context) {
  return {
    sku: context.sku,
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
    console.log(JSON.stringify(pickSignalOutput(context), null, 2));
    return;
  }

  if (cmd === 'sample') {
    const limit = intArg('limit', 5);
    const contexts = await builder.buildSkuContexts({ limit });
    const data = contexts.map(pickSignalOutput);
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
