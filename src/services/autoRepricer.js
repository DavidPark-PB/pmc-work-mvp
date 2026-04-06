'use strict';

const { getClient } = require('../db/supabaseClient');

const MY_SHIPPING = 3.90;
const KILL_PRICE_UNDERCUT = 2.00;
const MAX_DAILY_CHANGES = 50;
const MAX_PRICE_DROP_PCT = 30;
const DEFAULT_FLOOR_PCT = 60; // Floor = 60% of current price if not set
const COMPETITOR_CRASH_THRESHOLD = 50; // Skip if competitor dropped >50%

/**
 * Auto Repricer — safe automatic price adjustment
 * @param {boolean} dryRun - true = simulate only, false = actually change prices
 */
async function runAutoRepricer(dryRun = true) {
  const db = getClient();
  const EbayAPI = require('../api/ebayAPI');
  const ebay = new EbayAPI();
  const report = { processed: 0, changed: 0, skipped: [], errors: [], changes: [], mode: dryRun ? 'dry_run' : 'live' };

  console.log(`[AutoRepricer] Starting (${dryRun ? 'DRY RUN' : 'LIVE'})...`);

  // 1. Get all active competitors with item IDs
  let compRows = [];
  let from = 0;
  while (true) {
    const { data } = await db.from('competitor_prices')
      .select('sku, competitor_id, competitor_price, competitor_shipping, prev_price, seller_id, status')
      .neq('competitor_id', '')
      .not('competitor_id', 'is', null)
      .eq('status', 'active')
      .gt('competitor_price', 0)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    compRows = compRows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  if (compRows.length === 0) {
    console.log('[AutoRepricer] No active competitors found');
    return report;
  }

  // Group by SKU — cheapest competitor per SKU
  const compBySku = {};
  compRows.forEach(c => {
    const total = parseFloat(c.competitor_price) + parseFloat(c.competitor_shipping || 0);
    if (!compBySku[c.sku] || total < compBySku[c.sku].total) {
      compBySku[c.sku] = { ...c, total };
    }
  });

  console.log(`[AutoRepricer] ${Object.keys(compBySku).length} SKUs with competitors`);

  // 1.5. Load target seller tiers for custom undercuts
  const tierUndercuts = { F: 3.00, D: 2.00, C: 1.00, B: 0.50, A: 0 };
  const sellerTiers = {};
  try {
    const { data: tiers } = await db.from('target_sellers').select('seller_name, tier, undercut');
    (tiers || []).forEach(t => { sellerTiers[t.seller_name] = { tier: t.tier, undercut: t.undercut || tierUndercuts[t.tier] || KILL_PRICE_UNDERCUT }; });
    console.log(`[AutoRepricer] ${Object.keys(sellerTiers).length} target sellers loaded`);
  } catch (e) { /* table might not exist */ }

  // 2. Get my eBay listings
  let myListings = [];
  for (let page = 1; page <= 25; page++) {
    const result = await ebay.getActiveListings(page, 200);
    if (!result.items || result.items.length === 0) break;
    myListings = myListings.concat(result.items);
    if (!result.hasMore) break;
  }

  // Build lookup: sku/itemId → listing
  const myBySku = {};
  myListings.forEach(item => {
    const key = item.sku || item.itemId;
    if (key) myBySku[key] = item;
    if (item.itemId) myBySku[item.itemId] = item;
  });

  // 3. Check daily limit
  const today = new Date().toISOString().slice(0, 10);
  let todayChanges = 0;
  try {
    const { count } = await db.from('repricer_log')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'applied')
      .gte('created_at', today + 'T00:00:00Z');
    todayChanges = count || 0;
  } catch (e) { /* table might not exist */ }

  if (todayChanges >= MAX_DAILY_CHANGES && !dryRun) {
    console.log(`[AutoRepricer] Daily limit reached (${todayChanges}/${MAX_DAILY_CHANGES})`);
    report.skipped.push({ reason: 'daily_limit', count: todayChanges });
    return report;
  }

  // 4. Process each SKU with competitor
  for (const [sku, comp] of Object.entries(compBySku)) {
    if (!dryRun && report.changed >= MAX_DAILY_CHANGES - todayChanges) {
      report.skipped.push({ sku, reason: 'daily_limit_reached' });
      break;
    }

    report.processed++;
    const myItem = myBySku[sku];
    if (!myItem) continue; // No matching listing

    const myPrice = parseFloat(myItem.price) || 0;
    const myTotal = myPrice + MY_SHIPPING;
    const compTotal = comp.total;

    // Check if we're winning or losing
    const diff = myTotal - compTotal;
    const isLosing = diff > 0;
    const isWinning = diff < 0;

    // === FOLLOW-UP: 경쟁사 가격 인상 시 따라 올리기 ===
    if (isWinning && comp.prev_price && comp.prev_price > 0) {
      const prevCompTotal = parseFloat(comp.prev_price) + parseFloat(comp.competitor_shipping || 0);
      const compRaised = compTotal > prevCompTotal; // 경쟁사가 가격을 올렸는가?

      if (compRaised) {
        // 경쟁사가 올렸으면 나도 따라 올림 (경쟁사 - undercut)
        const sellerInfo2 = sellerTiers[comp.seller_id] || null;
        const undercut2 = sellerInfo2 ? sellerInfo2.undercut : KILL_PRICE_UNDERCUT;
        const raisePrice = Math.max(myPrice, +(compTotal - undercut2 - MY_SHIPPING).toFixed(2));

        // 현재보다 높을 때만 올림 (내리는 건 아래 킬프라이스에서 처리)
        if (raisePrice > myPrice) {
          const maxRaise = +(myPrice * 1.30).toFixed(2); // 최대 30% 인상 제한
          const finalRaise = Math.min(raisePrice, maxRaise);

          const change = {
            itemId: myItem.itemId, sku,
            title: (myItem.title || '').slice(0, 50),
            oldPrice: myPrice, newPrice: finalRaise,
            myOldTotal: myTotal, myNewTotal: +(finalRaise + MY_SHIPPING).toFixed(2),
            compTotal, competitorSeller: comp.seller_id || '',
            saving: +(finalRaise - myPrice).toFixed(2),
            action: 'raise', // 인상
            reason: `경쟁사 인상 ($${prevCompTotal.toFixed(2)}→$${compTotal.toFixed(2)})`,
          };

          if (dryRun) {
            change.status = 'dry_run';
            report.changes.push(change);
            report.changed++;
          } else if (report.changed < MAX_DAILY_CHANGES - todayChanges) {
            try {
              const result = await ebay.updateItem(myItem.itemId, { price: finalRaise });
              change.status = result.success ? 'applied' : 'failed';
              if (result.success) { report.changed++; await new Promise(r => setTimeout(r, 500)); }
              else { change.error = result.error; report.errors.push(change); }
            } catch (e) { change.status = 'error'; change.error = e.message; report.errors.push(change); }
            report.changes.push(change);
          }

          // Log
          try {
            await db.from('repricer_log').insert({
              item_id: myItem.itemId, sku, old_price: myPrice, new_price: finalRaise,
              competitor_price: comp.competitor_price, reason: change.reason,
              status: change.status, created_at: new Date().toISOString(),
            });
          } catch (e) { /* ignore */ }
        }
      }
      continue; // 이기고 있으면 킬프라이스 불필요
    }

    // Already winning (경쟁사 인상 아님) — skip
    if (!isLosing) continue;

    // Safety check 1: Competitor price crash (>50% drop from previous)
    if (comp.prev_price && comp.prev_price > 0) {
      const drop = (comp.prev_price - comp.competitor_price) / comp.prev_price * 100;
      if (drop >= COMPETITOR_CRASH_THRESHOLD) {
        report.skipped.push({ sku, reason: 'competitor_crash', detail: `${drop.toFixed(0)}% drop ($${comp.prev_price}→$${comp.competitor_price})`, seller: comp.seller_id });
        continue;
      }
    }

    // Calculate kill price with seller-specific undercut
    const sellerInfo = sellerTiers[comp.seller_id] || null;
    const undercut = sellerInfo ? sellerInfo.undercut : KILL_PRICE_UNDERCUT;
    const killPrice = Math.max(0.99, compTotal - undercut - MY_SHIPPING);
    const killPriceRounded = +killPrice.toFixed(2);

    // Safety check 2: Floor price (60% of current price)
    const floorPrice = +(myPrice * DEFAULT_FLOOR_PCT / 100).toFixed(2);
    if (killPriceRounded < floorPrice) {
      report.skipped.push({ sku, reason: 'below_floor', detail: `kill $${killPriceRounded} < floor $${floorPrice}`, seller: comp.seller_id });
      continue;
    }

    // Safety check 3: Max price drop (30%)
    const dropPct = ((myPrice - killPriceRounded) / myPrice * 100);
    if (dropPct > MAX_PRICE_DROP_PCT) {
      report.skipped.push({ sku, reason: 'too_large_drop', detail: `${dropPct.toFixed(0)}% drop ($${myPrice}→$${killPriceRounded})`, seller: comp.seller_id });
      continue;
    }

    // Safety check 4: Price too low
    if (killPriceRounded < 1) {
      report.skipped.push({ sku, reason: 'price_too_low', detail: `$${killPriceRounded}` });
      continue;
    }

    // All safety checks passed
    const change = {
      itemId: myItem.itemId,
      sku,
      title: (myItem.title || '').slice(0, 50),
      oldPrice: myPrice,
      newPrice: killPriceRounded,
      myOldTotal: myTotal,
      myNewTotal: +(killPriceRounded + MY_SHIPPING).toFixed(2),
      compTotal,
      competitorSeller: comp.seller_id || '',
      saving: +(myPrice - killPriceRounded).toFixed(2),
    };

    if (dryRun) {
      change.status = 'dry_run';
      report.changes.push(change);
      report.changed++;
    } else {
      // Actually apply the price change
      try {
        const result = await ebay.updateItem(myItem.itemId, { price: killPriceRounded });
        if (result.success) {
          change.status = 'applied';
          report.changes.push(change);
          report.changed++;
          // Rate limit
          await new Promise(r => setTimeout(r, 500));
        } else {
          change.status = 'failed';
          change.error = result.error;
          report.errors.push(change);
        }
      } catch (e) {
        change.status = 'error';
        change.error = e.message;
        report.errors.push(change);
      }
    }

    // Log to DB
    try {
      await db.from('repricer_log').insert({
        item_id: myItem.itemId,
        sku,
        old_price: myPrice,
        new_price: killPriceRounded,
        competitor_price: compTotal,
        reason: `vs ${comp.seller_id || 'unknown'} ($${compTotal})`,
        status: change.status,
      });
    } catch (e) { /* table might not exist */ }
  }

  console.log(`[AutoRepricer] Done: ${report.processed} processed, ${report.changed} ${dryRun ? 'would change' : 'changed'}, ${report.skipped.length} skipped, ${report.errors.length} errors`);
  return report;
}

module.exports = { runAutoRepricer };
