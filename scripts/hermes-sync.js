#!/usr/bin/env node
'use strict';

/**
 * Hermes Platform Sync CLI.
 *
 * Examples:
 *   node scripts/hermes-sync.js ebay products --limit=5
 *   node scripts/hermes-sync.js ebay orders --days=30 --limit=5
 *   node scripts/hermes-sync.js ebay inventory --limit=5
 *   node scripts/hermes-sync.js ebay all --days=30 --limit=5
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
    '  npm run hermes:sync -- ebay products [--limit=5]',
    '  npm run hermes:sync -- ebay orders --days=30 [--limit=5]',
    '  npm run hermes:sync -- ebay inventory [--limit=5]',
    '  npm run hermes:sync -- ebay all --days=30 [--limit=5]',
    '',
    'Phase 1A is read-only: output is canonical JSON; no DB writes.',
  ].join('\n'));
}

async function main() {
  const platform = (process.argv[2] || '').toLowerCase();
  const resource = (process.argv[3] || '').toLowerCase();
  const days = intArg('days', 30);
  const limit = intArg('limit', null);

  if (platform !== 'ebay') {
    printUsage();
    throw new Error(`Unsupported platform: ${platform || '(missing)'}`);
  }

  const ebay = require('../src/connectors/ebay');
  let result;

  if (resource === 'products') {
    result = await ebay.syncProducts({ limit });
  } else if (resource === 'orders') {
    result = await ebay.syncOrders({ days, limit });
  } else if (resource === 'inventory') {
    result = await ebay.syncInventory({ limit });
  } else if (resource === 'all') {
    result = await ebay.syncAll({ days, limit });
  } else {
    printUsage();
    throw new Error(`Unsupported resource: ${resource || '(missing)'}`);
  }

  console.log(JSON.stringify({ platform, resource, count: Array.isArray(result) ? result.length : undefined, data: result }, null, 2));
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
