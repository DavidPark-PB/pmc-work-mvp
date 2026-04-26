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
      .select('id, sku, competitor_id, competitor_price, competitor_shipping, seller_id, title, status, last_refreshed_at')
      .neq('competitor_id', '')
      .not('competitor_id', 'is', null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allComps = allComps.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // active 는 매 사이클 체크. ended 는 24h 마다 1회 재확인 (false-ended self-heal).
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const activeComps = allComps.filter(c => {
    if (c.status !== 'ended') return true;
    const last = c.last_refreshed_at ? new Date(c.last_refreshed_at).getTime() : 0;
    return last < cutoff;
  });
  console.log(`[CompetitorMonitor] ${activeComps.length} competitors to check (incl. stale-ended)`);

  if (activeComps.length === 0) return { alerts: [] };

  const EbayAPI = require('../api/ebayAPI');
  const ebay = new EbayAPI();
  const alerts = [];

  // Batch check with GetMultipleItems (20 at a time)
  const itemIds = [...new Set(activeComps.map(c => c.competitor_id).filter(Boolean))];

  // Use Browse API only (Shopping API rate limit causes false 'ended' marking)
  for (let i = 0; i < itemIds.length; i += 10) {
    const batch = itemIds.slice(i, i + 10);
    let items = [];

    const failedIds = new Set();
    for (const bid of batch) {
      try {
        const browseItem = await ebay._fetchViaBrowseAPI(bid);
        if (browseItem) items.push(browseItem);
        else failedIds.add(bid);
      } catch (e) {
        // Browse API 호출 실패 (네트워크·rate limit·404 등)
        // — 일시적 실패면 ended 잘못 마킹되면 안 되니까 failedIds 에 기록 후 skip
        failedIds.add(bid);
        console.warn(`[CompetitorMonitor] Browse API error for ${bid}:`, e.message);
      }
    }

    // If we couldn't fetch ANY item in batch, likely API issue — skip entire batch
    if (items.length === 0 && batch.length > 0) {
      console.warn(`[CompetitorMonitor] All ${batch.length} items failed — skipping batch`);
      continue;
    }

    const itemMap = {};
    items.forEach(item => { itemMap[item.itemId] = item; });

    // Check each competitor in this batch
    for (const comp of activeComps.filter(c => batch.includes(c.competitor_id))) {
      const live = itemMap[comp.competitor_id];

      if (!live) {
        // 이 itemId 의 fetch 가 실제로 실패했으면 (네트워크/rate limit/일시 오류 등)
        // ended 마킹 절대 금지 — 다음 사이클 (2h 후) 다시 시도. 실수 ended 누적 방지.
        if (failedIds.has(comp.competitor_id)) {
          continue;
        }
        // fetch 자체는 성공했는데 응답에 없는 경우만 진짜 ended (드문 케이스)
        if (items.length > 0) {
          await db.from('competitor_prices').update({
            status: 'ended',
            prev_price: comp.competitor_price,
            last_refreshed_at: new Date().toISOString(),
          }).eq('id', comp.id);
          alerts.push({
            type: 'ended',
            sku: comp.sku,
            seller: comp.seller_id,
            competitorId: comp.competitor_id,
            message: `${comp.seller_id || 'Unknown'} listing ended (${comp.competitor_id})`,
          });
        }
        continue;
      }
      // live 객체 있음 → ended 였다면 active 로 자동 복구
      if (comp.status === 'ended') {
        console.log(`[CompetitorMonitor] ${comp.competitor_id} 잘못 ended 마킹돼 있었음 → active 복구`);
      }

      const updates = {
        tracked_at: new Date().toISOString(),
        last_refreshed_at: new Date().toISOString(),
        // 신규: 변형 + 재고 정보 (마이그레이션 034 미적용 시 PostgREST 가 무시)
        price_min: live.priceMin ?? null,
        price_max: live.priceMax ?? null,
        variant_count: live.variantCount ?? 1,
        quantity_available: live.quantityAvailable ?? null,
        // status 는 live 의 status (active/out_of_stock) 우선
        status: live.status || 'active',
      };
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
        } else if (newPrice > oldPrice && changePct >= 5) {
          // 경쟁사 가격 인상 → 우리도 올릴 기회!
          alerts.push({
            type: 'raise_opportunity',
            sku: comp.sku,
            seller: comp.seller_id || live.seller,
            competitorId: comp.competitor_id,
            oldPrice,
            newPrice,
            changePct: changePct.toFixed(1),
            message: `▲ ${comp.seller_id || live.seller} 가격 인상 +${changePct.toFixed(0)}%: $${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)} — 마진 회복 기회!`,
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

      // 마이그레이션 034 미적용 시 신규 컬럼 제거 후 재시도
      const { error: upErr } = await db.from('competitor_prices').update(updates).eq('id', comp.id);
      if (upErr && upErr.code === '42703') {
        const legacy = { ...updates };
        ['price_min','price_max','variant_count','quantity_available','last_refreshed_at'].forEach(k => delete legacy[k]);
        await db.from('competitor_prices').update(legacy).eq('id', comp.id);
      }
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
