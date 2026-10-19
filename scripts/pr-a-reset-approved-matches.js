#!/usr/bin/env node
/**
 * PR-A (2026-10-20) · product_matches 승인 무결성 데이터 전환.
 *
 * 사장님 지침:
 *   - approved 2,592건 전부 suggested 로 전환 (실제 사람 승인 흔적 0건)
 *   - "깨끗함" 1,135건 (564 + 571) 은 review_priority=1 (1순위)
 *   - "애매함" 17건은 pending → pending_review (migration 118 완료 후)
 *
 * 분류 소스:
 *   - approved_by NULL 1,348건 분류 JSON:
 *       /private/tmp/.../scratchpad/approved_null_classification_all.json
 *   - approved_by non-human 1,244건 분류: 이 스크립트가 동일 로직으로 재계산
 *     (snapshot 저장 안 함 — 결정론적이고 재현 가능)
 *   - 애매함 17건 소스: Downloads/매칭검증_저신뢰_145건_20261019.xlsx "애매함" 시트
 *
 * 실행:
 *   DRY_RUN=true  node scripts/pr-a-reset-approved-matches.js  (기본, 미리보기만)
 *   DRY_RUN=false node scripts/pr-a-reset-approved-matches.js  (실제 UPDATE)
 *
 * 사전 조건:
 *   - Migration 118 적용 완료 (suggested/pending_review enum 추가, review_priority 컬럼)
 *   - Migration 119 는 이 스크립트 완료 후 적용 (CHECK 제약)
 *
 * 안전:
 *   - DRY_RUN 기본 true. 환경변수 명시해야 실제 UPDATE
 *   - UPDATE 는 (status='approved' AND id=...) 로 좁혀 걸림 → 다른 상태로
 *     이미 바뀐 row 는 영향 없음 (idempotent)
 *   - 각 단계 전후 집계 출력
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) {
  console.error('[PR-A reset] SUPABASE_URL / SUPABASE_SERVICE_KEY 없음.');
  process.exit(2);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 100;

function log(...args) { console.log(`[PR-A ${DRY_RUN ? 'DRY' : 'LIVE'}]`, ...args); }

async function fetchAllApproved() {
  //   페이지네이션
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('product_matches')
      .select('id, seller_id, our_sku, our_item_id, competitor_item_id, confidence, method, approved_by, created_at')
      .eq('status', 'approved')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function fetchCompetitorTitles(competitorIds) {
  const map = new Map();
  for (let i = 0; i < competitorIds.length; i += BATCH_SIZE) {
    const chunk = competitorIds.slice(i, i + BATCH_SIZE);
    const { data, error } = await db
      .from('competitor_listings')
      .select('ebay_item_id, title, total_price, price')
      .in('ebay_item_id', chunk);
    if (error) throw error;
    for (const row of data) map.set(String(row.ebay_item_id), row);
  }
  return map;
}

async function fetchEbayProducts() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('ebay_products')
      .select('sku, item_id, title, price_usd')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const bySku = new Map(), byItem = new Map();
  for (const p of rows) {
    if (p.sku) bySku.set(String(p.sku), p);
    if (p.item_id) byItem.set(String(p.item_id), p);
  }
  return { bySku, byItem };
}

const QTY_RE = /(\d+)\s*(box|boxes|pcs|pc|packs|pack|ea|nea|set|sets)\b/i;
const BOX_SET_RE = /\b(box set|boxes set|bulk pack|set of \d+)\b/i;
const RANDOM_RE = /\b(random|secret|blind|sealed box)\b/i;
const NEW_RE = /\b(new|sealed|BNIB|brand new)\b/i;
const USED_RE = /\b(used|opened|pre[- ]owned|secondhand)\b/i;

function extractQty(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  const m = t.match(QTY_RE);
  if (m) return `${m[1]}_${m[2].toLowerCase()}`;
  if (BOX_SET_RE.test(t)) return 'BOX_SET';
  return null;
}
function extractFlags(title) {
  if (!title) return {};
  const t = title.toLowerCase();
  return { random: RANDOM_RE.test(t), new: NEW_RE.test(t), used: USED_RE.test(t) };
}

function classify(match, compMap, myLookup) {
  const comp = compMap.get(String(match.competitor_item_id)) || {};
  const my = myLookup(match);
  const ct = comp.title || '';
  const pt = my.title || '';
  const cp = comp.total_price ?? comp.price ?? null;
  const pp = my.price_usd ?? null;

  //   가격 50%+
  let priceSus = false;
  if (cp != null && pp != null && +pp > 0) {
    const diff = Math.abs(+cp - +pp) / +pp * 100;
    if (diff >= 50) priceSus = true;
  }
  //   수량 불일치
  const cq = extractQty(ct), pq = extractQty(pt);
  const qtySus = (cq && pq && cq !== pq) || ((cq == null) !== (pq == null) && (cq || pq));
  //   조건 불일치
  const cf = extractFlags(ct), pf = extractFlags(pt);
  const condSus =
    (cf.new && pf.used) ||
    (cf.used && pf.new) ||
    (cf.random !== pf.random && (cf.random || pf.random));

  if (priceSus || qtySus || condSus) return 'suspect';
  if (ct && pt) return 'clean';
  return 'other';
}

async function updateBatch(ids, patch) {
  //   Supabase bulk UPDATE by id — 100개씩
  let okTotal = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    if (DRY_RUN) { okTotal += chunk.length; continue; }
    const { error, count } = await db
      .from('product_matches')
      .update(patch, { count: 'exact' })
      .in('id', chunk);
    if (error) throw error;
    okTotal += count ?? chunk.length;
  }
  return okTotal;
}

async function updateAemaehamToPendingReview() {
  //   애매함 17건 — 이전 세션에서 임시로 'pending' 으로 돌려놓음.
  //   ai_reason 에 '[P0-3 애매함 2026-10-19 · pending_review enum 추가 전 임시 pending]' prefix 가 들어있음.
  //   그걸 기준으로 식별.
  const { data, error } = await db
    .from('product_matches')
    .select('id, ai_reason')
    .eq('status', 'pending')
    .like('ai_reason', '[P0-3 애매함%');
  if (error) throw error;
  log(`애매함 임시 pending → pending_review 대상: ${data.length}건`);
  if (data.length === 0) return 0;
  const ids = data.map(r => r.id);
  return await updateBatch(ids, {
    status: 'pending_review',
    updated_at: new Date().toISOString(),
  });
}

async function main() {
  log(`시작 · DRY_RUN=${DRY_RUN}`);

  log('[1/5] approved 전부 로드...');
  const approved = await fetchAllApproved();
  log(`  → ${approved.length}건`);

  log('[2/5] 경쟁 리스팅 + 내 상품 로드...');
  const compIds = [...new Set(approved.map(m => String(m.competitor_item_id)))];
  const compMap = await fetchCompetitorTitles(compIds);
  const { bySku, byItem } = await fetchEbayProducts();
  const myLookup = (m) => {
    const s = String(m.our_sku || ''); const i = String(m.our_item_id || '');
    return bySku.get(s) || byItem.get(s) || byItem.get(i) || {};
  };
  log(`  → competitor_listings ${compMap.size}건 매칭 · ebay_products sku=${bySku.size}+itemid=${byItem.size}`);

  log('[3/5] 분류 (깨끗함/의심/기타)...');
  const groups = { clean: [], suspect: [], other: [] };
  for (const m of approved) groups[classify(m, compMap, myLookup)].push(m.id);
  log(`  깨끗함: ${groups.clean.length}건`);
  log(`  의심:   ${groups.suspect.length}건`);
  log(`  기타:   ${groups.other.length}건`);

  log('[4/5] 전환 UPDATE...');
  const now = new Date().toISOString();
  //   깨끗함: suggested + review_priority=1 + approved_by/approved_at 초기화 (CHECK 통과)
  const cleanOk = await updateBatch(groups.clean, {
    status: 'suggested',
    approved_by: null, approved_at: null,
    review_priority: 1,
    updated_at: now,
  });
  //   의심: suggested + approved_by/approved_at 초기화
  const suspectOk = await updateBatch(groups.suspect, {
    status: 'suggested',
    approved_by: null, approved_at: null,
    updated_at: now,
  });
  //   기타: suggested + approved_by/approved_at 초기화
  const otherOk = await updateBatch(groups.other, {
    status: 'suggested',
    approved_by: null, approved_at: null,
    updated_at: now,
  });
  log(`  깨끗함 → suggested + priority=1: ${cleanOk}건`);
  log(`  의심   → suggested              : ${suspectOk}건`);
  log(`  기타   → suggested              : ${otherOk}건`);

  log('[5/5] 애매함 17건 pending → pending_review...');
  const aemOk = await updateAemaehamToPendingReview();
  log(`  → ${aemOk}건`);

  log('완료.');
  if (DRY_RUN) log('⚠️  DRY_RUN=true 이므로 실제 UPDATE 안 됨. DRY_RUN=false 로 재실행하여 적용.');
}

main().catch(e => { console.error('[PR-A reset] 실패:', e.message); process.exit(1); });
