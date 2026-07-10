'use strict';

/**
 * seed-suppliers.js — 사장님이 실제 쓰는 도매 소싱처 pre-populate (2026-07-10)
 *
 * 계약서 §Engine 5 예약 스키마 활용:
 *   suppliers 마스터가 채워지면 sku_master.supplier_id 로 링크 시작.
 *   Engine 5 활성 시 즉시 마진·품절률·클레임 자동 축적 가능.
 *
 * 실행:
 *   node scripts/seed-suppliers.js          (dry-run)
 *   node scripts/seed-suppliers.js --apply  (실제 insert/update)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');

const APPLY = process.argv.includes('--apply');

// 사장님 지정 (2026-07-10). 추가는 UI 에서.
const SUPPLIERS = [
  { name: '토이탑',        channel: 'domestic', notes: '완구 도매' },
  { name: '베어나인',      channel: 'domestic', notes: '' },
  { name: '팬시피아',      channel: 'domestic', notes: '팬시/문구' },
  { name: '아이토빅',      channel: 'domestic', notes: '유아완구' },
  { name: '씨스타',        channel: 'domestic', notes: '' },
  { name: '천유',          channel: 'domestic', notes: '' },
  { name: '도매몬',        channel: 'domestic', notes: '종합 도매' },
  { name: '뉴띵',          channel: 'domestic', notes: '' },
  { name: '착한강아지',    channel: 'domestic', notes: '반려동물' },
  { name: '이가라인',      channel: 'domestic', notes: '' },
  { name: '스타원몰',      channel: 'domestic', notes: '' },
  { name: '고로고로',      channel: 'domestic', notes: '' },
  { name: '문구다방',      channel: 'domestic', notes: '문구' },
  { name: '해피메이트',    channel: 'domestic', notes: '' },
  { name: '지원몰',        channel: 'domestic', notes: '' },
  { name: '오키즈',        channel: 'domestic', notes: '유아' },
];

async function main() {
  const db = getClient();

  const { data: existing, error: qErr } = await db
    .from('suppliers')
    .select('id, name, is_active')
    .in('name', SUPPLIERS.map((s) => s.name));
  if (qErr) throw new Error(`suppliers 조회 실패: ${qErr.message}`);
  const existingByName = new Map((existing || []).map((r) => [r.name, r]));

  const toInsert = [];
  const toReactivate = [];
  for (const s of SUPPLIERS) {
    const cur = existingByName.get(s.name);
    if (!cur) toInsert.push({ ...s, is_active: true });
    else if (!cur.is_active) toReactivate.push(cur.id);
  }

  console.log(`[suppliers] 대상 ${SUPPLIERS.length}명 — 신규 ${toInsert.length}, 재활성 ${toReactivate.length}, 이미 ${SUPPLIERS.length - toInsert.length - toReactivate.length}`);
  toInsert.forEach((s) => console.log(`  + insert ${s.name}`));
  toReactivate.forEach((id) => console.log(`  ~ reactivate id=${id}`));

  if (!APPLY) {
    console.log('[suppliers] dry-run — 실제 반영: node scripts/seed-suppliers.js --apply');
    return;
  }

  if (toInsert.length > 0) {
    const { error } = await db.from('suppliers').insert(toInsert);
    if (error) throw new Error(`insert 실패: ${error.message}`);
  }
  for (const id of toReactivate) {
    await db.from('suppliers').update({ is_active: true }).eq('id', id);
  }
  console.log('[suppliers] 완료 — SKU 마스터 화면 드롭다운에서 선택 가능');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[suppliers] 실패:', e.message); process.exit(1); });
