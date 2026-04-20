/**
 * B2B 인보이스 자동화 서비스
 * - 구매자(Buyer) 관리: Google Sheets "B2B Buyers" 탭
 * - 인보이스 생성: ExcelJS 템플릿 → Drive 업로드
 * - B2B 가격표: Drive 폴더 내 가격 시트 연동
 * - 매출 집계: 구매자별/월별 자동 계산
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const path = require('path');
const ExcelJS = require('exceljs');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');
const GoogleDriveAPI = require('../api/googleDriveAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const B2B_DRIVE_FOLDER_ID = process.env.B2B_DRIVE_FOLDER_ID || '1FduYLrs9G8qU197QoYqYtLY0Il3t4Tet';

const BUYERS_SHEET = 'B2B Buyers';
const INVOICES_SHEET = 'B2B Invoices';

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

class B2BInvoiceService {
  constructor() {
    this.sheets = new GoogleSheetsAPI(
      path.join(__dirname, '../../config/credentials.json')
    );
    this.drive = new GoogleDriveAPI(
      path.join(__dirname, '../../config/credentials.json')
    );
  }

  // ────────────────────── 시트 초기화 ──────────────────────

  async _ensureSheets() {
    try {
      const info = await this.sheets.getSpreadsheetInfo(SPREADSHEET_ID);
      const existingTabs = info.sheets.map(s => s.properties.title);

      if (!existingTabs.includes(BUYERS_SHEET)) {
        await this.sheets.createSheet(SPREADSHEET_ID, BUYERS_SHEET);
        await this.sheets.writeData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A1`, [BUYER_HEADERS]);
        console.log(`✅ "${BUYERS_SHEET}" 탭 생성 완료`);
      }

      if (!existingTabs.includes(INVOICES_SHEET)) {
        await this.sheets.createSheet(SPREADSHEET_ID, INVOICES_SHEET);
        await this.sheets.writeData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A1`, [INVOICE_HEADERS]);
        console.log(`✅ "${INVOICES_SHEET}" 탭 생성 완료`);
      }
    } catch (err) {
      console.error('시트 초기화 오류:', err.message);
    }
  }

  // ────────────────────── 구매자 관리 ──────────────────────

  /**
   * 구매자 목록 조회
   */
  async getBuyers() {
    await this._ensureSheets();
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A:M`);
    if (!rows || rows.length <= 1) return [];

    const headers = rows[0];
    return rows.slice(1).filter(r => r[0]).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      obj.TotalOrders = Number(obj.TotalOrders) || 0;
      obj.TotalRevenue = Number(obj.TotalRevenue) || 0;
      return obj;
    });
  }

  /**
   * 구매자 생성
   */
  async createBuyer(data) {
    await this._ensureSheets();
    const buyers = await this.getBuyers();

    // 자동 ID 생성: B001, B002, ...
    const maxId = buyers.reduce((max, b) => {
      const num = parseInt(b.BuyerID?.replace('B', ''), 10) || 0;
      return num > max ? num : max;
    }, 0);
    const newId = `B${String(maxId + 1).padStart(3, '0')}`;

    const row = [
      newId,
      data.name || '',
      data.contact || '',
      data.email || '',
      data.whatsapp || '',
      data.phone || '',
      data.address || '',
      data.country || '',
      data.currency || 'USD',
      data.paymentTerms || 'Net 30',
      data.notes || '',
      '0',
      '0',
    ];

    await this.sheets.appendData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A:M`, [row]);
    console.log(`✅ 구매자 생성: ${newId} - ${data.name}`);

    const obj = {};
    BUYER_HEADERS.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }

  /**
   * 구매자 수정
   */
  async updateBuyer(buyerId, data) {
    await this._ensureSheets();
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A:M`);
    if (!rows || rows.length <= 1) throw new Error('구매자 데이터 없음');

    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === buyerId);
    if (rowIndex === -1) throw new Error(`구매자 ${buyerId} 없음`);

    const existing = rows[rowIndex];
    const updated = [
      buyerId,
      data.name ?? existing[1] ?? '',
      data.contact ?? existing[2] ?? '',
      data.email ?? existing[3] ?? '',
      data.whatsapp ?? existing[4] ?? '',
      data.phone ?? existing[5] ?? '',
      data.address ?? existing[6] ?? '',
      data.country ?? existing[7] ?? '',
      data.currency ?? existing[8] ?? 'USD',
      data.paymentTerms ?? existing[9] ?? '',
      data.notes ?? existing[10] ?? '',
      existing[11] ?? '0',
      existing[12] ?? '0',
    ];

    const sheetRow = rowIndex + 1; // 1-indexed
    await this.sheets.writeData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A${sheetRow}:M${sheetRow}`, [updated]);
    console.log(`✅ 구매자 수정: ${buyerId}`);

    const obj = {};
    BUYER_HEADERS.forEach((h, i) => { obj[h] = updated[i]; });
    return obj;
  }

  // ────────────────────── B2B 가격표 ──────────────────────

  /**
   * B2B 가격표 조회
   * 메인 스프레드시트의 "B2B Prices" 탭 또는 Drive 폴더 내 가격 시트에서 읽기
   */
  async getB2BPrices() {
    try {
      // 먼저 메인 시트의 "B2B Prices" 탭 시도
      const rows = await this.sheets.readData(SPREADSHEET_ID, "'B2B Prices'!A:F");
      if (rows && rows.length > 1) {
        const headers = rows[0];
        return rows.slice(1).filter(r => r[0]).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          if (obj.Price) obj.Price = parseFloat(obj.Price) || 0;
          if (obj.MOQ) obj.MOQ = parseInt(obj.MOQ, 10) || 1;
          return obj;
        });
      }
    } catch (err) {
      console.warn('B2B Prices 탭 없음, 빈 배열 반환:', err.message);
    }
    return [];
  }

  // ────────────────────── 인보이스 생성 ──────────────────────

  /**
   * 다음 인보이스 번호 생성 (INV-2026-0001 형식)
   */
  async _getNextInvoiceNo() {
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:A`);
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;

    let maxNum = 0;
    if (rows) {
      rows.forEach(r => {
        if (r[0] && r[0].startsWith(prefix)) {
          const num = parseInt(r[0].replace(prefix, ''), 10) || 0;
          if (num > maxNum) maxNum = num;
        }
      });
    }
    return `${prefix}${String(maxNum + 1).padStart(4, '0')}`;
  }

  /**
   * 인보이스 생성
   * @param {Object} data
   * @param {string} data.buyerId - 구매자 ID
   * @param {Array<{sku, name, qty, price}>} data.items - 상품 목록
   * @param {number} data.tax - 세금 (기본 0)
   * @param {number} data.shipping - 배송비 (기본 0)
   * @param {string} data.currency - 통화 (기본 USD)
   * @param {string} data.dueDate - 만기일 (기본 30일 후)
   * @param {string} data.notes - 비고
   */
  async generateInvoice(data) {
    await this._ensureSheets();

    // 1. 구매자 정보 조회
    const buyers = await this.getBuyers();
    const buyer = buyers.find(b => b.BuyerID === data.buyerId);
    if (!buyer) throw new Error(`구매자 ${data.buyerId} 없음`);

    // 2. 인보이스 번호 생성
    const invoiceNo = await this._getNextInvoiceNo();
    const today = new Date();
    const invoiceDate = today.toISOString().split('T')[0];

    // 만기일: dueDate 지정 또는 PaymentTerms에서 계산
    let dueDate = data.dueDate;
    if (!dueDate) {
      const netDays = parseInt((buyer.PaymentTerms || '').replace(/\D/g, ''), 10) || 30;
      const due = new Date(today);
      due.setDate(due.getDate() + netDays);
      dueDate = due.toISOString().split('T')[0];
    }

    // 3. 금액 계산
    const items = (data.items || []).map(item => ({
      sku: item.sku || '',
      name: item.name || '',
      qty: Number(item.qty) || 1,
      price: Number(item.price) || 0,
      total: (Number(item.qty) || 1) * (Number(item.price) || 0),
    }));
    const subtotal = items.reduce((sum, i) => sum + i.total, 0);
    const tax = Number(data.tax) || 0;
    const shipping = Number(data.shipping) || 0;
    const total = subtotal + tax + shipping;
    const currency = data.currency || buyer.Currency || 'USD';

    // 4. Excel 인보이스 생성
    const xlsxBuffer = await this._buildInvoiceXlsx({
      invoiceNo, invoiceDate, dueDate,
      buyer, items, subtotal, tax, shipping, total, currency,
      notes: data.notes || '',
    });

    // 5. Drive 업로드 시도
    let driveFileId = '';
    let driveUrl = '';
    try {
      const fileName = `${invoiceNo}_${buyer.Name.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
      const uploaded = await this.drive.uploadFile(
        B2B_DRIVE_FOLDER_ID,
        fileName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xlsxBuffer
      );
      driveFileId = uploaded.id || '';
      driveUrl = uploaded.webViewLink || '';
      console.log(`✅ 인보이스 Drive 업로드: ${fileName}`);
    } catch (driveErr) {
      console.warn('⚠️ Drive 업로드 실패 (API 미활성화?), 로컬 저장:', driveErr.message);
      // 로컬 폴더에 저장
      const fs = require('fs');
      const localDir = path.join(__dirname, '../../data/invoices');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, `${invoiceNo}.xlsx`);
      fs.writeFileSync(localPath, xlsxBuffer);
      driveUrl = `/data/invoices/${invoiceNo}.xlsx`;
      console.log(`📁 로컬 저장: ${localPath}`);
    }

    // 6. 시트에 인보이스 기록
    const invoiceRow = [
      invoiceNo,
      data.buyerId,
      buyer.Name,
      invoiceDate,
      dueDate,
      JSON.stringify(items),
      subtotal.toFixed(2),
      tax.toFixed(2),
      shipping.toFixed(2),
      total.toFixed(2),
      currency,
      'CREATED',
      driveFileId,
      driveUrl,
      '',
      '',
    ];
    await this.sheets.appendData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:P`, [invoiceRow]);

    // 7. 구매자 통계 업데이트 (TotalOrders, TotalRevenue)
    await this._updateBuyerStats(data.buyerId);

    console.log(`✅ 인보이스 생성 완료: ${invoiceNo} → ${buyer.Name} (${currency} ${total.toFixed(2)})`);

    return {
      invoiceNo,
      buyerId: data.buyerId,
      buyerName: buyer.Name,
      date: invoiceDate,
      dueDate,
      items,
      subtotal,
      tax,
      shipping,
      total,
      currency,
      status: 'CREATED',
      driveFileId,
      driveUrl,
      xlsxBuffer,
    };
  }

  /**
   * 자동 인보이스 생성.
   *   data.mode: 'catalog' (기본) | 'orders'
   *   data.buyerId
   *   data.items[]  (mode=catalog): [{ catalogTab, rowIndex, side, boxes, unitPriceOverride? }]
   *   data.orderIds[] (mode=orders): 플랫폼 주문 order_no 배열
   *   data.shippingOverride? — 배송비 수동 덮어쓰기 (버퍼 0 등록시 shipping 0)
   *   data.dueDate?, data.notes?
   */
  async generateInvoiceAuto(data) {
    const mode = data.mode === 'orders' ? 'orders' : 'catalog';
    const buyers = await this.getBuyers();
    const buyer = buyers.find(b => b.BuyerID === data.buyerId);
    if (!buyer) throw new Error(`구매자 ${data.buyerId} 없음`);

    const shippingRule = (buyer.ShippingRule && Object.keys(buyer.ShippingRule).length > 0)
      ? buyer.ShippingRule
      : { perBoxes: 30, rate: 120, currency: 'USD' };

    let items = [];
    let totalBoxes = 0;
    let invoiceCurrency = (shippingRule.currency || buyer.Currency || 'USD').toUpperCase();
    let memoExtra = [];

    if (mode === 'catalog') {
      const catalogService = require('./catalogService');
      const rates = await catalogService.getRates().catch(() => ({ usd: 1400, jpy: 1000, local: 1000 }));
      const usdToKrw = Number(rates.usd) || 1400;

      // 탭별로 묶어서 한 번씩 getCatalog (캐시 효과)
      const inputItems = Array.isArray(data.items) ? data.items : [];
      if (inputItems.length === 0) throw new Error('카탈로그 품목을 선택하세요');
      const byTab = new Map();
      for (const it of inputItems) {
        if (!it.catalogTab) throw new Error('catalogTab이 누락된 품목이 있습니다');
        if (!byTab.has(it.catalogTab)) byTab.set(it.catalogTab, []);
        byTab.get(it.catalogTab).push(it);
      }
      for (const [tab, tabItems] of byTab) {
        const { items: catalogItems = [] } = await catalogService.getCatalog(tab);
        for (const sel of tabItems) {
          const found = catalogItems.find(c =>
            c.rowIndex === sel.rowIndex && (sel.side ? c.side === sel.side : true)
          );
          if (!found) {
            memoExtra.push(`카탈로그 항목 누락 (${tab} row ${sel.rowIndex})`);
            continue;
          }
          const boxes = Math.max(1, parseInt(sel.boxes, 10) || 1);
          const usdPrice = Number(sel.unitPriceOverride ?? found.usdPrice) || 0;
          const priceInInvoice = invoiceCurrency === 'KRW'
            ? Math.round(usdPrice * usdToKrw)
            : usdPrice;
          items.push({
            sku: found.setCode || found.upc || '',
            name: found.name,
            qty: boxes,
            price: priceInInvoice,
          });
          totalBoxes += boxes;
        }
      }
      if (items.length === 0) throw new Error('유효한 카탈로그 품목이 없습니다');
    } else if (mode === 'orders') {
      const { getClient } = require('../db/supabaseClient');
      const db = getClient();
      const orderNos = Array.isArray(data.orderIds) ? data.orderIds : [];
      if (orderNos.length === 0) throw new Error('주문을 선택하세요');
      const { data: rows, error } = await db.from('orders')
        .select('order_no, platform, title, sku, quantity, payment_amount, currency')
        .in('order_no', orderNos);
      if (error) throw error;
      if (!rows || rows.length === 0) throw new Error('주문을 찾을 수 없습니다');

      // 통화 검증 — 모두 같아야 함
      const ccySet = new Set(rows.map(r => (r.currency || 'USD').toUpperCase()));
      if (ccySet.size > 1) {
        throw new Error(`주문 통화가 섞여있습니다 (${[...ccySet].join(', ')}). 같은 통화 주문끼리만 묶어주세요.`);
      }
      invoiceCurrency = [...ccySet][0];
      for (const r of rows) {
        const qty = Number(r.quantity) || 1;
        const total = Number(r.payment_amount) || 0;
        items.push({
          sku: r.sku || '',
          name: r.title || r.order_no,
          qty,
          price: qty > 0 ? total / qty : total,
        });
      }
      memoExtra.push(`주문 ${rows.length}건 기반 자동 생성`);
    }

    // 배송비 계산 (catalog 모드만 자동, orders 모드는 주문에 이미 포함)
    let shipping = 0;
    if (data.shippingOverride != null && data.shippingOverride !== '') {
      shipping = Number(data.shippingOverride) || 0;
    } else if (mode === 'catalog') {
      const perBoxes = Math.max(1, parseInt(shippingRule.perBoxes, 10) || 30);
      const rate = Number(shippingRule.rate) || 0;
      const chunks = Math.ceil(totalBoxes / perBoxes);
      shipping = chunks * rate;
      if (shipping > 0) {
        memoExtra.push(`배송비 = ${perBoxes}박스 × ${chunks}묶음 (${totalBoxes}박스)`);
      }
    }

    const notes = [data.notes, ...memoExtra].filter(Boolean).join(' · ');
    return this.generateInvoice({
      buyerId: data.buyerId,
      items,
      tax: 0,
      shipping,
      currency: invoiceCurrency,
      dueDate: data.dueDate,
      notes,
    });
  }

  /**
   * Excel 인보이스 빌드
   */
  async _buildInvoiceXlsx({ invoiceNo, invoiceDate, dueDate, buyer, items, subtotal, tax, shipping, total, currency, notes }) {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Invoice');

    // 열 너비
    ws.columns = [
      { width: 5 },   // A: #
      { width: 18 },  // B: SKU
      { width: 35 },  // C: Description
      { width: 10 },  // D: Qty
      { width: 14 },  // E: Unit Price
      { width: 14 },  // F: Total
    ];

    // 스타일
    const titleFont = { name: 'Arial', size: 16, bold: true };
    const headerFont = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    const normalFont = { name: 'Arial', size: 10 };
    const boldFont = { name: 'Arial', size: 10, bold: true };
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } };
    const lightFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    const borderThin = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' },
    };
    const currencyFmt = `"${currency}" #,##0.00`;

    // Row 1: 회사명
    ws.mergeCells('A1:F1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'PMC Corporation';
    titleCell.font = titleFont;
    titleCell.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 30;

    // Row 2: 회사 정보
    ws.mergeCells('A2:F2');
    ws.getCell('A2').value = 'E-commerce Distribution & Wholesale';
    ws.getCell('A2').font = { ...normalFont, color: { argb: 'FF666666' } };

    // Row 4-6: 인보이스 정보
    ws.getCell('A4').value = 'INVOICE';
    ws.getCell('A4').font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF2B579A' } };

    ws.getCell('A5').value = 'Invoice No:';
    ws.getCell('A5').font = boldFont;
    ws.getCell('B5').value = invoiceNo;
    ws.getCell('B5').font = normalFont;

    ws.getCell('D5').value = 'Date:';
    ws.getCell('D5').font = boldFont;
    ws.getCell('E5').value = invoiceDate;
    ws.getCell('E5').font = normalFont;

    ws.getCell('D6').value = 'Due Date:';
    ws.getCell('D6').font = boldFont;
    ws.getCell('E6').value = dueDate;
    ws.getCell('E6').font = normalFont;

    // Row 8-11: Bill To
    ws.getCell('A8').value = 'Bill To:';
    ws.getCell('A8').font = boldFont;
    ws.getCell('A9').value = buyer.Name;
    ws.getCell('A9').font = boldFont;
    ws.getCell('A10').value = buyer.Address || '';
    ws.getCell('A10').font = normalFont;
    ws.getCell('A11').value = `${buyer.Country || ''} | ${buyer.Email || ''} | ${buyer.Phone || ''}`;
    ws.getCell('A11').font = { ...normalFont, color: { argb: 'FF666666' } };

    // Row 13: 테이블 헤더
    const headerRow = ws.getRow(13);
    const tableHeaders = ['#', 'SKU', 'Description', 'Qty', 'Unit Price', 'Total'];
    tableHeaders.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.border = borderThin;
      cell.alignment = { vertical: 'middle', horizontal: i >= 3 ? 'right' : 'left' };
    });
    headerRow.height = 22;

    // 아이템 행
    let rowNum = 14;
    items.forEach((item, idx) => {
      const row = ws.getRow(rowNum);
      const isEven = idx % 2 === 0;

      row.getCell(1).value = idx + 1;
      row.getCell(2).value = item.sku;
      row.getCell(3).value = item.name;
      row.getCell(4).value = item.qty;
      row.getCell(5).value = item.price;
      row.getCell(5).numFmt = currencyFmt;
      row.getCell(6).value = item.total;
      row.getCell(6).numFmt = currencyFmt;

      for (let c = 1; c <= 6; c++) {
        const cell = row.getCell(c);
        cell.font = normalFont;
        cell.border = borderThin;
        cell.alignment = { vertical: 'middle', horizontal: c >= 4 ? 'right' : 'left' };
        if (isEven) cell.fill = lightFill;
      }
      row.height = 20;
      rowNum++;
    });

    // 합계 영역
    rowNum += 1;
    const summaryData = [
      ['Subtotal', subtotal],
      ['Tax', tax],
      ['Shipping', shipping],
      ['TOTAL', total],
    ];

    summaryData.forEach(([label, value], idx) => {
      const row = ws.getRow(rowNum);
      row.getCell(5).value = label;
      row.getCell(5).font = idx === 3 ? { ...boldFont, size: 12 } : boldFont;
      row.getCell(5).alignment = { horizontal: 'right' };
      row.getCell(6).value = value;
      row.getCell(6).numFmt = currencyFmt;
      row.getCell(6).font = idx === 3 ? { ...boldFont, size: 12 } : normalFont;
      row.getCell(6).alignment = { horizontal: 'right' };
      if (idx === 3) {
        row.getCell(5).border = { top: { style: 'double' }, bottom: { style: 'double' } };
        row.getCell(6).border = { top: { style: 'double' }, bottom: { style: 'double' } };
      }
      rowNum++;
    });

    // Notes
    if (notes) {
      rowNum += 1;
      ws.getCell(`A${rowNum}`).value = 'Notes:';
      ws.getCell(`A${rowNum}`).font = boldFont;
      rowNum++;
      ws.mergeCells(`A${rowNum}:F${rowNum}`);
      ws.getCell(`A${rowNum}`).value = notes;
      ws.getCell(`A${rowNum}`).font = normalFont;
    }

    // Payment Terms
    rowNum += 2;
    ws.getCell(`A${rowNum}`).value = `Payment Terms: ${buyer.PaymentTerms || 'Net 30'}`;
    ws.getCell(`A${rowNum}`).font = { ...normalFont, color: { argb: 'FF666666' } };

    // 프린트 설정
    ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ────────────────────── 인보이스 조회 ──────────────────────

  /**
   * 인보이스 목록 조회
   * @param {Object} filters - { buyerId, status, fromDate, toDate }
   */
  async getInvoices(filters = {}) {
    await this._ensureSheets();
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:P`);
    if (!rows || rows.length <= 1) return [];

    const headers = rows[0];
    let invoices = rows.slice(1).filter(r => r[0]).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      obj.Subtotal = Number(obj.Subtotal) || 0;
      obj.Tax = Number(obj.Tax) || 0;
      obj.Shipping = Number(obj.Shipping) || 0;
      obj.Total = Number(obj.Total) || 0;
      // Items JSON 파싱
      try { obj.ItemsParsed = JSON.parse(obj.Items || '[]'); } catch { obj.ItemsParsed = []; }
      return obj;
    });

    // 필터
    if (filters.buyerId) invoices = invoices.filter(i => i.BuyerID === filters.buyerId);
    if (filters.status) invoices = invoices.filter(i => i.Status === filters.status);
    if (filters.fromDate) invoices = invoices.filter(i => i.Date >= filters.fromDate);
    if (filters.toDate) invoices = invoices.filter(i => i.Date <= filters.toDate);

    return invoices;
  }

  /**
   * 인보이스 상태 업데이트 (CREATED → SENT → PAID)
   */
  async updateInvoiceStatus(invoiceNo, status, extra = {}) {
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:P`);
    if (!rows || rows.length <= 1) throw new Error('인보이스 데이터 없음');

    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === invoiceNo);
    if (rowIndex === -1) throw new Error(`인보이스 ${invoiceNo} 없음`);

    const sheetRow = rowIndex + 1;

    // L: Status
    await this.sheets.writeData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!L${sheetRow}`, [[status]]);

    // O: SentVia, P: SentAt
    if (extra.sentVia) {
      const now = new Date().toISOString();
      await this.sheets.writeData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!O${sheetRow}:P${sheetRow}`, [[extra.sentVia, now]]);
    }

    // PAID면 구매자 통계 업데이트
    if (status === 'PAID') {
      const buyerId = rows[rowIndex][1];
      await this._updateBuyerStats(buyerId);
    }

    console.log(`✅ 인보이스 ${invoiceNo} → ${status}`);
    return { invoiceNo, status };
  }

  // ────────────────────── 인보이스 다운로드 ──────────────────────

  /**
   * 인보이스 다운로드 (재생성)
   * @param {string} invoiceNo
   * @param {string} format - 'xlsx' 또는 'pdf'
   */
  async downloadInvoice(invoiceNo, format = 'xlsx') {
    const invoices = await this.getInvoices();
    const inv = invoices.find(i => i.InvoiceNo === invoiceNo);
    if (!inv) throw new Error(`인보이스 ${invoiceNo} 없음`);

    // Drive에서 다운로드 시도
    if (inv.DriveFileId) {
      try {
        if (format === 'pdf') {
          const pdfBuffer = await this.drive.convertXlsxToPdf(
            await this.drive.downloadFile(inv.DriveFileId),
            `temp-${invoiceNo}`
          );
          return { buffer: pdfBuffer, mimeType: 'application/pdf', fileName: `${invoiceNo}.pdf` };
        }
        const xlsxBuffer = await this.drive.downloadFile(inv.DriveFileId);
        return {
          buffer: xlsxBuffer,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: `${invoiceNo}.xlsx`,
        };
      } catch (driveErr) {
        console.warn('Drive 다운로드 실패, 재생성:', driveErr.message);
      }
    }

    // 로컬 파일 확인
    const localPath = path.join(__dirname, '../../data/invoices', `${invoiceNo}.xlsx`);
    const fs = require('fs');
    if (fs.existsSync(localPath)) {
      const buffer = fs.readFileSync(localPath);
      if (format === 'pdf') {
        try {
          const pdfBuffer = await this.drive.convertXlsxToPdf(buffer, `temp-${invoiceNo}`);
          return { buffer: pdfBuffer, mimeType: 'application/pdf', fileName: `${invoiceNo}.pdf` };
        } catch {
          // PDF 변환 실패 시 xlsx 반환
        }
      }
      return {
        buffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: `${invoiceNo}.xlsx`,
      };
    }

    // 재생성
    const buyers = await this.getBuyers();
    const buyer = buyers.find(b => b.BuyerID === inv.BuyerID);
    const xlsxBuffer = await this._buildInvoiceXlsx({
      invoiceNo: inv.InvoiceNo,
      invoiceDate: inv.Date,
      dueDate: inv.DueDate,
      buyer: buyer || { Name: inv.BuyerName, Address: '', Country: '', Email: '', Phone: '', PaymentTerms: '' },
      items: inv.ItemsParsed,
      subtotal: inv.Subtotal,
      tax: inv.Tax,
      shipping: inv.Shipping,
      total: inv.Total,
      currency: inv.Currency,
      notes: '',
    });

    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${invoiceNo}.xlsx`,
    };
  }

  // ────────────────────── 전송 ──────────────────────

  /**
   * WhatsApp 딥링크 생성
   */
  async getWhatsAppLink(invoiceNo) {
    const invoices = await this.getInvoices();
    const inv = invoices.find(i => i.InvoiceNo === invoiceNo);
    if (!inv) throw new Error(`인보이스 ${invoiceNo} 없음`);

    const buyers = await this.getBuyers();
    const buyer = buyers.find(b => b.BuyerID === inv.BuyerID);
    const phone = (buyer?.WhatsApp || buyer?.Phone || '').replace(/[^0-9]/g, '');

    const message = encodeURIComponent(
      `Hi ${buyer?.Name || inv.BuyerName},\n\n` +
      `Please find your invoice ${inv.InvoiceNo} for ${inv.Currency} ${inv.Total}.\n` +
      `Due date: ${inv.DueDate}\n\n` +
      (inv.DriveUrl ? `Download: ${inv.DriveUrl}\n\n` : '') +
      `Thank you for your business!\n- PMC Corporation`
    );

    const link = phone
      ? `https://wa.me/${phone}?text=${message}`
      : `https://wa.me/?text=${message}`;

    // 상태 업데이트
    await this.updateInvoiceStatus(invoiceNo, 'SENT', { sentVia: 'WhatsApp' });

    return { link, phone, buyerName: buyer?.Name || inv.BuyerName };
  }

  // ────────────────────── 매출 분석 ──────────────────────

  /**
   * 매출 요약 (통화별 분리)
   */
  async getRevenueSummary() {
    const invoices = await this.getInvoices();
    const buyers = await this.getBuyers();

    const paidInvoices = invoices.filter(i => i.Status === 'PAID');

    // 통화별 매출 분리
    const revenueByCurrency = {};
    paidInvoices.forEach(inv => {
      const cur = inv.Currency || 'USD';
      if (!revenueByCurrency[cur]) revenueByCurrency[cur] = 0;
      revenueByCurrency[cur] += inv.Total;
    });

    const totalRevenue = paidInvoices.reduce((s, i) => s + i.Total, 0);
    const totalOutstanding = invoices
      .filter(i => i.Status !== 'PAID')
      .reduce((s, i) => s + i.Total, 0);

    // 구매자별
    const byBuyer = {};
    invoices.forEach(inv => {
      if (!byBuyer[inv.BuyerID]) {
        byBuyer[inv.BuyerID] = {
          buyerId: inv.BuyerID,
          buyerName: inv.BuyerName,
          totalInvoices: 0,
          paidAmount: 0,
          outstandingAmount: 0,
          currency: inv.Currency || 'USD',
        };
      }
      byBuyer[inv.BuyerID].totalInvoices++;
      if (inv.Status === 'PAID') {
        byBuyer[inv.BuyerID].paidAmount += inv.Total;
      } else {
        byBuyer[inv.BuyerID].outstandingAmount += inv.Total;
      }
    });

    // 월별 (통화별 분리)
    const byMonth = {};
    invoices.forEach(inv => {
      const month = (inv.Date || '').substring(0, 7);
      if (!month) return;
      if (!byMonth[month]) byMonth[month] = { month, total: 0, paid: 0, count: 0, byCurrency: {} };
      byMonth[month].total += inv.Total;
      byMonth[month].count++;
      if (inv.Status === 'PAID') byMonth[month].paid += inv.Total;
      const cur = inv.Currency || 'USD';
      if (!byMonth[month].byCurrency[cur]) byMonth[month].byCurrency[cur] = 0;
      byMonth[month].byCurrency[cur] += inv.Total;
    });

    // 월별 정렬 + 성장률 계산
    const monthsSorted = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    for (let i = 1; i < monthsSorted.length; i++) {
      const prev = monthsSorted[i - 1].total;
      const curr = monthsSorted[i].total;
      monthsSorted[i].growth = prev > 0 ? Math.round(((curr - prev) / prev) * 10000) / 100 : null;
    }

    return {
      totalInvoices: invoices.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      totalBuyers: buyers.length,
      revenueByCurrency: Object.entries(revenueByCurrency).map(([c, v]) => ({
        currency: c, amount: Math.round(v * 100) / 100,
      })),
      byBuyer: Object.values(byBuyer).sort((a, b) => b.paidAmount - a.paidAmount),
      byMonth: monthsSorted.reverse(),
    };
  }

  /**
   * 바이어 매출 순위
   */
  async getBuyerRanking() {
    const invoices = await this.getInvoices();
    const buyers = await this.getBuyers();

    const ranking = {};
    invoices.forEach(inv => {
      if (!ranking[inv.BuyerID]) {
        ranking[inv.BuyerID] = {
          buyerId: inv.BuyerID,
          buyerName: inv.BuyerName,
          country: '',
          totalOrders: 0,
          totalRevenue: 0,
          currency: inv.Currency || 'USD',
          lastOrderDate: '',
          avgOrderValue: 0,
        };
      }
      const r = ranking[inv.BuyerID];
      r.totalOrders++;
      if (inv.Status === 'PAID') r.totalRevenue += inv.Total;
      if (inv.Date > r.lastOrderDate) r.lastOrderDate = inv.Date;
    });

    // 바이어 정보 보강
    buyers.forEach(b => {
      if (ranking[b.BuyerID]) {
        ranking[b.BuyerID].country = b.Country || '';
      }
    });

    // 평균 주문 금액 계산
    Object.values(ranking).forEach(r => {
      r.totalRevenue = Math.round(r.totalRevenue * 100) / 100;
      r.avgOrderValue = r.totalOrders > 0
        ? Math.round((r.totalRevenue / r.totalOrders) * 100) / 100
        : 0;
    });

    return Object.values(ranking)
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  /**
   * 상품별 판매 통계
   * @param {string} buyerId - 특정 바이어 필터 (optional)
   */
  async getProductStats(buyerId) {
    let invoices = await this.getInvoices();
    if (buyerId) invoices = invoices.filter(i => i.BuyerID === buyerId);

    const productMap = {};

    invoices.forEach(inv => {
      const items = inv.ItemsParsed || [];
      items.forEach(item => {
        const name = (item.name || '').trim();
        if (!name) return;

        const key = name.toLowerCase();
        if (!productMap[key]) {
          productMap[key] = {
            name,
            totalQty: 0,
            totalRevenue: 0,
            orderCount: 0,
            buyers: new Set(),
          };
        }
        productMap[key].totalQty += (item.qty || 1);
        productMap[key].totalRevenue += (item.total || 0);
        productMap[key].orderCount++;
        productMap[key].buyers.add(inv.BuyerName || inv.BuyerID);
      });
    });

    return Object.values(productMap)
      .map(p => ({
        name: p.name,
        totalQty: p.totalQty,
        totalRevenue: Math.round(p.totalRevenue * 100) / 100,
        orderCount: p.orderCount,
        buyers: [...p.buyers],
        buyerCount: p.buyers.size,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  // ────────────────────── 내부 헬퍼 ──────────────────────

  /**
   * 구매자 통계 업데이트 (TotalOrders, TotalRevenue)
   */
  async _updateBuyerStats(buyerId) {
    try {
      const invoices = await this.getInvoices({ buyerId });
      const totalOrders = invoices.length;
      const totalRevenue = invoices
        .filter(i => i.Status === 'PAID')
        .reduce((s, i) => s + i.Total, 0);

      const rows = await this.sheets.readData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A:M`);
      if (!rows) return;

      const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === buyerId);
      if (rowIndex === -1) return;

      const sheetRow = rowIndex + 1;
      await this.sheets.writeData(
        SPREADSHEET_ID,
        `'${BUYERS_SHEET}'!L${sheetRow}:M${sheetRow}`,
        [[String(totalOrders), totalRevenue.toFixed(2)]]
      );
    } catch (err) {
      console.warn('구매자 통계 업데이트 실패:', err.message);
    }
  }
}

module.exports = B2BInvoiceService;
