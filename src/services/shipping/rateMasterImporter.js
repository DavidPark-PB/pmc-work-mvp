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

  //   원본목록 → per-provider version rows.
  //   Correction (2026-09-13): the workbook is a UNIFIED multi-provider rate
  //   book. eGS/KPL/FedEx/SHIPTER/KoreaPost rates update on independent
  //   schedules — a single `shipping_rate_versions` row per provider is the
  //   only way `getActiveVersion(provider)` stays truthful without
  //   cross-provider supersede accidents.
  //     Idempotency key remains (provider, source_name, effective_from) so
  //     re-importing the same workbook is still a no-op.
  //     `원본목록` rows enumerate each provider — pick each unique provider row.
  const versionRows = (sheets.get('원본목록') || []).filter(r => String(r.provider || '').trim());
  if (versionRows.length === 0) {
    errors.push(`sheet '원본목록' has no provider rows — cannot derive rate version identity`);
    return { ok: false, errors, warnings };
  }
  //   Build provider → version metadata map (workbook lists eGS,
  //   FEDEX_INTL / KOREA_POST etc.; we key on the exact provider strings).
  const versionsByProvider = new Map();
  const importDateIso = new Date().toISOString().slice(0, 10);
  for (const row of versionRows) {
    const provider = String(row.provider || '').trim();
    if (!provider) continue;
    const source_name = String(row.source || '').trim();
    let effective_from = normalizeDate(row.effective);
    if (!source_name) errors.push(`원본목록 provider=${provider}: source is empty`);
    //   Some rows lack an explicit effective date (KPL / KoreaPost in v2).
    //   Default to today (importDateIso) with a warning so the provider still
    //   gets a rate_version row and can be activated. The idempotency key
    //   still holds (provider, source_name, effective_from) — reimport of
    //   the same workbook today stays a no-op; a different day creates a
    //   new draft that owner can review.
    if (!effective_from) {
      effective_from = importDateIso;
      warnings.push(`원본목록 provider=${provider}: effective_from missing — defaulted to ${importDateIso}`);
    }
    versionsByProvider.set(provider, {
      provider,
      source_name,
      effective_from,
      note: row.use ? String(row.use).trim() : null,
    });
  }

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

  //   Cross-sheet integrity:
  //     1. Every country's benchmark_service must exist in shipping_services.
  //     2. Every benchmark service must have at least one bracket row
  //        (owner directive §7 test: "모든 benchmark service에 최소 1개 이상의
  //        운임구간 존재"). Otherwise the country resolves to
  //        WEIGHT_OVER_MAX_BRACKET on every quote — that's a workbook error.
  {
    const svcCodes = new Set(services.map(s => s.service_code));
    const svcCodesWithBrackets = new Set(
      brackets.filter(b => b.base_rate > 0).map(b => b.service_code)
    );
    for (const c of countries) {
      if (!c.benchmark_service_code) continue;
      if (!svcCodes.has(c.benchmark_service_code)) {
        errors.push(`국가_Master ${c.country_code}: benchmark_service ${c.benchmark_service_code} not in 서비스_Master`);
      } else if (!svcCodesWithBrackets.has(c.benchmark_service_code)) {
        errors.push(`국가_Master ${c.country_code}: benchmark_service ${c.benchmark_service_code} has no brackets in 운임_Master`);
      }
    }
  }

  //   Per-provider version index for the importer.
  //   Surcharges are eGS-scoped metadata and attach to the primary version only.
  //   Countries: the primary version gets the full 국가_Master; every other
  //   provider version gets ONLY the countries its own brackets are keyed on
  //   (selectCountriesForProvider) — shippingQuoteService resolves the country
  //   inside the same rate_version_id, so a provider without its own country
  //   rows can never quote (production KPL v4 COUNTRY_NOT_IN_MASTER, 2026-09-14).
  const versionsList = [...versionsByProvider.values()];
  const primaryProviderForCountries =
    versionsByProvider.has('eGS') ? 'eGS'
    : (versionsList[0]?.provider || null);

  const draft = { primaryProviderForCountries, services, countries, brackets };
  const countryScopeByProvider = {};
  for (const { provider } of versionsList) {
    const scope = selectCountriesForProvider(draft, provider);
    countryScopeByProvider[provider] = {
      count: scope.countries.length,
      codes: provider === primaryProviderForCountries ? null : scope.countries.map(c => c.country_code),
      missingCountryKeys: scope.missingCountryKeys,
    };
    for (const key of scope.missingCountryKeys) {
      warnings.push(`운임_Master provider=${provider}: country_key ${key} not in 국가_Master — no country row created`);
    }
  }

  return {
    ok: errors.length === 0,
    versions:                    versionsList,
    primaryProviderForCountries,
    countryScopeByProvider,
    services, countries, brackets, surcharges,
    errors, warnings,
  };
}

const NON_COUNTRY_BRACKET_KEYS = new Set(['__ALL__', '__ZONE__']);

/**
 * Countries to store under one provider's rate version.
 *
 *   · primary provider (eGS)  → the full 국가_Master, unchanged.
 *   · any other provider      → only 국가_Master rows whose country_code is a
 *     country_key on that provider's own brackets (KPL v2 → US, JP). Zone /
 *     catch-all keys never create countries. Descriptive columns (name, zone,
 *     is_eu, vat_rate) are copied from 국가_Master; benchmark_service_code is
 *     re-pointed to the provider's own service that carries that country's
 *     brackets, because shippingQuoteService/getService resolve the benchmark
 *     inside the same rate_version_id (an eGS benchmark would never resolve in a
 *     KPL version). If several services cover one country, the one whose
 *     coverage equals the country wins, else the lexicographically first.
 *
 * Bracket keys with no 국가_Master row are returned in `missingCountryKeys`
 * (caller warns) — a country row is never fabricated.
 *
 * Pure: depends only on the parsed workbook, so a re-import of the same workbook
 * (or a future provider with country-keyed brackets) reproduces the same rows.
 */
function selectCountriesForProvider(parsed, provider) {
  const allCountries = parsed.countries || [];
  if (provider === parsed.primaryProviderForCountries) {
    return { countries: allCountries, missingCountryKeys: [] };
  }

  const servicesByCountry = new Map();
  for (const b of parsed.brackets || []) {
    if (b.provider !== provider) continue;
    const key = String(b.country_key || '').trim().toUpperCase();
    if (!key || NON_COUNTRY_BRACKET_KEYS.has(key)) continue;
    if (!servicesByCountry.has(key)) servicesByCountry.set(key, new Set());
    servicesByCountry.get(key).add(b.service_code);
  }

  const providerServices = new Map((parsed.services || [])
    .filter(s => s.provider === provider)
    .map(s => [s.service_code, s]));
  const masterByCode = new Map(allCountries.map(c => [c.country_code, c]));

  const countries = [];
  const missingCountryKeys = [];
  for (const code of [...servicesByCountry.keys()].sort()) {
    const master = masterByCode.get(code);
    if (!master) { missingCountryKeys.push(code); continue; }
    const candidates = [...servicesByCountry.get(code)].sort();
    const benchmark =
      candidates.find(sc => String(providerServices.get(sc)?.coverage || '').trim().toUpperCase() === code)
      || candidates[0];
    countries.push({ ...master, benchmark_service_code: benchmark });
  }
  return { countries, missingCountryKeys };
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
 * Multi-provider two-phase importer. Parses + validates, then writes to
 * Supabase creating ONE rate_version per provider found in 원본목록.
 * Idempotent per (provider, source_name, effective_from).
 *
 * Response shape (correction 2026-09-13):
 *   {
 *     versions: [ { provider, versionId, alreadyImported, rowCounts } ],
 *     errors:   [...],
 *     warnings: [...],
 *   }
 *
 * Never touches wms_orders or any table outside the 5 shipping_rate_master tables.
 */
async function importWorkbook(supabase, buffer, opts = {}) {
  const { importedBy = null } = opts;

  const parsed = await parseAndValidate(buffer);
  if (!parsed.ok) {
    return { versions: [], errors: parsed.errors, warnings: parsed.warnings };
  }

  //   Split rows by their `provider` column so we can attach each to the
  //   matching version. Countries + surcharges attach to `primaryProviderForCountries`.
  const servicesByProvider = new Map();
  for (const s of parsed.services) {
    const p = s.provider;
    if (!p) continue;
    if (!servicesByProvider.has(p)) servicesByProvider.set(p, []);
    servicesByProvider.get(p).push(s);
  }
  const bracketsByProvider = new Map();
  for (const b of parsed.brackets) {
    const p = b.provider;
    if (!p) continue;
    if (!bracketsByProvider.has(p)) bracketsByProvider.set(p, []);
    bracketsByProvider.get(p).push(b);
  }

  const perProviderResults = [];
  const errors = [];

  for (const versionMeta of parsed.versions) {
    const { provider, source_name, effective_from, note } = versionMeta;

    //   Skip providers that have NO rate-loaded services (owner directive §2:
    //   운임 미적재 서비스는 active rate version이 있는 것처럼 표시하지 않는다).
    const svcs = servicesByProvider.get(provider) || [];
    const brks = bracketsByProvider.get(provider) || [];
    const hasLoadedRate = svcs.some(s => s.rate_loaded) && brks.length > 0;
    if (!hasLoadedRate) {
      perProviderResults.push({
        provider,
        versionId:       null,
        alreadyImported: false,
        skipped:         true,
        reason:          'no rate_loaded service or brackets — provider not activated',
        rowCounts:       { services: 0, countries: 0, brackets: 0, surcharges: 0 },
      });
      continue;
    }

    //   Idempotency check per provider.
    const existing = await supabase
      .from('shipping_rate_versions')
      .select('id, status')
      .eq('provider',       provider)
      .eq('source_name',    source_name)
      .eq('effective_from', effective_from)
      .maybeSingle();
    if (existing.error) {
      errors.push(`${provider}: idempotency lookup failed: ${existing.error.message}`);
      continue;
    }
    if (existing.data) {
      perProviderResults.push({
        provider,
        versionId:       existing.data.id,
        alreadyImported: true,
        rowCounts:       { services: 0, countries: 0, brackets: 0, surcharges: 0 },
        note:            `already imported (id=${existing.data.id}, status=${existing.data.status})`,
      });
      continue;
    }

    //   Insert draft version + provider-scoped children.
    const versionIns = await supabase
      .from('shipping_rate_versions')
      .insert({ provider, source_name, effective_from, status: 'draft', imported_by: importedBy, note })
      .select('id')
      .single();
    if (versionIns.error) { errors.push(`${provider}: version insert failed: ${versionIns.error.message}`); continue; }
    const versionId = versionIns.data.id;

    const rowCounts = { services: 0, countries: 0, brackets: 0, surcharges: 0 };
    try {
      if (svcs.length) {
        const payload = svcs.map(({ _rowNum, ...s }) => ({ ...s, rate_version_id: versionId }));
        const r = await supabase.from('shipping_services').insert(payload).select('id');
        if (r.error) throw new Error(`services insert: ${r.error.message}`);
        rowCounts.services = r.data?.length || 0;
      }
      //   Countries: primary provider → full 국가_Master; other providers →
      //   only the countries their own brackets are keyed on (KPL → US, JP).
      const providerCountries = selectCountriesForProvider(parsed, provider).countries;
      if (providerCountries.length) {
        const payload = providerCountries.map(({ _rowNum, ...c }) => ({ ...c, rate_version_id: versionId }));
        const r = await supabase.from('shipping_countries').insert(payload).select('id');
        if (r.error) throw new Error(`countries insert: ${r.error.message}`);
        rowCounts.countries = r.data?.length || 0;
      }
      //   Surcharges attach to the PRIMARY provider only (eGS unless the
      //   workbook lacks eGS).
      if (provider === parsed.primaryProviderForCountries) {
        if (parsed.surcharges.length) {
          const payload = parsed.surcharges.map(({ _rowNum, value, ...s }) => ({
            ...s,
            value: Number.isFinite(value) ? value : 0,
            note:  Number.isFinite(value) ? s.note : `${s.note || ''}${s.note ? ' · ' : ''}raw=${value}`,
            rate_version_id: versionId,
          }));
          const r = await supabase.from('shipping_surcharges').insert(payload).select('id');
          if (r.error) throw new Error(`surcharges insert: ${r.error.message}`);
          rowCounts.surcharges = r.data?.length || 0;
        }
      }
      if (brks.length) {
        //   Schema contract: shipping_rate_brackets columns are
        //   (rate_version_id, service_code, country_key, zone_key,
        //    weight_to_kg, base_rate, currency, note, active).
        //   `provider` is NOT a column on this table — it is derivable via
        //   rate_version_id → shipping_rate_versions.provider, and no code
        //   queries brackets by provider. Strip it explicitly so PostgREST
        //   never sees an unknown key (that was the owner-reported
        //   "Could not find the 'provider' column of 'shipping_rate_brackets'"
        //   error on the V2 upload).
        const payload = brks.map(({ _rowNum, provider: _p, ...b }) => ({
          ...b, rate_version_id: versionId,
        }));
        for (let i = 0; i < payload.length; i += 500) {
          const chunk = payload.slice(i, i + 500);
          const r = await supabase.from('shipping_rate_brackets').insert(chunk).select('id');
          if (r.error) throw new Error(`brackets insert (chunk ${i}): ${r.error.message}`);
          rowCounts.brackets += r.data?.length || 0;
        }
      }
    } catch (e) {
      await supabase.from('shipping_rate_versions').delete().eq('id', versionId);
      errors.push(`${provider}: ${e.message}`);
      continue;
    }

    perProviderResults.push({ provider, versionId, alreadyImported: false, rowCounts });
  }

  return {
    versions: perProviderResults,
    errors,
    warnings: parsed.warnings,
  };
}

/**
 * fetchAllPaginated — page through a Supabase query in 1000-row chunks
 * until the last page returns fewer than `pageSize` rows. Necessary
 * because PostgREST caps a single response at 1000 rows by default —
 * a bare `.select().eq()` against a 3,876-row table silently returns
 * only the first 1000, which is exactly how activateVersion() falsely
 * reported half the eGS services as "no brackets" (owner-reported
 * bug, 2026-09-13 · production eGS v3 activation).
 *
 * `buildQuery(range)` must return a NEW Supabase query builder each
 * call (Supabase builders are single-shot after `await`), scoped with
 * whatever `.eq/.in/.select` the caller needs.
 */
async function fetchAllPaginated(buildQuery, pageSize = 1000, hardStopPages = 500) {
  const all = [];
  let from = 0;
  for (let page = 0; page < hardStopPages; page++) {
    const q = buildQuery();
    //   Some Supabase builder chains don't expose `.range` at every point
    //   in the pipeline — guard so a caller mistake fails loudly.
    if (typeof q.range !== 'function') {
      throw new Error('fetchAllPaginated: buildQuery() must return a Supabase query builder with .range');
    }
    const r = await q.range(from, from + pageSize - 1);
    if (r.error) throw r.error;
    const rows = r.data || [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
    from += pageSize;
  }
  //   `hardStopPages * pageSize` = 500k rows. A table this big would be
  //   an entirely different problem than the one this helper solves;
  //   throw so we never silently truncate again.
  throw new Error(`fetchAllPaginated: exceeded hard-stop of ${hardStopPages} pages (${hardStopPages * pageSize} rows)`);
}

/**
 * assertVersionActivatable — pre-flight guards run before promoting a
 * draft version to 'active'. Every rejection carries `.code` so the
 * calling route can surface a machine-readable reason back to the SPA.
 *
 * Owner directive §5:
 *   Activation MUST be refused when
 *     · no active service is attached (empty version)
 *     · no bracket rows exist
 *     · a rate_loaded service has zero bracket rows
 *     · a country's benchmark_service is not present in this version's services
 *     · a benchmark_service has no bracket rows
 *   Otherwise a version left incomplete by a mid-flight import failure
 *   could be silently promoted and every quote against it would return
 *   WEIGHT_OVER_MAX_BRACKET / no-service errors in production.
 *
 * Every child-table read below uses `fetchAllPaginated` — a bare
 * `.select().eq()` silently caps at 1000 rows and previously produced
 * a false SERVICE_WITHOUT_BRACKETS listing for 28 eGS services whose
 * brackets sat past pk 1000.
 */
async function assertVersionActivatable(supabase, versionId) {
  //   Services and countries stay well under 1000 in practice, but we
  //   paginate all three to future-proof and keep the mechanism uniform.
  const svcRows = await fetchAllPaginated(() => supabase
    .from('shipping_services')
    .select('service_code, rate_loaded, active')
    .eq('rate_version_id', versionId));
  const activeLoaded = svcRows.filter(s => s.active && s.rate_loaded);
  if (activeLoaded.length === 0) {
    const err = new Error(`version ${versionId}: no active rate_loaded services attached — refuse to activate`);
    err.code = 'NO_ACTIVE_SERVICE'; throw err;
  }

  //   Brackets: the 3,876-row table that tripped the 1000-cap. Paginate
  //   through all rows so the distinct-service-code set is complete.
  const brkRows = await fetchAllPaginated(() => supabase
    .from('shipping_rate_brackets')
    .select('service_code')
    .eq('rate_version_id', versionId));
  if (brkRows.length === 0) {
    const err = new Error(`version ${versionId}: zero brackets attached — refuse to activate`);
    err.code = 'NO_BRACKETS'; throw err;
  }
  const bracketsByService = new Set(brkRows.map(b => b.service_code));
  const svcsWithoutBrackets = activeLoaded
    .filter(s => !bracketsByService.has(s.service_code))
    .map(s => s.service_code);
  if (svcsWithoutBrackets.length) {
    const err = new Error(`version ${versionId}: rate_loaded services without brackets — ${svcsWithoutBrackets.join(', ')}`);
    err.code = 'SERVICE_WITHOUT_BRACKETS'; throw err;
  }

  //   Country benchmark integrity. The primary version owns the full countries
  //   sheet; a per-provider version (KPL) carries only its bracket countries,
  //   benchmarked to its own services. A version with zero countries (zone-only
  //   or legacy import) is still valid, so skip when countries.length === 0.
  const ctyRows = await fetchAllPaginated(() => supabase
    .from('shipping_countries')
    .select('country_code, benchmark_service_code')
    .eq('rate_version_id', versionId));
  if (ctyRows.length > 0) {
    //   Benchmarks may reference services from ANY provider (per owner
    //   directive: eGS countries can benchmark to KPL services). Load every
    //   active version's services once and check across the union.
    const activeVersions = await supabase
      .from('shipping_rate_versions')
      .select('id')
      .eq('status', 'active');
    if (activeVersions.error) throw activeVersions.error;
    const svcVersionIds = [versionId, ...(activeVersions.data || []).map(v => v.id)];
    const allSvcs = await fetchAllPaginated(() => supabase
      .from('shipping_services')
      .select('service_code, rate_version_id')
      .in('rate_version_id', svcVersionIds));
    const allSvcCodes = new Set(allSvcs.map(s => s.service_code));
    const missing = ctyRows
      .filter(c => c.benchmark_service_code && !allSvcCodes.has(c.benchmark_service_code))
      .map(c => `${c.country_code}→${c.benchmark_service_code}`);
    if (missing.length) {
      const err = new Error(`version ${versionId}: countries reference missing benchmark services — ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
      err.code = 'BENCHMARK_SERVICE_MISSING'; throw err;
    }
    //   Benchmark service must ALSO have at least one bracket somewhere —
    //   another paginated read across all active-or-target versions.
    const allBrks = await fetchAllPaginated(() => supabase
      .from('shipping_rate_brackets')
      .select('service_code')
      .in('rate_version_id', svcVersionIds));
    const svcCodesWithBrackets = new Set(allBrks.map(b => b.service_code));
    const emptyBench = ctyRows
      .filter(c => c.benchmark_service_code && !svcCodesWithBrackets.has(c.benchmark_service_code))
      .map(c => `${c.country_code}→${c.benchmark_service_code}`);
    if (emptyBench.length) {
      const err = new Error(`version ${versionId}: countries whose benchmark service has zero brackets — ${emptyBench.slice(0, 5).join(', ')}${emptyBench.length > 5 ? ` (+${emptyBench.length - 5} more)` : ''}`);
      err.code = 'BENCHMARK_SERVICE_EMPTY'; throw err;
    }
  }
}

/**
 * Promote a draft version to 'active' and supersede prior active versions
 * of the same provider. Owner-only surface. Applies §5 activation guards
 * before any mutation so a broken version cannot slip through.
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

  //   Pre-flight guards. Any throw here is caught by the caller and
  //   surfaced to the SPA — nothing is mutated in the meantime.
  await assertVersionActivatable(supabase, versionId);

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
  assertVersionActivatable,
  selectCountriesForProvider,
  //   internal helpers exported for tests
  REQUIRED_SHEETS,
  REQUIRED_HEADERS,
  yn,
  toNum,
  normalizeDate,
  fetchAllPaginated,
};
