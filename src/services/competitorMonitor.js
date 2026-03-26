'use strict';

const { getClient } = require('../db/supabaseClient');

/**
 * Competitor Monitor — detect price changes, ended listings, title changes
 * Runs every 6 hours via cron
 */
async function runCompetitorMonitor() {
  const db = getClient();
  console.log('[CompetitorMonitor] Starting scan...');

  // Get all active competitors with item IDs
  let allComps = [];
  let from = 0;
  while (true) {
    const { data } = await db.from('competitor_prices')
      .select('id, sku, competitor_id, competitor_price, competitor_shipping, seller_id, title, status')
      .neq('competitor_id', '')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allComps = allComps.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const activeComps = allComps.filter(c => c.status !== 'ended');
  console.log(`[CompetitorMonitor] ${activeComps.length} active competitors to check`);

  if (activeComps.length === 0) return { alerts: [] };

  const EbayAPI = require('../api/ebayAPI');
  const ebay = new EbayAPI();
  const alerts = [];

  // Batch check with GetMultipleItems (20 at a time)
  const itemIds = [...new Set(activeComps.map(c => c.competitor_id).filter(Boolean))];

  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    let items = [];
    try {
      items = await ebay.getCompetitorItems(batch);
    } catch (e) {
      console.warn('[CompetitorMonitor] API batch error:', e.message);
      continue;
    }

    const itemMap = {};
    items.forEach(item => { itemMap[item.itemId] = item; });

    // Check each competitor in this batch
    for (const comp of activeComps.filter(c => batch.includes(c.competitor_id))) {
      const live = itemMap[comp.competitor_id];

      if (!live) {
        // Listing ended/removed
        await db.from('competitor_prices').update({
          status: 'ended',
          prev_price: comp.competitor_price,
        }).eq('id', comp.id);
        alerts.push({
          type: 'ended',
          sku: comp.sku,
          seller: comp.seller_id,
          competitorId: comp.competitor_id,
          message: `${comp.seller_id || 'Unknown'} listing ended (${comp.competitor_id})`,
        });
        continue;
      }

      const updates = { tracked_at: new Date().toISOString() };
      const oldPrice = parseFloat(comp.competitor_price) || 0;
      const newPrice = parseFloat(live.price) || 0;
      const newShipping = parseFloat(live.shippingCost) || 0;

      // Price change detection
      if (oldPrice > 0 && newPrice > 0 && oldPrice !== newPrice) {
        const changePct = Math.abs(newPrice - oldPrice) / oldPrice * 100;
        updates.prev_price = oldPrice;
        updates.competitor_price = newPrice;
        updates.competitor_shipping = newShipping;

        if (changePct >= 50) {
          // Extreme price drop — suspicious
          alerts.push({
            type: 'price_crash',
            sku: comp.sku,
            seller: comp.seller_id || live.seller,
            competitorId: comp.competitor_id,
            oldPrice,
            newPrice,
            changePct: changePct.toFixed(1),
            message: `${comp.seller_id || live.seller} price crashed ${changePct.toFixed(0)}%: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
          });
        } else if (changePct >= 10) {
          alerts.push({
            type: 'price_change',
            sku: comp.sku,
            seller: comp.seller_id || live.seller,
            competitorId: comp.competitor_id,
            oldPrice,
            newPrice,
            changePct: changePct.toFixed(1),
            message: `${comp.seller_id || live.seller} price changed ${newPrice > oldPrice ? '+' : ''}${changePct.toFixed(0)}%: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
          });
        }
      } else {
        updates.competitor_price = newPrice;
        updates.competitor_shipping = newShipping;
      }

      // Title change detection
      if (comp.title && live.title && comp.title !== live.title) {
        alerts.push({
          type: 'title_change',
          sku: comp.sku,
          seller: comp.seller_id || live.seller,
          competitorId: comp.competitor_id,
          oldTitle: comp.title,
          newTitle: live.title,
          message: `${comp.seller_id || live.seller} title changed on ${comp.competitor_id}`,
        });
      }
      updates.title = live.title || '';

      // Update seller if missing
      if (!comp.seller_id && live.seller) {
        updates.seller_id = live.seller;
      }

      await db.from('competitor_prices').update(updates).eq('id', comp.id);
    }

    // Rate limit pause between batches
    if (i + 20 < itemIds.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Save alerts to DB
  if (alerts.length > 0) {
    console.log(`[CompetitorMonitor] ${alerts.length} alerts generated`);
    await db.from('competitor_alerts').insert(
      alerts.map(a => ({
        type: a.type,
        sku: a.sku,
        seller_id: a.seller || '',
        competitor_id: a.competitorId || '',
        message: a.message,
        data: JSON.stringify(a),
      }))
    ).then(() => {}).catch(() => {
      // Table might not exist yet — ignore
      console.warn('[CompetitorMonitor] competitor_alerts table not found, skipping alert save');
    });
  }

  console.log(`[CompetitorMonitor] Done. ${alerts.length} alerts, ${activeComps.length} checked`);
  return { alerts, checked: activeComps.length };
}

module.exports = { runCompetitorMonitor };
