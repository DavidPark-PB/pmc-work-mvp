'use strict';

/**
 * engine4-prune-inactive-skus.js
 *
 * Commerce OS v1 계약서 §Engine 4 Pruning 조기 실행.
 *
 * 목적 (2026-07-10):
 *   판매 이력이 아예 없는 죽은 SKU 를 자동가격 대상에서 제외해서
 *   Engine 1 이 원가/무게 없는 것을 BLOCK 하는 부담을 줄인다.
 *
 * ⚠️ 안전 (반드시 지킴):
 *   - eBay API 호출 ABSOLUTE ZERO. 리스팅 상태 변경 없음.
 *   - sku_master.status = 'paused' 로만 표시 (내부 필드).
 *   - 계약서 §Engine 4 원문: "Dead Score → 삭제 후보 CSV" — 삭제는 사람이 결정.
 *     여기서 'paused' 는 자동가격 대상에서 제외이지 리스팅 삭제 아님.
 *   - 새로 판매 되면 아래 재활성 로직으로 자동 복귀 가능 (별도 잡).
 *
 * 판정 기준:
 *   ebay_products.sales_count = 0 or null AND status != 'ended'
 *   → 대응 sku_master (internal_sku 매칭) 을 status='paused' 로 전환
 *   이미 paused/discontinued 인 것은 건드리지 않음.
 *
 * 실행:
 *   node scripts/engine4-prune-inactive-skus.js          (dry-run — 개수만 출력)
 *   node scripts/engine4-prune-inactive-skus.js --apply  (실제 반영)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const APPLY = process.argv.includes('--apply');

async function main() {
  const db = getClient();

  // 1. 판매 0 인 eBay 리스팅의 SKU 수집 (ended 제외)
  let deadSkus = [];
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('ebay_products')
      .select('sku, item_id, title, sales_count')
      .neq('status', 'ended')
      .or('sales_count.is.null,sales_count.eq.0')
      .range(from, from + 999);
    if (error) throw new Error(`ebay_products: ${error.message}`);
    if (!data || data.length === 0) break;
    deadSkus = deadSkus.concat(data.filter((p) => p.sku));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[engine4] 판매 0 eBay 리스팅: ${deadSkus.length}개`);

  const skus = [...new Set(deadSkus.map((p) => p.sku))];
  console.log(`[engine4] 고유 SKU: ${skus.length}개`);

  // 2. sku_master 에서 대응 SKU 중 status='active' 인 것만 후보 (이미 paused/discontinued 는 skip)
  const activeCandidates = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data, error } = await db.from('sku_master')
      .select('id, internal_sku, status')
      .in('internal_sku', chunk)
      .eq('status', 'active');
    if (error) throw new Error(`sku_master: ${error.message}`);
    (data || []).forEach((s) => activeCandidates.set(s.internal_sku, s.id));
  }
  console.log(`[engine4] active → paused 전환 대상: ${activeCandidates.size}개`);

  if (activeCandidates.size === 0) {
    console.log('[engine4] 처리 대상 없음 — 종료');
    return;
  }

  if (!APPLY) {
    console.log('[engine4] dry-run — 실제 반영: node scripts/engine4-prune-inactive-skus.js --apply');
    console.log('[engine4] 샘플 5개:');
    const sampleSet = new Set([...activeCandidates.keys()].slice(0, 5));
    deadSkus.filter((p) => sampleSet.has(p.sku)).slice(0, 5).forEach((p) => {
      console.log(`  ${p.sku.padEnd(20)} | 판매 ${p.sales_count ?? 0} | ${(p.title || '').slice(0, 60)}`);
    });
    return;
  }

  // 3. sku_master.status = 'paused' UPDATE (500개 청크)
  const ids = [...activeCandidates.values()];
  let updated = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await db.from('sku_master')
      .update({ status: 'paused', updated_at: new Date().toISOString(), notes: 'Engine 4 자동 (판매 이력 0)' })
      .in('id', chunk);
    if (error) {
      console.warn(`[engine4] update 실패(${i}~): ${error.message}`);
      continue;
    }
    updated += chunk.length;
    console.log(`[engine4] ${updated}/${ids.length} paused...`);
  }

  // 4. team_task 로 감사 로그 (하루 1장 dedupe)
  const today = new Date().toISOString().slice(0, 10);
  const sampleSkus = [...activeCandidates.keys()].slice(0, 30);
  try {
    const res = await createExceptionTask({
      exceptionType: 'AUTOMATION_FAILED', // 임시 재사용 (Engine 4 전용 타입은 나중에)
      dedupeKey: `engine4:pause:${today}`,
      title: `[Engine4] 판매 0 SKU 자동가격 대상 제외 — ${updated}개 paused`,
      memo: [
        '판매 이력 없는 SKU 를 sku_master.status=paused 로 전환.',
        '⚠️ 리스팅 자체는 유지됨 (eBay API 호출 없음).',
        '새로 판매 되면 별도 잡이 자동으로 active 복귀 가능.',
        '완전 삭제 여부는 사장님이 판단 (Dead Score CSV 참고).',
      ].join('\n'),
      severity: 'low',
      context: {
        source: 'engine4-prune',
        run_at: new Date().toISOString(),
        total_dead_listings: deadSkus.length,
        unique_dead_skus: skus.length,
        paused_count: updated,
        sample_skus: sampleSkus,
      },
    });
    console.log(`[engine4] team_task ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
  } catch (e) {
    console.warn('[engine4] team_task 생성 실패:', e.message);
  }

  console.log(`[engine4] 완료 — ${updated}개 SKU paused`);
  console.log('[engine4] 다음: node src/jobs/engine1DryRunJob.js 재실행 → BLOCK 대폭 감소 확인');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[engine4] 실패:', e.message); process.exit(1); });
