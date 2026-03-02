/**
 * 기존 Drive 폴더에서 B2B 바이어 + 인보이스 데이터 임포트
 * - 하위 폴더(월별) 재귀 탐색
 * - Excel에서 실제 라인 아이템 파싱
 * - 상태: PAID (기존 인보이스는 모두 결제 완료)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const path = require('path');
const ExcelJS = require('exceljs');
const GoogleDriveAPI = require('../src/api/googleDriveAPI');
const GoogleSheetsAPI = require('../src/api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const FOLDER_ID = '1FduYLrs9G8qU197QoYqYtLY0Il3t4Tet';

const SKIP_FOLDERS = ['00_TEMPLATE', '00[ 알리바바 _ 인보이스 ]', 'AA_[ 인보이스 양식 ]'];

const BUYER_HEADERS = [
  'BuyerID', 'Name', 'Contact', 'Email', 'WhatsApp',
  'Phone', 'Address', 'Country', 'Currency', 'PaymentTerms',
  'Notes', 'TotalOrders', 'TotalRevenue',
];

const INVOICE_HEADERS = [
  'InvoiceNo', 'BuyerID', 'BuyerName', 'Date', 'DueDate',
  'Items', 'Subtotal', 'Tax', 'Shipping', 'Total',
  'Currency', 'Status', 'DriveFileId', 'DriveUrl', 'SentVia', 'SentAt',
];

// ── 셀 값 추출 헬퍼 ──
function getCellVal(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result;
    if (v.text) return v.text;
    if (v.richText) return v.richText.map(r => r.text).join('');
    return '';
  }
  return v;
}

function getCellNum(cell) {
  const v = getCellVal(cell);
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── 인보이스 라인 아이템 파싱 ──
function parseLineItems(ws) {
  const items = [];
  let headerRow = -1;
  let itemCol = -1;    // 상품명 컬럼
  let qtyCol = -1;     // 수량 컬럼
  let priceCol = -1;   // 단가 컬럼
  let amountCol = -1;  // 금액 컬럼
  let noCol = -1;      // 번호 컬럼

  // 1단계: 헤더 행 찾기 (NO./ITEM/Q'ty 또는 품명/수량/단가 패턴)
  ws.eachRow((row, rowNum) => {
    if (headerRow > 0) return; // 이미 찾았으면 스킵

    const cellTexts = [];
    row.eachCell((cell, colNum) => {
      const val = String(getCellVal(cell)).trim().toLowerCase();
      cellTexts.push({ val, col: colNum });
    });

    // 영문 패턴: item, q'ty/qty/quantity, unit price/price, amount/total
    const hasItem = cellTexts.find(c => c.val === 'item' || c.val === 'items' || c.val === 'description' || c.val === 'product');
    const hasQty = cellTexts.find(c => c.val.includes('qty') || c.val.includes("q'ty") || c.val === 'quantity' || c.val === 'q');
    const hasPrice = cellTexts.find(c => c.val.includes('unit price') || c.val === 'price' || c.val === 'u/price');
    const hasAmount = cellTexts.find(c => c.val === 'amount' || c.val === 'total' || c.val === 'ext. price');
    const hasNo = cellTexts.find(c => c.val === 'no.' || c.val === 'no' || c.val === '#');

    // 한글 패턴: 품명/상품명, 수량, 단가, 금액
    const hasItemKR = cellTexts.find(c => c.val.includes('품명') || c.val.includes('상품'));
    const hasQtyKR = cellTexts.find(c => c.val === '수량');
    const hasPriceKR = cellTexts.find(c => c.val.includes('단가'));
    const hasAmountKR = cellTexts.find(c => c.val.includes('금액') || c.val.includes('합계'));

    if ((hasItem && hasQty) || (hasItemKR && hasQtyKR)) {
      headerRow = rowNum;
      itemCol = (hasItem || hasItemKR).col;
      qtyCol = (hasQty || hasQtyKR).col;
      priceCol = (hasPrice || hasPriceKR)?.col || -1;
      amountCol = (hasAmount || hasAmountKR)?.col || -1;
      noCol = hasNo?.col || -1;
    }
  });

  if (headerRow < 0) return items;

  // 2단계: 헤더 다음 행부터 아이템 파싱 (TOTAL 행까지)
  ws.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return;

    // TOTAL 행이면 중단
    let isTotalRow = false;
    row.eachCell((cell) => {
      const val = String(getCellVal(cell)).toLowerCase().trim();
      if (val === 'total' || val === 'grand total' || val === '합계' || val === '총합계') {
        isTotalRow = true;
      }
    });
    if (isTotalRow) return;

    // SUBTOTAL 행도 스킵
    let isSubtotalRow = false;
    row.eachCell((cell) => {
      const val = String(getCellVal(cell)).toLowerCase().trim();
      if (val === 'subtotal' || val === 'sub total' || val === '소계') isSubtotalRow = true;
    });
    if (isSubtotalRow) return;

    // 상품명 가져오기
    const name = String(getCellVal(row.getCell(itemCol)) || '').trim();
    if (!name) return; // 빈 행 스킵

    // 번호 확인 (숫자가 아니면 빈 행일 수 있음)
    if (noCol > 0) {
      const noVal = getCellVal(row.getCell(noCol));
      if (noVal === '' || noVal === null || noVal === undefined) return;
    }

    const qty = qtyCol > 0 ? getCellNum(row.getCell(qtyCol)) : 0;
    const price = priceCol > 0 ? getCellNum(row.getCell(priceCol)) : 0;

    // amount: 명시적 컬럼이 있으면 사용, 없으면 qty * price
    let amount = 0;
    if (amountCol > 0) {
      amount = getCellNum(row.getCell(amountCol));
    }
    if (!amount && qty && price) {
      amount = qty * price;
    }

    items.push({
      name,
      qty: qty || 1,
      price: Math.round(price * 100) / 100,
      total: Math.round(amount * 100) / 100,
    });
  });

  return items;
}

// ── 하위 폴더 포함 인보이스 파일 수집 ──
async function collectInvoiceFiles(drive, folderId, depth = 0) {
  const allFiles = [];

  // 현재 폴더의 파일 (xlsx + Google Sheets)
  const fileRes = await drive.drive.files.list({
    q: `'${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  allFiles.push(...(fileRes.data.files || []));

  // 하위 폴더 탐색 (최대 2단계)
  if (depth < 2) {
    const folderRes = await drive.drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const sub of (folderRes.data.files || [])) {
      const subFiles = await collectInvoiceFiles(drive, sub.id, depth + 1);
      allFiles.push(...subFiles);
    }
  }

  return allFiles;
}

// ── 통화 감지 ──
function detectCurrency(ws) {
  let detected = '';
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      const val = String(cell.value || '');
      if (!detected) {
        if (val.includes('USD') || val.includes('$')) detected = 'USD';
        else if (val.includes('KRW') || val.includes('\u20A9') || val.includes('\uC6D0')) detected = 'KRW';
        else if (val.includes('EUR') || val.includes('\u20AC')) detected = 'EUR';
        else if (val.includes('JPY') || val.includes('\u00A5') || val.includes('\u5186')) detected = 'JPY';
      }
      if (!detected && cell.numFmt) {
        if (cell.numFmt.includes('\u20A9') || cell.numFmt.includes('KRW')) detected = 'KRW';
        else if (cell.numFmt.includes('\u20AC')) detected = 'EUR';
        else if (cell.numFmt.includes('\u00A5')) detected = 'JPY';
        else if (cell.numFmt.includes('$')) detected = 'USD';
      }
    });
  });
  return detected;
}

// ── Total 금액 찾기 ──
function findTotal(ws) {
  let total = 0;
  ws.eachRow((row) => {
    // subtotal/tax/shipping 행은 건너뛰기
    let isSkipRow = false;
    row.eachCell((cell) => {
      const val = String(getCellVal(cell)).toLowerCase().trim();
      if (val === 'subtotal' || val === 'sub total' || val === 'tax' || val === 'shipping'
        || val === '소계' || val === '세금' || val === '배송비') {
        isSkipRow = true;
      }
    });
    if (isSkipRow) return;

    row.eachCell((cell, colNum) => {
      const val = String(getCellVal(cell)).toLowerCase().trim();
      if (val === 'total' || val === 'grand total' || val === '합계' || val === '총합계') {
        // 같은 행에서 오른쪽 10칸 내 가장 큰 숫자를 Total로 채택
        let maxVal = 0;
        const maxCol = Math.min(colNum + 10, 16384);
        for (let c = colNum + 1; c <= maxCol; c++) {
          const numVal = getCellNum(row.getCell(c));
          if (numVal > maxVal) maxVal = numVal;
        }
        if (maxVal > total) total = maxVal;
      }
    });
  });
  return total;
}

async function main() {
  const drive = new GoogleDriveAPI(path.join(__dirname, '../config/credentials.json'));
  await drive.authenticate();
  const sheets = new GoogleSheetsAPI(path.join(__dirname, '../config/credentials.json'));

  // 1. 바이어 폴더 목록
  const res = await drive.drive.files.list({
    q: `'${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const buyerFolders = (res.data.files || []).filter(f => !SKIP_FOLDERS.includes(f.name));
  console.log(`\n바이어 폴더: ${buyerFolders.length}개\n`);

  // 2. 바이어 데이터 구성
  const buyerRows = [];
  const invoiceRows = [];
  let invoiceCounter = 0;
  let totalItemsParsed = 0;

  for (let idx = 0; idx < buyerFolders.length; idx++) {
    const folder = buyerFolders[idx];
    const buyerId = `B${String(idx + 1).padStart(3, '0')}`;

    buyerRows.push([
      buyerId, folder.name, '', '', '', '', '', '', 'USD', 'Net 30',
      `DriveFolder:${folder.id}`, '0', '0',
    ]);

    // 3. 하위 폴더 포함 전체 인보이스 파일 수집
    const files = await collectInvoiceFiles(drive, folder.id);
    let buyerInvoiceCount = 0;
    let buyerTotal = 0;

    for (const file of files) {
      const isXlsx = file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const isSheet = file.mimeType === 'application/vnd.google-apps.spreadsheet';
      if (!isXlsx && !isSheet) continue;

      invoiceCounter++;
      const invoiceNo = `IMP-${String(invoiceCounter).padStart(4, '0')}`;
      const fileDate = file.modifiedTime ? file.modifiedTime.substring(0, 10) : '';

      let total = 0;
      let parsedItems = [];
      let currency = 'USD';

      const downloadBuffer = async () => {
        if (isSheet) {
          const exp = await drive.drive.files.export(
            { fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            { responseType: 'arraybuffer' }
          );
          return Buffer.from(exp.data);
        } else {
          const dl = await drive.drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          return Buffer.from(dl.data);
        }
      };

      try {
        const buf = await downloadBuffer();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];

        if (ws) {
          // 통화 감지
          const detectedCurrency = detectCurrency(ws);
          if (detectedCurrency) currency = detectedCurrency;

          // Total 금액 찾기
          total = findTotal(ws);

          // 라인 아이템 파싱
          parsedItems = parseLineItems(ws);
          if (parsedItems.length > 0) {
            totalItemsParsed += parsedItems.length;
          }

          // 아이템 합계와 Total 크로스체크
          if (parsedItems.length > 0) {
            const itemsSum = parsedItems.reduce((s, i) => s + i.total, 0);
            // total이 0이거나, 아이템 합계가 total의 100배 이상이면 아이템 합계 사용
            if (total === 0 || (itemsSum > 0 && itemsSum > total * 100)) {
              total = itemsSum;
            }
          }

          // 금액 기반 통화 추정
          if (!detectedCurrency && total >= 100000) {
            currency = 'KRW';
          }
        }
      } catch (parseErr) {
        console.log(`  ! 파싱실패 (${file.name}): ${parseErr.message}`);
      }

      buyerInvoiceCount++;
      buyerTotal += total;

      const itemsJson = JSON.stringify(parsedItems);

      invoiceRows.push([
        invoiceNo,
        buyerId,
        folder.name,
        fileDate,
        '', // dueDate
        itemsJson,
        total > 0 ? total.toFixed(2) : '0',
        '0', // tax
        '0', // shipping
        total > 0 ? total.toFixed(2) : '0',
        currency,
        'PAID', // 기존 인보이스는 모두 결제 완료
        file.id,
        file.webViewLink || '',
        '', // sentVia
        '', // sentAt
      ]);

      const itemInfo = parsedItems.length > 0 ? ` [${parsedItems.length}items]` : '';
      console.log(`  ${invoiceNo} | ${file.name} | ${currency} ${total.toFixed(2)}${itemInfo} | ${fileDate}`);
    }

    // 바이어 통계 업데이트
    buyerRows[idx][11] = String(buyerInvoiceCount);
    buyerRows[idx][12] = buyerTotal.toFixed(2);

    console.log(`${buyerId}: ${folder.name} -> ${buyerInvoiceCount}건, ${buyerTotal.toFixed(2)}\n`);
  }

  // 4. 시트에 쓰기
  console.log(`\n=== 시트 쓰기 ===`);

  // Buyers
  await sheets.clearData(SPREADSHEET_ID, "'B2B Buyers'!A2:M200");
  await sheets.writeData(SPREADSHEET_ID, "'B2B Buyers'!A1", [BUYER_HEADERS]);
  if (buyerRows.length > 0) {
    await sheets.writeData(SPREADSHEET_ID, "'B2B Buyers'!A2", buyerRows);
  }
  console.log(`Buyers: ${buyerRows.length}명`);

  // Invoices
  await sheets.clearData(SPREADSHEET_ID, "'B2B Invoices'!A2:P1000");
  await sheets.writeData(SPREADSHEET_ID, "'B2B Invoices'!A1", [INVOICE_HEADERS]);
  if (invoiceRows.length > 0) {
    await sheets.writeData(SPREADSHEET_ID, "'B2B Invoices'!A2", invoiceRows);
  }
  console.log(`Invoices: ${invoiceRows.length}건`);
  console.log(`Items parsed: ${totalItemsParsed}개 아이템`);

  console.log('\n임포트 완료!');
}

main().catch(err => {
  console.error('임포트 실패:', err.message);
  process.exit(1);
});
