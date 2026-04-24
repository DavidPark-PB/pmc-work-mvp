/**
 * 일회성 스크립트 — B2B 인보이스 master 템플릿의 품목 행을 6 → 20 개로 확장.
 * 템플릿: templates/b2b_invoice_master.xlsx
 *
 * 실행: node scripts/expand-b2b-invoice-template.js
 * 백업: templates/b2b_invoice_master.backup-YYYYMMDD.xlsx 로 원본 저장
 */
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, '../templates/b2b_invoice_master.xlsx');
const TARGET_ITEM_ROWS = 20;
const ITEM_FIRST_ROW = 23;
const CURRENT_LAST_ITEM = 28; // template 상 6번째 품목 행
const CURRENT_SHIPPING_ROW = 29;
const CURRENT_TOTAL_ROW = 30;

async function main() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('템플릿 파일 없음: ' + TEMPLATE_PATH);
  }

  // 백업
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = TEMPLATE_PATH.replace(/\.xlsx$/, `.backup-${stamp}.xlsx`);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(TEMPLATE_PATH, backupPath);
    console.log('✅ 원본 백업:', backupPath);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet('MASTER');
  if (!ws) throw new Error('MASTER 시트 없음');

  const currentCount = CURRENT_LAST_ITEM - ITEM_FIRST_ROW + 1;
  if (currentCount >= TARGET_ITEM_ROWS) {
    console.log(`⚠️ 이미 ${currentCount}행 — 확장 불필요. 종료.`);
    return;
  }
  const extraRows = TARGET_ITEM_ROWS - currentCount;
  console.log(`현재 품목 행 ${currentCount} → 목표 ${TARGET_ITEM_ROWS} (신규 ${extraRows} 행 삽입)`);

  // 기준 행: 28 (마지막 품목 행) — 스타일·높이 참고
  const refRow = ws.getRow(CURRENT_LAST_ITEM);
  const refHeight = refRow.height;

  // insertRow 를 쓰면 style 은 'i+' 로 위 행 복사. 단 병합은 자동 안 됨.
  // 그래서 insertRow 한 다음 병합을 재지정.
  for (let i = 0; i < extraRows; i++) {
    const insertAt = CURRENT_LAST_ITEM + 1 + i; // 29, 30, 31...
    ws.insertRow(insertAt, [], 'i+'); // 위 행 스타일 복사
    if (refHeight) ws.getRow(insertAt).height = refHeight;

    // 병합 재적용 (C:F = 상품명, G:H = 수량)
    try { ws.mergeCells(`C${insertAt}:F${insertAt}`); } catch {}
    try { ws.mergeCells(`G${insertAt}:H${insertAt}`); } catch {}

    // NO. 순번 (B 열) — 28행이 7이었으므로 이어서 8, 9, 10...
    ws.getCell(`B${insertAt}`).value = currentCount + i + 1;

    // 값은 비우기 (스타일만 복사, 내용은 클리어)
    ws.getCell(`C${insertAt}`).value = null;
    ws.getCell(`G${insertAt}`).value = null;
    ws.getCell(`I${insertAt}`).value = null;
    ws.getCell(`J${insertAt}`).value = null;
  }

  // 새 행 삽입으로 shipping 과 TOTAL 이 자동으로 아래로 밀림.
  // 새 위치:
  const newLastItem = CURRENT_LAST_ITEM + extraRows;       // 42
  const newShipping = CURRENT_SHIPPING_ROW + extraRows;    // 43
  const newTotal    = CURRENT_TOTAL_ROW + extraRows;       // 44

  // Shipping 행 B 컬럼 NO. 는 마지막 품목 다음 번호로
  ws.getCell(`B${newShipping}`).value = newLastItem - ITEM_FIRST_ROW + 2; // 22

  // Shipping 행 formula 업데이트 — 새 total 행 참조
  ws.getCell(`G${newShipping}`).value = { formula: `G${newTotal}/30`, result: 0 };
  ws.getCell(`J${newShipping}`).value = { formula: `G${newShipping}*I${newShipping}`, result: 0 };

  // TOTAL 행 formula — 모든 품목 범위 포함
  ws.getCell(`G${newTotal}`).value = { formula: `SUM(G${ITEM_FIRST_ROW}:H${newLastItem})`, result: 0 };
  ws.getCell(`J${newTotal}`).value = { formula: `SUM(J${ITEM_FIRST_ROW}:J${newShipping})`, result: 0 };

  await wb.xlsx.writeFile(TEMPLATE_PATH);
  console.log(`✅ 확장 완료: 품목 행 ${ITEM_FIRST_ROW}~${newLastItem} (${TARGET_ITEM_ROWS}행), shipping=${newShipping}, TOTAL=${newTotal}`);

  // 검증
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(TEMPLATE_PATH);
  const ws2 = wb2.getWorksheet('MASTER');
  console.log('--- 검증: 행별 NO. 값 ---');
  for (let r = ITEM_FIRST_ROW; r <= newShipping; r++) {
    const no = ws2.getCell(`B${r}`).value;
    const label = ws2.getCell(`C${r}`).value;
    const note = r === newShipping ? ' (shipping)' : '';
    console.log(`  row ${r}: B=${no} C=${JSON.stringify(label)}${note}`);
  }
}

main().catch(e => {
  console.error('❌ 실패:', e.message);
  process.exit(1);
});
