/**
 * SKU Enrichment routes — Owner Directive 2026-08-31 · V1
 * Atomicity upgrade (2026-09-01): sku_master + history 저장을 Postgres RPC 로 통합
 *   (마이그 106 · update_sku_cost_atomic · update_sku_supplier_atomic).
 *
 * Purpose:
 *   배송관리 화면에서 직원이 원가 / 소싱처를 한 번 입력하면 다음 동일 SKU 주문에서
 *   자동으로 불러올 수 있도록 sku_master 를 업데이트하고 이력을 남긴다.
 *
 * Endpoints:
 *   PATCH /api/sku-master/:internalSku/cost      · cost_krw 저장 + audit (single tx)
 *   PATCH /api/sku-master/:internalSku/supplier  · supplier 저장 + history (single tx)
 *   GET   /api/sku-master/:internalSku/enrichment · 현재 상태 + 최근 이력 조회
 *
 * suppliers CRUD 는 기존 /api/suppliers (routes/suppliers.js) 재사용.
 * 자동완성 필터는 프론트에서 client-side (list 500개 이하 예상).
 *
 * Safety:
 *   - Additive · 기존 데이터 삭제/덮어쓰기 없이 · 변경 시 이전값 이력 저장.
 *   - source tracking · 어디서 입력된 값인지 매번 기록 (shipping_manual · owner_correction 등).
 *   - AI 추정 없음 · 사용자 입력만.
 *   - Atomic · Postgres function 안에서 실행 → 중간 실패 시 전체 rollback.
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();
router.use(requireAdmin);

const VALID_SOURCES = new Set([
  'shipping_measured',
  'shipping_manual',
  'purchase_import',
  'owner_correction',
  'legacy_import',
]);
const DEFAULT_SOURCE = 'shipping_manual';

function sanitizeSource(src) {
  if (!src) return DEFAULT_SOURCE;
  const s = String(src).trim().toLowerCase();
  return VALID_SOURCES.has(s) ? s : DEFAULT_SOURCE;
}

// Postgres error code → HTTP status
//   P0002 = 존재 안 함 · 22023 = invalid input · else 500
function pgErrorToStatus(error) {
  if (!error) return 500;
  const code = error.code || '';
  if (code === 'P0002') return 404;
  if (code === '22023') return 400;
  return 500;
}

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/sku-master/:internalSku/cost
//   body: { cost_krw: number, source?: string, source_ref?: string, reason?: string }
// ══════════════════════════════════════════════════════════════════════════
router.patch('/sku-master/:internalSku/cost', async (req, res) => {
  try {
    const internalSku = String(req.params.internalSku || '').trim();
    if (!internalSku) return res.status(400).json({ success: false, error: 'internalSku 필요' });

    const cost = Number(req.body?.cost_krw);
    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ success: false, error: 'cost_krw 는 0 이상의 숫자여야 합니다' });
    }
    const source = sanitizeSource(req.body?.source);
    const sourceRef = req.body?.source_ref ? String(req.body.source_ref).slice(0, 500) : null;
    const reason    = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
    const changedBy = req.user?.id || null;

    const db = getClient();
    const { data, error } = await db.rpc('update_sku_cost_atomic', {
      p_internal_sku:  internalSku,
      p_new_cost_krw:  cost,
      p_source:        source,
      p_source_ref:    sourceRef,
      p_reason:        reason,
      p_changed_by:    changedBy,
    });
    if (error) {
      return res.status(pgErrorToStatus(error)).json({
        success: false,
        error: error.message,
        pg_code: error.code || null,
      });
    }

    // data = { sku_master_id, unchanged, cost_krw, previous_cost_krw, changed_at? }
    res.json({
      success: true,
      sku: internalSku,
      cost_krw: cost,
      previous_cost_krw: data?.previous_cost_krw != null ? Number(data.previous_cost_krw) : null,
      source,
      unchanged: !!data?.unchanged,
      atomic: true,
    });
  } catch (e) {
    console.error('[skuEnrichment/cost] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/sku-master/:internalSku/supplier
//   body: {
//     supplier_id?: number,      · 기존 suppliers 선택 (우선)
//     supplier_name?: string,    · supplier_id 없을 때 free-text (자유 등록 — history 만 남음)
//     purchase_price?: number,
//     currency?: string,
//     quantity?: number,
//     purchased_at?: 'YYYY-MM-DD',
//     source?: string,           · 기본 shipping_manual
//     source_ref?: string,       · 예: 주문번호
//     note?: string,
//     set_as_current?: boolean   · true 면 sku_master.supplier_id 도 업데이트 (default true when supplier_id 제공)
//   }
// ══════════════════════════════════════════════════════════════════════════
router.patch('/sku-master/:internalSku/supplier', async (req, res) => {
  try {
    const internalSku = String(req.params.internalSku || '').trim();
    if (!internalSku) return res.status(400).json({ success: false, error: 'internalSku 필요' });

    const body = req.body || {};
    const supplierId = body.supplier_id != null && Number.isFinite(Number(body.supplier_id))
      ? Number(body.supplier_id) : null;
    const supplierName = body.supplier_name ? String(body.supplier_name).trim().slice(0, 200) : null;

    if (!supplierId && !supplierName) {
      return res.status(400).json({ success: false, error: 'supplier_id 또는 supplier_name 필요' });
    }

    const purchasePrice = body.purchase_price != null && Number.isFinite(Number(body.purchase_price))
      ? Number(body.purchase_price) : null;
    const currency  = body.currency ? String(body.currency).trim().slice(0, 10) : (purchasePrice != null ? 'KRW' : null);
    const quantity  = body.quantity != null && Number.isFinite(Number(body.quantity)) ? Number(body.quantity) : null;
    const purchasedAt = body.purchased_at ? String(body.purchased_at).slice(0, 10) : null;
    const source     = sanitizeSource(body.source);
    const sourceRef  = body.source_ref ? String(body.source_ref).slice(0, 500) : null;
    const note       = body.note ? String(body.note).slice(0, 1000) : null;
    const setAsCurrent = body.set_as_current === false ? false : !!(supplierId || body.set_as_current);
    const changedBy  = req.user?.id || null;

    const db = getClient();
    const { data, error } = await db.rpc('update_sku_supplier_atomic', {
      p_internal_sku:   internalSku,
      p_supplier_id:    supplierId,
      p_supplier_name:  supplierName,
      p_purchase_price: purchasePrice,
      p_currency:       currency,
      p_quantity:       quantity,
      p_purchased_at:   purchasedAt,
      p_source:         source,
      p_source_ref:     sourceRef,
      p_note:           note,
      p_set_as_current: setAsCurrent,
      p_created_by:     changedBy,
    });
    if (error) {
      return res.status(pgErrorToStatus(error)).json({
        success: false,
        error: error.message,
        pg_code: error.code || null,
      });
    }

    // data = { sku_master_id, history_id, supplier_id_set, resolved_supplier_name }
    res.json({
      success: true,
      sku: internalSku,
      history_id: data?.history_id ?? null,
      supplier_id_set: !!data?.supplier_id_set,
      resolved_supplier_name: data?.resolved_supplier_name || null,
      atomic: true,
    });
  } catch (e) {
    console.error('[skuEnrichment/supplier] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/sku-master/:internalSku/enrichment
//   응답: {
//     sku: { id, internal_sku, title, weight_gram, weight_source, ..., cost_krw, supplier_id, ... },
//     currentSupplier: { id, name, channel } | null,
//     recentCostHistory: [{ new_cost_krw, previous_cost_krw, source, changed_at }, ...],
//     recentSupplierHistory: [{ supplier_name, purchase_price, purchased_at, source }, ...],
//   }
// ══════════════════════════════════════════════════════════════════════════
router.get('/sku-master/:internalSku/enrichment', async (req, res) => {
  try {
    const internalSku = String(req.params.internalSku || '').trim();
    if (!internalSku) return res.status(400).json({ success: false, error: 'internalSku 필요' });
    const db = getClient();

    const { data: sku, error: eGet } = await db
      .from('sku_master')
      .select(`
        id, internal_sku, title,
        weight_gram, weight_status, default_packaging_weight_g, weight_source, weight_measured_at,
        length_cm, width_cm, height_cm, dims_source, dims_measured_at,
        cost_krw, cost_source, cost_updated_at,
        supplier_id, supplier_sku, shipping_group, updated_at
      `)
      .eq('internal_sku', internalSku)
      .maybeSingle();
    if (eGet) return res.status(500).json({ success: false, error: `sku_master 조회 실패: ${eGet.message}` });
    if (!sku) return res.status(404).json({ success: false, error: 'sku_master 에 internal_sku 없음' });

    let currentSupplier = null;
    if (sku.supplier_id) {
      const { data: sup } = await db
        .from('suppliers').select('id, name, channel, contact').eq('id', sku.supplier_id).maybeSingle();
      currentSupplier = sup || null;
    }

    const { data: costRows } = await db
      .from('sku_cost_history')
      .select('previous_cost_krw, new_cost_krw, currency, source, source_ref, reason, changed_at')
      .eq('sku_master_id', sku.id)
      .order('changed_at', { ascending: false })
      .limit(10);

    const { data: supRows } = await db
      .from('sku_supplier_history')
      .select('supplier_id, supplier_name, purchase_price, currency, quantity, purchased_at, source, source_ref, note, is_preferred, created_at')
      .eq('sku_master_id', sku.id)
      .order('created_at', { ascending: false })
      .limit(10);

    res.json({
      success: true,
      sku,
      currentSupplier,
      recentCostHistory: costRows || [],
      recentSupplierHistory: supRows || [],
    });
  } catch (e) {
    console.error('[skuEnrichment/enrichment] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
