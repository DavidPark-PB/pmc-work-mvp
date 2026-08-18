/**
 * src/services/oms/physicalIdentityDiagnostic.js — Phase 7A-4e · READ-ONLY.
 *
 * SINGLE authoritative physical-identity diagnostic shared by:
 *   - ebayPhysicalUnmatchedReporter (Phase 7A-4c CLI)
 *   - physicalSpecificCoverage      (Shopify/eBay trust gate)
 *   - channelSalesEvidence          (multi-channel velocity trust)
 *
 * Semantics (Phase 7A-4c hardened · Owner directive 7A-4e):
 *   - business-time window = oms_orders.shipped_at (NEVER imported_at)
 *   - set_name multi-word phrase matching
 *   - set_code word-boundary matching (sv9 NEVER matches sv9a)
 *   - unit_type / language decisive
 *   - known sku_master → sku_master_link → sellable_unit → sellable_unit_components → physical
 *   - known-mapped items are NOT candidates
 *   - trust gate operates on UNIQUE UNRESOLVED IDENTITIES, not raw item count
 *   - E-classified groups are structured false positives · do NOT block trust
 *
 * ZERO writes to any table / marketplace.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');

const CLASSIFICATIONS = Object.freeze({
  A_MATCHER_BUG: 'A_MATCHER_BUG',
  B_EXISTING_SKU_PHYSICAL_BRIDGE_MISSING: 'B_EXISTING_SKU_PHYSICAL_BRIDGE_MISSING',
  C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT: 'C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT',
  D_SAME_PHYSICAL_SINGLE_UNIT_RELIST: 'D_SAME_PHYSICAL_SINGLE_UNIT_RELIST',
  E_FALSE_POSITIVE: 'E_FALSE_POSITIVE',
  F_MANUAL_REVIEW: 'F_MANUAL_REVIEW',
});

// ─── Pure helpers ───────────────────────────────────────────

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildStructuredHints(phy) {
  const phrases = [];
  if (phy.set_name) {
    const s = String(phy.set_name).trim().toLowerCase().replace(/\s+/g, ' ');
    if (s.split(' ').filter(Boolean).length >= 2) phrases.push(s);
  }
  const setCodeRegex = phy.set_code
    ? new RegExp(`\\b${escapeRegex(String(phy.set_code).toLowerCase())}\\b`, 'i')
    : null;
  return {
    phrases,
    setCodeRegex,
    setCodeText: phy.set_code ? String(phy.set_code).toLowerCase() : null,
    language: (phy.language || '').toLowerCase(),
    unit_type: (phy.unit_type || '').toLowerCase(),
  };
}

function passesStructuredHints(item, hints) {
  const combined = `${String(item.title || '').toLowerCase()} ${String(item.marketplace_sku || '').toLowerCase()}`;
  const hits = [];
  let phraseHit = false;
  for (const p of hints.phrases) {
    if (combined.includes(p)) { phraseHit = true; hits.push(`phrase:${p}`); }
  }
  const setCodeHit = hints.setCodeRegex ? hints.setCodeRegex.test(combined) : false;
  if (setCodeHit) hits.push(`set_code:${hints.setCodeText}`);
  return { pass: phraseHit || setCodeHit, hits, phrase_hit: phraseHit, set_code_hit: setCodeHit };
}

function detectUnitSignals(rawTitle, rawSku) {
  const both = `${String(rawTitle || '').toLowerCase()} ${String(rawSku || '').toLowerCase()}`;
  const signals = {
    is_booster_box: /\bbooster\s*box\b/.test(both) || /\bbox(?:es|ed)?\b/.test(both),
    is_booster_pack: /\bbooster\s*pack\b/.test(both) || /\bpacks?\b/.test(both),
    is_case: false,
    is_single_card: /\bsingle\s*card\b/.test(both) || /\bpsa\s*\d+\b/.test(both) || /\bgraded\b/.test(both) || /\bslabb?ed\b/.test(both),
    is_bundle_with_promo: /\bpromo\s*(?:pack|bundle|included)\b/.test(both) || /\+\s*promo\b/.test(both),
    is_accessory: /\b(sleeves?|binder|deck\s*box|playmat|toploader|dice|album|collection\s*file|file\s*set|expansion\s*pack\s*collection)\b/.test(both),
    mentions_japanese: /\bjapanese\b/.test(both) || /\bjapan\b/.test(both),
    mentions_korean: /\bkorean\b/.test(both) || /\bkorea\b/.test(both),
    mentions_english: /\benglish\b/.test(both),
    boxes_quantity: null,
  };
  const boxMatch = both.match(/(\d{1,3})\s*box(?:es)?/i);
  signals.boxes_quantity = boxMatch ? parseInt(boxMatch[1], 10) : null;
  signals.is_case = /\bcase\b/.test(both) || /\bmultipack\b/.test(both)
    || (signals.boxes_quantity != null && signals.boxes_quantity > 1);
  return signals;
}

function classifyBySemantics(phy, signals) {
  const wantLanguage = String(phy.language || '').toLowerCase();
  const wantUnitType = String(phy.unit_type || '').toLowerCase();

  if (wantLanguage === 'ko' && signals.mentions_japanese && !signals.mentions_korean) {
    return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: 'language_mismatch:physical=ko/listing=japanese' };
  }
  if (wantLanguage === 'ja' && signals.mentions_korean && !signals.mentions_japanese) {
    return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: 'language_mismatch:physical=ja/listing=korean' };
  }
  if (wantUnitType === 'booster_box') {
    if (signals.is_single_card) return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: 'unit_mismatch:physical=booster_box/listing=single_card' };
    if (signals.is_accessory)   return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: 'unit_mismatch:physical=booster_box/listing=accessory' };
    if (signals.is_booster_pack && !signals.is_booster_box) return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: 'unit_mismatch:physical=booster_box/listing=loose_booster_pack' };
    if (signals.is_case || signals.is_bundle_with_promo) {
      return {
        classification: CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT,
        reason: signals.is_bundle_with_promo ? 'bundle_with_promo_variant_needed' : `multi_box_case(boxes=${signals.boxes_quantity ?? 'case'})`,
      };
    }
    if (signals.is_booster_box) {
      if (wantLanguage === 'ko' && signals.mentions_korean) return { classification: CLASSIFICATIONS.D_SAME_PHYSICAL_SINGLE_UNIT_RELIST, reason: 'booster_box_language_matched(ko)' };
      return { classification: CLASSIFICATIONS.F_MANUAL_REVIEW, reason: 'booster_box_language_ambiguous' };
    }
  }
  return { classification: CLASSIFICATIONS.F_MANUAL_REVIEW, reason: 'insufficient_evidence' };
}

function classifyStructural(item, existingLinkMap, skuMasterBridgeMap, currentPhysicalId, channel) {
  if (item.sku_master_id == null) {
    const key = _linkKey(channel, item.listing_id != null ? String(item.listing_id) : null, item.variant_id != null ? String(item.variant_id) : null);
    if (existingLinkMap.has(key)) {
      return { classification: CLASSIFICATIONS.A_MATCHER_BUG, reason: 'exact_sku_listing_link_exists_but_item_unmatched' };
    }
    return null;
  }
  const bridge = skuMasterBridgeMap.get(item.sku_master_id);
  if (!bridge || bridge.linkedPhysicalIds.size === 0) {
    return { classification: CLASSIFICATIONS.B_EXISTING_SKU_PHYSICAL_BRIDGE_MISSING, reason: `sku_master(${item.sku_master_id})_orphan_no_bridge` };
  }
  if (!bridge.linkedPhysicalIds.has(currentPhysicalId)) {
    return { classification: CLASSIFICATIONS.E_FALSE_POSITIVE, reason: `sku_master(${item.sku_master_id})_bridged_to_other_physical(${[...bridge.linkedPhysicalIds].join(',')})` };
  }
  return null;
}

function combinedClassify({ item, signals, existingLinkMap, skuMasterBridgeMap, currentPhysicalId, phy, channel }) {
  const sem = classifyBySemantics(phy, signals);
  const struct = classifyStructural(item, existingLinkMap, skuMasterBridgeMap, currentPhysicalId, channel);
  if (sem.classification === CLASSIFICATIONS.E_FALSE_POSITIVE) return sem;
  if (struct && struct.classification === CLASSIFICATIONS.A_MATCHER_BUG) return struct;
  if (struct && struct.classification === CLASSIFICATIONS.E_FALSE_POSITIVE) return struct;
  if (sem.classification === CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT) return sem;
  if (sem.classification === CLASSIFICATIONS.D_SAME_PHYSICAL_SINGLE_UNIT_RELIST) return sem;
  if (struct && struct.classification === CLASSIFICATIONS.B_EXISTING_SKU_PHYSICAL_BRIDGE_MISSING) return struct;
  return sem;
}

function proposedOwnerAction(classification) {
  switch (classification) {
    case CLASSIFICATIONS.A_MATCHER_BUG: return 'FIX_MATCHER';
    case CLASSIFICATIONS.B_EXISTING_SKU_PHYSICAL_BRIDGE_MISSING: return 'OWNER_APPROVE_BRIDGE_TO_PHYSICAL';
    case CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT: return 'CREATE_SELLABLE_VARIANT_THEN_LINK';
    case CLASSIFICATIONS.D_SAME_PHYSICAL_SINGLE_UNIT_RELIST: return 'OWNER_APPROVE_LINK_EXISTING_SKU';
    case CLASSIFICATIONS.E_FALSE_POSITIVE: return 'FALSE_POSITIVE_EXCLUDE_FROM_DIAGNOSTIC';
    default: return 'MANUAL_REVIEW';
  }
}

// ─── Main analysis (shared) ────────────────────────────────

/**
 * Analyse physical identity for one (physical_product, channel) pair.
 * READ-ONLY. Never mutates any table.
 *
 * @param {Object} args
 * @param {number}   args.physicalProductId
 * @param {'shopify'|'ebay'|string} [args.channel='ebay']
 * @param {number}   [args.days=30]
 * @param {number}   [args.nowMs=Date.now()]
 */
async function analysePhysicalIdentity({ physicalProductId, channel = 'ebay', days = 30, nowMs = Date.now() } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const db = getClient();
  const daysN = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const windowEndIso = new Date(nowMs).toISOString();
  const windowStartIso = new Date(nowMs - daysN * 86400_000).toISOString();

  const { data: phy } = await db.from('physical_products')
    .select('id, canonical_title, canonical_title_ko, set_code, set_name, language, region, unit_type')
    .eq('id', physicalProductId).maybeSingle();
  if (!phy) return _emptyResult(physicalProductId, channel, daysN, windowStartIso, windowEndIso, 'physical_not_found');

  const knownIdentities = await _fetchKnownIdentities(db, physicalProductId, channel);
  const knownSkuMasterIds = new Set(knownIdentities.map(k => k.sku_master_id).filter(Boolean));

  // ── shipped_at window ──
  const { data: allOrders } = await db.from('oms_orders')
    .select('id, external_order_number, external_order_id, imported_at, shipped_at, fulfillment_status')
    .eq('channel', channel);
  const shippedOrders = (allOrders || []).filter(o =>
    o.shipped_at && o.shipped_at >= windowStartIso && o.shipped_at <= windowEndIso);
  const shippedOrderIds = new Set(shippedOrders.map(o => o.id));
  const orderById = new Map(shippedOrders.map(o => [o.id, o]));

  let allShippedItems = [];
  if (shippedOrderIds.size) {
    const { data: allItems } = await db.from('oms_order_items')
      .select('id, order_id, external_line_id, listing_id, variant_id, marketplace_sku, title, quantity, sku_master_id, match_status, match_reason');
    allShippedItems = (allItems || []).filter(i => shippedOrderIds.has(i.order_id));
  }

  // ── known-mapped shipped events (LOWER BOUND) ──
  const knownShippedEvents = [];
  for (const it of allShippedItems) {
    if (it.sku_master_id == null || !knownSkuMasterIds.has(it.sku_master_id)) continue;
    const ord = orderById.get(it.order_id);
    const knownId = knownIdentities.find(k => k.sku_master_id === it.sku_master_id);
    const qtyPer = knownId?.quantity_per_unit ?? 1;
    knownShippedEvents.push({
      order_item_id: it.id, order_id: it.order_id,
      external_order_number: ord.external_order_number,
      external_line_id: it.external_line_id,
      listing_id: it.listing_id, variant_id: it.variant_id,
      marketplace_sku: it.marketplace_sku, title: it.title,
      raw_quantity: it.quantity, qty_per_unit: qtyPer,
      physical_units: (Number(it.quantity) || 0) * qtyPer,
      sku_master_id: it.sku_master_id, shipped_at: ord.shipped_at,
    });
  }
  const knownMappedPhysicalUnits30d = knownShippedEvents.reduce((a, e) => a + (e.physical_units || 0), 0);
  const knownMappedPhysicalUnits7d = knownShippedEvents
    .filter(e => new Date(e.shipped_at).getTime() >= nowMs - 7 * 86400_000)
    .reduce((a, e) => a + (e.physical_units || 0), 0);

  // ── candidates (not in known set) ──
  const candidateItems = allShippedItems.filter(i =>
    !(i.sku_master_id != null && knownSkuMasterIds.has(i.sku_master_id))
  );

  // ── structured hint pre-filter ──
  const hints = buildStructuredHints(phy);
  const structuredCandidates = [];
  for (const it of candidateItems) {
    const h = passesStructuredHints(it, hints);
    if (h.pass) structuredCandidates.push({ item: it, hits: h.hits, phrase_hit: h.phrase_hit, set_code_hit: h.set_code_hit });
  }

  // ── group by identity ──
  const groups = new Map();
  for (const { item, hits, phrase_hit, set_code_hit } of structuredCandidates) {
    const key = item.listing_id != null ? String(item.listing_id) : `__no_listing__:${item.marketplace_sku ?? item.id}`;
    const bucket = groups.get(key) || {
      identity_key: key, listing_id: item.listing_id != null ? String(item.listing_id) : null,
      variant_ids: new Set(), marketplace_sku_examples: new Set(), title_examples: new Set(),
      hit_tokens: new Set(), items: [], raw_quantity: 0, shipped_raw_quantity: 0,
      phrase_hit: false, set_code_hit: false,
    };
    bucket.items.push(item);
    bucket.raw_quantity += Number(item.quantity) || 0;
    bucket.shipped_raw_quantity += Number(item.quantity) || 0;
    if (item.variant_id != null) bucket.variant_ids.add(String(item.variant_id));
    if (item.marketplace_sku) bucket.marketplace_sku_examples.add(String(item.marketplace_sku));
    if (item.title) bucket.title_examples.add(String(item.title));
    hits.forEach(t => bucket.hit_tokens.add(t));
    bucket.phrase_hit = bucket.phrase_hit || phrase_hit;
    bucket.set_code_hit = bucket.set_code_hit || set_code_hit;
    groups.set(key, bucket);
  }

  const listingIdsForLookup = [...groups.keys()].filter(k => !k.startsWith('__no_listing__:'));
  const existingLinkMap = await _fetchLinkExistence(db, channel, listingIdsForLookup);
  const ebayProductsMap = channel === 'ebay'
    ? await _fetchEbayProductsPresence(db, listingIdsForLookup)
    : new Map();
  const candidateSkuMasterIds = [...new Set(candidateItems.map(i => i.sku_master_id).filter(v => v != null))];
  const skuMasterBridgeMap = await _fetchSkuMasterBridgeMap(db, candidateSkuMasterIds);

  const analysedGroups = [...groups.values()].map(g => {
    const ex = g.items[0];
    const signals = detectUnitSignals([...g.title_examples][0], [...g.marketplace_sku_examples][0]);
    const combined = combinedClassify({
      item: ex, signals, existingLinkMap, skuMasterBridgeMap,
      currentPhysicalId: physicalProductId, phy, channel,
    });
    const classification = combined.classification;
    const reason = combined.reason;
    const proposed_owner_action = proposedOwnerAction(classification);

    let physical_units_per_sold_unit = 1;
    if (classification === CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT) {
      physical_units_per_sold_unit = (signals.boxes_quantity != null && signals.boxes_quantity > 1)
        ? signals.boxes_quantity : 1;
    }
    const eligibleForConfirmed = (
      classification === CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT ||
      classification === CLASSIFICATIONS.D_SAME_PHYSICAL_SINGLE_UNIT_RELIST
    );
    const proposed_physical_units_if_owner_confirms = eligibleForConfirmed
      ? g.shipped_raw_quantity * physical_units_per_sold_unit : 0;

    return {
      identity_key: g.identity_key,
      listing_id: g.listing_id,
      listing_in_ebay_products: g.listing_id ? ebayProductsMap.has(g.listing_id) : false,
      variant_ids: [...g.variant_ids],
      marketplace_sku_examples: [...g.marketplace_sku_examples],
      title_examples: [...g.title_examples],
      hit_tokens: [...g.hit_tokens],
      phrase_hit: g.phrase_hit,
      set_code_hit: g.set_code_hit,
      items_count: g.items.length,
      raw_quantity: g.raw_quantity,
      shipped_raw_quantity: g.shipped_raw_quantity,
      unit_signals: signals,
      classification, reason, proposed_owner_action,
      physical_units_per_sold_unit,
      proposed_physical_units_if_owner_confirms,
      sample_items: g.items.slice(0, 5).map(it => ({
        order_item_id: it.id, order_id: it.order_id,
        external_order_number: orderById.get(it.order_id)?.external_order_number ?? null,
        external_line_id: it.external_line_id,
        listing_id: it.listing_id, variant_id: it.variant_id,
        marketplace_sku: it.marketplace_sku, title: it.title,
        raw_quantity: it.quantity,
        current_sku_master_id: it.sku_master_id, match_status: it.match_status,
        shipped_at: orderById.get(it.order_id)?.shipped_at ?? null,
      })),
    };
  });

  analysedGroups.sort((a, b) => (b.raw_quantity - a.raw_quantity) || (b.items_count - a.items_count));

  const classificationCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const g of analysedGroups) classificationCounts[_letter(g.classification)] += g.items_count;

  // Unresolved = groups that are NOT structured false positives.
  const unresolvedGroups = analysedGroups.filter(g => g.classification !== CLASSIFICATIONS.E_FALSE_POSITIVE);
  const unresolvedUniqueIdentities = unresolvedGroups.length;
  const unresolvedByLetter = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const g of unresolvedGroups) {
    const l = _letter(g.classification);
    if (l !== 'E') unresolvedByLetter[l] = (unresolvedByLetter[l] || 0) + 1;
  }

  const confirmedUnbridgedPhysicalUnits30d = analysedGroups
    .filter(g => g.classification === CLASSIFICATIONS.C_CONFIRMED_SAME_PHYSICAL_NEW_SELLABLE_UNIT
              || g.classification === CLASSIFICATIONS.D_SAME_PHYSICAL_SINGLE_UNIT_RELIST)
    .reduce((a, g) => a + g.proposed_physical_units_if_owner_confirms, 0);

  return {
    physical_product_id: physicalProductId,
    channel,
    days: daysN,
    window_start: windowStartIso,
    window_end: windowEndIso,
    window_time_field: 'oms_orders.shipped_at',
    physical: phy,
    known_identities: knownIdentities,
    known_shipped_events: knownShippedEvents,
    known_mapped_physical_units_7d: knownMappedPhysicalUnits7d,
    known_mapped_physical_units_30d: knownMappedPhysicalUnits30d,
    candidate_items_in_shipped_window: analysedGroups.reduce((a, g) => a + g.items_count, 0),
    candidate_unique_identities_in_shipped_window: analysedGroups.length,
    unresolved_unique_identities: unresolvedUniqueIdentities,
    unresolved_group_count_by_letter: unresolvedByLetter,
    classifications_by_letter: classificationCounts,
    groups: analysedGroups,
    confirmed_but_unbridged_physical_units_30d: confirmedUnbridgedPhysicalUnits30d,
    diagnostic_hints: {
      phrases: hints.phrases,
      set_code: hints.setCodeText,
      language: hints.language,
      unit_type: hints.unit_type,
    },
    generated_at: new Date(nowMs).toISOString(),
  };
}

// ─── helpers ──────────────────────────────────────────────

async function _fetchKnownIdentities(db, physicalId, channel) {
  const out = [];
  const { data: comps } = await db.from('sellable_unit_components')
    .select('sellable_unit_id, quantity_per_unit').eq('physical_product_id', physicalId);
  const sellableIds = [...new Set((comps || []).map(c => c.sellable_unit_id))];
  const qtyPerBySellable = new Map((comps || []).map(c => [c.sellable_unit_id, c.quantity_per_unit]));
  if (sellableIds.length === 0) return out;
  const { data: links } = await db.from('sku_master_link')
    .select('sku_master_id, sellable_unit_id').in('sellable_unit_id', sellableIds);
  const skuIds = [...new Set((links || []).map(l => l.sku_master_id))];
  if (skuIds.length === 0) return out;
  const { data: sll } = await db.from('sku_listing_link')
    .select('sku_id, marketplace, listing_id, option_id, marketplace_sku')
    .eq('marketplace', channel).in('sku_id', skuIds);
  for (const r of (sll || [])) {
    const link = (links || []).find(l => l.sku_master_id === r.sku_id);
    out.push({
      listing_id: r.listing_id != null ? String(r.listing_id) : null,
      variant_id: r.option_id != null ? String(r.option_id) : null,
      marketplace_sku: r.marketplace_sku ?? null,
      sku_master_id: r.sku_id,
      sellable_unit_id: link?.sellable_unit_id ?? null,
      quantity_per_unit: link ? qtyPerBySellable.get(link.sellable_unit_id) : null,
    });
  }
  return out;
}

async function _fetchLinkExistence(db, marketplace, listingIds) {
  const out = new Map();
  if (!listingIds.length) return out;
  const { data } = await db.from('sku_listing_link')
    .select('id, sku_id, marketplace, listing_id, option_id')
    .eq('marketplace', marketplace).in('listing_id', listingIds);
  for (const r of (data || [])) {
    out.set(_linkKey(r.marketplace, String(r.listing_id), r.option_id != null ? String(r.option_id) : null), {
      sku_listing_link_id: r.id, sku_master_id: r.sku_id,
    });
  }
  return out;
}

async function _fetchEbayProductsPresence(db, listingIds) {
  const out = new Map();
  if (!listingIds.length) return out;
  const { data } = await db.from('ebay_products').select('item_id').in('item_id', listingIds);
  for (const r of (data || [])) out.set(String(r.item_id), true);
  return out;
}

async function _fetchSkuMasterBridgeMap(db, skuMasterIds) {
  const out = new Map();
  if (!skuMasterIds.length) return out;
  const { data: links } = await db.from('sku_master_link')
    .select('sku_master_id, sellable_unit_id').in('sku_master_id', skuMasterIds);
  const sellableIds = [...new Set((links || []).map(l => l.sellable_unit_id))];
  const { data: comps } = sellableIds.length
    ? await db.from('sellable_unit_components')
        .select('sellable_unit_id, physical_product_id, quantity_per_unit').in('sellable_unit_id', sellableIds)
    : { data: [] };
  const sellableToPhysical = new Map();
  for (const c of (comps || [])) {
    if (!sellableToPhysical.has(c.sellable_unit_id)) sellableToPhysical.set(c.sellable_unit_id, new Set());
    sellableToPhysical.get(c.sellable_unit_id).add(c.physical_product_id);
  }
  for (const skuId of skuMasterIds) {
    const linkedSellable = (links || []).filter(l => l.sku_master_id === skuId).map(l => l.sellable_unit_id);
    const linkedPhysicalIds = new Set();
    for (const sellId of linkedSellable) {
      const set = sellableToPhysical.get(sellId);
      if (set) set.forEach(p => linkedPhysicalIds.add(p));
    }
    out.set(skuId, { linkedSellable, linkedPhysicalIds });
  }
  return out;
}

function _emptyResult(physicalProductId, channel, days, windowStartIso, windowEndIso, errorMessage) {
  return {
    physical_product_id: physicalProductId,
    channel, days,
    window_start: windowStartIso, window_end: windowEndIso,
    window_time_field: 'oms_orders.shipped_at',
    physical: null, error: errorMessage,
    known_identities: [], known_shipped_events: [],
    known_mapped_physical_units_7d: 0, known_mapped_physical_units_30d: 0,
    candidate_items_in_shipped_window: 0, candidate_unique_identities_in_shipped_window: 0,
    unresolved_unique_identities: 0, unresolved_group_count_by_letter: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    classifications_by_letter: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 },
    groups: [],
    confirmed_but_unbridged_physical_units_30d: 0,
    diagnostic_hints: { phrases: [], set_code: null, language: '', unit_type: '' },
    generated_at: new Date().toISOString(),
  };
}

function _linkKey(marketplace, listingId, optionId) {
  return `${marketplace}|${listingId ?? ''}|${optionId ?? ''}`;
}
function _letter(label) {
  if (label.startsWith('A_')) return 'A';
  if (label.startsWith('B_')) return 'B';
  if (label.startsWith('C_')) return 'C';
  if (label.startsWith('D_')) return 'D';
  if (label.startsWith('E_')) return 'E';
  return 'F';
}

module.exports = {
  CLASSIFICATIONS,
  analysePhysicalIdentity,
  _internals: {
    buildStructuredHints, passesStructuredHints, detectUnitSignals,
    classifyBySemantics, classifyStructural, combinedClassify, proposedOwnerAction,
    _linkKey, _letter,
  },
};
