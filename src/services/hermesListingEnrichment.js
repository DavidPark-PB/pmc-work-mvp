'use strict';

/**
 * Hermes v1 Listing Data Enrichment
 *
 * Read-only eBay listing detail cache. This module must not call marketplace write APIs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const EbayAPI = require('../api/ebayAPI');

function int(v, fallback = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function text(v) { return v == null ? '' : String(v); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }

function extractValue(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXml(match[1].trim()) : '';
}
function extractBlock(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? match[1] : '';
}
function extractAllValues(xml, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'g');
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) out.push(decodeXml(match[1].trim()));
  return out;
}
function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseNameValueList(block) {
  const specifics = {};
  const re = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
  let match;
  while ((match = re.exec(String(block || ''))) !== null) {
    const one = match[1];
    const name = extractValue(one, 'Name');
    const values = extractAllValues(one, 'Value');
    if (name) specifics[name] = values.join(', ');
  }
  return specifics;
}

function parseReturnPolicy(block) {
  if (!block) return {};
  return {
    returnsAccepted: extractValue(block, 'ReturnsAcceptedOption') || extractValue(block, 'ReturnsAccepted'),
    refund: extractValue(block, 'RefundOption') || extractValue(block, 'Refund'),
    returnsWithin: extractValue(block, 'ReturnsWithinOption') || extractValue(block, 'ReturnsWithin'),
    shippingCostPaidBy: extractValue(block, 'ShippingCostPaidByOption') || extractValue(block, 'ShippingCostPaidBy'),
    description: extractValue(block, 'Description'),
  };
}

function parseShippingPolicy(block) {
  if (!block) return {};
  const serviceBlocks = [];
  const re = /<ShippingServiceOptions>([\s\S]*?)<\/ShippingServiceOptions>/g;
  let match;
  while ((match = re.exec(block)) !== null) serviceBlocks.push(match[1]);
  return {
    shippingType: extractValue(block, 'ShippingType'),
    globalShipping: extractValue(block, 'GlobalShipping'),
    calculatedShippingRate: extractValue(block, 'CalculatedShippingRate'),
    services: serviceBlocks.map(s => ({
      service: extractValue(s, 'ShippingService'),
      cost: extractValue(s, 'ShippingServiceCost'),
      additionalCost: extractValue(s, 'ShippingServiceAdditionalCost'),
      priority: extractValue(s, 'ShippingServicePriority'),
      expedited: extractValue(s, 'ExpeditedService'),
      shippingTimeMin: extractValue(s, 'ShippingTimeMin'),
      shippingTimeMax: extractValue(s, 'ShippingTimeMax'),
    })),
  };
}

function parseGetItemResponse(xml, fallback = {}) {
  const item = extractBlock(xml, 'Item') || xml;
  const pictureBlock = extractBlock(item, 'PictureDetails');
  const itemSpecificsBlock = extractBlock(item, 'ItemSpecifics');
  const returnPolicyBlock = extractBlock(item, 'ReturnPolicy');
  const shippingDetailsBlock = extractBlock(item, 'ShippingDetails');
  const sellingStatusBlock = extractBlock(item, 'SellingStatus');
  const primaryCategoryBlock = extractBlock(item, 'PrimaryCategory');

  const pictureUrls = uniq(extractAllValues(pictureBlock, 'PictureURL'));
  const specifics = parseNameValueList(itemSpecificsBlock);
  const returnPolicy = parseReturnPolicy(returnPolicyBlock);
  const shippingPolicy = parseShippingPolicy(shippingDetailsBlock);

  return {
    sku: extractValue(item, 'SKU') || fallback.sku || '',
    itemId: extractValue(item, 'ItemID') || fallback.item_id || fallback.itemId || '',
    title: extractValue(item, 'Title') || fallback.title || '',
    categoryId: extractValue(primaryCategoryBlock, 'CategoryID'),
    categoryName: extractValue(primaryCategoryBlock, 'CategoryName'),
    conditionId: extractValue(item, 'ConditionID'),
    condition: extractValue(item, 'ConditionDisplayName') || extractValue(item, 'ConditionDescription'),
    soldQuantity: int(extractValue(sellingStatusBlock, 'QuantitySold') || extractValue(item, 'QuantitySold'), null),
    watchCount: int(extractValue(item, 'WatchCount'), null),
    viewCount: int(extractValue(item, 'HitCount'), null),
    handlingTime: int(extractValue(item, 'DispatchTimeMax'), null),
    estimatedDelivery: extractValue(shippingDetailsBlock, 'ShippingTimeMax') || '',
    promotionStatus: extractValue(item, 'PromotionalSaleDetails') ? 'promotion_data_present' : '',
    listingStatus: extractValue(sellingStatusBlock, 'ListingStatus') || extractValue(item, 'ListingStatus'),
    pictureUrls,
    itemSpecifics: specifics,
    returnPolicy,
    shippingPolicy,
    raw: {
      ack: extractValue(xml, 'Ack'),
      hasItemSpecifics: Object.keys(specifics).length > 0,
      hasReturnPolicy: Object.keys(returnPolicy).some(k => returnPolicy[k]),
      hasShippingPolicy: Object.keys(shippingPolicy).some(k => Array.isArray(shippingPolicy[k]) ? shippingPolicy[k].length : shippingPolicy[k]),
    },
  };
}

function normalizeLimit(v, fallback, max = 5000) {
  const n = int(v, fallback);
  return Math.max(1, Math.min(max, n || fallback));
}

function candidateMetadata({ scannedCount, candidateCount, returnedCount, scanLimit, exhaustedScan, missingOnly }) {
  return {
    scanned_count: scannedCount,
    candidate_count: candidateCount,
    returned_count: returnedCount,
    scan_limit: scanLimit,
    exhausted_scan: exhaustedScan,
    missing_only: Boolean(missingOnly),
  };
}

async function loadEnrichedItemIds(itemIds) {
  if (!itemIds || itemIds.length === 0) return new Set();
  const db = getClient();
  const { data, error } = await db
    .from('listing_details')
    .select('item_id,last_enriched_at')
    .eq('platform', 'ebay')
    .eq('listing_type', 'our')
    .in('item_id', itemIds);
  if (error) throw error;
  return new Set((data || []).map(d => d.item_id));
}

async function discoverCandidateListings({ limit = 50, sku = null, missingOnly = false, scanLimit = 5000 } = {}) {
  const db = getClient();
  const requestedLimit = normalizeLimit(limit, 50);
  const effectiveScanLimit = normalizeLimit(scanLimit, 5000, 10000);

  if (!missingOnly) {
    let q = db
      .from('ebay_products')
      .select('sku,item_id,title,updated_at')
      .not('item_id', 'is', null)
      .neq('item_id', '')
      .order('updated_at', { ascending: false })
      .limit(requestedLimit);
    if (sku) q = q.eq('sku', sku);
    const { data, error } = await q;
    if (error) throw error;
    const candidates = data || [];
    return {
      candidates,
      metadata: candidateMetadata({
        scannedCount: candidates.length,
        candidateCount: candidates.length,
        returnedCount: candidates.length,
        scanLimit: requestedLimit,
        exhaustedScan: candidates.length < requestedLimit,
        missingOnly,
      }),
    };
  }

  const candidates = [];
  let scannedCount = 0;
  let exhaustedScan = false;
  const batchSize = Math.min(1000, Math.max(100, requestedLimit * 5));

  while (scannedCount < effectiveScanLimit && candidates.length < requestedLimit) {
    const remainingScan = effectiveScanLimit - scannedCount;
    const size = Math.min(batchSize, remainingScan);
    let q = db
      .from('ebay_products')
      .select('sku,item_id,title,updated_at')
      .not('item_id', 'is', null)
      .neq('item_id', '')
      .order('updated_at', { ascending: false })
      .range(scannedCount, scannedCount + size - 1);
    if (sku) q = q.eq('sku', sku);

    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    scannedCount += rows.length;

    if (rows.length === 0) {
      exhaustedScan = true;
      break;
    }

    try {
      const itemIds = rows.map(r => r.item_id).filter(Boolean);
      const seen = await loadEnrichedItemIds(itemIds);
      for (const row of rows) {
        if (!seen.has(row.item_id)) candidates.push(row);
        if (candidates.length >= requestedLimit) break;
      }
    } catch (e) {
      console.warn('[ListingEnrichment] missing-only 필터 실패 — 현재 배치 후보에서 진행:', e.message);
      for (const row of rows) {
        candidates.push(row);
        if (candidates.length >= requestedLimit) break;
      }
    }

    if (rows.length < size) {
      exhaustedScan = true;
      break;
    }
  }

  if (scannedCount >= effectiveScanLimit && candidates.length < requestedLimit) exhaustedScan = true;

  return {
    candidates: candidates.slice(0, requestedLimit),
    metadata: candidateMetadata({
      scannedCount,
      candidateCount: candidates.length,
      returnedCount: Math.min(candidates.length, requestedLimit),
      scanLimit: effectiveScanLimit,
      exhaustedScan,
      missingOnly,
    }),
  };
}

async function getCandidateListings(options = {}) {
  const { candidates } = await discoverCandidateListings(options);
  return candidates;
}

async function fetchListingDetail(itemId, listing = {}) {
  const ebay = new EbayAPI();
  const requestBody = `
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>`;
  const xml = await ebay.callTradingAPI('GetItem', requestBody);
  const ack = extractValue(xml, 'Ack');
  if (ack && !['Success', 'Warning'].includes(ack)) {
    throw new Error(extractValue(xml, 'LongMessage') || extractValue(xml, 'ShortMessage') || `GetItem Ack=${ack}`);
  }
  return parseGetItemResponse(xml, listing);
}

async function saveListingDetail(detail, listing = {}) {
  const db = getClient();
  const itemId = detail.itemId || listing.item_id;
  const sku = detail.sku || listing.sku || null;
  const detailPayload = {
    platform: 'ebay',
    listing_type: 'our',
    sku,
    item_id: itemId,
    title: detail.title || listing.title || '',
    category_id: detail.categoryId || '',
    category_name: detail.categoryName || '',
    condition_id: detail.conditionId || '',
    condition: detail.condition || '',
    sold_quantity: detail.soldQuantity,
    watch_count: detail.watchCount,
    view_count: detail.viewCount,
    image_count: detail.pictureUrls.length,
    handling_time: detail.handlingTime,
    estimated_delivery: detail.estimatedDelivery || '',
    promotion_status: detail.promotionStatus || '',
    listing_status: detail.listingStatus || '',
    source_api: 'trading_get_item',
    last_enriched_at: new Date().toISOString(),
    raw_data: detail.raw || {},
  };

  const { error: detailErr } = await db
    .from('listing_details')
    .upsert(detailPayload, { onConflict: 'platform,listing_type,item_id' });
  if (detailErr) throw detailErr;

  await db.from('listing_images').delete().eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId);
  const imageRows = detail.pictureUrls.map((url, idx) => ({
    platform: 'ebay', listing_type: 'our', item_id: itemId, image_url: url, position: idx + 1, source: 'trading_get_item',
  }));
  if (imageRows.length > 0) {
    const { error } = await db.from('listing_images').insert(imageRows);
    if (error) throw error;
  }

  await db.from('listing_item_specifics').delete().eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId);
  const specRows = Object.entries(detail.itemSpecifics || {}).map(([name, value]) => ({
    platform: 'ebay', listing_type: 'our', item_id: itemId, name, value: text(value), source: 'trading_get_item',
  }));
  if (specRows.length > 0) {
    const { error } = await db.from('listing_item_specifics').insert(specRows);
    if (error) throw error;
  }

  const { error: policyErr } = await db
    .from('listing_policies')
    .upsert({
      platform: 'ebay',
      listing_type: 'our',
      item_id: itemId,
      return_policy: detail.returnPolicy || {},
      shipping_policy: detail.shippingPolicy || {},
      payment_policy: {},
      handling_time: detail.handlingTime,
      estimated_delivery: detail.estimatedDelivery || '',
      source: 'trading_get_item',
    }, { onConflict: 'platform,listing_type,item_id' });
  if (policyErr) throw policyErr;
}

async function logFailure(listing, error) {
  try {
    const db = getClient();
    await db.from('listing_enrichment_errors').insert({
      platform: 'ebay',
      listing_type: 'our',
      sku: listing.sku || null,
      item_id: listing.item_id || null,
      error_message: error.message || String(error),
      source_api: 'trading_get_item',
    });
  } catch (_) {}
}

async function withRetry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(800 * (i + 1));
    }
  }
  throw last;
}

async function enrichOneListing(listing) {
  const itemId = listing.item_id || listing.itemId;
  if (!itemId) throw new Error('item_id 없음');
  const detail = await withRetry(() => fetchListingDetail(itemId, listing), 2);
  await saveListingDetail(detail, listing);
  return {
    sku: detail.sku || listing.sku || '',
    itemId,
    title: detail.title || listing.title || '',
    imageCount: detail.pictureUrls.length,
    itemSpecificsCount: Object.keys(detail.itemSpecifics || {}).length,
    hasReturnPolicy: Object.keys(detail.returnPolicy || {}).some(k => detail.returnPolicy[k]),
    hasShippingPolicy: Object.keys(detail.shippingPolicy || {}).some(k => Array.isArray(detail.shippingPolicy[k]) ? detail.shippingPolicy[k].length : detail.shippingPolicy[k]),
    categoryId: detail.categoryId || '',
    condition: detail.condition || '',
  };
}

async function enrichListings({ limit = 50, sku = null, missingOnly = false, scanLimit = 5000, delayMs = 400, stopOnFailure = false } = {}) {
  const discovery = await discoverCandidateListings({ limit, sku, missingOnly, scanLimit });
  const candidates = discovery.candidates;
  const result = {
    requested: candidates.length,
    enriched: 0,
    failed: 0,
    items: [],
    errors: [],
    stopped: false,
    stop_reason: null,
    candidate_metadata: discovery.metadata,
  };

  for (const listing of candidates) {
    try {
      const item = await enrichOneListing(listing);
      result.enriched += 1;
      result.items.push(item);
      console.log(`[ListingEnrichment] OK ${item.sku || '-'} / ${item.itemId} images=${item.imageCount} specs=${item.itemSpecificsCount}`);
    } catch (e) {
      result.failed += 1;
      result.errors.push({ sku: listing.sku, itemId: listing.item_id, error: e.message });
      console.warn(`[ListingEnrichment] FAIL ${listing.sku || '-'} / ${listing.item_id}: ${e.message}`);
      await logFailure(listing, e);
      if (stopOnFailure) {
        result.stopped = true;
        result.stop_reason = e.message;
        break;
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return result;
}

module.exports = {
  enrichListings,
  enrichOneListing,
  fetchListingDetail,
  discoverCandidateListings,
  getCandidateListings,
  parseGetItemResponse,
};
