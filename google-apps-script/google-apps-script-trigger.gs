/**
 * Google Apps Script - 자동 Pending 표시 트리거
 *
 * 설정 방법:
 * 1. Google Sheets에서 확장 프로그램 → Apps Script 열기
 * 2. 이 코드를 붙여넣기
 * 3. 저장 후 트리거 설정:
 *    - 함수 선택: onEdit
 *    - 배포 대상: Head
 *    - 이벤트 소스: 스프레드시트에서
 *    - 이벤트 유형: 수정 시
 */

function onEdit(e) {
  const sheet = e.source.getActiveSheet();

  // "최종 Dashboard" 시트에서만 작동
  if (sheet.getName() !== '최종 Dashboard') {
    return;
  }

  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  // 헤더 행(3행) 이하에서만 작동
  if (row < 4) {
    return;
  }

  // 감지할 열들 (1-based index)
  const EBAY_PRICE_COL = 7;  // G열: eBay가격(USD)
  const EBAY_STOCK_COL = 17; // Q열: eBay재고
  const SHOPIFY_STOCK_COL = 18; // R열: Shopify재고
  const SYNC_STATUS_COL = 5;  // E열: Sync Status
  const LAST_UPDATED_COL = 6; // F열: Last Updated

  // 특정 열이 수정되었을 때만 Pending 설정
  if (col === EBAY_PRICE_COL || col === EBAY_STOCK_COL || col === SHOPIFY_STOCK_COL) {
    // Sync Status를 Pending으로 설정
    sheet.getRange(row, SYNC_STATUS_COL).setValue('Pending');

    // Last Updated에 현재 시간 기록
    const now = new Date();
    sheet.getRange(row, LAST_UPDATED_COL).setValue(now.toISOString());

    // 배경색 변경 (노란색으로 표시)
    sheet.getRange(row, SYNC_STATUS_COL).setBackground('#FFF9C4');

    Logger.log(`Row ${row}: 상태를 Pending으로 변경 (${columnToLetter(col)}열 수정됨)`);
  }
}

// 열 번호를 알파벳으로 변환
function columnToLetter(column) {
  let temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

/**
 * 수동으로 특정 범위를 Pending으로 설정하는 함수
 * 사용법: 특정 행들을 선택하고 이 함수를 실행
 */
function markSelectedRowsAsPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (sheet.getName() !== '최종 Dashboard') {
    SpreadsheetApp.getUi().alert('최종 Dashboard 시트에서만 사용 가능합니다!');
    return;
  }

  const range = sheet.getActiveRange();
  const startRow = range.getRow();
  const numRows = range.getNumRows();

  if (startRow < 4) {
    SpreadsheetApp.getUi().alert('데이터 행(4행 이하)을 선택해주세요!');
    return;
  }

  const SYNC_STATUS_COL = 5;  // E열
  const LAST_UPDATED_COL = 6; // F열

  const now = new Date();

  for (let i = 0; i < numRows; i++) {
    const row = startRow + i;
    sheet.getRange(row, SYNC_STATUS_COL).setValue('Pending');
    sheet.getRange(row, LAST_UPDATED_COL).setValue(now.toISOString());
    sheet.getRange(row, SYNC_STATUS_COL).setBackground('#FFF9C4');
  }

  SpreadsheetApp.getUi().alert(`${numRows}개 행을 Pending 상태로 설정했습니다!`);
}

/**
 * 메뉴에 커스텀 함수 추가
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔄 동기화')
      .addItem('선택한 행 Pending 설정', 'markSelectedRowsAsPending')
      .addSeparator()
      .addItem('도움말', 'showHelp')
      .addToUi();
}

function showHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '동기화 시스템 사용법',
    '1. eBay가격, eBay재고, Shopify재고 열을 수정하면 자동으로 Pending 표시됩니다.\\n\\n' +
    '2. 수동으로 Pending 설정:\\n' +
    '   - 원하는 행들을 선택\\n' +
    '   - 메뉴: 🔄 동기화 → 선택한 행 Pending 설정\\n\\n' +
    '3. 터미널에서 역전송 실행:\\n' +
    '   - Shopify: node sync-to-shopify.js\\n' +
    '   - eBay: node sync-to-ebay.js\\n\\n' +
    '4. 성공하면 Status가 "Success"로 변경됩니다!',
    ui.ButtonSet.OK
  );
}
