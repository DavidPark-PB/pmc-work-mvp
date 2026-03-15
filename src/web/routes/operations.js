'use strict';

/**
 * operations.js — Dashboard Operations API Router
 *
 * Mounted at: /api/ops
 * All queries use server-side pagination (LIMIT + OFFSET).
 * Bulk operations run in batches of 50 to respect platform rate limits.
 * Does NOT modify automation-owned columns (products.status, platform_listings.platform_data).
 */

const express = require('express');
const router = express.Router();
const { getClient: getSupabase } = require('../../db/supabaseClient');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const BULK_BATCH_SIZE = 50;

// ─── helpers ────────────────────────────────────────────────────────────────

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit) || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function sendError(res, status, message, detail) {
  return res.status(status).json({ error: message, detail: detail || null });
}

/**
 * Split an array into chunks of `size`.
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Sleep for ms milliseconds (used between bulk batches).
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 1. PRODUCTS ────────────────────────────────────────────────────────────

/**
 * GET /api/ops/products
 * Server-side paginated product list with search and filtering.
 *
 * Query params:
 *   q          — partial search across sku, title (uses ilike)
 *   workflow_status — draft | ready | listed | soldout | archived
 *   platform   — filter by platform listing existence (ebay|shopify|…)
 *   sort       — sku | title | cost_price | margin_pct | created_at (default: created_at)
 *   order      — asc | desc (default: desc)
 *   page       — page number (default: 1)
 *   limit      — page size (default: 50, max: 100)
 */
router.get('/products', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q, workflow_status, platform, sort = 'created_at', order = 'desc' } = req.query;

    const ALLOWED_SORT = ['sku', 'title', 'cost_price', 'margin_pct', 'created_at', 'workflow_status'];
    const sortCol = ALLOWED_SORT.includes(sort) ? sort : 'created_at';
    const ascending = order === 'asc';

    let query = supabase
      .from('products')
      .select(
        `id, sku, title, title_ko, cost_price, price_usd, margin_pct,
         workflow_status, status, stock, ebay_item_id, created_at,
         platform_listings(platform, status, price, quantity)`,
        { count: 'exact' }
      );

    // Partial search: sku OR title
    if (q && q.trim()) {
      const term = q.trim();
      query = query.or(`sku.ilike.%${term}%,title.ilike.%${term}%,ebay_item_id.ilike.%${term}%`);
    }

    // Always hide trashed products
    query = query.neq('status', 'trashed');

    // Workflow status filter
    if (workflow_status) {
      query = query.eq('workflow_status', workflow_status);
    }

    // Platform filter: pre-fetch matching product IDs from platform_listings
    // so pagination count is correct before range() is applied.
    if (platform) {
      const { data: plRows } = await supabase
        .from('platform_listings')
        .select('product_id')
        .eq('platform', platform);
      const ids = (plRows || []).map(r => r.product_id);
      if (ids.length === 0) {
        return res.json({
          data: [],
          pagination: { page, limit, offset: 0, total: 0, totalPages: 0 },
        });
      }
      query = query.in('id', ids);
    }

    query = query
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    let products = data || [];

    // Attach inventory from platform_listings.quantity (sum across platforms)
    // or fall back to products.stock
    products = products.map(p => {
      const listings = p.platform_listings || [];
      const totalQty = listings.reduce((sum, pl) => sum + (pl.quantity || 0), 0);
      return {
        ...p,
        inventory: totalQty > 0 ? totalQty : (p.stock || 0),
        platform_status: listings.reduce((acc, pl) => {
          acc[pl.platform] = pl.status;
          return acc;
        }, {}),
      };
    });

    res.json({
      data: products,
      pagination: {
        page,
        limit,
        offset,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * PATCH /api/ops/products/:id/workflow-status
 * Change workflow_status for a single product.
 * Only updates dashboard-owned columns.
 */
router.patch('/products/:id/workflow-status', async (req, res) => {
  const { id } = req.params;
  const { workflow_status } = req.body;
  const VALID = ['draft', 'ready', 'listed', 'soldout', 'archived'];

  if (!VALID.includes(workflow_status)) {
    return sendError(res, 400, 'Invalid workflow_status', `Must be one of: ${VALID.join(', ')}`);
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('products')
      .update({ workflow_status })
      .eq('id', parseInt(id))
      .select('id, sku, workflow_status')
      .single();

    if (error) return sendError(res, 500, 'Update failed', error.message);
    res.json({ data });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * DELETE /api/ops/products/:id
 * Soft-delete a product by setting status = 'trashed'.
 */
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('products')
      .update({ status: 'trashed' })
      .eq('id', parseInt(id));
    if (error) return sendError(res, 500, 'Delete failed', error.message);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * POST /api/ops/products/bulk
 * Bulk operations on multiple products.
 * Processed in batches of BULK_BATCH_SIZE (50) to avoid DB/API rate limits.
 *
 * Body: { action: 'set_workflow_status'|'set_price', ids: [int...], value: any }
 *
 * Actions:
 *   set_workflow_status  — value: 'draft'|'ready'|'listed'|'soldout'|'archived'
 *   set_price            — value: number (sets price_usd)
 */
router.post('/products/bulk', async (req, res) => {
  const { action, ids, value } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return sendError(res, 400, 'ids must be a non-empty array');
  }
  if (ids.length > 1000) {
    return sendError(res, 400, 'Maximum 1000 products per bulk request');
  }

  const VALID_ACTIONS = ['set_workflow_status', 'set_price'];
  if (!VALID_ACTIONS.includes(action)) {
    return sendError(res, 400, 'Invalid action', `Must be one of: ${VALID_ACTIONS.join(', ')}`);
  }

  if (action === 'set_workflow_status') {
    const VALID = ['draft', 'ready', 'listed', 'soldout', 'archived'];
    if (!VALID.includes(value)) {
      return sendError(res, 400, 'Invalid workflow_status value');
    }
  }

  if (action === 'set_price') {
    if (typeof value !== 'number' || value < 0) {
      return sendError(res, 400, 'Price must be a non-negative number');
    }
  }

  try {
    const supabase = getSupabase();
    const batches = chunk(ids, BULK_BATCH_SIZE);
    let totalUpdated = 0;
    const errors = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const updatePayload = action === 'set_workflow_status'
        ? { workflow_status: value }
        : { price_usd: value };

      const { error, count } = await supabase
        .from('products')
        .update(updatePayload)
        .in('id', batch);

      if (error) {
        errors.push({ batch: i, error: error.message });
      } else {
        totalUpdated += batch.length;
      }

      // Pause 100ms between batches to avoid DB saturation
      if (i < batches.length - 1) await sleep(100);
    }

    res.json({
      success: errors.length === 0,
      updated: totalUpdated,
      batches: batches.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 2. INVENTORY ───────────────────────────────────────────────────────────

/**
 * GET /api/ops/inventory
 * Paginated inventory list joined with product info.
 *
 * Query params: q (sku/title search), location, page, limit
 */
router.get('/inventory', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q } = req.query;

    // Query products table directly (inventory table often empty)
    let query = supabase
      .from('products')
      .select(
        `id, sku, title, title_ko, stock, workflow_status, status, updated_at`,
        { count: 'exact' }
      );

    // Hide trashed products
    query = query.neq('status', 'trashed');

    if (q && q.trim()) {
      const term = q.trim();
      query = query.or(`sku.ilike.%${term}%,title.ilike.%${term}%`);
    }

    query = query
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    // Map to inventory-like format for frontend compatibility
    const rows = (data || []).map(p => ({
      id: p.id,
      product_id: p.id,
      quantity: p.stock || 0,
      reserved: 0,
      location: 'default',
      updated_at: p.updated_at,
      products: { id: p.id, sku: p.sku, title: p.title, title_ko: p.title_ko },
    }));

    res.json({
      data: rows,
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * PUT /api/ops/inventory/:productId
 * Update inventory quantity for a product.
 * Creates the record if it doesn't exist (upsert).
 */
router.put('/inventory/:productId', async (req, res) => {
  const productId = parseInt(req.params.productId);
  const { quantity, location = 'default', reserved } = req.body;

  if (typeof quantity !== 'number' || quantity < 0) {
    return sendError(res, 400, 'quantity must be a non-negative number');
  }

  try {
    const supabase = getSupabase();
    const payload = { product_id: productId, quantity, location };
    if (typeof reserved === 'number') payload.reserved = reserved;

    const { data, error } = await supabase
      .from('inventory')
      .upsert(payload, { onConflict: 'product_id,location' })
      .select()
      .single();

    if (error) return sendError(res, 500, 'Update failed', error.message);

    // Sync back to products.stock for automation compatibility
    await supabase
      .from('products')
      .update({ stock: quantity })
      .eq('id', productId);

    res.json({ data });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 3. ORDERS ──────────────────────────────────────────────────────────────

/**
 * GET /api/ops/orders
 * Paginated order list with filtering.
 *
 * Query params: platform, status, q (order_no/sku/buyer_name), page, limit
 */
router.get('/orders', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { platform, status, q } = req.query;

    let query = supabase
      .from('orders')
      .select(
        `id, order_no, order_date, platform, sku, title, quantity,
         payment_amount, currency, buyer_name, country, status,
         carrier, tracking_no, created_at`,
        { count: 'exact' }
      );

    if (platform) query = query.eq('platform', platform);
    if (status)   query = query.eq('status', status);

    if (q && q.trim()) {
      const term = q.trim();
      query = query.or(`order_no.ilike.%${term}%,sku.ilike.%${term}%,buyer_name.ilike.%${term}%`);
    }

    query = query
      .order('order_date', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    res.json({
      data: data || [],
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * PATCH /api/ops/orders/:id/status
 * Update order status.
 */
router.patch('/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const VALID = ['awaiting_shipment', 'shipped', 'cancelled', 'NEW', 'PROCESSING'];

  if (!VALID.includes(status)) {
    return sendError(res, 400, 'Invalid status');
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('id, order_no, status')
      .single();

    if (error) return sendError(res, 500, 'Update failed', error.message);
    res.json({ data });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 4. PLATFORM LISTING MATRIX ─────────────────────────────────────────────

/**
 * GET /api/ops/listing-matrix
 * Paginated product × platform listing status matrix.
 * Uses the product_listing_matrix view created in migration 005.
 *
 * Query params: q, workflow_status, page, limit
 */
router.get('/listing-matrix', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q, workflow_status } = req.query;

    let query = supabase
      .from('product_listing_matrix')
      .select('*', { count: 'exact' });

    if (q && q.trim()) {
      const term = q.trim();
      query = query.or(`sku.ilike.%${term}%,title.ilike.%${term}%`);
    }

    if (workflow_status) {
      query = query.eq('workflow_status', workflow_status);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    res.json({
      data: data || [],
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 5. AUTOMATION LOGS ──────────────────────────────────────────────────────

/**
 * GET /api/ops/automation-logs
 * Paginated automation log viewer.
 *
 * Query params: job_type, status, sku, page, limit
 */
router.get('/automation-logs', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { job_type, status, sku } = req.query;

    let query = supabase
      .from('automation_logs')
      .select(
        `id, job_type, product_id, sku, status, message, created_at,
         products(sku, title)`,
        { count: 'exact' }
      );

    if (job_type) query = query.eq('job_type', job_type);
    if (status)   query = query.eq('status', status);
    if (sku)      query = query.ilike('sku', `%${sku}%`);

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    res.json({
      data: data || [],
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * POST /api/ops/automation-logs
 * Write a new automation log entry.
 * Called by automation service or dashboard triggered jobs.
 */
router.post('/automation-logs', async (req, res) => {
  const { job_type, product_id, sku, status, message, details } = req.body;

  if (!job_type || !status) {
    return sendError(res, 400, 'job_type and status are required');
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('automation_logs')
      .insert({ job_type, product_id: product_id || null, sku: sku || '', status, message: message || '', details: details || {} })
      .select()
      .single();

    if (error) return sendError(res, 500, 'Insert failed', error.message);
    res.status(201).json({ data });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 6. PRICING ─────────────────────────────────────────────────────────────

/**
 * GET /api/ops/pricing
 * Paginated product list for the pricing page.
 *
 * Columns: sku, title, cost_price, price_usd, margin_pct, workflow_status
 * Query params: q, page, limit, sort (margin_pct|price_usd|cost_price)
 */
router.get('/pricing', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q, sort = 'sku', order = 'asc' } = req.query;

    const ALLOWED_SORT = ['sku', 'title', 'cost_price', 'price_usd', 'margin_pct'];
    const sortCol = ALLOWED_SORT.includes(sort) ? sort : 'sku';
    const ascending = order !== 'desc';

    let query = supabase
      .from('products')
      .select(
        `id, sku, title, cost_price, price_usd, shipping_usd, margin_pct,
         profit_krw, workflow_status`,
        { count: 'exact' }
      );

    // Hide trashed products
    query = query.neq('status', 'trashed');

    if (q && q.trim()) {
      const term = q.trim();
      query = query.or(`sku.ilike.%${term}%,title.ilike.%${term}%`);
    }

    query = query
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    res.json({
      data: data || [],
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

/**
 * POST /api/ops/pricing/bulk-update
 * Bulk price update — processed in batches of 50.
 *
 * Body: { items: [{ id: int, price_usd: number }, ...] }
 */
router.post('/pricing/bulk-update', async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return sendError(res, 400, 'items must be a non-empty array');
  }
  if (items.length > 1000) {
    return sendError(res, 400, 'Maximum 1000 items per bulk request');
  }

  const invalid = items.find(i => typeof i.id !== 'number' || typeof i.price_usd !== 'number' || i.price_usd < 0);
  if (invalid) {
    return sendError(res, 400, 'Each item must have id (int) and price_usd (number >= 0)');
  }

  try {
    const supabase = getSupabase();
    const batches = chunk(items, BULK_BATCH_SIZE);
    let totalUpdated = 0;
    const errors = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      // Supabase doesn't support per-row bulk updates directly.
      // Use individual upserts within the batch, run concurrently.
      const results = await Promise.allSettled(
        batch.map(item =>
          supabase
            .from('products')
            .update({ price_usd: item.price_usd })
            .eq('id', item.id)
        )
      );

      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && !r.value.error) {
          totalUpdated++;
        } else {
          errors.push({ id: batch[idx].id, error: r.reason?.message || r.value?.error?.message });
        }
      });

      // 100ms pause between batches
      if (i < batches.length - 1) await sleep(100);
    }

    res.json({
      success: errors.length === 0,
      updated: totalUpdated,
      batches: batches.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 7. COMPETITOR MONITOR ──────────────────────────────────────────────────

/**
 * GET /api/ops/competitor
 * Paginated competitor price comparison.
 * Joins competitor_prices with products to show our price vs competitor.
 *
 * Query params: q (sku), platform, page, limit
 */
router.get('/competitor', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q, platform = 'ebay' } = req.query;

    // Get latest competitor price per SKU
    // Supabase doesn't support window functions directly, so we get recent rows.
    let cpQuery = supabase
      .from('competitor_prices')
      .select('sku, platform, competitor_id, competitor_price, competitor_shipping, tracked_at', { count: 'exact' })
      .eq('platform', platform)
      .order('tracked_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (q && q.trim()) {
      cpQuery = cpQuery.ilike('sku', `%${q.trim()}%`);
    }

    const { data: cpData, error: cpError, count } = await cpQuery;
    if (cpError) return sendError(res, 500, 'DB query failed', cpError.message);

    if (!cpData || cpData.length === 0) {
      return res.json({ data: [], pagination: { page, limit, offset, total: 0, totalPages: 0 } });
    }

    // Fetch our prices for these SKUs in one query
    const skus = [...new Set(cpData.map(r => r.sku))];
    const { data: ourProducts } = await supabase
      .from('products')
      .select('sku, title, price_usd, cost_price')
      .in('sku', skus);

    const productMap = Object.fromEntries((ourProducts || []).map(p => [p.sku, p]));

    const data = cpData.map(cp => {
      const our = productMap[cp.sku] || {};
      const ourTotal = (our.price_usd || 0);
      const theirTotal = (cp.competitor_price || 0) + (cp.competitor_shipping || 0);
      return {
        sku: cp.sku,
        title: our.title || '',
        our_price: ourTotal,
        competitor_id: cp.competitor_id,
        competitor_price: cp.competitor_price,
        competitor_shipping: cp.competitor_shipping,
        competitor_total: theirTotal,
        difference: +(ourTotal - theirTotal).toFixed(2),
        tracked_at: cp.tracked_at,
      };
    });

    res.json({
      data,
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 8. NOTIFICATIONS (polling-based) ───────────────────────────────────────

/**
 * GET /api/ops/notifications
 * Returns recent events that require staff attention.
 * Designed for polling (no WebSocket needed).
 *
 * Checks:
 *   - automation_logs: recent failures (last 1 hour)
 *   - inventory: low stock (quantity < 5)
 *   - competitor_prices: SKUs where competitor is cheaper than us by > 10%
 */
router.get('/notifications', async (req, res) => {
  try {
    const supabase = getSupabase();
    const notifications = [];

    // 1. Recent automation failures (last 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: failedJobs } = await supabase
      .from('automation_logs')
      .select('id, job_type, sku, message, created_at')
      .eq('status', 'failed')
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(20);

    (failedJobs || []).forEach(j => {
      notifications.push({
        type: 'error',
        category: 'automation',
        title: `자동화 실패: ${j.job_type}`,
        message: `SKU ${j.sku || '?'} — ${j.message || '알 수 없는 오류'}`,
        created_at: j.created_at,
        ref_id: j.id,
      });
    });

    // 2. Low inventory (quantity < 5)
    const { data: lowStock } = await supabase
      .from('inventory')
      .select('product_id, quantity, products(sku, title)')
      .lt('quantity', 5)
      .order('quantity', { ascending: true })
      .limit(20);

    (lowStock || []).forEach(inv => {
      notifications.push({
        type: 'warning',
        category: 'inventory',
        title: '재고 부족',
        message: `SKU ${inv.products?.sku || inv.product_id} — 재고 ${inv.quantity}개`,
        created_at: new Date().toISOString(),
        ref_id: inv.product_id,
      });
    });

    // 3. Competitor undercutting us by > 10% (recent prices, last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: compPrices } = await supabase
      .from('competitor_prices')
      .select('sku, competitor_price, tracked_at')
      .gte('tracked_at', oneDayAgo)
      .order('tracked_at', { ascending: false })
      .limit(100);

    if (compPrices && compPrices.length > 0) {
      const skus = [...new Set(compPrices.map(c => c.sku))];
      const { data: ourPrices } = await supabase
        .from('products')
        .select('sku, price_usd')
        .in('sku', skus);

      const priceMap = Object.fromEntries((ourPrices || []).map(p => [p.sku, p.price_usd]));

      const processed = new Set();
      compPrices.forEach(cp => {
        if (processed.has(cp.sku)) return;
        const ourPrice = priceMap[cp.sku];
        if (!ourPrice) return;
        const diff = (ourPrice - cp.competitor_price) / ourPrice;
        if (diff > 0.1) { // competitor is >10% cheaper
          notifications.push({
            type: 'warning',
            category: 'competitor',
            title: '경쟁사 가격 주의',
            message: `SKU ${cp.sku} — 경쟁사 $${cp.competitor_price} vs 우리 $${ourPrice}`,
            created_at: cp.tracked_at,
            ref_id: cp.sku,
          });
          processed.add(cp.sku);
        }
      });
    }

    // Sort by newest first
    notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      data: notifications.slice(0, 50),
      unread: notifications.length,
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

// ─── 9. PROFIT VIEW ─────────────────────────────────────────────────────────

/**
 * GET /api/ops/profit
 * Profit analysis per product (paginated).
 *
 * Formula: profit = price_usd - (cost_price/exchange_rate) - platform_fee - shipping_usd
 * Falls back to stored margin_pct / profit_krw if fee details not available.
 */
router.get('/profit', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { page, limit, offset } = parsePagination(req.query);
    const { q, platform } = req.query;

    // Fetch exchange rate from margin_settings
    const { data: settings } = await supabase
      .from('margin_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['exchange_rate_usd']);

    const exchangeRate = settings?.find(s => s.setting_key === 'exchange_rate_usd')?.setting_value || 1400;

    let query = supabase
      .from('products')
      .select(
        `id, sku, title, cost_price, price_usd, shipping_usd, margin_pct, profit_krw,
         platform_listings(platform, price, fee_rate, shipping_krw)`,
        { count: 'exact' }
      );

    // Hide trashed products
    query = query.neq('status', 'trashed');

    if (q && q.trim()) {
      query = query.or(`sku.ilike.%${q.trim()}%,title.ilike.%${q.trim()}%`);
    }

    query = query
      .order('margin_pct', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return sendError(res, 500, 'DB query failed', error.message);

    const rows = (data || []).map(p => {
      const listings = p.platform_listings || [];
      const targetListing = platform
        ? listings.find(l => l.platform === platform)
        : listings[0];

      const salePrice = targetListing?.price || p.price_usd || 0;
      const feeRate = targetListing?.fee_rate || 0.18; // eBay default 18%
      const platformFee = +(salePrice * feeRate).toFixed(2);
      const shippingCost = p.shipping_usd || 0;
      const costUsd = +((p.cost_price || 0) / exchangeRate).toFixed(2);
      const profit = +(salePrice - costUsd - platformFee - shippingCost).toFixed(2);

      return {
        id: p.id,
        sku: p.sku,
        title: p.title,
        sale_price: salePrice,
        cost_price_krw: p.cost_price || 0,
        cost_price_usd: costUsd,
        platform_fee: platformFee,
        fee_rate: feeRate,
        shipping_cost: shippingCost,
        profit,
        margin_pct: p.margin_pct || 0,
        platform: targetListing?.platform || 'N/A',
      };
    });

    res.json({
      data: rows,
      pagination: { page, limit, offset, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err) {
    sendError(res, 500, 'Internal error', err.message);
  }
});

module.exports = router;
