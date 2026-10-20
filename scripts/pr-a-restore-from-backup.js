#!/usr/bin/env node
/**
 * PR-A 복구 (2026-10-21) · product_matches_backup_20261021 → product_matches 되돌리기.
 *
 * 사장님 지침: "문제 생기면 이 테이블 기준으로 복구하는 스크립트도 하나 준비해줘
 *   (실행은 내가 결정)."
 *
 * 복구 방식:
 *   - 백업과 라이브의 id 를 기준으로 compare → status/approved_by/approved_at/
 *     ai_reason/review_priority/updated_at 필드만 백업 값으로 되돌림.
 *   - 백업 이후 "신규 insert" 된 row 는 손대지 않음 (id 가 백업에 없으므로).
 *   - 백업 이후 삭제된 row (라이브에 없음) 는 복구 안 함.
 *     이유: Migration 119 CHECK 가 걸려있을 때 재삽입이 실패할 수 있음.
 *     그런 경우는 사장님과 개별 상의.
 *
 * 실행:
 *   DRY_RUN=true  node scripts/pr-a-restore-from-backup.js  (기본, 미리보기)
 *   DRY_RUN=false node scripts/pr-a-restore-from-backup.js  (실제 UPDATE)
 *
 * 안전:
 *   - DRY_RUN 기본 true. 환경변수 명시해야 실제 실행
 *   - Migration 119 가 적용돼있으면 CHECK 가 복구 UPDATE 를 거부할 수 있음.
 *     그 경우 먼저 119 CHECK 를 임시 DROP 후 복구 → 재적용 순서로 진행.
 *     이 스크립트는 CHECK 를 건드리지 않음 (사장님 수동).
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error('SUPABASE 환경변수 없음.'); process.exit(2); }
const db = createClient(URL, KEY, { auth: { persistSession: false } });
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 100;

const RESTORE_FIELDS = ['status', 'approved_by', 'approved_at', 'ai_reason'];
//   review_priority 는 백업 시점에 컬럼이 없었을 수 있음 (migration 118 이후 추가).
//   존재 여부를 런타임에 체크.

function log(...a) { console.log(`[PR-A restore ${DRY_RUN ? 'DRY' : 'LIVE'}]`, ...a); }

async function pageAll(table, columns) {
  const rows = []; let from = 0;
  while (true) {
    const { data, error } = await db.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function main() {
  log('시작');

  //   백업 테이블 존재 확인
  const { error: checkErr } = await db
    .from('product_matches_backup_20261021')
    .select('id', { count: 'exact', head: true });
  if (checkErr) {
    console.error('[FAIL] product_matches_backup_20261021 조회 실패:', checkErr.message);
    console.error('       pr-a-backup-product-matches.sql 을 Supabase 에서 먼저 실행했는지 확인하세요.');
    process.exit(3);
  }

  //   컬럼 가변성 (review_priority) 처리
  const sampleRes = await db.from('product_matches_backup_20261021').select('*').limit(1).single();
  const hasReviewPriority = sampleRes.data && 'review_priority' in sampleRes.data;
  const fields = hasReviewPriority ? [...RESTORE_FIELDS, 'review_priority'] : RESTORE_FIELDS;
  log(`복구 대상 필드: ${fields.join(', ')} · review_priority 포함=${hasReviewPriority}`);

  log('[1/3] 백업 + 라이브 전체 로드...');
  const backupCols = ['id', ...fields].join(',');
  const liveCols   = ['id', ...fields].join(',');
  const backup = await pageAll('product_matches_backup_20261021', backupCols);
  const live   = await pageAll('product_matches',                 liveCols);
  log(`  백업: ${backup.length}건 · 라이브: ${live.length}건`);

  const liveMap = new Map(live.map(r => [r.id, r]));
  const todo = []; let noDiff = 0, missingInLive = 0;
  for (const b of backup) {
    const l = liveMap.get(b.id);
    if (!l) { missingInLive++; continue; } // 라이브에서 삭제된 row
    //   diff 검사 — 하나라도 다르면 복구 대상
    let diff = false;
    for (const f of fields) {
      const bv = b[f], lv = l[f];
      if (bv === lv) continue;
      //   null/undefined 동치
      if ((bv == null && lv == null)) continue;
      diff = true; break;
    }
    if (diff) todo.push(b);
    else noDiff++;
  }

  log(`[2/3] 비교 완료 · 복구 대상 ${todo.length}건 · 이미 동일 ${noDiff}건 · 라이브에서 삭제 ${missingInLive}건`);
  if (todo.length === 0) {
    log('복구할 row 없음. 종료.');
    return;
  }

  //   상태별 분해 (로그용)
  const byStatus = {};
  for (const t of todo) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  log(`  복구 후 상태 분포: ${JSON.stringify(byStatus)}`);

  log('[3/3] UPDATE 실행...');
  const now = new Date().toISOString();
  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    for (const b of chunk) {
      const patch = { updated_at: now };
      for (const f of fields) patch[f] = b[f];
      if (DRY_RUN) { ok++; continue; }
      const { error } = await db.from('product_matches').update(patch).eq('id', b.id);
      if (error) {
        fail++;
        if (fail <= 5) console.error(`  FAIL id=${b.id}: ${error.message}`);
      } else {
        ok++;
      }
    }
    if ((i + BATCH_SIZE) % 500 === 0) log(`  진행 ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length}`);
  }
  log(`완료 · ok=${ok} fail=${fail}${DRY_RUN ? ' (DRY_RUN=true · 실제 UPDATE 안 됨)' : ''}`);
  if (!DRY_RUN && fail > 0) {
    console.error('⚠️  일부 UPDATE 실패. Migration 119 CHECK 가 걸려있을 가능성.');
    console.error('    그 경우: CHECK 임시 DROP → 복구 재실행 → CHECK 재적용 순서로 진행.');
    process.exit(4);
  }
}

main().catch(e => { console.error('[restore] 실패:', e.message); process.exit(1); });
