'use strict';

/**
 * tests/services/shippingShadowRecorder.test.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13).
 *
 * Owner directive §4 · §7 test coverage:
 *   · recordShadowResult writes with correct payload shape
 *   · difference_amount + difference_pct computed correctly
 *   · idempotency via upsert(onConflict: listing_job_id,product_ref)
 *   · required fields enforced (listingJobId, productRef, marketplace)
 *   · numeric coercion / int cast safety
 *   · error is thrown but automation caller is responsible for swallowing it
 *     (spec §7: shadow storage failure MUST NOT fail the automation listing)
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const REC  = require.resolve(path.join(REPO, 'src/services/shipping/shadowRecorder.js'));

function loadFresh() {
  delete require.cache[REC];
  return require(REC);
}

function makeStub(behavior) {
  //   Behavior is a function that receives (payload) and returns { data, error }.
  const calls = [];
  const stub = {
    from(table) {
      return {
        upsert(payload, opts) {
          calls.push({ table, payload, opts });
          return {
            select() {
              return {
                maybeSingle: async () => behavior({ table, payload, opts }),
              };
            },
          };
        },
      };
    },
  };
  return { stub, calls };
}

test('REC-A · records legacy/new/difference correctly', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub, calls } = makeStub(() => ({ data: { id: 7 }, error: null }));
  const out = await recordShadowResult({
    listingJobId: 'JOB-1',
    productRef:   'SKU-100',
    marketplace:  'ebay',
    destinationCountry: 'us',
    legacyListingPrice:  10000,
    newListingPrice:     12500,
    legacyShippingCost:  5000,
    newShippingCost:     7000,
    chargeableWeightKg:  0.5,
    serviceCode: 'EGS_STD_US',
    rateVersionId: 42,
    policyBandId: 3,
    status: 'ok',
  }, { supabase: stub });
  assert.equal(out.id, 7);
  assert.equal(calls.length, 1);
  const p = calls[0].payload;
  assert.equal(p.listing_job_id, 'JOB-1');
  assert.equal(p.product_ref, 'SKU-100');
  assert.equal(p.destination_country, 'US');
  assert.equal(p.legacy_listing_price, 10000);
  assert.equal(p.new_listing_price, 12500);
  assert.equal(p.difference_amount, 2500);
  //   (12500 - 10000) / 10000 = 0.25 → 4-dp = 0.25
  assert.equal(p.difference_pct, 0.25);
  assert.equal(p.status, 'ok');
});

test('REC-B · upsert uses (listing_job_id, product_ref) as unique key', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub, calls } = makeStub(() => ({ data: { id: 1 }, error: null }));
  await recordShadowResult({
    listingJobId: 'JOB-2', productRef: 'SKU-200', marketplace: 'ebay', status: 'ok',
  }, { supabase: stub });
  assert.equal(calls[0].opts.onConflict, 'listing_job_id,product_ref');
  assert.equal(calls[0].opts.ignoreDuplicates, true);
});

test('REC-C · missing legacy/new price → null diffs (never NaN)', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub, calls } = makeStub(() => ({ data: { id: 1 }, error: null }));
  await recordShadowResult({
    listingJobId: 'JOB-3', productRef: 'SKU-300', marketplace: 'ebay',
    legacyListingPrice: null, newListingPrice: 5000, status: 'ok',
  }, { supabase: stub });
  const p = calls[0].payload;
  assert.equal(p.difference_amount, null);
  assert.equal(p.difference_pct, null);
});

test('REC-D · required fields throw (listingJobId, productRef, marketplace)', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub } = makeStub(() => ({ data: null, error: null }));
  await assert.rejects(
    () => recordShadowResult({ productRef: 'x', marketplace: 'ebay' }, { supabase: stub }),
    /required/,
  );
  await assert.rejects(
    () => recordShadowResult({ listingJobId: 'j', marketplace: 'ebay' }, { supabase: stub }),
    /required/,
  );
  await assert.rejects(
    () => recordShadowResult({ listingJobId: 'j', productRef: 'x' }, { supabase: stub }),
    /required/,
  );
});

test('REC-E · Supabase error propagates (caller MUST swallow to protect listing)', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub } = makeStub(() => ({ data: null, error: { message: 'db down' } }));
  await assert.rejects(
    () => recordShadowResult({
      listingJobId: 'JOB-E', productRef: 'SKU-E', marketplace: 'ebay', status: 'ok',
    }, { supabase: stub }),
    /db down/,
  );
});

test('REC-F · blocked status stored with reason', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub, calls } = makeStub(() => ({ data: { id: 1 }, error: null }));
  await recordShadowResult({
    listingJobId: 'JOB-F', productRef: 'SKU-F', marketplace: 'ebay',
    status: 'blocked', blockedReason: 'NO_SHIPPING_POLICY',
  }, { supabase: stub });
  const p = calls[0].payload;
  assert.equal(p.status, 'blocked');
  assert.equal(p.blocked_reason, 'NO_SHIPPING_POLICY');
});

test('REC-G · long strings truncated to column limits', async () => {
  const { recordShadowResult } = loadFresh();
  const { stub, calls } = makeStub(() => ({ data: { id: 1 }, error: null }));
  await recordShadowResult({
    listingJobId: 'j'.repeat(1000),
    productRef:   'p'.repeat(1000),
    marketplace:  'ebay',
    serviceCode:  's'.repeat(200),
    blockedReason:'r'.repeat(500),
    status: 'blocked',
  }, { supabase: stub });
  const p = calls[0].payload;
  assert.equal(p.listing_job_id.length, 200);
  assert.equal(p.product_ref.length, 200);
  assert.equal(p.service_code.length, 50);
  assert.equal(p.blocked_reason.length, 80);
});
