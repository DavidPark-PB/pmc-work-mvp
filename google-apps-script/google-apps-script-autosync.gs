/**
 * Google Apps Script - 자동 동기화 시스템
 *
 * 설정 방법:
 * 1. Google Sheets에서 확장 프로그램 → Apps Script 열기
 * 2. 이 코드를 기존 스크립트에 추가
 * 3. 트리거 설정:
 *    - 함수 선택: autoSyncCheck
 *    - 이벤트 소스: 시간 기반
 *    - 시간 간격: 12시간마다
 *
 * ⚠️ 중요: 이 스크립트는 Pending 마킹만 수행합니다.
 *          실제 API 전송은 Node.js 스크립트로 수행해야 합니다.
 */

// 설정 상수
const CONFIG = {
  SHEET_NAME: '최종 Dashboard',
  HEADER_ROW: 3,  // 헤더가 있는 행

  // 열 위치 (1-based index)
  COL: {
    SKU: 2,              // B열
    SYNC_STATUS: 5,      // E열
    PURCHASE_PRICE: 6,   // F열: 매입가 (보호)
    PRICE: 7,            // G열: 판매가(USD)
    SHIPPING: 8,         // H열: 국제 배송비(USD)
    WEIGHT: 15,          // O열: 무게(kg) (보호)
    EBAY_STOCK: 17,      // Q열: eBay재고
    SHOPIFY_STOCK: 18,   // R열: Shopify재고
    PLATFORM: 21,        // U열: 플랫폼
    LAST_UPDATED: 22     // V열: Last Updated
  },

  // 보호할 열 (절대 수정 금지)
  PROTECTED_COLS: [6, 15],  // F열(매입가), O열(무게)

  // 이메일 알림 설정
  ADMIN_EMAIL: 'your-email@example.com',  // 대표님 이메일로 변경
  SEND_EMAIL_ALERTS: false  // true로 변경하면 이메일 알림 활성화
};

/**
 * 자동 동기화 체크 (12시간마다 실행)
 * - Pending 상태인 행 수 확인
 * - 로그 기록
 * - 필요시 이메일 알림
 */
function autoSyncCheck() {
  try {
    const sheet = getSheet();
    if (!sheet) return;

    Logger.log('=== 자동 동기화 체크 시작 ===');

    // Pending 상태인 행 찾기
    const pendingRows = findPendingRows(sheet);

    Logger.log(`발견된 Pending 행: ${pendingRows.length}개`);

    if (pendingRows.length > 0) {
      // 플랫폼별로 분류
      const ebayCount = pendingRows.filter(r => r.platform === 'eBay만' || r.platform === '양쪽').length;
      const shopifyCount = pendingRows.filter(r => r.platform === 'Shopify만' || r.platform === '양쪽').length;

      Logger.log(`- eBay 동기화 필요: ${ebayCount}개`);
      Logger.log(`- Shopify 동기화 필요: ${shopifyCount}개`);

      // 이메일 알림 (설정된 경우)
      if (CONFIG.SEND_EMAIL_ALERTS && pendingRows.length > 0) {
        sendSyncAlert(pendingRows.length, ebayCount, shopifyCount);
      }

      // 스프레드시트에 알림 셀 업데이트
      updateSyncNotification(sheet, pendingRows.length, ebayCount, shopifyCount);
    } else {
      Logger.log('동기화 필요한 항목이 없습니다.');
      clearSyncNotification(sheet);
    }

    Logger.log('=== 자동 동기화 체크 완료 ===');

  } catch (error) {
    Logger.log('오류 발생: ' + error.message);
    if (CONFIG.SEND_EMAIL_ALERTS) {
      sendErrorAlert(error);
    }
  }
}

/**
 * 수동 동기화 실행 (시트 메뉴에서 실행)
 * - Pending 행들을 찾아 보고
 * - Node.js 스크립트 실행 안내
 */
function manualSync() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet();

  if (!sheet) {
    ui.alert('오류', '최종 Dashboard 시트를 찾을 수 없습니다!', ui.ButtonSet.OK);
    return;
  }

  const pendingRows = findPendingRows(sheet);

  if (pendingRows.length === 0) {
    ui.alert('동기화', '동기화가 필요한 항목이 없습니다!', ui.ButtonSet.OK);
    return;
  }

  const ebayCount = pendingRows.filter(r => r.platform === 'eBay만' || r.platform === '양쪽').length;
  const shopifyCount = pendingRows.filter(r => r.platform === 'Shopify만' || r.platform === '양쪽').length;

  const message = `동기화 대기 중인 항목: ${pendingRows.length}개\n\n` +
                  `- eBay: ${ebayCount}개\n` +
                  `- Shopify: ${shopifyCount}개\n\n` +
                  `터미널에서 다음 명령어를 실행하세요:\n\n` +
                  `eBay: node sync-to-ebay.js\n` +
                  `Shopify: node sync-to-shopify.js`;

  ui.alert('동기화 필요', message, ui.ButtonSet.OK);
}

/**
 * 시트 가져오기
 */
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    Logger.log('오류: "' + CONFIG.SHEET_NAME + '" 시트를 찾을 수 없습니다!');
    return null;
  }

  return sheet;
}

/**
 * Pending 상태인 행 찾기
 */
function findPendingRows(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < CONFIG.HEADER_ROW + 1) {
    return [];
  }

  // Sync Status와 Platform 열만 읽기
  const statusRange = sheet.getRange(CONFIG.HEADER_ROW + 1, CONFIG.COL.SYNC_STATUS, lastRow - CONFIG.HEADER_ROW, 1);
  const platformRange = sheet.getRange(CONFIG.HEADER_ROW + 1, CONFIG.COL.PLATFORM, lastRow - CONFIG.HEADER_ROW, 1);
  const skuRange = sheet.getRange(CONFIG.HEADER_ROW + 1, CONFIG.COL.SKU, lastRow - CONFIG.HEADER_ROW, 1);

  const statuses = statusRange.getValues();
  const platforms = platformRange.getValues();
  const skus = skuRange.getValues();

  const pendingRows = [];

  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i][0];
    const platform = platforms[i][0];
    const sku = skus[i][0];

    if (status === 'Pending' && platform && sku) {
      pendingRows.push({
        row: CONFIG.HEADER_ROW + 1 + i,
        sku: sku,
        platform: platform
      });
    }
  }

  return pendingRows;
}

/**
 * 동기화 알림 업데이트 (시트 상단에 표시)
 */
function updateSyncNotification(sheet, total, ebay, shopify) {
  // A1 셀에 알림 메시지 표시
  const notificationCell = sheet.getRange('A1');
  notificationCell.setValue(`⚠️ 동기화 필요: 총 ${total}개 (eBay: ${ebay}, Shopify: ${shopify})`);
  notificationCell.setBackground('#FFF9C4');
  notificationCell.setFontWeight('bold');
}

/**
 * 동기화 알림 제거
 */
function clearSyncNotification(sheet) {
  const notificationCell = sheet.getRange('A1');
  notificationCell.setValue('🚚 배송비');
  notificationCell.setBackground(null);
  notificationCell.setFontWeight('normal');
}

/**
 * 이메일 알림 발송 (동기화 필요)
 */
function sendSyncAlert(total, ebay, shopify) {
  const subject = `[자동 알림] ${total}개 상품 동기화 필요`;
  const body = `안녕하세요,\n\n` +
               `Google Sheets에서 동기화가 필요한 상품이 발견되었습니다.\n\n` +
               `📊 상세 정보:\n` +
               `- 총 ${total}개 상품\n` +
               `- eBay: ${ebay}개\n` +
               `- Shopify: ${shopify}개\n\n` +
               `다음 명령어로 동기화를 실행하세요:\n` +
               `- eBay: node sync-to-ebay.js\n` +
               `- Shopify: node sync-to-shopify.js\n\n` +
               `시트 링크: ${SpreadsheetApp.getActiveSpreadsheet().getUrl()}\n\n` +
               `자동 알림 시스템`;

  MailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body);
}

/**
 * 이메일 알림 발송 (오류 발생)
 */
function sendErrorAlert(error) {
  const subject = '[오류 알림] 자동 동기화 체크 실패';
  const body = `자동 동기화 체크 중 오류가 발생했습니다.\n\n` +
               `오류 메시지:\n${error.message}\n\n` +
               `스택 트레이스:\n${error.stack}\n\n` +
               `시트 링크: ${SpreadsheetApp.getActiveSpreadsheet().getUrl()}`;

  MailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body);
}

/**
 * 안전 장치: 보호된 열 수정 방지
 * (이 함수는 onEdit에 통합할 수 있음)
 */
function onEdit(e) {
  const sheet = e.source.getActiveSheet();

  if (sheet.getName() !== CONFIG.SHEET_NAME) {
    return;
  }

  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  // 헤더 행 이상은 보호
  if (row < CONFIG.HEADER_ROW + 1) {
    return;
  }

  // 보호된 열 체크
  if (CONFIG.PROTECTED_COLS.includes(col)) {
    const ui = SpreadsheetApp.getUi();
    ui.alert('⚠️ 경고',
             `이 열(${columnToLetter(col)})은 보호되어 있어 수정할 수 없습니다!\n\n` +
             `보호된 열:\n` +
             `- F열: 매입가\n` +
             `- O열: 무게(kg)\n\n` +
             `변경사항이 취소됩니다.`,
             ui.ButtonSet.OK);

    // 변경 취소
    range.setValue(e.oldValue || '');
    return;
  }

  // 가격/재고 열이 수정되면 Pending 마킹
  const WATCH_COLS = [CONFIG.COL.PRICE, CONFIG.COL.EBAY_STOCK, CONFIG.COL.SHOPIFY_STOCK];

  if (WATCH_COLS.includes(col)) {
    sheet.getRange(row, CONFIG.COL.SYNC_STATUS).setValue('Pending');
    sheet.getRange(row, CONFIG.COL.LAST_UPDATED).setValue(new Date().toISOString());
    sheet.getRange(row, CONFIG.COL.SYNC_STATUS).setBackground('#FFF9C4');

    Logger.log(`Row ${row}: 자동으로 Pending 설정 (${columnToLetter(col)}열 수정)`);
  }
}

/**
 * 메뉴 추가
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔄 동기화')
      .addItem('📊 지금 동기화 상태 확인', 'manualSync')
      .addItem('🔄 선택한 행 Pending 설정', 'markSelectedRowsAsPending')
      .addSeparator()
      .addItem('⚙️ 자동 동기화 체크 실행', 'autoSyncCheck')
      .addSeparator()
      .addItem('📖 도움말', 'showHelp')
      .addToUi();
}

/**
 * 선택한 행을 Pending으로 설정
 */
function markSelectedRowsAsPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (sheet.getName() !== CONFIG.SHEET_NAME) {
    SpreadsheetApp.getUi().alert('최종 Dashboard 시트에서만 사용 가능합니다!');
    return;
  }

  const range = sheet.getActiveRange();
  const startRow = range.getRow();
  const numRows = range.getNumRows();

  if (startRow < CONFIG.HEADER_ROW + 1) {
    SpreadsheetApp.getUi().alert('데이터 행(4행 이하)을 선택해주세요!');
    return;
  }

  const now = new Date();

  for (let i = 0; i < numRows; i++) {
    const row = startRow + i;
    sheet.getRange(row, CONFIG.COL.SYNC_STATUS).setValue('Pending');
    sheet.getRange(row, CONFIG.COL.LAST_UPDATED).setValue(now.toISOString());
    sheet.getRange(row, CONFIG.COL.SYNC_STATUS).setBackground('#FFF9C4');
  }

  SpreadsheetApp.getUi().alert(`${numRows}개 행을 Pending 상태로 설정했습니다!`);
}

/**
 * 도움말
 */
function showHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '🔄 자동 동기화 시스템',
    '📌 자동 감지:\n' +
    '   - 판매가, eBay재고, Shopify재고를 수정하면 자동으로 Pending 표시\n\n' +
    '⏰ 자동 체크 (12시간마다):\n' +
    '   - Pending 상태인 상품 수를 자동으로 확인\n' +
    '   - A1 셀에 알림 표시\n\n' +
    '🔒 안전 장치:\n' +
    '   - F열(매입가)와 O열(무게) 수정 차단\n\n' +
    '💻 실제 동기화:\n' +
    '   1. 터미널에서 Node.js 스크립트 실행\n' +
    '   2. eBay: node sync-to-ebay.js\n' +
    '   3. Shopify: node sync-to-shopify.js\n\n' +
    '📧 이메일 알림:\n' +
    '   - CONFIG.SEND_EMAIL_ALERTS를 true로 설정\n' +
    '   - CONFIG.ADMIN_EMAIL에 이메일 입력',
    ui.ButtonSet.OK
  );
}

/**
 * 열 번호를 알파벳으로 변환
 */
function columnToLetter(column) {
  let temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}
