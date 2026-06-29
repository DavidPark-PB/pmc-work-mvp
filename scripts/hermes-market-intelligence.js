#!/usr/bin/env node
'use strict';

/**
 * Manual Hermes v1 Market Intelligence runner.
 *
 * Examples:
 *   node scripts/hermes-market-intelligence.js alerts --hours=24 --telegram
 *   node scripts/hermes-market-intelligence.js daily --hours=24 --telegram
 *   node scripts/hermes-market-intelligence.js product --days=30 --telegram
 *   node scripts/hermes-market-intelligence.js listing --days=30 --telegram
 *   node scripts/hermes-market-intelligence.js sync
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const market = require('../src/services/hermesMarketIntelligence');
const productIntel = require('../src/services/hermesProductIntelligence');
const listingIntel = require('../src/services/hermesListingIntelligence');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function has(flag) { return process.argv.includes(`--${flag}`); }

async function main() {
  const cmd = process.argv[2] || 'daily';
  const hours = parseInt(arg('hours', '24'), 10) || 24;
  const days = parseInt(arg('days', '30'), 10) || 30;
  const sendTelegram = has('telegram');

  if (cmd === 'sync') {
    const my = await market.syncMyListingsSnapshot();
    const mappings = await market.syncSkuMappingsFromProductMatches();
    console.log(JSON.stringify({ my, mappings }, null, 2));
    return;
  }

  if (cmd === 'alerts') {
    const result = await market.generateMarketAlerts({ hours, sendTelegram });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'daily') {
    const result = await market.runDailyReport({ hours, sendTelegram });
    console.log(result.report.markdown);
    return;
  }

  if (cmd === 'product') {
    const result = await productIntel.runProductIntelligence({ days, sendTelegram });
    console.log(result.report.markdown);
    return;
  }

  if (cmd === 'listing') {
    const result = await listingIntel.runListingIntelligence({ days, sendTelegram });
    console.log(result.report.markdown);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
