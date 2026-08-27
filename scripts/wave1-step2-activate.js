#!/usr/bin/env node
'use strict';
/**
 * wave1-step2-activate.js — Wave 1 activate (실제 sku_master 3건 UPDATE).
 * eligibility 변경: [null] → ["coupang","naver","11st","gmarket"] · 3 SKU 만.
 * 3 SKU 외 변경 감지 시 STOP.
 *
 * BEFORE / AFTER 스냅샷 저장:
 *   exports/b2c-inventory/wave1_activate_snapshot_<ts>.json
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const pilot = require('../src/services/b2cInventory/pilotSelection');
const waves = require('../src/services/b2cInventory/pilotWaves');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const EXPECTED_SKUS = [2616, 2290, 6048];

(async () => {
  console.log('='.repeat(78));
  console.log('Wave 1 · STEP 2 · Activate (REAL WRITE · sku_master 3 UPDATE)');
  console.log('='.repeat(78));

  //   BEFORE: 전체 active SKU 의 channel_eligibility non-null 갯수
  const { count: beforeNonNull } = await db.from('sku_master')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('channel_eligibility', 'is', null);
  console.log(`\nBEFORE 전체 active SKU 중 channel_eligibility != NULL: ${beforeNonNull}`);

  //   BEFORE: Wave 1 3 SKU 상세
  const { data: beforeSku } = await db.from('sku_master')
    .select('id, internal_sku, channel_eligibility').in('id', EXPECTED_SKUS);
  console.log(`\nBEFORE Wave 1 SKU 상세:`);
  (beforeSku || []).forEach(r => console.log(`  id=${r.id} · ${r.internal_sku} · eligibility=${JSON.stringify(r.channel_eligibility)}`));

  //   Activate · Wave 1
  console.log(`\n실행 · pilotActivate wave=wave_1 size=50 skuIds=${EXPECTED_SKUS.join(',')}`);
  const result = await pilot.pilotActivate({
    db, size: 50, userId: 'owner_direct_wave1', skuIds: EXPECTED_SKUS, waveLabel: 'wave_1',
  });

  console.log(`\nresults: requested=${result.results.requested} · activated=${result.results.activated} · unchanged=${result.results.unchanged} · skipped_due_to_drift=${result.results.skipped_due_to_drift} · errors=${result.results.errors.length}`);

  //   AFTER: 전체 non-null 갯수 (반드시 before + activated 이어야 함)
  const { count: afterNonNull } = await db.from('sku_master')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('channel_eligibility', 'is', null);
  console.log(`\nAFTER 전체 active SKU 중 channel_eligibility != NULL: ${afterNonNull}`);
  const delta = Number(afterNonNull) - Number(beforeNonNull);
  console.log(`Delta: ${delta} (expected = activated ${result.results.activated})`);

  //   AFTER: 3 SKU 상세
  const { data: afterSku } = await db.from('sku_master')
    .select('id, internal_sku, channel_eligibility').in('id', EXPECTED_SKUS);
  console.log(`\nAFTER Wave 1 SKU 상세:`);
  const wanted = ['coupang','naver','11st','gmarket'];
  let allOk = true;
  for (const r of (afterSku || [])) {
    const ok = Array.isArray(r.channel_eligibility) &&
      r.channel_eligibility.length === 4 &&
      wanted.every(c => r.channel_eligibility.includes(c));
    console.log(`  id=${r.id} · ${r.internal_sku} · eligibility=${JSON.stringify(r.channel_eligibility)} · ${ok ? '✓' : '✗'}`);
    if (!ok) allOk = false;
  }

  //   3 SKU 외 변경 감지 (unexpected 변화)
  //   Wave 1 3 SKU 만 activate 요청 · delta 가 activated 초과면 이상
  const unexpected = delta - result.results.activated;
  const safe = unexpected === 0;
  console.log(`\n3 SKU 외 변경 감지: ${safe ? '✓ 없음 (안전)' : `✗ ${unexpected}건 unexpected 변화 · STOP`}`);

  //   snapshot 저장
  const now = new Date().toISOString();
  const outDir = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `wave1_activate_snapshot_${now.replace(/[:.]/g,'-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    at: now, requested_sku_ids: EXPECTED_SKUS,
    before: { total_non_null_eligibility: Number(beforeNonNull), wave1_skus: beforeSku },
    after:  { total_non_null_eligibility: Number(afterNonNull),  wave1_skus: afterSku },
    delta, unexpected,
    activate_result: result,
  }, null, 2));
  console.log(`\n스냅샷: ${outPath}`);

  console.log('\n' + '='.repeat(78));
  console.log(allOk && safe
    ? '✓ STEP 2 SUCCESS · STEP 3 진행 가능'
    : '✗ STEP 2 FAILED · 조건 불일치 또는 unexpected 변화 · STOP');
  console.log('='.repeat(78));
  if (!allOk || !safe) process.exit(1);
})().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
