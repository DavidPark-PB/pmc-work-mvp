'use strict';
/**
 * b2cChannelMatrix.js — B2C Inventory Distribution OS · Phase 3 · Channel Matrix API.
 *
 * Endpoints (server.js: /api/b2c/sku 로 mount):
 *   GET  /:id/channel-matrix       · 로그인 필요 (authGuard)
 *   PATCH /:id/eligibility         · requireAdmin
 *
 * Owner directive (2026-08-25):
 *   · 자동 Task 대상 채널 4개: coupang, naver, 11st, gmarket (Phase 3 UI 표시는 6개)
 *   · V1 표시 채널: ebay, shopify, coupang, naver, 11st, gmarket
 *   · channel_eligibility NULL 은 "모두 eligible" 이 아님 · config default_eligibility_mode 로 처리
 *   · 직원은 eligibility 수정 불가 (PATCH 는 requireAdmin)
 *
 * Pure logic (validation · matrix build · eligibility 계산) 은 별도 helper 로 분리해
 * unit-test 가능하게 만들었다. 이 파일은 HTTP + DB 얇은 wrapper 만 담당.
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../../db/supabaseClient');
const { authGuard, requireAdmin } = require('../../middleware/auth');
const helpers = require('../../services/b2cInventory/channelMatrixHelpers');

//   ── GET /:id/channel-matrix ──────────────────────────────────
router.get('/:id/channel-matrix', authGuard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const db = getClient();

    //   1. sku_master row
    const { data: sku, error: e1 } = await db.from('sku_master')
      .select('id, internal_sku, title, status, cost_krw, channel_eligibility')
      .eq('id', id)
      .maybeSingle();
    if (e1) throw e1;
    if (!sku) return res.status(404).json({ error: 'SKU not found' });

    //   2. v_sku_channel_matrix rows for this SKU (dedup 완료)
    const { data: matrixRows, error: e2 } = await db.from('v_sku_channel_matrix')
      .select('channel, listing_id, marketplace_sku, raw_status, channel_status, selling_price, selling_currency, listing_url, last_checked_at')
      .eq('sku_master_id', id);
    if (e2) throw e2;

    //   3. config: b2c.default_eligibility_mode (0=NONE, 1=KOREA_ALL)
    const { data: cfgRows } = await db.from('margin_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['b2c.default_eligibility_mode']);
    const defaultMode = Number((cfgRows || []).find(r => r.setting_key === 'b2c.default_eligibility_mode')?.setting_value || 0);

    const built = helpers.buildMatrixResponse(matrixRows, sku.channel_eligibility);

    res.json({
      data: {
        sku_master_id:              sku.id,
        internal_sku:               sku.internal_sku,
        title:                      sku.title,
        cost_krw:                   sku.cost_krw,
        channel_eligibility:        sku.channel_eligibility,
        eligibility_state:          helpers.computeEligibilityState(sku.channel_eligibility),
        default_eligibility_mode:   defaultMode,
        display_channels:           helpers.DISPLAY_CHANNELS,
        auto_task_channels:         Array.from(helpers.AUTO_TASK_CHANNELS),
        channels:                   built.channels,
        other_channels:             built.other_channels,
        admin_note:                 helpers.adminNoteFor(sku.channel_eligibility, defaultMode),
      },
    });
  } catch (e) {
    console.error('[b2cChannelMatrix] GET error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── PATCH /:id/eligibility (admin only) ─────────────────────
//   Body: { channel_eligibility: [...channels] | null }
router.patch('/:id/eligibility', authGuard, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const validation = helpers.validateEligibilityBody(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const newVal = validation.value;

    const db = getClient();
    //   기존 값 확인 (감사 · 로그용)
    const { data: before, error: eBefore } = await db.from('sku_master')
      .select('id, internal_sku, channel_eligibility')
      .eq('id', id)
      .maybeSingle();
    if (eBefore) throw eBefore;
    if (!before) return res.status(404).json({ error: 'SKU not found' });

    const { data: updated, error: eUpd } = await db.from('sku_master')
      .update({ channel_eligibility: newVal, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, internal_sku, channel_eligibility, updated_at')
      .maybeSingle();
    if (eUpd) throw eUpd;

    console.log('[b2cChannelMatrix] eligibility updated', {
      sku_id: id,
      internal_sku: before.internal_sku,
      before: before.channel_eligibility,
      after: newVal,
      by_user_id: req.user?.id,
      by_user: req.user?.username,
    });

    res.json({ data: updated, before: before.channel_eligibility });
  } catch (e) {
    console.error('[b2cChannelMatrix] PATCH error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports._internal = helpers;
