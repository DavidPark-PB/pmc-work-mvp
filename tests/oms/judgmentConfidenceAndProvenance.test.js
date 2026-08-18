'use strict';

/**
 * tests/oms/judgmentConfidenceAndProvenance.test.js — Phase 8K.
 *
 * Covers:
 *   inventoryReasonExplanations (Korean translator + unknown passthrough)
 *   judgmentConfidencePolicy (deterministic derived tier + evidence actions)
 *   inventoryOwnerDecisionService integration (additive fields, verbatim
 *     preservation of decision / action / priority / urgency / cost numbers)
 *   Static audit: no Telegram / iMessage / scheduler / agent / marketplace /
 *     DB write / evidence.jsonb / secret exposure. No new DB query.
 *
 * ABSOLUTE:
 *   NEVER contacts a real Telegram or iMessage transport.
 *   NEVER runs a real Supabase query — assessFn is injected.
 *   NEVER mutates inventory / marketplace / purchase / hold / scheduler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildOwnerDecision, ACTION, PROVENANCE_SOURCE, FORBIDDEN_AUTOMATIC_ACTIONS, _internals: ownerInternals } =
  require('../../src/services/oms/inventoryOwnerDecisionService');
const { translate, KNOWN_REASON_CODES, _internals: reasonInternals } =
  require('../../src/services/oms/inventoryReasonExplanations');
const { deriveJudgmentConfidence, TIER, TIER_ORDER, _internals: policyInternals } =
  require('../../src/services/oms/judgmentConfidencePolicy');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ─── BP production-shape fixture (matches Phase 8B result verbatim) ───

function bpDecisionFixture(overrides = {}) {
  const base = {
    physical_product_id: 1,
    generated_at: '2026-08-18T00:00:00.000Z',
    physical: {
      id: 1, canonical_title: 'Battle Partners Booster Box',
      set_code: 'sv9', set_name: 'Battle Partners', language: 'ko', region: null, unit_type: 'booster_box',
    },
    decision: {
      status: DECISION.WATCH, confidence_level: 'low',
      reason_codes: [
        'hold_status:review_demand_and_supply_risk',
        'demand_concentrated_large_order',
        'current_supply_ask_only',
        'replacement_difficulty_hard',
        'no_current_primary_supplier_quote',
      ],
      hold_quantity_blockers: [],
      strategic_hold_recommended_units: null,
      upstream_hold_status: 'REVIEW_DEMAND_AND_SUPPLY_RISK',
      upstream_supply_verdict: 'AT_RISK',
      depth_gap: 15,
    },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: {
      trusted: true, units_7d: 60, units_30d: 61, velocity_7d: 8.57, velocity_30d: 2.033333333333333,
      raw_days_of_supply: 22.13, adjusted_velocity: null,
      demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984,
      total_shipments_30d: 3, trust_reason: 'multi_channel_evidence',
    },
    supply_summary: {
      verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only',
      supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD',
      replacement_difficulty_reason_codes: ['ask_only_supply', 'no_current_supplier_quote'],
      evidenced_replacement_depth: 30, largest_currently_coverable_target: 30,
      uncovered_at_60: 30, uncovered_at_100: 70,
      secondary_market_dependency_by_target: { 10: 1.0, 30: 1.0, 60: 1.0, 100: 1.0 },
      replacement_coverage: { 10: 1.0, 30: 1.0, 60: 0.5, 100: 0.3 },
      observed_secondary_market_unit_cost_min: 40000, secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2, stale_observations: 0, total: 2 }],
    },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
      note: 'categories separated',
    },
    missing_evidence: [],
    recommended_human_action: 'stub',
    strategic_hold_source: {
      physical: { id: 1, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko' },
      inventory: { on_hand: 60, reserved: 15, available: 45 },
      demand: {
        trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.033333333333333,
        raw_days_of_supply: 22.13, trust_reason: 'multi_channel_evidence',
      },
      demand_concentration: {
        demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60,
        largest_shipment_share_30d: 0.984, total_shipments_30d: 3,
      },
      supply_risk: {
        verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only',
        supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD',
        evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70,
        secondary_market_dependency_by_target: { 60: 1.0, 100: 1.0 },
        observed_secondary_market_unit_cost_min: 40000,
        secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2, stale_observations: 0, total: 2 }],
        observation_count: 2,
        evidence_confidence: 'low',
      },
      historical_reference_context: {
        replacement_price_status: 'AVAILABLE',
        replacement_price: 40000,
        replacement_price_currency: 'KRW',
        replacement_price_observed_at: '2026-08-15T00:00:00Z',
        latest_snapshot_id: 42,
        latest_snapshot_calculated_at: '2026-08-16T00:00:00Z',
        latest_snapshot_engine_version: 'v1.2',
        historical_typical_supplier_cost_krw_median: 19500,
      },
      historical_reference_product_cost: {
        status: 'HISTORICAL_REFERENCE_ONLY',
        currency: 'KRW',
        median_krw_per_physical: 19500,
        observation_count: 4,
        note: 'typical reference · not current replacement',
      },
      historical_accounting_cost: { cost_krw: 45000, note: 'from sku_master' },
    },
  };
  return _deepMerge(base, overrides);
}
function _deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = _deepMerge(a?.[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}
const fakeAssess = (fix) => async id => (id === fix.physical_product_id ? fix : { error: 'physical_not_found' });

async function bpOwnerDecision(fixOverrides = {}) {
  const fx = bpDecisionFixture(fixOverrides);
  return buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(fx) });
}

// ─── K01-K05 · inventoryReasonExplanations ──────────────

test('K01. translate(known code) returns Korean plain-language string', () => {
  const s = translate('demand_untrusted');
  assert.equal(typeof s, 'string');
  assert.match(s, /수요 데이터/);
});

test('K02. translate(unknown code) returns the ORIGINAL string VERBATIM (Owner rule 6)', () => {
  const s = translate('some_new_undocumented_reason_code_v42');
  assert.equal(s, 'some_new_undocumented_reason_code_v42');
});

test('K03. translate embeds context values only when present (never invents numbers)', () => {
  const with_ctx = translate('demand_concentrated_large_order', {
    largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984,
  });
  assert.match(with_ctx, /60개/);
  assert.match(with_ctx, /98\.4%/);
  const without_ctx = translate('demand_concentrated_large_order');
  assert.match(without_ctx, /지속적 수요로 판정되지 않습니다/);
  assert.doesNotMatch(without_ctx, /\d+개/);
  assert.doesNotMatch(without_ctx, /\d+\.\d%/);
});

test('K04. translate handles dynamic-suffix reasons (uncovered_at_60_15 → context-embedded ko)', () => {
  const s = translate('uncovered_at_60_15');
  assert.match(s, /60개 조달/);
  assert.match(s, /15개가 부족/);
});

test('K05. translate is defensive: non-string / empty / null returns cast String() safely', () => {
  assert.equal(translate(''), '');
  assert.equal(translate(null), 'null');
  assert.equal(translate(undefined), 'undefined');
  assert.equal(translate(42), '42');
});

// ─── K06-K10 · tier derivation (deterministic) ─────────

test('K06. TIER_ORDER · UNKNOWN < LOW < MEDIUM < HIGH', () => {
  assert.equal(TIER_ORDER.UNKNOWN, 0);
  assert.equal(TIER_ORDER.LOW, 1);
  assert.equal(TIER_ORDER.MEDIUM, 2);
  assert.equal(TIER_ORDER.HIGH, 3);
});

test('K07. _minTier([LOW, HIGH, MEDIUM]) → LOW', () => {
  assert.equal(policyInternals._minTier(['LOW', 'HIGH', 'MEDIUM']), 'LOW');
  assert.equal(policyInternals._minTier(['MEDIUM', 'HIGH']), 'MEDIUM');
  assert.equal(policyInternals._minTier(['HIGH', 'HIGH']), 'HIGH');
});

test('K08. _minTier([HIGH, UNKNOWN, MEDIUM]) → UNKNOWN (UNKNOWN dominates)', () => {
  assert.equal(policyInternals._minTier(['HIGH', 'UNKNOWN', 'MEDIUM']), 'UNKNOWN');
  assert.equal(policyInternals._minTier([]), 'UNKNOWN');
  assert.equal(policyInternals._minTier(['UNKNOWN']), 'UNKNOWN');
});

test('K09. demand tier · trusted=true→HIGH · false→LOW · null→UNKNOWN (never guesses)', () => {
  assert.equal(policyInternals._deriveDemandTier({ demand: { trusted: true } }), 'HIGH');
  assert.equal(policyInternals._deriveDemandTier({ demand: { trusted: false } }), 'LOW');
  assert.equal(policyInternals._deriveDemandTier({ demand: { trusted: null } }), 'UNKNOWN');
  assert.equal(policyInternals._deriveDemandTier({}), 'UNKNOWN');
  assert.equal(policyInternals._deriveDemandTier({ demand: {} }), 'UNKNOWN');
});

test('K10. supply tier · maps evidence_confidence enum · unknown value → UNKNOWN', () => {
  assert.equal(policyInternals._deriveSupplyTier({ supply_risk: { evidence_confidence: 'none' } }), 'UNKNOWN');
  assert.equal(policyInternals._deriveSupplyTier({ supply_risk: { evidence_confidence: 'low' } }), 'LOW');
  assert.equal(policyInternals._deriveSupplyTier({ supply_risk: { evidence_confidence: 'medium' } }), 'MEDIUM');
  assert.equal(policyInternals._deriveSupplyTier({ supply_risk: { evidence_confidence: 'high' } }), 'HIGH');
  assert.equal(policyInternals._deriveSupplyTier({ supply_risk: { evidence_confidence: 'weird_value' } }), 'UNKNOWN');
  assert.equal(policyInternals._deriveSupplyTier({}), 'UNKNOWN');
});

// ─── K11-K14 · recommended_evidence_actions (Owner-approved mapping) ─

test('K11. every recommended_evidence_actions value is from Phase 8F ACTION enum (no new enum)', async () => {
  const owner = await bpOwnerDecision();
  const knownActions = new Set(Object.values(ACTION));
  for (const a of owner.recommended_evidence_actions) {
    assert.ok(knownActions.has(a), `unknown action ${a} not in Phase 8F ACTION enum`);
  }
  for (const dim of Object.values(owner.judgment_confidence.by_dimension)) {
    for (const a of dim.recommended_evidence_actions || []) {
      assert.ok(knownActions.has(a), `dimension action ${a} not in Phase 8F ACTION enum`);
    }
  }
});

test('K12. BP mapping · demand LOW→REVIEW_DATA_QUALITY · ask_only→CONFIRM_EXECUTABLE_QUOTE · no primary→CHECK_PRIMARY_SUPPLIER', async () => {
  // BP has trusted=true so demand is HIGH; force demand LOW for this mapping check
  const owner = await bpOwnerDecision({ strategic_hold_source: { demand: { trusted: false } } });
  const jc = owner.judgment_confidence;
  assert.ok(jc.by_dimension.demand.recommended_evidence_actions.includes(ACTION.REVIEW_DATA_QUALITY));
  assert.ok(jc.by_dimension.supply.recommended_evidence_actions.includes(ACTION.CONFIRM_EXECUTABLE_QUOTE));
  assert.ok(jc.by_dimension.supply.recommended_evidence_actions.includes(ACTION.CHECK_PRIMARY_SUPPLIER));
});

test('K13. secondary_market_dependency_at_60 > 0.5 → CHECK_SECONDARY_MARKET fires REGARDLESS of quality (Owner rule 3 rev.2)', () => {
  const holdSrcQuoted = {
    supply_risk: {
      current_supply_quality: 'supplier_quote', has_current_supplier_or_executable: true,
      secondary_market_dependency_by_target: { 60: 0.8 },
    },
  };
  assert.ok(policyInternals._supplyActions(holdSrcQuoted).includes(ACTION.CHECK_SECONDARY_MARKET));
  // BP case: ask_only + dep60 100% → CHECK_SECONDARY_MARKET also fires (previous rev suppressed this)
  const holdSrcAskOnly = {
    supply_risk: {
      current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
      secondary_market_dependency_by_target: { 60: 1.0 },
    },
  };
  assert.ok(policyInternals._supplyActions(holdSrcAskOnly).includes(ACTION.CHECK_SECONDARY_MARKET));
});

test('K14. cost tier UNKNOWN → REVIEW_DATA_QUALITY · identity blockers present → REVIEW_DATA_QUALITY', () => {
  // Strip ALL cost categories (rev.2 · each independent) + set blockers
  const bpFix = bpDecisionFixture({
    strategic_hold_source: {
      historical_reference_product_cost: null,
      historical_accounting_cost: null,
      supply_risk: {
        current_supply_quality: 'none', has_current_supplier_or_executable: false,
        secondary_market_depth: [], observed_secondary_market_unit_cost_min: null,
      },
    },
    decision: { hold_quantity_blockers: ['identity_ambiguous_offer_matches'] },
  });
  const { judgment_confidence, recommended_evidence_actions } = deriveJudgmentConfidence(bpFix);
  assert.equal(judgment_confidence.by_dimension.cost.tier, 'UNKNOWN');
  assert.equal(judgment_confidence.by_dimension.identity.tier, 'LOW');
  assert.ok(recommended_evidence_actions.includes(ACTION.REVIEW_DATA_QUALITY));
});

// ─── K15-K18 · data_provenance ─────────────────────────

test('K15. PROVENANCE_SOURCE is a whitelist enum · every emitted source is in the whitelist', async () => {
  const owner = await bpOwnerDecision();
  const whitelist = new Set(Object.values(PROVENANCE_SOURCE));
  const dp = owner.data_provenance;
  const sources = [
    dp.inventory.source, dp.demand.source, dp.supply.source,
    dp.cost_context.historical_typical_supplier_cost_krw_median.source,
    dp.cost_context.historical_accounting_cost_krw.source,
    dp.cost_context.observed_secondary_market_ask_min_krw.source,
  ];
  for (const s of sources) assert.ok(whitelist.has(s), `source '${s}' not in PROVENANCE_SOURCE whitelist`);
});

test('K16. Missing upstream metadata → null (never invented)', async () => {
  // Strip historical_reference_product_cost + secondary_market_depth
  const owner = await bpOwnerDecision({
    strategic_hold_source: {
      historical_reference_product_cost: null,
      historical_accounting_cost: null,
      supply_risk: { secondary_market_depth: [], observed_secondary_market_unit_cost_min: null },
    },
  });
  const cc = owner.data_provenance.cost_context;
  assert.equal(cc.historical_typical_supplier_cost_krw_median.source, 'UNKNOWN');
  assert.equal(cc.historical_typical_supplier_cost_krw_median.observation_count, null);
  assert.equal(cc.historical_accounting_cost_krw.source, 'UNKNOWN');
  assert.equal(cc.observed_secondary_market_ask_min_krw.source, 'UNKNOWN');
  // inventory as_of is not surfaced by upstream today
  assert.equal(owner.data_provenance.inventory.as_of, null);
  // demand latest_observed_at is not surfaced
  assert.equal(owner.data_provenance.demand.latest_observed_at, null);
});

test('K17. Response NEVER exposes evidence.jsonb raw · no secret / token / chat_id literal', async () => {
  const owner = await bpOwnerDecision();
  const flat = JSON.stringify(owner);
  assert.doesNotMatch(flat, /"evidence":\s*\{[^}]*"supplier_id"/, 'raw evidence.supplier_id must not leak');
  assert.doesNotMatch(flat, /BOT_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(flat, /-100\d{7,}/, 'raw -100 chat_id must not leak');
  assert.doesNotMatch(flat, /\d{9,}:AAH[A-Za-z0-9_-]+/, 'raw bot token pattern must not leak');
});

test('K18. buildOwnerDecision runs with assessFn stub — NO new DB query · assess called exactly once', async () => {
  let assessCalls = 0;
  await buildOwnerDecision({
    physicalProductId: 1,
    assessFn: async () => { assessCalls++; return bpDecisionFixture(); },
  });
  assert.equal(assessCalls, 1, 'Phase 8K explainability must not trigger any additional upstream call');
});

// ─── K19-K21 · verbatim preservation of decision / action / priority ─

test('K19. headline.confidence_level is preserved VERBATIM · judgment_confidence.headline_confidence_level equals decision.confidence_level', async () => {
  const owner = await bpOwnerDecision();
  assert.equal(owner.headline.confidence_level, 'low');
  assert.equal(owner.judgment_confidence.headline_confidence_level, 'low');
});

test('K20. Derived overall_tier vs headline · both fields exposed (rev.2: BP overall is UNKNOWN because identity_verified missing)', async () => {
  // BP rev.2 tiers: demand HIGH · supply LOW · cost MEDIUM · identity UNKNOWN → overall UNKNOWN
  //   (UNKNOWN < LOW < MEDIUM < HIGH · UNKNOWN dominates min)
  const owner = await bpOwnerDecision();
  const jc = owner.judgment_confidence;
  assert.equal(jc.overall_tier, 'UNKNOWN');
  assert.equal(jc.headline_confidence_level, 'low');
  // 'low' ≠ 'UNKNOWN' → derived_matches_headline=false · BOTH exposed
  assert.equal(jc.derived_matches_headline, false);
  assert.ok(Object.prototype.hasOwnProperty.call(jc, 'overall_tier'));
  assert.ok(Object.prototype.hasOwnProperty.call(jc, 'headline_confidence_level'));
});

test('K20b. Force divergence: overall LOW but headline "high" → derived_matches_headline=false · both exposed', async () => {
  const owner = await bpOwnerDecision({ decision: { confidence_level: 'high' } });
  const jc = owner.judgment_confidence;
  assert.equal(jc.headline_confidence_level, 'high');
  assert.notEqual(String(jc.overall_tier).toLowerCase(), 'high');
  assert.equal(jc.derived_matches_headline, false);
  // Both must be present on the response
  assert.ok(Object.prototype.hasOwnProperty.call(jc, 'overall_tier'));
  assert.ok(Object.prototype.hasOwnProperty.call(jc, 'headline_confidence_level'));
});

test('K21. decision / recommended_actions / priority_score / urgency_label unchanged by Phase 8K', async () => {
  const owner = await bpOwnerDecision();
  // BP-invariant values from Phase 8B/8E baseline
  assert.equal(owner.headline.decision_status, DECISION.WATCH);
  assert.equal(owner.headline.priority_score, 170);
  assert.equal(owner.headline.urgency_label, 'medium');
  assert.deepEqual(
    owner.recommended_actions.map(a => a.code).sort(),
    [ACTION.CHECK_PRIMARY_SUPPLIER, ACTION.CONFIRM_EXECUTABLE_QUOTE, ACTION.WATCH_ONLY].sort()
  );
});

// ─── K22-K25 · security / safety static audits ─────────

test('K22. Phase 8K files contain NO Telegram / iMessage / notify / marketplace / getClient references', () => {
  const files = [
    'src/services/oms/inventoryReasonExplanations.js',
    'src/services/oms/judgmentConfidencePolicy.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]\)/i, `${f}: telegramBot leak`);
    assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]\)/i, `${f}: imessage leak`);
    assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]\)/i, `${f}: notify leak`);
    assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]\)/i, `${f}: ebayAPI leak`);
    assert.doesNotMatch(src, /require\(['"][^'"]*scheduler['"]\)/i, `${f}: scheduler leak`);
    assert.doesNotMatch(src, /getClient\(/, `${f}: getClient leak`);
    assert.doesNotMatch(src, /\bfrom\(['"]/, `${f}: db table access leak`);
    assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(/, `${f}: marketplace API leak`);
    assert.doesNotMatch(src, /\.insert\(|\.upsert\(|\.delete\(/, `${f}: DB write leak`);
  }
});

test('K23. Unknown reason passthrough is safe against odd inputs (no code injection · returns cast String)', () => {
  // Malicious-looking (but harmless) inputs should NOT be interpreted as templates
  const nasty = "$$__proto__.polluted = true; return '<script>alert(1)</script>'";
  assert.equal(translate(nasty), nasty);
  assert.equal(typeof translate({}), 'string');
});

test('K24. buildOwnerDecision return NEVER contains BOT_TOKEN / TELEGRAM_CHAT_ID / IMESSAGE_TO literals', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'ZZZ_SUPER_SECRET_TOKEN_ZZZ';
  process.env.TELEGRAM_CHAT_ID = '-100_ZZZ_SECRET_CHAT_ID';
  process.env.IMESSAGE_TO = 'zzz_secret@example.com';
  const owner = await bpOwnerDecision();
  const flat = JSON.stringify(owner);
  assert.equal(flat.includes('ZZZ_SUPER_SECRET_TOKEN_ZZZ'), false);
  assert.equal(flat.includes('-100_ZZZ_SECRET_CHAT_ID'), false);
  assert.equal(flat.includes('zzz_secret@example.com'), false);
});

test('K25. BP integration · all additive fields present + Phase 8I/8J contract intact', async () => {
  const owner = await bpOwnerDecision();
  // Additive fields
  assert.ok(owner.judgment_confidence, 'judgment_confidence present');
  assert.ok(owner.judgment_confidence.by_dimension, 'by_dimension present');
  assert.ok(owner.reasons.reason_code_explanations, 'reason_code_explanations present');
  assert.ok(owner.data_provenance, 'data_provenance present');
  assert.ok(Array.isArray(owner.recommended_evidence_actions), 'recommended_evidence_actions array present');
  // BP verbatim
  assert.equal(owner.inventory.available, 45);
  assert.equal(owner.demand.units_30d, 61);
  assert.equal(owner.demand.velocity_30d, 2.033333333333333);
  assert.equal(owner.supply.replacement_difficulty, 'HARD');
  assert.equal(owner.cost_context.historical_typical_supplier_cost_krw_median, 19500);
  assert.equal(owner.cost_context.historical_accounting_cost_krw, 45000);
  assert.equal(owner.cost_context.observed_secondary_market_ask_min_krw, 40000);
  // Reason explanations translate concentrated_large_order
  const ex = owner.reasons.reason_code_explanations['demand_concentrated_large_order'];
  assert.match(ex, /1건의 대형 주문/);
  assert.match(ex, /98\.4%/);
  // Unknown reason from decision_reason_codes would passthrough — none present here
});

// ─── K26-K30 · edge cases ─────────────────────────────

test('K26. reason_code_explanations shape: { code: string } · verbatim keys · no dropped codes', async () => {
  const owner = await bpOwnerDecision();
  const codes = owner.reasons.reason_codes;
  const explanations = owner.reasons.reason_code_explanations;
  for (const c of codes) {
    assert.ok(Object.prototype.hasOwnProperty.call(explanations, c), `code ${c} missing from explanations map`);
    assert.equal(typeof explanations[c], 'string');
  }
});

test('K27. identity tier · physical present + no blockers but identity_verified missing → UNKNOWN (Owner rev.2)', () => {
  // Physical alone MUST NOT yield HIGH (rev.2)
  assert.equal(
    policyInternals._deriveIdentityTier({ physical: { id: 1, canonical_title: 'BP' } }, { hold_quantity_blockers: [] }),
    'UNKNOWN',
    'physical alone is NOT sufficient for HIGH',
  );
  // Explicit verified=true → HIGH
  assert.equal(
    policyInternals._deriveIdentityTier({ physical: { id: 1, canonical_title: 'BP' }, identity: { verified: true } }, { hold_quantity_blockers: [] }),
    'HIGH',
  );
  // Explicit verified=false → LOW
  assert.equal(
    policyInternals._deriveIdentityTier({ identity: { verified: false } }, { hold_quantity_blockers: [] }),
    'LOW',
  );
  // Blockers dominate — LOW regardless of verified (even true)
  assert.equal(
    policyInternals._deriveIdentityTier({ identity: { verified: true } }, { hold_quantity_blockers: ['x'] }),
    'LOW',
  );
  // Both missing → UNKNOWN
  assert.equal(policyInternals._deriveIdentityTier({}, {}), 'UNKNOWN');
  // Alternate upstream location · physical.identity_verified
  assert.equal(
    policyInternals._deriveIdentityTier({ physical: { id: 1, canonical_title: 'BP', identity_verified: true } }, { hold_quantity_blockers: [] }),
    'HIGH',
  );
  // Non-boolean 'true' string → treated as missing → UNKNOWN
  assert.equal(
    policyInternals._deriveIdentityTier({ identity: { verified: 'true' } }, { hold_quantity_blockers: [] }),
    'UNKNOWN',
    'strict bool check · non-bool treated as missing',
  );
});

test('K28. cost tier (rev.2) · category-independent · counts NEVER summed', () => {
  // Empty upstream → all UNKNOWN
  const empty = policyInternals._deriveCostBreakdown({});
  assert.equal(empty.overall, 'UNKNOWN');
  assert.deepEqual(empty.category_tiers, { supplier: 'UNKNOWN', accounting: 'UNKNOWN', secondary_market: 'UNKNOWN' });

  // Historical typical only → supplier MEDIUM, overall MEDIUM
  const typicalOnly = policyInternals._deriveCostBreakdown({
    historical_reference_product_cost: { observation_count: 3 },
  });
  assert.equal(typicalOnly.category_tiers.supplier, 'MEDIUM', 'historical typical only → MEDIUM ceiling');
  assert.equal(typicalOnly.overall, 'MEDIUM');

  // 100 typical observations still cap at MEDIUM (count does NOT lift)
  const manyTypical = policyInternals._deriveCostBreakdown({
    historical_reference_product_cost: { observation_count: 100 },
  });
  assert.equal(manyTypical.category_tiers.supplier, 'MEDIUM');
  assert.equal(manyTypical.overall, 'MEDIUM');

  // Executable quote without freshness → supplier MEDIUM (Owner: no HIGH without freshness)
  const execNoFresh = policyInternals._deriveCostBreakdown({
    supply_risk: { current_supply_quality: 'executable', has_current_supplier_or_executable: true },
  });
  assert.equal(execNoFresh.category_tiers.supplier, 'MEDIUM');
  assert.equal(execNoFresh.freshness_verified, false);

  // Executable quote WITH freshness → supplier HIGH
  const execWithFresh = policyInternals._deriveCostBreakdown({
    supply_risk: { current_supply_quality: 'executable', has_current_supplier_or_executable: true },
    historical_reference_context: { replacement_price_observed_at: '2026-08-15T00:00:00Z' },
  });
  assert.equal(execWithFresh.category_tiers.supplier, 'HIGH');
  assert.equal(execWithFresh.overall, 'HIGH');
});

test('K29. error path · judgment_confidence + data_provenance present + all UNKNOWN', async () => {
  const owner = await buildOwnerDecision({
    physicalProductId: 999999,
    assessFn: async () => ({ physical_product_id: 999999, error: 'physical_not_found', decision: { status: DECISION.INSUFFICIENT_DATA, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: null }, physical: null, inventory_summary: null, demand_summary: null, supply_summary: null, cost_context: null, missing_evidence: ['physical_not_found'], generated_at: new Date().toISOString(), strategic_hold_source: {} }),
  });
  assert.equal(owner.error, 'physical_not_found');
  assert.equal(owner.judgment_confidence.overall_tier, 'UNKNOWN');
  for (const dimKey of ['demand', 'supply', 'cost', 'identity']) {
    assert.equal(owner.judgment_confidence.by_dimension[dimKey].tier, 'UNKNOWN', `${dimKey} tier should be UNKNOWN in error path`);
  }
  assert.equal(owner.data_provenance.inventory.source, 'UNKNOWN');
});

test('K30. UI source file references "판단 신뢰도" + "숫자의 출처" + "확인되지 않음" (UNKNOWN not hidden)', () => {
  const uiSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/ownerInventory.js'), 'utf8');
  assert.match(uiSrc, /판단 신뢰도/);
  assert.match(uiSrc, /숫자의 출처/);
  assert.match(uiSrc, /확인되지 않음/);
  // no operational mutation button text was added
  assert.doesNotMatch(uiSrc, />\s*(BUY|PURCHASE|HOLD|CHANGE PRICE|CHANGE LISTING|ADJUST INVENTORY)\s*</i);
});

// ─── K31-K33 · regression guards ───────────────────────

test('K31. Phase 8I/8J response contract intact · pre-existing fields unchanged', async () => {
  const owner = await bpOwnerDecision();
  assert.ok(owner.headline && owner.product && owner.inventory && owner.demand && owner.supply && owner.cost_context && owner.reasons && owner.recommended_actions && owner.forbidden_automatic_actions && owner.source_snapshot);
  // 8I forbidden auto actions still surfaced
  assert.ok(owner.forbidden_automatic_actions.includes('AUTO_PURCHASE'));
});

test('K32. Full BP scenario (rev.2) · WATCH · 170 · identity=UNKNOWN (no verified) · cost=MEDIUM (typical only) · overall=UNKNOWN', async () => {
  const owner = await bpOwnerDecision();
  assert.equal(owner.headline.decision_status, DECISION.WATCH);
  assert.equal(owner.headline.priority_score, 170);
  assert.equal(owner.judgment_confidence.by_dimension.demand.tier, 'HIGH');    // trusted=true
  assert.equal(owner.judgment_confidence.by_dimension.supply.tier, 'LOW');     // evidence_confidence=low
  // Identity rev.2: physical present alone is NOT HIGH · no verified field → UNKNOWN
  assert.equal(owner.judgment_confidence.by_dimension.identity.tier, 'UNKNOWN');
  // Cost rev.2: BP fixture has no current supplier/executable AND historical typical (4 obs) → supplier MEDIUM · overall MEDIUM
  assert.equal(owner.judgment_confidence.by_dimension.cost.tier, 'MEDIUM');
  assert.equal(owner.judgment_confidence.by_dimension.cost.category_tiers.supplier, 'MEDIUM');
  assert.equal(owner.judgment_confidence.by_dimension.cost.category_tiers.accounting, 'MEDIUM');   // cost_krw present, no freshness → MEDIUM
  assert.equal(owner.judgment_confidence.by_dimension.cost.category_tiers.secondary_market, 'LOW');
  // Overall = min(HIGH, LOW, MEDIUM, UNKNOWN) → UNKNOWN
  assert.equal(owner.judgment_confidence.overall_tier, 'UNKNOWN');
});

// ─── K34-K42 · rev.2 regression tests (Owner-mandated) ─────────

test('K34. rev.2 · physical present + no blockers + verified missing → identity UNKNOWN (never HIGH)', async () => {
  const owner = await bpOwnerDecision({
    strategic_hold_source: { identity: undefined, physical: { identity_verified: undefined } },
    decision: { hold_quantity_blockers: [] },
  });
  assert.equal(owner.judgment_confidence.by_dimension.identity.tier, 'UNKNOWN');
  assert.equal(owner.judgment_confidence.by_dimension.identity.identity_verified, null);
});

test('K35. rev.2 · identity_verified=true (via strategic_hold_source.identity.verified) → identity HIGH', async () => {
  const owner = await bpOwnerDecision({
    strategic_hold_source: { identity: { verified: true } },
    decision: { hold_quantity_blockers: [] },
  });
  assert.equal(owner.judgment_confidence.by_dimension.identity.tier, 'HIGH');
  assert.equal(owner.judgment_confidence.by_dimension.identity.identity_verified, true);
});

test('K36. rev.2 · identity_verified=false → identity LOW', async () => {
  const owner = await bpOwnerDecision({
    strategic_hold_source: { identity: { verified: false } },
    decision: { hold_quantity_blockers: [] },
  });
  assert.equal(owner.judgment_confidence.by_dimension.identity.tier, 'LOW');
  assert.equal(owner.judgment_confidence.by_dimension.identity.identity_verified, false);
});

test('K37. rev.2 · secondary observation count 999 does NOT lift supplier tier (categories independent)', () => {
  // Historical typical only (MEDIUM) + massive secondary observations
  const holdSrc = {
    historical_reference_product_cost: { observation_count: 3 },
    supply_risk: {
      current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
      secondary_market_depth: [{ min_ask: 40000, fresh_observations: 999, stale_observations: 0, total: 999 }],
      observed_secondary_market_unit_cost_min: 40000,
    },
  };
  const b = policyInternals._deriveCostBreakdown(holdSrc);
  assert.equal(b.category_tiers.supplier, 'MEDIUM', 'supplier stays MEDIUM · secondary count does not lift');
  assert.equal(b.category_tiers.secondary_market, 'LOW', 'secondary always LOW ceiling');
  assert.equal(b.overall, 'MEDIUM', 'overall = supplier (priority) not secondary');
});

test('K38. rev.2 · historical typical only present → cost overall MEDIUM (never higher)', () => {
  const b = policyInternals._deriveCostBreakdown({
    historical_reference_product_cost: { observation_count: 10 },
  });
  assert.equal(b.category_tiers.supplier, 'MEDIUM');
  assert.equal(b.category_tiers.accounting, 'UNKNOWN');
  assert.equal(b.category_tiers.secondary_market, 'UNKNOWN');
  assert.equal(b.overall, 'MEDIUM');
});

test('K39. rev.2 · secondary ask only → cost overall LOW', () => {
  const b = policyInternals._deriveCostBreakdown({
    supply_risk: {
      secondary_market_depth: [{ fresh_observations: 5, total: 5 }],
      observed_secondary_market_unit_cost_min: 40000,
    },
  });
  assert.equal(b.category_tiers.supplier, 'UNKNOWN');
  assert.equal(b.category_tiers.accounting, 'UNKNOWN');
  assert.equal(b.category_tiers.secondary_market, 'LOW');
  assert.equal(b.overall, 'LOW');
});

test('K40. rev.2 · freshness unknown → cost NEVER HIGH', () => {
  // executable quote present but no replacement_price_observed_at
  const noFresh = policyInternals._deriveCostBreakdown({
    supply_risk: { current_supply_quality: 'executable', has_current_supplier_or_executable: true },
    historical_reference_context: {},   // no replacement_price_observed_at
  });
  assert.notEqual(noFresh.category_tiers.supplier, 'HIGH');
  assert.notEqual(noFresh.overall, 'HIGH');
  // accounting cost_krw without freshness → MEDIUM (not HIGH)
  const acctNoFresh = policyInternals._deriveCostBreakdown({
    historical_accounting_cost: { cost_krw: 45000 },   // no observed_at
  });
  assert.equal(acctNoFresh.category_tiers.accounting, 'MEDIUM');
});

test('K41. rev.2 · BP scenario · dep60=100% + ask_only → CHECK_SECONDARY_MARKET INCLUDED', async () => {
  const owner = await bpOwnerDecision();
  const actions = owner.recommended_evidence_actions;
  assert.ok(actions.includes(ACTION.CONFIRM_EXECUTABLE_QUOTE), 'CONFIRM_EXECUTABLE_QUOTE missing');
  assert.ok(actions.includes(ACTION.CHECK_PRIMARY_SUPPLIER), 'CHECK_PRIMARY_SUPPLIER missing');
  assert.ok(actions.includes(ACTION.CHECK_SECONDARY_MARKET), 'CHECK_SECONDARY_MARKET missing (rev.2 fix)');
});

test('K42. rev.2 · recommended_evidence_actions has NO duplicates + deterministic order', async () => {
  const owner = await bpOwnerDecision();
  const actions = owner.recommended_evidence_actions;
  // No dupes
  assert.equal(new Set(actions).size, actions.length, 'duplicates present in recommended_evidence_actions');
  // Deterministic order: CONFIRM_EXECUTABLE_QUOTE < CHECK_PRIMARY_SUPPLIER < CHECK_SECONDARY_MARKET
  const idxA = actions.indexOf(ACTION.CONFIRM_EXECUTABLE_QUOTE);
  const idxB = actions.indexOf(ACTION.CHECK_PRIMARY_SUPPLIER);
  const idxC = actions.indexOf(ACTION.CHECK_SECONDARY_MARKET);
  assert.ok(idxA < idxB && idxB < idxC, `expected policy order · got: ${actions.join(', ')}`);
});

test('K43. rev.2 · category_tiers exposed on cost dimension', async () => {
  const owner = await bpOwnerDecision();
  const cost = owner.judgment_confidence.by_dimension.cost;
  assert.ok(cost.category_tiers, 'category_tiers missing on cost dimension');
  for (const k of ['supplier', 'accounting', 'secondary_market']) {
    assert.ok(Object.prototype.hasOwnProperty.call(cost.category_tiers, k), `category_tiers.${k} missing`);
  }
  assert.equal(typeof cost.freshness_verified, 'boolean');
});

test('K44. rev.2 · decision/priority/action/urgency STILL unchanged after rev.2 changes', async () => {
  const owner = await bpOwnerDecision();
  assert.equal(owner.headline.decision_status, DECISION.WATCH);
  assert.equal(owner.headline.priority_score, 170);
  assert.equal(owner.headline.urgency_label, 'medium');
  const codes = owner.recommended_actions.map(a => a.code).sort();
  assert.deepEqual(codes, [ACTION.CHECK_PRIMARY_SUPPLIER, ACTION.CONFIRM_EXECUTABLE_QUOTE, ACTION.WATCH_ONLY].sort());
});

test('K33. No Phase 8C/8D alerter / no scheduler / no agent references added by Phase 8K files', () => {
  const files = [
    'src/services/oms/inventoryReasonExplanations.js',
    'src/services/oms/judgmentConfidencePolicy.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
    assert.doesNotMatch(src, /inventoryExceptionsAlerter/, `${f}: alerter reference leak`);
    assert.doesNotMatch(src, /cron|scheduleDaily|setInterval/, `${f}: scheduler reference leak`);
    assert.doesNotMatch(src, /require\(['"][^'"]*agent[^'"]*['"]\)/i, `${f}: agent reference leak`);
  }
});
