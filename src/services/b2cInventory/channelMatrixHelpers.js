'use strict';
/**
 * channelMatrixHelpers.js — pure helper functions for B2C Channel Matrix API.
 * No I/O · fully unit-testable. Imported by src/web/routes/b2cChannelMatrix.js.
 *
 * Owner directive (2026-08-25):
 *   · channel_eligibility NULL 은 "모두 eligible" 이 아님
 *   · V1 표시 채널 6개: ebay, shopify, coupang, naver, 11st, gmarket
 *   · 자동 Task 대상 4개: coupang, naver, 11st, gmarket
 */

const DISPLAY_CHANNELS = ['ebay', 'shopify', 'coupang', 'naver', '11st', 'gmarket'];
const AUTO_TASK_CHANNELS = new Set(['coupang', 'naver', '11st', 'gmarket']);
//   PATCH 시 허용하는 채널 (관리자가 알 수 없는 값 넣지 못하도록)
const KNOWN_CHANNELS = new Set([
  'ebay', 'shopify', 'coupang', 'naver', '11st', 'gmarket',
  'auction', 'shopee', 'alibaba', 'qoo10', 'other',
]);

//   ── eligibility state (SKU 전체 상태) ─────────────────────
//   returns 'unspecified' | 'none' | 'explicit'
function computeEligibilityState(channel_eligibility) {
  if (channel_eligibility === null || channel_eligibility === undefined) return 'unspecified';
  if (!Array.isArray(channel_eligibility)) return 'unspecified';   //   방어적
  if (channel_eligibility.length === 0) return 'none';
  return 'explicit';
}

//   ── per-channel eligibility ───────────────────────────────
//   returns true | false | null (null = unspecified)
function computeChannelEligibility(channel_eligibility, channel) {
  if (channel_eligibility === null || channel_eligibility === undefined) return null;
  if (!Array.isArray(channel_eligibility)) return null;
  return channel_eligibility.includes(channel);
}

//   ── PATCH body validation ─────────────────────────────────
//   Body: { channel_eligibility: [...channels] | null }
//   returns { ok: true, value: [...] | null } | { ok: false, error: 'msg' }
function validateEligibilityBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body 는 JSON object 여야 함' };
  }
  const raw = body.channel_eligibility;
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'channel_eligibility 는 배열 또는 null 이어야 함' };
  }
  const cleaned = [];
  for (const v of raw) {
    if (typeof v !== 'string') {
      return { ok: false, error: `channel_eligibility 원소는 문자열이어야 함 (got ${typeof v})` };
    }
    const norm = v.trim().toLowerCase();
    if (!KNOWN_CHANNELS.has(norm)) {
      return { ok: false, error: `알 수 없는 채널 값: ${v}` };
    }
    if (!cleaned.includes(norm)) cleaned.push(norm);
  }
  return { ok: true, value: cleaned };
}

//   ── merge matrix rows into fixed 6-channel array ─────────
//   matrixRows: array of { channel, channel_status, listing_id, ... } from v_sku_channel_matrix
//   channel_eligibility: raw from sku_master
//   returns { channels: [ 6 objects · one per DISPLAY_CHANNELS ], other_channels: [] }
function buildMatrixResponse(matrixRows, channel_eligibility) {
  const byChannel = new Map();
  for (const r of (matrixRows || [])) {
    if (r && r.channel) byChannel.set(r.channel, r);
  }
  const channels = DISPLAY_CHANNELS.map(ch => {
    const row = byChannel.get(ch);
    return {
      channel:            ch,
      channel_status:     row ? row.channel_status : 'NONE',
      raw_status:         row ? (row.raw_status ?? null) : null,
      listing_id:         row ? (row.listing_id ?? null) : null,
      listing_url:        row ? (row.listing_url ?? null) : null,
      marketplace_sku:    row ? (row.marketplace_sku ?? null) : null,
      selling_price:      row ? (row.selling_price ?? null) : null,
      selling_currency:   row ? (row.selling_currency ?? null) : null,
      last_checked_at:    row ? (row.last_checked_at ?? null) : null,
      eligible:           computeChannelEligibility(channel_eligibility, ch),
      auto_task_target:   AUTO_TASK_CHANNELS.has(ch),
    };
  });
  const other_channels = Array.from(byChannel.values())
    .filter(r => !DISPLAY_CHANNELS.includes(r.channel))
    .map(r => ({
      channel:          r.channel,
      channel_status:   r.channel_status,
      raw_status:       r.raw_status ?? null,
      listing_id:       r.listing_id ?? null,
      listing_url:      r.listing_url ?? null,
      marketplace_sku:  r.marketplace_sku ?? null,
      selling_price:    r.selling_price ?? null,
      selling_currency: r.selling_currency ?? null,
      last_checked_at:  r.last_checked_at ?? null,
    }));
  return { channels, other_channels };
}

//   ── admin_note (NULL + default_mode=0 일 때만) ────────────
function adminNoteFor(channel_eligibility, default_mode) {
  if (channel_eligibility === null && Number(default_mode) === 0) {
    return 'channel_eligibility 가 NULL 이라 config default_eligibility_mode=0 (NONE) 에 따라 자동 Task 생성 대상이 아닙니다. 명시적으로 채널을 설정하려면 이 화면에서 eligibility 를 지정하세요.';
  }
  return null;
}

module.exports = {
  DISPLAY_CHANNELS,
  AUTO_TASK_CHANNELS,
  KNOWN_CHANNELS,
  computeEligibilityState,
  computeChannelEligibility,
  validateEligibilityBody,
  buildMatrixResponse,
  adminNoteFor,
};
