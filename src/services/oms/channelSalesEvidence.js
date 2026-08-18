/**
 * src/services/oms/channelSalesEvidence.js — Phase 7A-3d · READ-ONLY.
 *
 * Owner directive:
 *   Historical window coverage is decided by historical_sync_runs provenance,
 *   NOT by oms_orders.imported_at min. A complete sync of the last 30d run
 *   yesterday still constitutes 30d coverage.
 *
 *   Multi-channel aggregation: each channel is reported separately. `overall`
 *   is UNKNOWN unless every relevant channel has trusted evidence. Shopify
 *   complete + eBay unsupported → overall UNKNOWN.
 *
 * NEVER writes. Reuses existing physicalSpecificCoverage for per-channel physical trust.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { analysePhysicalIdentityCoverage } = require('./physicalSpecificCoverage');

const ONE_DAY_MS = 24 * 3600 * 1000;
const WINDOW_END_TOLERANCE_MS = 24 * 3600 * 1000;   // end within past 24h counts as fresh

/**
 * @typedef {Object} ChannelWindowStatus
 * @property {'shopify'|'ebay'|string} channel
 * @property {'complete'|'partial'|'failed'|'unsupported'|'no_provenance'} status
 * @property {boolean} window_complete
 * @property {Object|null} provenance    latest matching historical_sync_runs row (id/window/status/…)
 * @property {number|null} covered_days
 * @property {string|null} covered_start
 * @property {string|null} covered_end
 * @property {string} note
 */

/**
 * Look up the latest historical_sync_runs row that authoritatively covers the
 * requested window for a channel. Returns window_complete=true only when:
 *   - a row exists with status='complete' AND is_complete=true
 *   - its window covers [now-daysN, now-tolerance]
 *   - it was NOT truncated by limit
 *
 * Rows with status='skipped_unsupported' (e.g. eBay) return status='unsupported'.
 *
 * @param {string} channel
 * @param {number} daysN
 */
async function getChannelWindowStatus(channel, daysN = 30) {
  const db = getClient();
  const nowMs = Date.now();
  const requiredStartMs = nowMs - daysN * ONE_DAY_MS;
  const freshCutoffMs = nowMs - WINDOW_END_TOLERANCE_MS;

  const { data: rows, error } = await db.from('historical_sync_runs')
    .select('id, channel, status, is_complete, window_start, window_end, requested_days, completed_at, metadata, error_message')
    .eq('channel', channel)
    .order('completed_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  const runs = rows || [];

  // Any unsupported marker?
  const unsupported = runs.find(r => r.status === 'skipped_unsupported');
  if (runs.length === 0) {
    return _statusObj(channel, 'no_provenance', false, null, null, null, null, 'no historical_sync_runs row for this channel');
  }
  if (unsupported && !runs.find(r => r.status === 'complete' && r.is_complete)) {
    return _statusObj(channel, 'unsupported', false, unsupported, null, null, null,
      unsupported.error_message || 'channel marked unsupported for historical velocity');
  }

  // Best complete run whose window covers the requested one
  for (const r of runs) {
    if (r.status !== 'complete' || r.is_complete !== true) continue;
    const wsMs = r.window_start ? new Date(r.window_start).getTime() : null;
    const weMs = r.window_end   ? new Date(r.window_end).getTime()   : null;
    if (wsMs == null || weMs == null) continue;
    const truncated = !!(r.metadata && r.metadata.truncated_by_limit);
    if (truncated) continue;
    if (wsMs <= requiredStartMs && weMs >= freshCutoffMs) {
      const coveredDays = Math.floor((weMs - wsMs) / ONE_DAY_MS);
      return _statusObj(channel, 'complete', true, r,
        coveredDays, r.window_start, r.window_end,
        `historical_sync_runs#${r.id} covers ${coveredDays}d ending ${r.window_end}`);
    }
  }

  // Fall through: latest partial/failed run for diagnostic
  const latest = runs[0];
  const s = latest.status === 'partial' ? 'partial' : latest.status === 'failed' ? 'failed' : 'no_provenance';
  return _statusObj(channel, s, false, latest, null, latest.window_start, latest.window_end,
    latest.error_message || `latest run status=${latest.status}`);
}

function _statusObj(channel, status, complete, provenance, coveredDays, coveredStart, coveredEnd, note) {
  return {
    channel, status, window_complete: complete,
    provenance: provenance ? {
      id: provenance.id, status: provenance.status, is_complete: provenance.is_complete,
      window_start: provenance.window_start, window_end: provenance.window_end,
      requested_days: provenance.requested_days, completed_at: provenance.completed_at,
      truncated_by_limit: !!(provenance.metadata && provenance.metadata.truncated_by_limit),
      error_message: provenance.error_message ?? null,
    } : null,
    covered_days: coveredDays, covered_start: coveredStart, covered_end: coveredEnd,
    note,
  };
}

// ─────────────────────────────────────────────────────────────
// Multi-channel physical sales aggregation
// ─────────────────────────────────────────────────────────────

/**
 * Combine per-channel physical evidence into a single overall trust decision.
 *
 * Each channel report:
 *   - channel_window: ChannelWindowStatus
 *   - physical_coverage: PhysicalCoverageReport (Phase 7A-3c)
 *   - shopify_style aggregate: shipped_units_7d, shipped_units_30d
 *   - channel_zero_is_legitimate: window_complete AND physical trusted AND shipped=0
 *
 * Overall:
 *   - if every channel: window_complete AND physically trusted → overall trusted
 *     · overall_units = sum of per-channel shipped_units
 *   - else → overall UNKNOWN
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.days=30]
 * @param {string[]} [args.channels=['shopify','ebay']]
 */
async function computeMultiChannelPhysicalSales({ physicalProductId, days = 30, channels = ['shopify', 'ebay'] } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const daysN = Math.max(1, Math.min(365, parseInt(days, 10) || 30));

  const perChannel = [];
  for (const ch of channels) {
    const win = await getChannelWindowStatus(ch, daysN);
    const phys = await analysePhysicalIdentityCoverage({ physicalProductId, channel: ch, days: daysN });
    const shippedUnits7 = phys.physical_units_shipped_7d;
    const shippedUnits30 = phys.physical_units_shipped_30d;
    const channelTrusted = win.window_complete && phys.velocity_trusted;
    const channelZeroLegitimate = channelTrusted && shippedUnits30 === 0 && phys.potential_unmapped_same_physical === 0;

    perChannel.push({
      channel: ch,
      channel_window: win,
      physical_coverage: phys,
      shipped_units_7d: shippedUnits7,
      shipped_units_30d: shippedUnits30,
      channel_trusted: channelTrusted,
      channel_zero_is_legitimate: channelZeroLegitimate,
      trust_reason: channelTrusted
        ? (channelZeroLegitimate ? 'legitimate_zero_full_coverage' : 'trusted_with_shipments')
        : _explainUntrust(win, phys),
    });
  }

  // Overall aggregate — every channel must be trusted for overall trust
  const allTrusted = perChannel.length > 0 && perChannel.every(c => c.channel_trusted);
  const anyUnsupported = perChannel.some(c => c.channel_window.status === 'unsupported');
  const overallTrusted = allTrusted && !anyUnsupported;

  let overallUnits7 = null, overallUnits30 = null;
  if (overallTrusted) {
    overallUnits7  = perChannel.reduce((a, c) => a + (Number(c.shipped_units_7d) || 0), 0);
    overallUnits30 = perChannel.reduce((a, c) => a + (Number(c.shipped_units_30d) || 0), 0);
  }

  return {
    physical_product_id: physicalProductId,
    days: daysN,
    per_channel: perChannel,
    overall: {
      trusted: overallTrusted,
      sales_units_7d: overallUnits7,
      sales_units_30d: overallUnits30,
      sales_velocity_7d: overallTrusted ? (overallUnits7 / 7) : null,
      sales_velocity_30d: overallTrusted ? (overallUnits30 / 30) : null,
      trust_gate_reason: overallTrusted
        ? 'all_channels_trusted'
        : (anyUnsupported ? 'some_channel_unsupported' : _summariseUntrustedChannels(perChannel)),
      coverage_summary: perChannel.map(c => `${c.channel}=${c.channel_window.status}${c.channel_trusted ? '·trusted' : '·untrusted'}`).join(' · '),
    },
    generated_at: new Date().toISOString(),
  };
}

function _explainUntrust(win, phys) {
  if (!win.window_complete) return `window_${win.status}`;
  if (!phys.velocity_trusted) return `physical_${phys.trust_reason ?? 'untrusted'}`;
  return 'unknown';
}

function _summariseUntrustedChannels(perChannel) {
  return perChannel.filter(c => !c.channel_trusted).map(c => `${c.channel}:${c.trust_reason}`).join(' · ');
}

module.exports = {
  getChannelWindowStatus,
  computeMultiChannelPhysicalSales,
};
