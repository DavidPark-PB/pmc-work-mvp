/**
 * Google Apps Script - 자동 정렬 및 필터 시스템
 *
 * 기능:
 * 1. 품절/재고부족 상품 자동으로 맨 아래로 정렬
 * 2. 메뉴에서 수동 정렬 실행
 * 3. 필터 뷰 생성
 *
 * 설정 방법:
 * 1. Google Sheets → 확장 프로그램 → Apps Script
 * 2. 이 코드 붙여넣기
 * 3. 저장 후 실행
 */

// 설정 (2026-01-25 새 칼럼 구조에 맞게 업데이트)
const SORT_CONFIG = {
  SHEET_NAME: '최종 Dashboard',
  HEADER_ROW: 1,  // 헤더가 있는 행
  DATA_START_ROW: 2,  // 데이터 시작 행
  SORT_PRIORITY_COL: 21,  // U열 (정렬순위) - 새 구조
  PURCHASE_PRICE_COL: 5,  // E열 (매입가 - 품절 표시) - 새 구조
};

/**
 * 메뉴에 정렬 옵션 추가
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

  ui.createMenu('📦 정렬/필터')
      .addItem('🔼 판매가능 상품 먼저 (품절 맨 아래)', 'sortSoldoutToBottom')
      .addItem('🔽 품절 상품 먼저 (품절 맨 위)', 'sortSoldoutToTop')
      .addSeparator()
      .addItem('👀 품절 상품만 보기', 'showOnlySoldout')
      .addItem('✅ 판매가능 상품만 보기', 'showOnlyAvailable')
      .addItem('🔄 전체 보기 (필터 해제)', 'showAll')
      .addSeparator()
      .addItem('📖 도움말', 'showSortHelp')
      .addToUi();

  ui.createMenu('🚚 eBay 배송비')
      .addItem('📊 배송비 현황 확인', 'showShippingStatus')
      .addItem('🚀 배송비 전체 동기화 (eBay 업데이트)', 'syncAllShippingToEbay')
      .addSeparator()
      .addItem('📖 도움말', 'showShippingHelp')
      .addToUi();
}

/**
 * 품절 상품을 맨 아래로 정렬
 */
function sortSoldoutToBottom() {
  const sheet = getSheet();
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();

  try {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow < SORT_CONFIG.DATA_START_ROW + 1) {
      ui.alert('정렬할 데이터가 없습니다.');
      return;
    }

    // 데이터 범위 (헤더 제외)
    const dataRange = sheet.getRange(
      SORT_CONFIG.DATA_START_ROW,
      1,
      lastRow - SORT_CONFIG.DATA_START_ROW + 1,
      lastCol
    );

    // Y열(정렬순위) 기준 오름차순 정렬 (1=판매가능, 2=품절)
    dataRange.sort({
      column: SORT_CONFIG.SORT_PRIORITY_COL,
      ascending: true
    });

    ui.alert('✅ 정렬 완료!', '품절 상품이 맨 아래로 이동했습니다.', ui.ButtonSet.OK);

  } catch (error) {
    ui.alert('❌ 오류', error.message, ui.ButtonSet.OK);
  }
}

/**
 * 품절 상품을 맨 위로 정렬
 */
function sortSoldoutToTop() {
  const sheet = getSheet();
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();

  try {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow < SORT_CONFIG.DATA_START_ROW + 1) {
      ui.alert('정렬할 데이터가 없습니다.');
      return;
    }

    const dataRange = sheet.getRange(
      SORT_CONFIG.DATA_START_ROW,
      1,
      lastRow - SORT_CONFIG.DATA_START_ROW + 1,
      lastCol
    );

    // Y열(정렬순위) 기준 내림차순 정렬 (2=품절이 먼저)
    dataRange.sort({
      column: SORT_CONFIG.SORT_PRIORITY_COL,
      ascending: false
    });

    ui.alert('✅ 정렬 완료!', '품절 상품이 맨 위로 이동했습니다.', ui.ButtonSet.OK);

  } catch (error) {
    ui.alert('❌ 오류', error.message, ui.ButtonSet.OK);
  }
}

/**
 * 품절 상품만 보기 (필터)
 */
function showOnlySoldout() {
  const sheet = getSheet();
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();

  try {
    // 기존 필터 제거
    if (sheet.getFilter()) {
      sheet.getFilter().remove();
    }

    // 새 필터 생성
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const range = sheet.getRange(1, 1, lastRow, lastCol);

    const filter = range.createFilter();

    // Y열(정렬순위)에 필터 적용 - 2만 표시 (품절)
    const criteria = SpreadsheetApp.newFilterCriteria()
        .whenNumberEqualTo(2)
        .build();

    filter.setColumnFilterCriteria(SORT_CONFIG.SORT_PRIORITY_COL, criteria);

    ui.alert('🔍 필터 적용', '품절 상품만 표시됩니다.\n\n전체 보기: 📦 정렬/필터 → 전체 보기', ui.ButtonSet.OK);

  } catch (error) {
    ui.alert('❌ 오류', error.message, ui.ButtonSet.OK);
  }
}

/**
 * 판매가능 상품만 보기 (필터)
 */
function showOnlyAvailable() {
  const sheet = getSheet();
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();

  try {
    // 기존 필터 제거
    if (sheet.getFilter()) {
      sheet.getFilter().remove();
    }

    // 새 필터 생성
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const range = sheet.getRange(1, 1, lastRow, lastCol);

    const filter = range.createFilter();

    // Y열(정렬순위)에 필터 적용 - 1만 표시 (판매가능)
    const criteria = SpreadsheetApp.newFilterCriteria()
        .whenNumberEqualTo(1)
        .build();

    filter.setColumnFilterCriteria(SORT_CONFIG.SORT_PRIORITY_COL, criteria);

    ui.alert('✅ 필터 적용', '판매가능 상품만 표시됩니다.\n\n전체 보기: 📦 정렬/필터 → 전체 보기', ui.ButtonSet.OK);

  } catch (error) {
    ui.alert('❌ 오류', error.message, ui.ButtonSet.OK);
  }
}

/**
 * 전체 보기 (필터 해제)
 */
function showAll() {
  const sheet = getSheet();
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();

  try {
    if (sheet.getFilter()) {
      sheet.getFilter().remove();
    }

    ui.alert('🔄 필터 해제', '모든 상품이 표시됩니다.', ui.ButtonSet.OK);

  } catch (error) {
    ui.alert('❌ 오류', error.message, ui.ButtonSet.OK);
  }
}

/**
 * 시트 가져오기
 */
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SORT_CONFIG.SHEET_NAME);

  if (!sheet) {
    SpreadsheetApp.getUi().alert('❌ 오류', '"' + SORT_CONFIG.SHEET_NAME + '" 시트를 찾을 수 없습니다.', SpreadsheetApp.getUi().ButtonSet.OK);
    return null;
  }

  return sheet;
}

/**
 * 정렬/필터 도움말
 */
function showSortHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '📦 정렬/필터 도움말',
    '🔼 판매가능 상품 먼저:\n' +
    '   품절 상품이 맨 아래로 이동합니다.\n\n' +
    '🔽 품절 상품 먼저:\n' +
    '   품절 상품이 맨 위로 이동합니다.\n\n' +
    '👀 품절 상품만 보기:\n' +
    '   품절 상품만 표시됩니다.\n\n' +
    '✅ 판매가능 상품만 보기:\n' +
    '   판매가능한 상품만 표시됩니다.\n\n' +
    '🔄 전체 보기:\n' +
    '   필터를 해제하고 모든 상품을 표시합니다.\n\n' +
    '📌 정렬순위 열 (U열):\n' +
    '   1 = 판매가능\n' +
    '   2 = 품절/재고부족',
    ui.ButtonSet.OK
  );
}

/**
 * 매입가 변경 시 자동으로 정렬순위 업데이트
 * (onEdit 트리거에 추가)
 */
function onEditSortPriority(e) {
  const sheet = e.source.getActiveSheet();

  if (sheet.getName() !== SORT_CONFIG.SHEET_NAME) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  // 헤더 행이면 무시
  if (row < SORT_CONFIG.DATA_START_ROW) return;

  // F열(매입가) 수정 시
  if (col === SORT_CONFIG.PURCHASE_PRICE_COL) {
    const value = e.range.getValue();
    const sortCell = sheet.getRange(row, SORT_CONFIG.SORT_PRIORITY_COL);

    // 품절이면 2, 아니면 1
    if (String(value).toLowerCase() === '품절' ||
        String(value).toLowerCase() === '재고부족' ||
        String(value).toLowerCase() === '재고 부족' ||
        value === 0) {
      sortCell.setValue(2);
    } else {
      sortCell.setValue(1);
    }
  }
}

// =========================================
// 🚚 eBay 배송비 동기화 기능
// =========================================

/**
 * 배송비 현황 확인
 */
function showShippingStatus() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet();
  if (!sheet) return;

  const lastRow = sheet.getLastRow();

  // K열(eBay 배송비) 데이터 분석
  const shippingData = sheet.getRange(2, 11, lastRow - 1, 1).getValues();  // K열
  const itemIdData = sheet.getRange(2, 2, lastRow - 1, 1).getValues();     // B열 (Item ID)
  const purchaseData = sheet.getRange(2, 5, lastRow - 1, 1).getValues();   // E열 (매입가)

  let totalItems = 0;
  let withShipping = 0;
  let withoutShipping = 0;
  let soldout = 0;

  for (let i = 0; i < shippingData.length; i++) {
    const itemId = itemIdData[i][0];
    const shipping = shippingData[i][0];
    const purchase = purchaseData[i][0];

    // 유효한 Item ID (12자리 숫자)
    if (itemId && /^\d{12}$/.test(String(itemId))) {
      if (String(purchase) === '품절') {
        soldout++;
      } else {
        totalItems++;
        if (shipping !== null && shipping !== '' && !isNaN(parseFloat(shipping))) {
          withShipping++;
        } else {
          withoutShipping++;
        }
      }
    }
  }

  ui.alert(
    '📊 eBay 배송비 현황',
    '총 eBay 상품: ' + (totalItems + soldout) + '개\n' +
    '├ 판매가능: ' + totalItems + '개\n' +
    '│  ├ 배송비 입력됨: ' + withShipping + '개\n' +
    '│  └ 배송비 미입력: ' + withoutShipping + '개\n' +
    '└ 품절: ' + soldout + '개\n\n' +
    '⚠️ 배송비 미입력 상품은 eBay 동기화 시 제외됩니다.\n' +
    'K열(eBay 배송비)에 값을 입력해주세요.',
    ui.ButtonSet.OK
  );
}

/**
 * eBay 배송비 전체 동기화 (서버 호출)
 *
 * 이 함수는 외부 Node.js 스크립트를 트리거합니다.
 * 실제 eBay API 호출은 sync-ebay-shipping-cost.js에서 수행됩니다.
 */
function syncAllShippingToEbay() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet();
  if (!sheet) return;

  // 확인 대화상자
  const response = ui.alert(
    '🚀 eBay 배송비 전체 동기화',
    '시트의 K열(eBay 배송비) 값을 eBay에 업데이트합니다.\n\n' +
    '⚠️ 주의사항:\n' +
    '1. K열에 배송비가 입력된 상품만 업데이트됩니다.\n' +
    '2. 품절 상품은 제외됩니다.\n' +
    '3. 약 4,900개 상품 처리 시 약 40분 소요됩니다.\n\n' +
    '계속하시겠습니까?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    return;
  }

  // Sync_Log 시트에 작업 기록
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ss.getSheetByName('Sync_Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Sync_Log');
    logSheet.appendRow(['시간', '작업', '상태', '메모']);
  }

  const timestamp = new Date().toLocaleString('ko-KR');
  logSheet.appendRow([timestamp, 'eBay 배송비 동기화', 'PENDING', 'Apps Script에서 요청됨']);

  // 동기화 대상 카운트
  const lastRow = sheet.getLastRow();
  const shippingData = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
  const itemIdData = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const purchaseData = sheet.getRange(2, 5, lastRow - 1, 1).getValues();

  let targetCount = 0;
  for (let i = 0; i < shippingData.length; i++) {
    const itemId = itemIdData[i][0];
    const shipping = shippingData[i][0];
    const purchase = purchaseData[i][0];

    if (itemId && /^\d{12}$/.test(String(itemId)) &&
        shipping !== null && shipping !== '' && !isNaN(parseFloat(shipping)) &&
        String(purchase) !== '품절') {
      targetCount++;
    }
  }

  ui.alert(
    '✅ 동기화 요청 완료',
    '동기화 대상: ' + targetCount + '개 상품\n\n' +
    '📌 실행 방법:\n' +
    '로컬 PC에서 아래 명령어를 실행하세요:\n\n' +
    'cd "C:\\Users\\tooni\\PMC work MVP"\n' +
    'node sync-ebay-shipping-cost.js\n\n' +
    '또는 --dry-run 옵션으로 먼저 테스트:\n' +
    'node sync-ebay-shipping-cost.js --dry-run\n\n' +
    '진행 상황은 콘솔에서 확인할 수 있습니다.',
    ui.ButtonSet.OK
  );
}

/**
 * 배송비 동기화 도움말
 */
function showShippingHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '🚚 eBay 배송비 동기화 도움말',
    '📊 배송비 현황 확인:\n' +
    '   K열(eBay 배송비) 입력 현황을 보여줍니다.\n\n' +
    '🚀 배송비 전체 동기화:\n' +
    '   시트의 K열 값을 eBay에 업데이트합니다.\n' +
    '   ※ 로컬 PC에서 Node.js 스크립트 실행 필요\n\n' +
    '📌 칼럼 설명 (새 구조):\n' +
    '   J열: eBay 가격(USD) - 자동계산 (30% 마진)\n' +
    '   K열: eBay 배송비(USD) - 수동 입력\n' +
    '   L열: 최종 순이익(KRW) - 자동계산\n\n' +
    '💡 마진 전략:\n' +
    '   J열은 총원가의 30% 마진을 확보한 가격입니다.\n' +
    '   K열에 입력한 배송비가 추가 이익이 됩니다.\n' +
    '   예: K열에 $5 입력 → 순이익에 $5×1400 추가',
    ui.ButtonSet.OK
  );
}
