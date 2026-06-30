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

function printUsage() {
  console.error([
    'Usage:',
    '  npm run hermes:agent -- market --sku=<SKU>',
    '  npm run hermes:agent -- opportunity --sku=<SKU>',
    '',
    'Hermes agents are read-only unless explicitly documented otherwise.',
    'Phase 2B Opportunity Agent: no DB writes, no marketplace writes, no price changes, and no AI calls.',
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

  printUsage();
  throw new Error(`Unsupported command: ${cmd || '(missing)'}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
