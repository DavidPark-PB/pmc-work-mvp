'use strict';

/**
 * src/services/shipping/rateMasterRepository.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Thin read-only accessor over the 5 shipping_rate_master tables.
 *
 * All lookups pass through the CURRENT active version for a given provider
 * (default 'eGS'). If no active version exists the caller receives an
 * explicit null / empty result — never a silent fallback to another version
 * or, worse, to the legacy hardcoded rate tables (owner directive §1).
 *
 * Batch-friendly API — call getActiveVersion() once and pass its `id` into
 * subsequent lookups to keep a large auto-listing batch to one round trip
 * for the version (single SQL SELECT ... IN (...) for brackets).
 */

const { getClient } = require('../../db/supabaseClient');

async function getActiveVersion(supabase, provider = 'eGS') {
  const db = supabase || getClient();
  const res = await db
    .from('shipping_rate_versions')
    .select('id, provider, source_name, effective_from, effective_to, status, imported_at')
    .eq('provider', provider)
    .eq('status', 'active')
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data || null;
}

async function listServices(supabase, versionId) {
  const db = supabase || getClient();
  const res = await db
    .from('shipping_services')
    .select('service_code, service_name, vol_divisor, sale_type, incoterm, rate_loaded, perkg_surcharge_krw, coverage, active')
    .eq('rate_version_id', versionId)
    .eq('active', true);
  if (res.error) throw res.error;
  return res.data || [];
}

async function getService(supabase, versionId, serviceCode) {
  const db = supabase || getClient();
  const res = await db
    .from('shipping_services')
    .select('*')
    .eq('rate_version_id', versionId)
    .eq('service_code', serviceCode)
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data || null;
}

async function getCountry(supabase, versionId, countryCode) {
  const db = supabase || getClient();
  const res = await db
    .from('shipping_countries')
    .select('country_code, country_name, express_zone, is_eu, vat_rate, benchmark_service_code')
    .eq('rate_version_id', versionId)
    .eq('country_code', String(countryCode || '').toUpperCase())
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data || null;
}

/**
 * Round-up bracket lookup (owner directive §4).
 *   Chooses the smallest weight_to_kg >= chargeableKg for the given service,
 *   with country/zone matching. Never rounds down.
 *
 * @returns { base_rate, weight_to_kg, currency } or null if no bracket covers the weight.
 */
async function findApplicableBracket(supabase, versionId, serviceCode, opts) {
  const db = supabase || getClient();
  const { chargeableKg, countryCode, zoneCode } = opts || {};
  if (!(chargeableKg > 0)) throw new Error('chargeableKg must be positive');
  let q = db
    .from('shipping_rate_brackets')
    .select('country_key, zone_key, weight_to_kg, base_rate, currency, note')
    .eq('rate_version_id', versionId)
    .eq('service_code', serviceCode)
    .eq('active', true)
    .gte('weight_to_kg', chargeableKg)
    .order('weight_to_kg', { ascending: true })
    .limit(50);
  const res = await q;
  if (res.error) throw res.error;
  const rows = res.data || [];
  if (rows.length === 0) return null;
  //   Prefer exact country_key match; then zone match; then '__ALL__'.
  //   Priority: country == countryCode > zone_key == zoneCode > country_key == '__ALL__' or '__ZONE__'.
  const upper = countryCode ? String(countryCode).toUpperCase() : null;
  const zone  = zoneCode ? String(zoneCode).toUpperCase() : null;
  let pick =
    rows.find(r => upper && r.country_key === upper) ||
    rows.find(r => zone  && r.zone_key    === zone)  ||
    rows.find(r => r.country_key === '__ALL__' || r.country_key === '__ZONE__') ||
    rows.find(r => r.country_key === null);
  if (!pick) return null;
  return pick;
}

async function listEnabledSurcharges(supabase, versionId) {
  const db = supabase || getClient();
  const res = await db
    .from('shipping_surcharges')
    .select('rule_code, scope, value, unit, enabled, effective_from, effective_to, note')
    .eq('rate_version_id', versionId)
    .eq('enabled', true);
  if (res.error) throw res.error;
  return res.data || [];
}

module.exports = {
  getActiveVersion,
  listServices,
  getService,
  getCountry,
  findApplicableBracket,
  listEnabledSurcharges,
};
