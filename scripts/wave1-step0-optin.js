#!/usr/bin/env node
'use strict';
/**
 * wave1-step0-optin.js — Owner 승인 (2026-08-26) 하 Operator opt-in.
 *   id=4 kimjy · b2c_operator=true · b2c_channels=[coupang,naver]
 *   id=5 noms  · b2c_operator=true · b2c_channels=[11st,gmarket]
 * 재조회로 조건 확인. 불일치 시 즉시 STOP (exit 1).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { Client } = require('pg');
const CONN = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim() ||
  'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';

async function main() {
  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('='.repeat(78));
  console.log('Wave 1 · STEP 0 · Operator Opt-in');
  console.log('='.repeat(78));

  //   before snapshot
  const before = await c.query(`select id, username, is_active, b2c_operator, b2c_channels from users where id in (4,5) order by id`);
  console.log('\nBEFORE:');
  before.rows.forEach(r => console.log(`  id=${r.id} · ${r.username} · is_active=${r.is_active} · b2c_operator=${r.b2c_operator} · b2c_channels=${JSON.stringify(r.b2c_channels)}`));

  //   UPDATE 1 · kimjy
  await c.query(`
    update users set b2c_operator=true, b2c_channels='["coupang","naver"]'::jsonb    where id=4
  `);
  //   UPDATE 2 · noms
  await c.query(`
    update users set b2c_operator=true, b2c_channels='["11st","gmarket"]'::jsonb    where id=5
  `);

  //   verify
  const after = await c.query(`select id, username, is_active, b2c_operator, b2c_channels from users where id in (4,5) order by id`);
  console.log('\nAFTER:');
  const results = [];
  for (const r of after.rows) {
    const expectedChannels = r.id === 4 ? ['coupang','naver'] : ['11st','gmarket'];
    const ok =
      r.is_active === true &&
      r.b2c_operator === true &&
      Array.isArray(r.b2c_channels) &&
      JSON.stringify(r.b2c_channels.sort()) === JSON.stringify(expectedChannels.sort());
    console.log(`  id=${r.id} · ${r.username} · is_active=${r.is_active} · b2c_operator=${r.b2c_operator} · b2c_channels=${JSON.stringify(r.b2c_channels)} · ${ok ? '✓' : '✗ FAIL'}`);
    results.push({ id: r.id, ok, row: r });
  }
  const allOk = results.every(r => r.ok);
  console.log('\n' + '='.repeat(78));
  console.log(allOk ? '✓ STEP 0 SUCCESS · 조건 부합 · STEP 1 진행 가능' : '✗ STEP 0 FAILED · 조건 불일치 · STOP');
  console.log('='.repeat(78));

  await c.end();
  if (!allOk) process.exit(1);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
