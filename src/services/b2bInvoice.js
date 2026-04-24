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
      // PaymentTerms 입력 안 하면 빈 값 — 인보이스 생성 시 표준 문구 자동 사용
      data.paymentTerms || '',
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

  /**
   * 구매자 삭제 — Sheets 행 비우고 Supabase 레코드 제거.
   * 기존 인보이스가 있으면 기본적으로 막고, { force: true } 옵션 시에만 진행.
   */
  async deleteBuyer(buyerId, { force = false } = {}) {
    await this._ensureSheets();
    const rows = await this.sheets.readData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A:M`);
    if (!rows || rows.length <= 1) throw new Error('구매자 데이터 없음');
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === buyerId);
    if (rowIndex === -1) throw new Error(`구매자 ${buyerId} 없음`);

    // 기존 인보이스 체크 (안전 장치)
    const invoiceRows = await this.sheets.readData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:B`);
    const invCount = (invoiceRows || []).filter((r, i) => i > 0 && r[1] === buyerId).length;
    if (invCount > 0 && !force) {
      const e = new Error(`이 구매자에 인보이스 ${invCount}건이 연결돼 있습니다. 강제 삭제하려면 force=true.`);
      e.code = 'HAS_INVOICES';
      e.invoiceCount = invCount;
      throw e;
    }

    // Sheets: 행 내용 비움 (행 자체는 남지만 A열 비면 getBuyers 에서 필터됨)
    const sheetRow = rowIndex + 1;
    await this.sheets.clearData(SPREADSHEET_ID, `'${BUYERS_SHEET}'!A${sheetRow}:M${sheetRow}`);

    // Supabase
    try {
      const { getClient } = require('../db/supabaseClient');
      const db = getClient();
      await db.from('b2b_buyers').delete().eq('buyer_id', buyerId);
    } catch (e) {
      console.warn('[deleteBuyer] Supabase 삭제 실패 (없을 수 있음):', e.message);
    }

    console.log(`✅ 구매자 삭제: ${buyerId}${force ? ' (강제, 연결 인보이스 유지)' : ''}`);
    return { buyerId, invoiceCount: invCount };
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
   * 다음 문서 번호 생성.
   *   docType='INVOICE' (기본) → INV-2026-0001
   *   docType='QUOTE'          → Q-2026-0001
   * Sheets + Supabase 양쪽 모두 확인해 max 번호 기준 +1. 둘 중 한쪽이 앞서있어도 중복 방지.
   */
  async _getNextInvoiceNo(docType = 'INVOICE') {
    const year = new Date().getFullYear();
    const isQuote = String(docType).toUpperCase() === 'QUOTE';
    const prefix = isQuote ? `Q-${year}-` : `INV-${year}-`;

    const extractNum = (cell) => {
      if (!cell) return 0;
      const s = String(cell).trim();
      if (!s.startsWith(prefix)) return 0;
      const rest = s.slice(prefix.length);
      const n = parseInt(rest, 10);
      return Number.isFinite(n) ? n : 0;
    };

    let maxNum = 0;

    // 1) Sheets 스캔 (header 스킵, trim, 안전 파싱)
    try {
      const rows = await this.sheets.readData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:A`);
      if (rows) {
        rows.forEach((r, idx) => {
          if (idx === 0) return; // header row
          const n = extractNum(r && r[0]);
          if (n > maxNum) maxNum = n;
        });
      }
    } catch (e) {
      console.warn('[_getNextInvoiceNo] Sheets 스캔 실패:', e.message);
    }

    // 2) Supabase 크로스체크 — Sheet 보다 앞서 있을 수 있음 (생성 직후 Sheet write 실패 등)
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      const client = repo.db;
      const { data, error } = await client
        .from('b2b_invoices')
        .select('invoice_no')
        .like('invoice_no', `${prefix}%`)
        .order('invoice_no', { ascending: false })
        .limit(5);
      if (!error && data) {
        for (const r of data) {
          const n = extractNum(r.invoice_no);
          if (n > maxNum) maxNum = n;
        }
      }
    } catch (e) {
      console.warn('[_getNextInvoiceNo] Supabase 크로스체크 실패:', e.message);
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

    const docType = String(data.docType || 'INVOICE').toUpperCase();
    const isQuote = docType === 'QUOTE';

    // 2. 문서 번호 생성
    const invoiceNo = await this._getNextInvoiceNo(docType);
    const today = new Date();
    const invoiceDate = today.toISOString().split('T')[0];

    // 만기일/유효일: dueDate 지정 또는 PaymentTerms에서 계산. 견적서는 기본 14일.
    let dueDate = data.dueDate;
    if (!dueDate) {
      const defaultDays = isQuote ? 14 : (parseInt((buyer.PaymentTerms || '').replace(/\D/g, ''), 10) || 30);
      const due = new Date(today);
      due.setDate(due.getDate() + defaultDays);
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

    // 4. Excel 인보이스/견적서 생성
    const xlsxBuffer = await this._buildInvoiceXlsx({
      invoiceNo, invoiceDate, dueDate,
      buyer, items, subtotal, tax, shipping, total, currency,
      notes: data.notes || '',
      docType,
      validUntil: isQuote ? dueDate : undefined,
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
        DocType: docType,
        DriveFileId: driveFileId,
        DriveUrl: driveUrl,
      });
    } catch (err) {
      console.warn('[B2B] Supabase 동기화 실패 (마이그레이션 미적용?):', err.message);
    }

    // 7. 구매자 통계 업데이트 — 견적서는 매출 집계 제외
    if (!isQuote) {
      await this._updateBuyerStats(data.buyerId);
    }

    const docLabel = isQuote ? '견적서' : '인보이스';
    console.log(`✅ ${docLabel} 생성 완료: ${invoiceNo} → ${buyer.Name} (${currency} ${total.toFixed(2)})`);

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
      docType,
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

    // 배송 규칙: buyer 저장값 → override (이번 인보이스만) → 기본값 순
    const sr = (data.shippingRuleOverride && typeof data.shippingRuleOverride === 'object' && Object.keys(data.shippingRuleOverride).length > 0)
      ? data.shippingRuleOverride
      : buyer.ShippingRule;
    const shippingRule = (sr && Object.keys(sr).length > 0)
      ? sr
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

    // 추가 수수료 라인 — 각 수수료는 qty=1 라인아이템으로 품목 뒤에 추가됨.
    //   data.extraFees: [{ name: string, amount: number }]
    const extraFees = Array.isArray(data.extraFees) ? data.extraFees : [];
    for (const fee of extraFees) {
      const name = String(fee?.name || '').trim();
      const amount = Number(fee?.amount);
      if (!name || !Number.isFinite(amount) || amount === 0) continue;
      items.push({ sku: '', name, qty: 1, price: amount });
      memoExtra.push(`수수료: ${name} ${amount.toFixed(2)}`);
    }

    // 할인 — 마지막 라인아이템으로 음수 price 추가. 0/미입력 시 스킵.
    const discount = Number(data.discount);
    if (Number.isFinite(discount) && discount > 0) {
      items.push({ sku: '', name: 'Discount', qty: 1, price: -discount });
      memoExtra.push(`할인 ${discount.toFixed(2)}`);
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
      docType: data.docType || 'INVOICE',
    });
  }

  /**
   * 수기 인보이스 저장 — 이미 발행된 인보이스를 수동 등록.
   * Excel 생성 안 함. 원본 파일(PDF/이미지)은 Supabase Storage 에 저장.
   *   data.buyerId          — 선택 (buyer 매칭된 경우)
   *   data.buyerName        — 필수 (buyerId 없을 때 사용)
   *   data.invoiceNo?       — 있으면 그대로, 없으면 자동 생성
   *   data.invoiceDate, dueDate
   *   data.items[]          — {sku?, name, qty, price}
   *   data.subtotal, tax, shipping, total, currency, docType
   *   data.status?          — 기본 'SENT' (이미 보낸 인보이스)
   *   data.originalFile     — { buffer, mimeType, filename } (선택)
   *   data.notes
   */
  async saveManualInvoice(data) {
    await this._ensureSheets();
    const docType = String(data.docType || 'INVOICE').toUpperCase();
    const isQuote = docType === 'QUOTE';

    // 1. 구매자 매칭 (buyerId 우선, 없으면 buyerName 으로 fuzzy match)
    let buyer = null;
    let buyerId = data.buyerId || '';
    const buyerName = String(data.buyerName || '').trim();
    if (buyerId || buyerName) {
      const buyers = await this.getBuyers();
      if (buyerId) buyer = buyers.find(b => b.BuyerID === buyerId);
      if (!buyer && buyerName) {
        const lc = buyerName.toLowerCase();
        buyer = buyers.find(b => (b.Name || '').toLowerCase() === lc)
             || buyers.find(b => (b.Name || '').toLowerCase().includes(lc));
      }
      if (buyer) buyerId = buyer.BuyerID;
    }
    if (!buyerId) throw new Error('구매자를 선택하거나 이름을 입력하세요');

    // 2. 인보이스 번호 — 제공된 거 있으면 그대로, 없으면 자동
    const today = new Date();
    const invoiceDate = data.invoiceDate || today.toISOString().split('T')[0];
    const dueDate = data.dueDate || invoiceDate;
    let invoiceNo = String(data.invoiceNo || '').trim();
    if (!invoiceNo) {
      invoiceNo = await this._getNextInvoiceNo(docType);
    }

    // 3. items 정규화 + 금액 재계산
    const items = (data.items || []).map(it => ({
      sku: String(it.sku || '').trim(),
      name: String(it.name || '').trim(),
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
      total: Number(it.total) || (Number(it.qty) || 0) * (Number(it.price) || 0),
    })).filter(it => it.name || it.sku);
    const subtotal = items.reduce((s, i) => s + i.total, 0) || Number(data.subtotal) || 0;
    const tax = Number(data.tax) || 0;
    const shipping = Number(data.shipping) || 0;
    const total = Number(data.total) || (subtotal + tax + shipping);
    const currency = String(data.currency || buyer?.Currency || 'USD').toUpperCase();
    const status = String(data.status || 'SENT').toUpperCase();

    // 4. 원본 파일 Supabase Storage 업로드 (있으면)
    let originalPath = null;
    let originalMime = null;
    if (data.originalFile?.buffer) {
      const { getClient } = require('../db/supabaseClient');
      const db = getClient();
      const crypto = require('crypto');
      const safeName = (data.originalFile.filename || 'manual').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
      const key = `${invoiceNo}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
      try {
        await db.storage.from('b2b-manual').upload(key, data.originalFile.buffer, {
          contentType: data.originalFile.mimeType || 'application/octet-stream',
          upsert: false,
        });
        originalPath = key;
        originalMime = data.originalFile.mimeType || null;
      } catch (e) {
        console.warn('[saveManualInvoice] 원본 업로드 실패 (버킷 b2b-manual 없음?):', e.message);
      }
    }

    // 5. Sheet 기록 (기존 flow 와 동일 shape — DriveUrl 에 다운로드 API 경로)
    const driveUrl = originalPath ? `/api/b2b/invoices/${invoiceNo}/manual-download` : '';
    const invoiceRow = [
      invoiceNo,
      buyerId,
      buyer?.Name || buyerName,
      invoiceDate,
      dueDate,
      JSON.stringify(items),
      subtotal.toFixed(2),
      tax.toFixed(2),
      shipping.toFixed(2),
      total.toFixed(2),
      currency,
      status,
      '',                // DriveFileId
      driveUrl,
      '',
      '',
    ];
    await this.sheets.appendData(SPREADSHEET_ID, `'${INVOICES_SHEET}'!A:P`, [invoiceRow]);

    // 6. Supabase 기록 (is_manual=true)
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      await repo.createInvoice({
        InvoiceNo: invoiceNo,
        BuyerID: buyerId,
        BuyerName: buyer?.Name || buyerName,
        Date: invoiceDate,
        DueDate: dueDate,
        Items: items,
        Subtotal: subtotal,
        Tax: tax,
        Shipping: shipping,
        Total: total,
        Currency: currency,
        Status: status,
        DocType: docType,
        DriveUrl: driveUrl,
        IsManual: true,
        OriginalFilePath: originalPath,
        OriginalMimeType: originalMime,
      });
    } catch (err) {
      console.warn('[saveManualInvoice] Supabase 동기화 실패:', err.message);
    }

    // 7. 매출 집계 (견적서는 제외, 일반 인보이스는 반영)
    if (!isQuote) {
      await this._updateBuyerStats(buyerId).catch(() => {});
    }

    console.log(`✅ 수기 ${isQuote ? '견적서' : '인보이스'} 등록: ${invoiceNo} → ${buyer?.Name || buyerName} (${currency} ${total.toFixed(2)})`);

    return {
      invoiceNo,
      buyerId,
      buyerName: buyer?.Name || buyerName,
      date: invoiceDate,
      dueDate,
      items,
      subtotal,
      tax,
      shipping,
      total,
      currency,
      status,
      docType,
      isManual: true,
      originalFilePath: originalPath,
      driveUrl,
    };
  }

  /**
   * 기존 인보이스(자동 생성 or 수기)에 외부 파일(PDF/이미지/XLSX) 첨부.
   * Supabase Storage 의 b2b-manual 버킷에 저장, invoice 레코드의 original_file_path 갱신.
   * 기존 첨부가 있으면 교체하고 이전 파일은 삭제.
   */
  async attachFileToInvoice(invoiceNo, file) {
    if (!invoiceNo) throw new Error('invoiceNo 필요');
    if (!file?.buffer) throw new Error('파일이 없습니다');

    const { getClient } = require('../db/supabaseClient');
    const db = getClient();
    const crypto = require('crypto');

    // 기존 invoice 조회 (Sheets 우선 — 소스 of truth)
    const existing = await this.getInvoices({ statusGroup: 'all' });
    const inv = (existing || []).find(i => i.InvoiceNo === invoiceNo);
    if (!inv) throw new Error(`인보이스 ${invoiceNo} 없음`);

    const safeName = (file.filename || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
    const key = `${invoiceNo}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
    const { error: upErr } = await db.storage.from('b2b-manual').upload(key, file.buffer, {
      contentType: file.mimeType || 'application/octet-stream',
      upsert: false,
    });
    if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message} (버킷 b2b-manual 없음?)`);

    // 기존 첨부 삭제
    let prevPath = inv.OriginalFilePath || null;
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      // Supabase 에 record 가 있으면 기존 path 조회 시도
      const all = await repo.getInvoices({ includeVoided: true });
      const dbInv = all.find(i => i.InvoiceNo === invoiceNo);
      if (dbInv?.OriginalFilePath) prevPath = dbInv.OriginalFilePath;
    } catch {}
    if (prevPath && prevPath !== key) {
      try { await db.storage.from('b2b-manual').remove([prevPath]); } catch {}
    }

    // Supabase 레코드 갱신 — 없으면 생성 (Sheets 에만 있는 구형 인보이스 호환)
    try {
      const B2BRepo = require('../db/b2bRepository');
      const repo = new B2BRepo();
      await repo.createInvoice({
        InvoiceNo: invoiceNo,
        BuyerID: inv.BuyerID,
        BuyerName: inv.BuyerName,
        Date: inv.Date,
        DueDate: inv.DueDate,
        Items: inv.Items || inv.ItemsParsed || [],
        Subtotal: inv.Subtotal,
        Tax: inv.Tax,
        Shipping: inv.Shipping,
        Total: inv.Total,
        Currency: inv.Currency,
        Status: inv.Status,
        DocType: inv.DocType,
        IsManual: !!inv.IsManual,
        OriginalFilePath: key,
        OriginalMimeType: file.mimeType || null,
        DriveUrl: inv.DriveUrl || `/api/b2b/invoices/${invoiceNo}/manual-download`,
      });
    } catch (err) {
      console.warn('[attachFileToInvoice] Supabase 업데이트 실패:', err.message);
    }

    return {
      invoiceNo,
      originalFilePath: key,
      originalMimeType: file.mimeType || null,
      filename: safeName,
    };
  }

  /**
   * Excel 인보이스 빌드 — MASTER 템플릿(templates/b2b_invoice_master.xlsx) 로드 후 데이터 주입.
   * CCOREA 로고·서식·폰트·테두리는 템플릿에서 상속. 양식 변경 시 xlsx 파일만 교체하면 됨.
   */
  async _buildInvoiceXlsx({ invoiceNo, invoiceDate, dueDate, buyer, items, subtotal, tax, shipping, total, currency, notes, docType = 'INVOICE', validUntil }) {
    const fs = require('fs');
    const templatePath = path.join(__dirname, '../../templates/b2b_invoice_master.xlsx');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`인보이스 템플릿 파일 없음: ${templatePath}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const ws = workbook.getWorksheet('MASTER');
    if (!ws) throw new Error('MASTER 시트를 템플릿에서 찾을 수 없습니다');

    const isQuote = String(docType).toUpperCase() === 'QUOTE';

    // 날짜 포맷: "2026-04-22" → "Apr.22,2026"
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const formatDate = iso => {
      if (!iso) return '';
      const d = new Date(String(iso) + 'T00:00:00');
      if (isNaN(d)) return iso;
      return `${MONTHS[d.getMonth()]}.${d.getDate()},${d.getFullYear()}`;
    };

    // 0) 문서 타입 — 템플릿의 "INVOICE" 제목을 견적서일 때 교체 (B5:K6 merged)
    if (isQuote) {
      ws.getCell('B5').value = ' QUOTATION';
    }

    // 1) 바이어 정보 (B7~B11) — B컬럼이 5.43 로 좁아서 긴 주소가 올바로 안보임.
    //    B:F 로 확장 merge + wrapText 로 안정적 렌더.
    //    필드 lookup 은 케이스 혼용 방어 (일부 legacy 데이터가 lowercase).
    const pick = (...keys) => {
      for (const k of keys) {
        const v = buyer && buyer[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    const buyerName    = pick('Name', 'name');
    const buyerAddress = pick('Address', 'address');
    const buyerEmail   = pick('Email', 'email');
    const buyerPhone   = pick('Phone', 'phone') || pick('WhatsApp', 'whatsapp');
    const buyerNotes   = pick('Notes', 'notes');

    const emailPhone = [buyerEmail, buyerPhone].filter(Boolean).join(' / ');
    ws.getCell('B7').value = buyerName ? `Messrs. :${buyerName}` : 'Messrs. :';
    ws.getCell('B8').value = buyerAddress;
    ws.getCell('B9').value = emailPhone;
    // VAT/EORI — buyer 스키마에 없어서 Notes에서 추출 (있으면). 없으면 템플릿 샘플 클리어.
    const vatMatch  = buyerNotes.match(/VAT\s*[:\-]?\s*(\S+)/i);
    const eoriMatch = buyerNotes.match(/EORI\s*[:\-]?\s*(\S+)/i);
    ws.getCell('B10').value = vatMatch  ? `VAT: ${vatMatch[1]}`   : '';
    ws.getCell('B11').value = eoriMatch ? `EORI: ${eoriMatch[1]}` : '';

    // B7, B8, B9, B11 을 B:F 로 merge + wrap (B10 은 템플릿상 이미 B:C merge — 건너뜀).
    // horizontal 은 템플릿 원본 그대로 유지 (override 하지 않음 — 기존 왼쪽 정렬 유지).
    for (const r of [7, 8, 9, 11]) {
      const range = `B${r}:F${r}`;
      try { ws.unMergeCells(range); } catch {}
      try { ws.mergeCells(range); } catch {}
      const c = ws.getCell(`B${r}`);
      const prev = c.alignment || {};
      c.alignment = { ...prev, wrapText: true, vertical: prev.vertical || 'middle' };
    }
    // 긴 주소가 잘리지 않도록 B8 행 높이 확장 (최소 28)
    const row8 = ws.getRow(8);
    if (!row8.height || row8.height < 28) row8.height = 28;

    // 2) 인보이스/견적서 번호 (I7:J7 merged)
    ws.getCell('I7').value = invoiceNo;

    // 3) 조건 (E열 = 값, D = ':' , C = 라벨)
    ws.getCell('E15').value = formatDate(invoiceDate);
    ws.getCell('E16').value = 'FOB';
    ws.getCell('E17').value = 'Export Standard Packing';
    if (isQuote) {
      ws.getCell('C18').value = 'Validity';
      ws.getCell('E18').value = validUntil ? formatDate(validUntil) : 'Within 14 days';
    } else {
      // PaymentTerms 가 'Net 30' 처럼 legacy default 면 무시하고 표준 문구 사용
      const pt = (pick('PaymentTerms', 'paymentTerms') || '').trim();
      const looksGeneric = !pt || /^net\s*\d+$/i.test(pt);
      ws.getCell('E18').value = looksGeneric ? '100% T/T in advance' : pt;
    }
    ws.getCell('E19').value = 'Asap after payment';
    ws.getCell('E20').value = 'Republic of Korea';

    // 4) 품목 — 템플릿상 기본 20행(23~42). 실제 품목 수만큼만 채우고
    //    남는 빈 행은 splice 로 삭제해서 shipping/TOTAL 이 마지막 품목 바로 밑에 붙음.
    const ITEM_FIRST_ROW = 23;
    const TEMPLATE_ITEM_LAST_ROW = 42;
    const TEMPLATE_MAX_ITEMS = TEMPLATE_ITEM_LAST_ROW - ITEM_FIRST_ROW + 1; // 20
    const itemList = items || [];
    if (itemList.length > TEMPLATE_MAX_ITEMS) {
      throw new Error(`품목 수 초과 (${itemList.length}개). 템플릿 최대 ${TEMPLATE_MAX_ITEMS}개. 인보이스 분할 필요.`);
    }
    const itemCount = Math.max(1, itemList.length); // 최소 1행 유지 (Shipping/TOTAL 스타일 보존)

    // 1. 품목 데이터 기입 — 1..itemCount 행만
    for (let i = 0; i < itemCount; i++) {
      const row = ITEM_FIRST_ROW + i;
      const it = itemList[i];
      ws.getCell(`B${row}`).value = i + 1; // NO. 자동 번호
      if (it) {
        ws.getCell(`C${row}`).value = it.name || it.sku || '';
        ws.getCell(`G${row}`).value = Number(it.qty) || 0;
        ws.getCell(`I${row}`).value = Number(it.price) || 0;
        const itemTotal = Number(it.total) || (Number(it.qty) || 0) * (Number(it.price) || 0);
        ws.getCell(`J${row}`).value = itemTotal;
      }
    }

    // 2. 남는 빈 행 제거 — shipping/TOTAL 이 위로 올라옴
    const rowsToRemove = TEMPLATE_MAX_ITEMS - itemCount;
    if (rowsToRemove > 0) {
      ws.spliceRows(ITEM_FIRST_ROW + itemCount, rowsToRemove);
    }

    // 이제 shipping / TOTAL 의 실제 행 번호
    const SHIPPING_ROW = ITEM_FIRST_ROW + itemCount;         // 마지막 품목 + 1
    const TOTAL_ROW = SHIPPING_ROW + 1;

    // 3. Shipping 행 NO. 컬럼 (B) 자동 번호 + 금액 주입 ("1 × amount = amount")
    ws.getCell(`B${SHIPPING_ROW}`).value = itemCount + 1;
    const shippingAmount = Number(shipping) || 0;
    if (shippingAmount > 0) {
      ws.getCell(`G${SHIPPING_ROW}`).value = 1;
      ws.getCell(`I${SHIPPING_ROW}`).value = shippingAmount;
      ws.getCell(`J${SHIPPING_ROW}`).value = shippingAmount;
    } else {
      ws.getCell(`G${SHIPPING_ROW}`).value = null;
      ws.getCell(`I${SHIPPING_ROW}`).value = null;
      ws.getCell(`J${SHIPPING_ROW}`).value = null;
    }

    // 4. TOTAL 행 — formula 는 spliceRows 후에도 참조 범위가 자동 갱신되지만
    //    명시적 값으로 세팅해 안전하게.
    ws.getCell(`J${TOTAL_ROW}`).value = Number(total) || 0;
    // 총 수량 G 셀 — 남아있는 formula 가 있을 수 있으므로 합계 직접 주입
    const totalQty = itemList.reduce((s, it) => s + (Number(it?.qty) || 0), 0);
    if (totalQty > 0) ws.getCell(`G${TOTAL_ROW}`).value = totalQty;

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
