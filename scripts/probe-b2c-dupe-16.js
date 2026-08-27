#!/usr/bin/env node
'use strict';
/**
 * probe-b2c-dupe-16.js — Phase 3 pre-work · v_sku_channel_matrix 2808 vs active SKU 2792 = 16 diff 원인.
 *
 * Owner 질문:
 *   · 같은 SKU 에 동일 channel listing 이 복수 존재?
 *   · 동일 SKU+channel 중복?
 *   · v_sku_b2c_scorecard 의 live/registered/observed 값이 중복 때문에 부풀려지는가?
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

(async () => {
  //   ── 1. v_sku_channel_matrix 전체 로드 (2808 rows 예상) ─
  let rows = []; let offset = 0;
  while (true) {
    const { data, error } = await db.from('v_sku_channel_matrix')
      .select('sku_master_id,internal_sku,channel,channel_status,listing_id,marketplace_sku,raw_status,last_checked_at')
      .range(offset, offset + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`v_sku_channel_matrix 총 rows: ${rows.length}`);

  //   ── 2. sku_master_id × channel 조합별 갯수 ─────────────
  const key = r => `${r.sku_master_id}||${r.channel || 'NULL'}`;
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dupes = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);
  console.log(`고유 (sku_master_id × channel) 조합: ${groups.size}`);
  console.log(`중복 발생 조합 (>1 row): ${dupes.length}`);
  console.log(`총 중복으로 인한 추가 rows: ${dupes.reduce((s, [, a]) => s + (a.length - 1), 0)}`);
  console.log();

  //   ── 3. 중복 사례 상세 ────────────────────────────────
  console.log('=== 중복 사례 (모든 dupe) ===');
  for (const [k, arr] of dupes) {
    console.log(`\n[${k}] · ${arr.length} rows`);
    for (const r of arr) {
      console.log(`  · listing_id=${r.listing_id ?? '-'} · status=${r.channel_status} (raw=${r.raw_status ?? '-'}) · mkt_sku=${r.marketplace_sku ?? '-'} · last_checked=${r.last_checked_at ?? '-'}`);
    }
  }

  //   ── 4. 각 중복 sku_master_id 의 sku_listing_link 원본 확인 ─
  const dupSkuIds = Array.from(new Set(dupes.map(([, arr]) => arr[0].sku_master_id)));
  console.log('\n\n=== 원본 sku_listing_link 로 역추적 ===');
  for (const smid of dupSkuIds) {
    const { data: sllRows } = await db.from('sku_listing_link')
      .select('*').eq('sku_id', smid);
    console.log(`\nsku_master_id=${smid} · sku_listing_link ${(sllRows||[]).length} rows:`);
    (sllRows || []).forEach(r => {
      console.log(`  · id=${r.id} · marketplace=${r.marketplace} · listing_id=${r.listing_id} · option_id=${r.option_id} · is_primary=${r.is_primary} · updated_at=${r.updated_at}`);
    });
    //   sku_master.internal_sku 로 platform_listings 도 조회
    const { data: sm } = await db.from('sku_master').select('internal_sku').eq('id', smid).maybeSingle();
    if (sm) {
      const { data: plRows } = await db.from('platform_listings')
        .select('id,platform,platform_item_id,sku,status,quantity,price,updated_at')
        .eq('sku', sm.internal_sku);
      console.log(`  ↳ platform_listings.sku='${sm.internal_sku}' → ${(plRows||[]).length} rows:`);
      (plRows || []).forEach(r => {
        console.log(`     · id=${r.id} · platform=${r.platform} · item_id=${r.platform_item_id} · status=${r.status} · qty=${r.quantity} · updated_at=${r.updated_at}`);
      });
    }
  }

  //   ── 5. v_sku_b2c_scorecard 부풀림 여부 · dupe SKU 의 live/registered/observed 확인 ─
  console.log('\n\n=== v_sku_b2c_scorecard · dupe SKU 값 확인 ===');
  const { data: scRows } = await db.from('v_sku_b2c_scorecard')
    .select('sku_master_id,internal_sku,live_channels,registered_channels,observed_channels,missing_channels_seen')
    .in('sku_master_id', dupSkuIds);
  console.table((scRows||[]).map(r => ({
    sku_id: r.sku_master_id,
    internal_sku: r.internal_sku,
    live_ch: r.live_channels,
    reg_ch: r.registered_channels,
    obs_ch: r.observed_channels,
    missing: JSON.stringify(r.missing_channels_seen || []),
  })));

  //   ── 6. 전체 active SKU 수와 관계 ─────────────────────
  const { count: activeCount } = await db.from('sku_master').select('*',{count:'exact',head:true}).eq('status','active');
  const distinctSkuInView = new Set(rows.map(r => r.sku_master_id)).size;
  console.log(`\nsku_master status=active total: ${activeCount}`);
  console.log(`v_sku_channel_matrix distinct sku_master_id: ${distinctSkuInView}`);
  console.log(`차이: ${activeCount - distinctSkuInView} (view 에 없는 active SKU · matrix LEFT JOIN 이라 이론상 0 이어야 함)`);
})().catch(e => { console.error('FATAL', e.stack || e); process.exit(1); });
