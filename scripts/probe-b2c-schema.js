#!/usr/bin/env node
'use strict';
/**
 * probe-b2c-schema.js — Phase 2 pre-migration schema verification (READ-ONLY).
 * Uses Supabase REST (@supabase/supabase-js) — no DDL, no direct Postgres.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const section = (title) => console.log('\n' + '='.repeat(60) + '\n' + title + '\n' + '-'.repeat(60));

async function sample(table) {
  const { data, error } = await db.from(table).select('*').limit(1);
  if (error) return { err: error.message };
  return data && data.length ? Object.keys(data[0]) : [];
}
async function distinct(table, col, extraCol) {
  const sel = extraCol ? `${col},${extraCol}` : col;
  const { data, error } = await db.from(table).select(sel).limit(5000);
  if (error) return { err: error.message };
  const map = new Map();
  for (const r of data) {
    const k = extraCol ? `${r[col]}||${r[extraCol]}` : String(r[col]);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
}
async function count(table, filter) {
  let q = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? { err: error.message } : n;
}

async function main() {
  section('1. team_tasks — 컬럼 (확장 전 스냅샷)');
  console.log(await sample('team_tasks'));

  section('2. team_tasks — priority / status / exception_type / auto_generated 값 분포');
  console.log('priority:', await distinct('team_tasks', 'priority'));
  console.log('status:',   await distinct('team_tasks', 'status'));
  console.log('exception_type (top):', (await distinct('team_tasks', 'exception_type')).slice(0, 15));
  console.log('total rows:', await count('team_tasks'));
  console.log('auto_generated=true:', await count('team_tasks', q => q.eq('auto_generated', true)));
  console.log('related_sku_id NOT NULL:', await count('team_tasks', q => q.not('related_sku_id', 'is', null)));
  console.log('dedupe_key NOT NULL:',    await count('team_tasks', q => q.not('dedupe_key', 'is', null)));

  section('3. sku_master — 컬럼 + 총 행수');
  console.log(await sample('sku_master'));
  console.log('total:', await count('sku_master'));
  console.log('active:', await count('sku_master', q => q.eq('status', 'active')));

  section('4. sku_listing_link — 컬럼 + marketplace 분포');
  console.log(await sample('sku_listing_link'));
  console.log('by marketplace:', await distinct('sku_listing_link', 'marketplace'));
  console.log('total:', await count('sku_listing_link'));

  section('5. platform_listings — 컬럼 + platform/status 분포');
  console.log(await sample('platform_listings'));
  console.log('platform × status (top 20):');
  const ps = await distinct('platform_listings', 'platform', 'status');
  ps.slice(0, 25).forEach(([k, n]) => console.log(`  ${k.padEnd(45)} ${n}`));

  section('6. oms_orders — channel 분포');
  console.log('channel:', await distinct('oms_orders', 'channel'));
  console.log('total oms_orders:', await count('oms_orders'));
  console.log('last 90d (approx):', await count('oms_orders', q => q.gte('ordered_at', new Date(Date.now() - 90 * 86400e3).toISOString())));

  section('7. inventory_movements — movement_type + 컬럼');
  console.log('movement_type:', await distinct('inventory_movements', 'movement_type'));
  console.log(await sample('inventory_movements'));
  console.log('total:', await count('inventory_movements'));

  section('8. sku_master_link — 여러 sku_master → 하나 sellable_unit 중복 확인');
  const { data: sml } = await db.from('sku_master_link').select('sellable_unit_id').limit(5000);
  const smlMap = new Map();
  for (const r of (sml || [])) smlMap.set(r.sellable_unit_id, (smlMap.get(r.sellable_unit_id) || 0) + 1);
  const dupes = Array.from(smlMap.entries()).filter(([, n]) => n > 1);
  console.log(`sku_master_link total: ${sml?.length || 0}`);
  console.log(`sellable_unit 당 sku_master 여러 개 (dupe): ${dupes.length}`);
  console.log(`  샘플 top 5:`, dupes.slice(0, 5));

  section('9. margin_settings — 기존 b2c.* key 유무');
  const { data: cfg } = await db.from('margin_settings').select('setting_key,setting_value,category').limit(500);
  const b2c = (cfg || []).filter(r => (r.setting_key || '').startsWith('b2c.') || r.category === 'b2c_inventory');
  console.log(`b2c.* keys already present: ${b2c.length}`);
  b2c.forEach(r => console.log(` - ${r.setting_key}=${r.setting_value} (cat=${r.category})`));
  console.log(`total margin_settings rows: ${cfg?.length || 0}`);

  section('10. users — role 분포');
  console.log('role:', await distinct('users', 'role'));

  section('11. ebay_products — sku_master.internal_sku 와 join 정확성');
  console.log(await sample('ebay_products'));
  console.log('total ebay_products:', await count('ebay_products'));

  section('12. shopify_products 존재 확인');
  console.log(await sample('shopify_products'));

  section('13. oms_order_items — sku_master_id 매칭율');
  console.log('total:', await count('oms_order_items'));
  console.log('sku_master_id NOT NULL:', await count('oms_order_items', q => q.not('sku_master_id', 'is', null)));
}

main().catch(e => { console.error('FATAL', e.stack || e); process.exit(1); });
