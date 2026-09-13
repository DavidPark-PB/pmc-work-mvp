'use strict';

/**
 * src/services/shipping/rateMasterImporter.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Reads CCOREA_통합배송비_기본데이터_v1.xlsx (or any workbook with the same 5-sheet
 * contract) and upserts it into the shipping_rate_master tables.
 *
 * Contract:
 *   Required sheets: 국가_Master · 서비스_Master · 운임_Master · 할증_Master · 원본목록
 *   Optional (verification only, NOT imported): 견적계산 · 출고비교
 *
 * Idempotency (owner directive §3):
 *   · A rate_version is uniquely keyed on (provider, source_name, effective_from).
 *   · If the row already exists, importOrPreview returns { alreadyImported: true }
 *     without inserting any child row.
 *   · Prior versions of the same provider flip to status='superseded' (never
 *     deleted). The incoming version begins as 'draft' and only activates
 *     when the caller explicitly promotes it (activateVersion).
 *
 * Two entry points:
 *   parseAndValidate(buffer) → { ok, version, services[], countries[], brackets[],
 *                                surcharges[], errors[], warnings[] }
 *     Read-only; used by the /preview endpoint. NEVER writes to the DB.
 *
 *   importWorkbook(supabase, buffer, { sourceName, provider, effectiveFrom,
 *                                       importedBy }) → { versionId, rowCounts,
 *                                                          alreadyImported, errors[] }
 *     Two-phase:
 *       (1) parseAndValidate — if errors, abort without touching DB.
 *       (2) INSERT version + child rows in a single logical transaction (Supabase
 *           doesn't expose transactions in the JS client; we insert version first,
 *           then children; on child error the version is deleted for rollback).
 *
 * Never reads or writes to `wms_orders` / legacy `orders` / any table outside the
 * 5 shipping_rate_master tables. Never calls a marketplace API.
 */

const { parseXlsxFromBuffer } = require('./xlsxParser');

const REQUIRED_SHEETS = ['국가_Master', '서비스_Master', '운임_Master', '할증_Master', '원본목록'];

//   Header allowlist per sheet (spec §3 of the directive — sheets must not
//   invent columns). Extra columns are ignored; missing REQUIRED columns hard-fail.
const REQUIRED_HEADERS = {
  '국가_Master':   ['country_code', 'country_name', 'is_eu', 'vat_rate_pct', 'benchmark_service'],
  '서비스_Master': ['provider', 'service_code', 'service_name', 'vol_divisor', 'sale_type', 'incoterm', 'rate_loaded'],
  '운임_Master':   ['provider', 'service_code', 'country_key', 'weight_to_kg', 'base_rate', 'currency'],
  '할증_Master':   ['rule_code', 'scope', 'value', 'unit', 'enabled'],
  '원본목록':      ['provider', 'source', 'effective'],
};

//   Truthy/falsy tokens the workbook uses in 'is_eu', 'active', 'rate_loaded', 'enabled'.
function yn(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').trim().toUpperCase();
  return s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1';
}
function toNum(v, def = null) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Read-only parse + validate. Returns a report object; never touches DB.
 * The caller (route /preview) can render this to the operator before commit.
 */
async function parseAndValidate(buffer) {
  const errors = [];
  const warnings = [];
  let sheets;
  try {
    sheets = await parseXlsxFromBuffer(buffer);
  } catch (e) {
    return { ok: false, errors: [`xlsx parse failed: ${e.message}`], warnings: [] };
  }

  //   Sheet presence check.
  for (const name of REQUIRED_SHEETS) {
    if (!sheets.has(name)) errors.push(`missing required sheet: ${name}`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  //   Header presence check per sheet.
  for (const [sheetName, requiredCols] of Object.entries(REQUIRED_HEADERS)) {
    const rows = sheets.get(sheetName) || [];
    if (rows.length === 0) {
      warnings.push(`sheet '${sheetName}' has zero data rows`);
      continue;
    }
    const headerRow = rows[0];
    for (const col of requiredCols) {
      if (!(col in headerRow)) errors.push(`sheet '${sheetName}' missing column: ${col}`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  //   원본목록 → version row.
  //   Spec §3: idempotency needs (provider, source, effective) — every column required.
  const versionRow = (sheets.get('원본목록') || [])[0];
  if (!versionRow) {
    errors.push(`sheet '원본목록' is empty — cannot derive rate version identity`);
    return { ok: false, errors, warnings };
  }
  const version = {
    provider:       String(versionRow.provider || '').trim(),
    source_name:    String(versionRow.source || '').trim(),
    effective_from: normalizeDate(versionRow.effective),
    note:           versionRow.use ? String(versionRow.use).trim() : null,
  };
  if (!version.provider)       errors.push(`원본목록.provider is empty`);
  if (!version.source_name)    errors.push(`원본목록.source is empty`);
  if (!version.effective_from) errors.push(`원본목록.effective is empty or unparseable`);

  //   서비스_Master → services[].
  const services = (sheets.get('서비스_Master') || []).map(r => ({
    provider:            String(r.provider || '').trim(),
    service_code:        String(r.service_code || '').trim(),
    service_name:        String(r.service_name || '').trim(),
    vol_divisor:         toNum(r.vol_divisor),
    sale_type:           r.sale_type ? String(r.sale_type).trim() : null,
    incoterm:            r.incoterm  ? String(r.incoterm).trim()  : null,
    rate_loaded:         yn(r.rate_loaded),
    coverage:            r.coverage ? String(r.coverage) : null,
    usage:               r.usage    ? String(r.usage)    : null,
    perkg_surcharge_krw: toNum(r.perkg_surcharge_krw, 0),
    active:              true,
    _rowNum:             r._rowNum,
  }));
  //   Duplicate service_code (per version) is a hard error.
  //   vol_divisor 0 is TOLERATED when rate_loaded is false (KPACKET / SHIPTER
  //   future-loaded services). Owner directive §9 requires such services to
  //   return RATE_NOT_LOADED at quote time — never a fabricated rate.
  {
    const seen = new Set();
    for (const s of services) {
      if (!s.service_code) errors.push(`서비스_Master row ${s._rowNum}: empty service_code`);
      if (s.rate_loaded && !(s.vol_divisor > 0)) {
        errors.push(`서비스_Master row ${s._rowNum} (${s.service_code}): rate_loaded=Y but vol_divisor missing`);
      }
      if (seen.has(s.service_code)) errors.push(`서비스_Master duplicate service_code: ${s.service_code}`);
      seen.add(s.service_code);
    }
  }

  //   국가_Master → countries[].
  //   VAT stored as pct in workbook (0.19 = 19%). Owner accepts either decimal
  //   or pct-notation, but the DB column stores the same units as the workbook.
  const countries = (sheets.get('국가_Master') || []).map(r => ({
    country_code:           String(r.country_code || '').trim().toUpperCase(),
    country_name:           r.country_name ? String(r.country_name).trim() : null,
    express_zone:           r.express_zone ? String(r.express_zone).trim() : null,
    is_eu:                  yn(r.is_eu),
    vat_rate:               toNum(r.vat_rate_pct, 0),
    benchmark_service_code: String(r.benchmark_service || '').trim(),
    _rowNum:                r._rowNum,
  }));
  {
    const seen = new Set();
    for (const c of countries) {
      if (!c.country_code)           errors.push(`국가_Master row ${c._rowNum}: empty country_code`);
      if (!c.benchmark_service_code) errors.push(`국가_Master row ${c._rowNum} (${c.country_code}): missing benchmark_service`);
      if (seen.has(c.country_code))  errors.push(`국가_Master duplicate country_code: ${c.country_code}`);
      seen.add(c.country_code);
    }
  }

  //   운임_Master → brackets[].
  //   eGS Express stores rows with empty country_key and zone_key='A'..'J' —
  //   the zone matches shipping_countries.express_zone. Country-scoped
  //   brackets fall back to country_key='__ALL__' when both are empty.
  const brackets = (sheets.get('운임_Master') || []).map(r => ({
    provider:     String(r.provider || '').trim(),
    service_code: String(r.service_code || '').trim(),
    country_key:  r.country_key ? String(r.country_key).trim() : (r.zone_key ? '__ZONE__' : '__ALL__'),
    zone_key:     r.zone_key ? String(r.zone_key).trim() : null,
    weight_to_kg: toNum(r.weight_to_kg),
    base_rate:    toNum(r.base_rate),
    currency:     r.currency ? String(r.currency).trim().toUpperCase() : 'KRW',
    note:         r.note ? String(r.note) : null,
    active:       true,
    _rowNum:      r._rowNum,
  }));
  //   Bracket integrity — no duplicates on (service_code, country_key, zone_key, weight_to_kg),
  //   ascending weight_to_kg per (service_code, country_key, zone_key).
  {
    const seen = new Set();
    const byGroup = new Map();
    for (const b of brackets) {
      const key = `${b.service_code}|${b.country_key}|${b.zone_key || ''}|${b.weight_to_kg}`;
      if (seen.has(key)) errors.push(`운임_Master row ${b._rowNum}: duplicate bracket (${b.service_code}, ${b.country_key}, zone=${b.zone_key || '-'}, ${b.weight_to_kg}kg)`);
      seen.add(key);
      if (b.weight_to_kg == null || b.weight_to_kg <= 0) errors.push(`운임_Master row ${b._rowNum}: invalid weight_to_kg`);
      if (b.base_rate    == null || b.base_rate <  0)    errors.push(`운임_Master row ${b._rowNum}: invalid base_rate`);
      const group = `${b.service_code}|${b.country_key}|${b.zone_key || ''}`;
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(b);
    }
    for (const [group, arr] of byGroup) {
      arr.sort((a, b) => a.weight_to_kg - b.weight_to_kg);
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].weight_to_kg <= arr[i - 1].weight_to_kg) {
          errors.push(`운임_Master (${group}) brackets must be strictly ascending — row ${arr[i]._rowNum}`);
        }
      }
    }
  }

  //   할증_Master → surcharges[].
  const surcharges = (sheets.get('할증_Master') || []).map(r => ({
    rule_code:      String(r.rule_code || '').trim(),
    scope:          r.scope ? String(r.scope).trim() : null,
    value:          toNum(r.value, r.value),   //   'PCT' rules may hold '국가별' — preserved
    unit:           r.unit ? String(r.unit).trim() : null,
    enabled:        yn(r.enabled),
    effective_from: normalizeDate(r.effective_from),
    effective_to:   normalizeDate(r.effective_to),
    note:           r.note ? String(r.note) : null,
    _rowNum:        r._rowNum,
  }));

  //   Cross-sheet integrity: every country's benchmark_service should exist in services.
  //   Owner directive §4: workbook gaps for a specific country resolve to
  //   RATE_NOT_LOADED at quote time (not a fabricated fallback). Import
  //   continues so the rest of the rate book is usable — the affected country
  //   is surfaced as a warning.
  {
    const svcCodes = new Set(services.map(s => s.service_code));
    for (const c of countries) {
      if (c.benchmark_service_code && !svcCodes.has(c.benchmark_service_code)) {
        warnings.push(`국가_Master ${c.country_code}: benchmark_service ${c.benchmark_service_code} not in 서비스_Master — quote will return RATE_NOT_LOADED for this country`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    version, services, countries, brackets, surcharges,
    errors, warnings,
  };
}

//   Loose date parser: accepts JS Date, ISO string, "YYYY-MM-DD", "YYYY.MM.DD",
//   Excel serial numbers (rare in this workbook, but supported for safety).
function normalizeDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    //   Excel epoch 1900-01-00 with the 1900 leap-year bug.
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const ms = v * 86400000;
    const d = new Date(epoch.getTime() + ms);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  //   'YYYY-MM-DD' or 'YYYY.MM.DD' or 'YYYY/MM/DD'
  const m = /^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})$/.exec(s);
  if (m) {
    const yr = m[1], mo = m[2].padStart(2, '0'), da = m[3].padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

/**
 * Two-phase importer. Parses + validates, then writes to Supabase.
 * Idempotent on (provider, source_name, effective_from).
 *
 * Never touches wms_orders or any table outside the 5 shipping_rate_master tables.
 */
async function importWorkbook(supabase, buffer, opts = {}) {
  const {
    sourceName    = 'upload',
    provider      = null,           //   override 원본목록.provider
    effectiveFrom = null,           //   override 원본목록.effective
    importedBy    = null,
  } = opts;

  const parsed = await parseAndValidate(buffer);
  if (!parsed.ok) return { versionId: null, alreadyImported: false, errors: parsed.errors, warnings: parsed.warnings };

  const versionKey = {
    provider:       provider      || parsed.version.provider,
    source_name:    sourceName    || parsed.version.source_name,
    effective_from: effectiveFrom || parsed.version.effective_from,
  };

  //   Idempotency check.
  const existing = await supabase
    .from('shipping_rate_versions')
    .select('id, status')
    .eq('provider',       versionKey.provider)
    .eq('source_name',    versionKey.source_name)
    .eq('effective_from', versionKey.effective_from)
    .maybeSingle();
  if (existing.error) return { versionId: null, alreadyImported: false, errors: [existing.error.message], warnings: parsed.warnings };
  if (existing.data) {
    return {
      versionId:       existing.data.id,
      alreadyImported: true,
      rowCounts:       { services: 0, countries: 0, brackets: 0, surcharges: 0 },
      warnings:        [...parsed.warnings, `version already imported (id=${existing.data.id}, status=${existing.data.status})`],
    };
  }

  //   Insert new version as 'draft'.
  const versionIns = await supabase
    .from('shipping_rate_versions')
    .insert({
      provider:       versionKey.provider,
      source_name:    versionKey.source_name,
      effective_from: versionKey.effective_from,
      status:         'draft',
      imported_by:    importedBy,
      note:           parsed.version.note,
    })
    .select('id')
    .single();
  if (versionIns.error) return { versionId: null, alreadyImported: false, errors: [versionIns.error.message], warnings: parsed.warnings };
  const versionId = versionIns.data.id;

  //   Child inserts. On error, delete the version and surface the error.
  const rowCounts = { services: 0, countries: 0, brackets: 0, surcharges: 0 };
  try {
    if (parsed.services.length) {
      const payload = parsed.services.map(({ _rowNum, ...s }) => ({ ...s, rate_version_id: versionId }));
      const r = await supabase.from('shipping_services').insert(payload).select('id');
      if (r.error) throw new Error(`services insert: ${r.error.message}`);
      rowCounts.services = r.data?.length || 0;
    }
    if (parsed.countries.length) {
      const payload = parsed.countries.map(({ _rowNum, ...c }) => ({ ...c, rate_version_id: versionId }));
      const r = await supabase.from('shipping_countries').insert(payload).select('id');
      if (r.error) throw new Error(`countries insert: ${r.error.message}`);
      rowCounts.countries = r.data?.length || 0;
    }
    if (parsed.brackets.length) {
      //   Batch by 500 to avoid Supabase payload limits on very large rate books.
      const payload = parsed.brackets.map(({ _rowNum, ...b }) => ({ ...b, rate_version_id: versionId }));
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const r = await supabase.from('shipping_rate_brackets').insert(chunk).select('id');
        if (r.error) throw new Error(`brackets insert (chunk ${i}): ${r.error.message}`);
        rowCounts.brackets += r.data?.length || 0;
      }
    }
    if (parsed.surcharges.length) {
      const payload = parsed.surcharges.map(({ _rowNum, value, ...s }) => ({
        ...s,
        //   Non-numeric 'value' cells (e.g. '국가별') are stored as 0 with the raw
        //   token preserved in note. Consumers know 'unit' and can dispatch on it.
        value: Number.isFinite(value) ? value : 0,
        note:  Number.isFinite(value) ? s.note : `${s.note || ''}${s.note ? ' · ' : ''}raw=${value}`,
        rate_version_id: versionId,
      }));
      const r = await supabase.from('shipping_surcharges').insert(payload).select('id');
      if (r.error) throw new Error(`surcharges insert: ${r.error.message}`);
      rowCounts.surcharges = r.data?.length || 0;
    }
  } catch (e) {
    //   Rollback the version. Cascade takes care of any children already inserted.
    await supabase.from('shipping_rate_versions').delete().eq('id', versionId);
    return { versionId: null, alreadyImported: false, errors: [e.message], warnings: parsed.warnings };
  }

  return {
    versionId,
    alreadyImported: false,
    rowCounts,
    warnings: parsed.warnings,
    errors:   [],
  };
}

/**
 * Promote a draft version to 'active' and supersede prior active versions
 * of the same provider. Owner-only surface.
 */
async function activateVersion(supabase, versionId) {
  const target = await supabase
    .from('shipping_rate_versions')
    .select('id, provider, effective_from, status')
    .eq('id', versionId)
    .maybeSingle();
  if (target.error) throw target.error;
  if (!target.data) throw new Error(`version ${versionId} not found`);
  if (target.data.status === 'active') return { versionId, alreadyActive: true };

  //   Supersede prior active versions of the same provider.
  const supers = await supabase
    .from('shipping_rate_versions')
    .update({ status: 'superseded', effective_to: target.data.effective_from })
    .eq('provider', target.data.provider)
    .eq('status', 'active')
    .select('id');
  if (supers.error) throw supers.error;

  const activate = await supabase
    .from('shipping_rate_versions')
    .update({ status: 'active' })
    .eq('id', versionId)
    .select('id')
    .maybeSingle();
  if (activate.error) throw activate.error;

  return { versionId, superseded: supers.data?.map(r => r.id) || [] };
}

module.exports = {
  parseAndValidate,
  importWorkbook,
  activateVersion,
  //   internal helpers exported for tests
  REQUIRED_SHEETS,
  REQUIRED_HEADERS,
  yn,
  toNum,
  normalizeDate,
};
