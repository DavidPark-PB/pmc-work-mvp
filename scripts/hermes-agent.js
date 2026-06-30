#!/usr/bin/env node
'use strict';

/**
 * Hermes Agent CLI.
 *
 * Examples:
 *   node scripts/hermes-agent.js market --sku=202551129453
 *   node scripts/hermes-agent.js opportunity --sku=202551129453
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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
    '  npm run hermes:agent -- market --sku=<SKU>',
    '  npm run hermes:agent -- opportunity --sku=<SKU>',
    '  npm run hermes:agent -- opportunity-write --sku=<SKU> --dry-run',
    '  npm run hermes:agent -- opportunity-write --sku=<SKU> --write',
    '  npm run hermes:agent -- opportunity-list [--sku=<SKU>] [--status=new] [--opportunity_type=<TYPE>] [--limit=20]',
    '',
    'Hermes agents are read-only unless explicitly documented otherwise.',
    'Phase 2C Opportunity Writer: default dry-run; writes only with --write; no marketplace writes, price changes, or AI calls.',
  ].join('\n'));
}

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();

  if (cmd === 'market') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }

    const { runMarketAgent } = require('../src/agents/marketAgent');
    const result = await runMarketAgent({ sku });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }

    const { runOpportunityAgent } = require('../src/agents/opportunityAgent');
    const result = await runOpportunityAgent({ sku });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-write') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }
    const dryRun = !hasFlag('write');

    const { runOpportunityWriteAgent } = require('../src/agents/opportunityAgent');
    const result = await runOpportunityWriteAgent({ sku, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-list') {
    const { listHermesOpportunities } = require('../src/services/opportunityInbox');
    const result = await listHermesOpportunities({
      sku: arg('sku', null),
      status: arg('status', null),
      opportunity_type: arg('opportunity_type', arg('type', null)),
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  throw new Error(`Unsupported command: ${cmd || '(missing)'}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
