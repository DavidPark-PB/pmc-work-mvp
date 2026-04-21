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

    // 5. Drive 업로드 시도 — 실패 시 API 다운로드 엔드포인트로 fallback.
    // (과거 로컬 파일 저장 fallback은 Fly.io ephemeral disk라 의미 없어 제거)
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
      console.warn('⚠️ Drive 업로드 실패 — API download 엔드포인트 fallback:', driveErr.message);
      driveUrl = `/api/b2b/invoices/${invoiceNo}/download`;
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

    // 6-b. Supabase에도 인보이스 동기화 (실패해도 Sheets 기준으로 계속 진행)
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      await repo.createInvoice({
        InvoiceNo: invoiceNo,
        BuyerID: data.buyerId,
        BuyerName: buyer.Name,
        Date: invoiceDate,
        DueDate: dueDate,
        Items: items,
        Subtotal: subtotal,
        Tax: tax,
        Shipping: shipping,
        Total: total,
        Currency: currency,
        Status: 'CREATED',
        DriveFileId: driveFileId,
        DriveUrl: driveUrl,
      });
    } catch (err) {
      console.warn('[B2B] Supabase 동기화 실패 (마이그레이션 미적용?):', err.message);
    }

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
   * Excel 인보이스 빌드 — MASTER 템플릿(templates/b2b_invoice_master.xlsx) 로드 후 데이터 주입.
   * CCOREA 로고·서식·폰트·테두리는 템플릿에서 상속. 양식 변경 시 xlsx 파일만 교체하면 됨.
   */
  async _buildInvoiceXlsx({ invoiceNo, invoiceDate, dueDate, buyer, items, subtotal, tax, shipping, total, currency, notes }) {
    const fs = require('fs');
    const templatePath = path.join(__dirname, '../../templates/b2b_invoice_master.xlsx');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`인보이스 템플릿 파일 없음: ${templatePath}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const ws = workbook.getWorksheet('MASTER');
    if (!ws) throw new Error('MASTER 시트를 템플릿에서 찾을 수 없습니다');

    // 날짜 포맷: "2026-04-22" → "Apr.22,2026"
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const formatDate = iso => {
      if (!iso) return '';
      const d = new Date(String(iso) + 'T00:00:00');
      if (isNaN(d)) return iso;
      return `${MONTHS[d.getMonth()]}.${d.getDate()},${d.getFullYear()}`;
    };

    // 1) 바이어 정보 (B7~B11)
    const emailPhone = [buyer.Email, buyer.Phone || buyer.WhatsApp].filter(Boolean).join(' / ');
    ws.getCell('B7').value = `Messrs. :${buyer.Name || ''}`;
    ws.getCell('B8').value = buyer.Address || '';
    ws.getCell('B9').value = emailPhone;
    // VAT/EORI — buyer 스키마에 없어서 Notes에서 추출 (있으면). 없으면 공백
    const vatMatch  = (buyer.Notes || '').match(/VAT\s*[:\-]?\s*(\S+)/i);
    const eoriMatch = (buyer.Notes || '').match(/EORI\s*[:\-]?\s*(\S+)/i);
    ws.getCell('B10').value = vatMatch  ? `VAT: ${vatMatch[1]}`   : '';
    ws.getCell('B11').value = eoriMatch ? `EORI: ${eoriMatch[1]}` : '';

    // 2) 인보이스 번호 (I7:J7 merged)
    ws.getCell('I7').value = invoiceNo;

    // 3) 조건 (E열 = 값, D = ':' , C = 라벨)
    ws.getCell('E15').value = formatDate(invoiceDate);
    ws.getCell('E16').value = 'FOB';
    ws.getCell('E17').value = 'Export Standard Packing';
    ws.getCell('E18').value = buyer.PaymentTerms || '100% T/T in advance';
    ws.getCell('E19').value = 'Asap after payment';
    ws.getCell('E20').value = 'Republic of Korea';

    // 4) 품목 — 행 23~28 (최대 6개)
    const ITEM_FIRST_ROW = 23;
    const ITEM_LAST_ROW = 28;
    const maxItems = ITEM_LAST_ROW - ITEM_FIRST_ROW + 1;
    if ((items || []).length > maxItems) {
      throw new Error(`품목 수 초과 (${items.length}개). 템플릿 최대 ${maxItems}개. 인보이스 분할 필요.`);
    }
    for (let i = 0; i < maxItems; i++) {
      const row = ITEM_FIRST_ROW + i;
      const it = items[i];
      if (it) {
        ws.getCell(`C${row}`).value = it.name || it.sku || '';    // C:F merged
        ws.getCell(`G${row}`).value = Number(it.qty) || 0;        // G:H merged
        ws.getCell(`I${row}`).value = Number(it.price) || 0;
        const itemTotal = Number(it.total) || (Number(it.qty) || 0) * (Number(it.price) || 0);
        ws.getCell(`J${row}`).value = itemTotal;
      } else {
        // 빈 행 — NO. 열(B)은 템플릿 값 유지, 값 셀만 비움
        ws.getCell(`C${row}`).value = '';
        ws.getCell(`G${row}`).value = '';
        ws.getCell(`I${row}`).value = '';
        ws.getCell(`J${row}`).value = '';
      }
    }

    // 5) 배송 (row 29) — 템플릿 formula 덮어쓰고 우리 시스템 값 주입
    const shippingAmount = Number(shipping) || 0;
    if (shippingAmount > 0) {
      ws.getCell('G29').value = Math.max(1, Math.ceil(shippingAmount / 100));
      ws.getCell('I29').value = 100;
      ws.getCell('J29').value = shippingAmount;
    } else {
      ws.getCell('G29').value = 0;
      ws.getCell('I29').value = 0;
      ws.getCell('J29').value = 0;
    }

    // 6) TOTAL (row 30) — 템플릿 SUM formula 그대로 둬도 되지만 명시적으로 값도 세팅
    ws.getCell('J30').value = Number(total) || 0;

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
      // DriveUrl 정규화 — 과거 로컬 fallback(/data/invoices/...)이나 깨진 값은 API 경로로 교정
      if (obj.DriveUrl && !/^https?:\/\//i.test(obj.DriveUrl)) {
        obj.DriveUrl = `/api/b2b/invoices/${obj.InvoiceNo}/download`;
      }
      return obj;
    });

    // voided 제외 (Supabase 마이그레이션 025 적용 시) — includeVoided 옵션으로 오버라이드 가능
    if (!filters.includeVoided) {
      try {
        const B2BRepo = require('../db/b2bRepository');
        const repo = new B2BRepo();
        const { data } = await repo.db
          .from('b2b_invoices')
          .select('invoice_no')
          .not('voided_at', 'is', null);
        const voidedSet = new Set((data || []).map(r => r.invoice_no));
        if (voidedSet.size > 0) invoices = invoices.filter(i => !voidedSet.has(i.InvoiceNo));
      } catch { /* migration 025 미적용 — 필터 스킵 */ }
    }

    // 필터
    if (filters.buyerId) invoices = invoices.filter(i => i.BuyerID === filters.buyerId);
    if (filters.status) invoices = invoices.filter(i => i.Status === filters.status);
    if (filters.fromDate) invoices = invoices.filter(i => i.Date >= filters.fromDate);
    if (filters.toDate) invoices = invoices.filter(i => i.Date <= filters.toDate);

    // statusGroup: 진행 상태별 필터 (active=진행중 / completed=완료 / all=전체)
    // 완료=PAID (결제 완료된 것). 메인 목록 기본값은 active로 PAID 숨김.
    if (filters.statusGroup === 'active') {
      invoices = invoices.filter(i => i.Status !== 'PAID');
    } else if (filters.statusGroup === 'completed') {
      invoices = invoices.filter(i => i.Status === 'PAID');
    }

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

    // Supabase에도 반영
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      await repo.updateInvoiceStatus(invoiceNo, status);
    } catch { /* 미마이그레이션 시 무시 */ }

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

    // 로컬 파일 fallback 제거 (Fly.io ephemeral disk라 항상 false였음) → 바로 재생성

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
