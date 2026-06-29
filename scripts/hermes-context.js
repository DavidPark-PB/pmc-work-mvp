#!/usr/bin/env node
'use strict';

/**
 * Hermes SKU Context CLI.
 *
 * Examples:
 *   node scripts/hermes-context.js sku 202551129453
 *   node scripts/hermes-context.js sample --limit=5
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
    '  npm run hermes:context -- sku <SKU>',
    '  npm run hermes:context -- sample --limit=5',
    '',
    'Phase 1B is read-only: output is SKU Context JSON; no DB writes.',
  ].join('\n'));
}

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  const builder = require('../src/services/skuContextBuilder');

  if (cmd === 'sku') {
    const sku = process.argv[3];
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }
    const result = await builder.buildSkuContext({ sku });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'sample') {
    const limit = intArg('limit', 5);
    const result = await builder.buildSkuContexts({ limit });
    console.log(JSON.stringify({ count: result.length, data: result }, null, 2));
    return;
  }

  printUsage();
  throw new Error(`Unsupported command: ${cmd || '(missing)'}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
