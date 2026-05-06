/**
 * 주문 자동수집 → Google Sheets 배송시트 기록 서비스
 * eBay + Shopify 주문을 가져와서 통합 포맷으로 시트에 기록
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const path = require('path');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');
const EbayAPI = require('../api/ebayAPI');
const ShopifyAPI = require('../api/shopifyAPI');
const { getClient: getSupabase } = require('../db/supabaseClient');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = '주문 배송';

// 시트 헤더 (A~T, 20열)
const HEADERS = [
  '주문일자', '플랫폼', '주문번호', 'SKU', '상품명',
  '수량', '결제금액', '통화', '구매자명', '국가',
  '배송사', '운송장번호', '상태',
  // 배송 주소 (N~T) — 캐리어 시트 자동생성에 사용
  'Street', 'City', 'Province', 'ZipCode', 'Phone', 'CountryCode', 'Email',
];

class OrderSync {
  constructor() {
    this.sheets = new GoogleSheetsAPI(
      path.join(__dirname, '../../config/credentials.json')
    );
    this.ebay = new EbayAPI();
    this.shopify = new ShopifyAPI();
  }

  /**
   * 메인: 주문 수집 → 시트 기록
   * @param {number} days - 최근 N일
   * @returns {{ synced: number, newOrders: number, duplicates: number, errors: string[] }}
   */
  async syncOrders(days = 7) {
    const errors = [];

    // 1. 시트 준비
    await this.ensureSheet();

    // 2. 플랫폼별 주문 수집 (병렬) — awaiting shipment / unfulfilled 주문만
    //    days 범위로 최근 주문만 (Shopify는 오래된 unfulfilled 주문이 1000건+ 쌓여있을 수 있음)
    const [ebayOrders, shopifyOrders] = await Promise.all([
      this.fetchEbayOrders().catch(err => {
        errors.push(`eBay: ${err.message}`);
        return [];
      }),
      this.fetchShopifyOrders(days).catch(err => {
        errors.push(`Shopify: ${err.message}`);
        return [];
      }),
    ]);

    const allOrders = [...ebayOrders, ...shopifyOrders];
    console.log(`주문 수집 완료: eBay ${ebayOrders.length}건, Shopify ${shopifyOrders.length}건`);

    if (allOrders.length === 0) {
      return { synced: 0, newOrders: 0, duplicates: 0, errors };
    }

    // 3-A. Supabase upsert: awaiting-shipment(NEW) orders always update, others insert-only
    let supabaseUpserted = 0;
    let shippedCount = 0;
    try {
      const db = getSupabase();
      const allOrderNos = allOrders.map(o => o.orderId);

      // Find which order_nos are already in DB and still status='NEW' (not shipped)
      const { data: existingNew } = await db.from('orders')
        .select('order_no')
        .in('order_no', allOrderNos)
        .in('status', ['NEW', 'new']);
      const awaitingSet = new Set((existingNew || []).map(r => r.order_no));

      const supabaseRows = allOrders.map(o => ({
        order_date: o.orderDate || null,
        platform: o.platform || '',
        order_no: o.orderId || '',
        sku: o.sku || '',
        title: o.title || '',
        quantity: parseInt(o.quantity) || 1,
        payment_amount: parseFloat(o.amount) || 0,
        currency: o.currency || 'USD',
        buyer_name: o.buyerName || '',
        country: o.country || '',
        carrier: '',
        tracking_no: '',
        status: 'NEW',
        street: o.street || '',
        city: o.city || '',
        province: o.province || '',
        zip_code: o.zipCode || '',
        phone: o.phone || '',
        country_code: o.countryCode || '',
        email: o.email || '',
      }));

      // Awaiting-shipment orders: upsert (refresh data from eBay, preserve carrier/status via separate update)
      const awaitingRows = supabaseRows.filter(r => awaitingSet.has(r.order_no));
      const newRows = supabaseRows.filter(r => !awaitingSet.has(r.order_no));

      if (awaitingRows.length > 0) {
        // 데이터 필드만 갱신 (carrier/tracking/status 보존). PostgreSQL 의 ON CONFLICT 가
        // 모든 컬럼을 덮어쓰기 때문에 여기선 carrier/tracking/status 만 fetched 값 그대로
        // 유지하기 위해 추가 select.
        // → 100~200건 짜리 sync 가 200번 update 호출 → quota 초과의 주범. 한 번의 upsert 로.
        const { data: preserved } = await db.from('orders')
          .select('order_no, carrier, tracking_no, status')
          .in('order_no', awaitingRows.map(r => r.order_no));
        const preserveMap = new Map((preserved || []).map(r => [r.order_no, r]));
        const upsertRows = awaitingRows.map(r => ({
          ...r,
          carrier: preserveMap.get(r.order_no)?.carrier ?? r.carrier,
          tracking_no: preserveMap.get(r.order_no)?.tracking_no ?? r.tracking_no,
          status: preserveMap.get(r.order_no)?.status ?? r.status,
        }));
        await db.from('orders').upsert(upsertRows, { onConflict: 'order_no' });
        supabaseUpserted += awaitingRows.length;
      }

      if (newRows.length > 0) {
        // Insert new, skip existing (ignoreDuplicates preserves manually-set carrier/status)
        await db.from('orders').upsert(newRows, { onConflict: 'order_no', ignoreDuplicates: true });
        supabaseUpserted += newRows.length;
      }

      // Mark orders no longer in awaiting shipment as SHIPPED
      const currentAwaitingOrderNos = new Set(allOrderNos);
      const { data: dbNewOrders } = await db.from('orders')
        .select('order_no')
        .in('status', ['NEW', 'READY'])
        .eq('platform', 'eBay');
      shippedCount = 0;
      if (dbNewOrders) {
        const toShip = dbNewOrders.filter(o => !currentAwaitingOrderNos.has(o.order_no));
        if (toShip.length > 0) {
          const shipNos = toShip.map(o => o.order_no);
          await db.from('orders').update({ status: 'SHIPPED' }).in('order_no', shipNos);
          shippedCount = toShip.length;
          console.log(`📦 ${shippedCount}건 주문 SHIPPED 처리 (eBay awaiting shipment에서 사라짐)`);
        }
      }
    } catch (dbErr) {
      console.error('⚠️ Supabase order upsert 실패 (시트 저장은 계속):', dbErr.message);
      errors.push(`Supabase: ${dbErr.message}`);
    }

    // 3-B. Google Sheets 중복 체크 + shipped 자동 제거
    //   - 시트의 OrderNo 가 현재 eBay awaiting set 에 없으면 → shipped 됨 → 시트 row 비움
    //   - 시트에 이미 있는 awaiting 주문 → 중복으로 분류 (skip)
    const existingMap = await this.getExistingOrderRows(); // { orderNo: rowIndex (1-based) }
    const currentAwaitingSet = new Set(allOrders.map(o => o.orderId));
    const shippedRowsToClear = [];
    for (const [orderNo, rowIdx] of existingMap.entries()) {
      // 시트에 있는데 eBay awaiting 응답에 없음 = shipped 또는 cancelled
      if (!currentAwaitingSet.has(orderNo)) {
        shippedRowsToClear.push(`${SHEET_NAME}!A${rowIdx}:T${rowIdx}`);
      }
    }
    let sheetShippedRemoved = 0;
    if (shippedRowsToClear.length > 0) {
      try {
        // Sheets API batchClear 한 번으로 처리 — quota 절약
        await this.sheets.batchClearData(SPREADSHEET_ID, shippedRowsToClear);
        sheetShippedRemoved = shippedRowsToClear.length;
        console.log(`📦 ${sheetShippedRemoved}개 발송완료 row 시트에서 비움`);
      } catch (e) {
        console.warn('⚠️ shipped row 정리 실패 (시트 그대로 남음):', e.message);
      }
    }

    const existingIds = new Set(existingMap.keys());
    const newOrders = allOrders.filter(o => {
      // 시트에서 방금 비운 row 의 orderNo 는 existingIds 에 그대로 있으니 따로 걸러야 함
      if (shippedRowsToClear.length > 0 && !currentAwaitingSet.has(o.orderId)) {
        // 안전장치 — 사실 도달 불가 (currentAwaitingSet 에 모두 있음)
        return true;
      }
      if (existingIds.has(o.orderId)) {
        // 이미 시트에 있고 awaiting 그대로 → 중복 (skip)
        return false;
      }
      if (o._legacyId && existingIds.has(o._legacyId)) return false;
      return true;
    });
    const duplicates = allOrders.length - newOrders.length;

    if (newOrders.length === 0) {
      // B2B 거래처 자동 매칭 (기존 주문 중 미매칭 것만 스캔)
      try {
        const matcher = require('./b2bBuyerMatcher');
        await matcher.matchRecent();
      } catch (e) { console.warn('[orderSync] b2b match fail:', e.message); }
      return { synced: allOrders.length, newOrders: 0, duplicates, supabaseUpserted, shipped: shippedCount || 0, errors };
    }

    // 4. 날짜순 정렬 (최신이 아래로)
    newOrders.sort((a, b) => new Date(a.orderDate) - new Date(b.orderDate));

    // 5. 시트에 추가 (A~T, 20열)
    const rows = newOrders.map(o => [
      o.orderDate,
      o.platform,
      o.orderId,
      o.sku,
      o.title,
      o.quantity,
      o.amount,
      o.currency,
      o.buyerName,
      o.country,
      '', // 배송사 (수동 선택)
      '', // 운송장번호
      'NEW',
      // 배송 주소
      o.street || '',
      o.city || '',
      o.province || '',
      o.zipCode || '',
      o.phone || '',
      o.countryCode || '',
      o.email || '',
    ]);

    // 기존 데이터 행 수 기록 (EU 자동 배정 시 행 번호 계산용)
    const existingRowCount = (await this.getExistingRowCount());

    await this.sheets.appendData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`, rows);
    console.log(`✅ 새 주문 ${newOrders.length}건 시트에 추가`);

    // 5-1. EU 주문 → 윤익스프레스 자동 배정
    // ⚠️ Quota 주의: 이전엔 EU row 마다 writeData() 1회 호출 (200건 = 200 writes/min → quota 초과).
    //   지금은 모든 EU row 의 K:M update 를 batchWriteData() 한 번으로 처리.
    let euAssigned = 0;
    try {
      const CarrierSheets = require('./carrierSheets');
      const EU_COUNTRIES = CarrierSheets.EU_COUNTRIES;
      const euOrders = newOrders.filter(o => EU_COUNTRIES.has((o.countryCode || '').toUpperCase()));

      if (euOrders.length > 0) {
        const cs = new CarrierSheets();
        const yunikSpreadsheetId = '1UZD25uxEUREhhwdw8fpg3w1e9q1LHJF8zw1xNhyPQfI';

        // 탭 1번만 생성하여 재사용
        const sheetTab = await cs.getOrCreateYunikTab(yunikSpreadsheetId);

        // 모든 EU row 의 K:M update 를 한 번에 batch
        const euUpdates = [];
        const euOrdersInOrder = []; // 윤 시트에 추가할 순서 보존
        for (let i = 0; i < newOrders.length; i++) {
          const o = newOrders[i];
          const cc = (o.countryCode || '').toUpperCase();
          if (!EU_COUNTRIES.has(cc)) continue;
          const rowIndex = existingRowCount + 1 + 1 + i; // 1-based
          euUpdates.push({
            range: `${SHEET_NAME}!K${rowIndex}:M${rowIndex}`,
            values: [['윤익스프레스', '', 'READY']],
          });
          euOrdersInOrder.push(o);
        }
        if (euUpdates.length > 0) {
          await this.sheets.batchWriteData(SPREADSHEET_ID, euUpdates);
        }

        // 윤익스프레스 캐리어 시트에 모든 EU 주문 한 번에 append (CarrierSheets 가 batch 지원하면 활용)
        if (typeof cs.addManyToCarrierSheet === 'function' && euOrdersInOrder.length > 0) {
          await cs.addManyToCarrierSheet('윤익스프레스', euOrdersInOrder, { sheetTab });
        } else {
          // fallback: 개별 호출 (carrierSheets 가 아직 batch 안 지원)
          for (const o of euOrdersInOrder) {
            await cs.addToCarrierSheet('윤익스프레스', o, { sheetTab });
          }
        }
        euAssigned = euOrdersInOrder.length;
        console.log(`✅ EU 주문 ${euAssigned}건 윤익스프레스 자동 배정 (batch)`);
      }
    } catch (euErr) {
      console.error(`⚠️ EU 자동 배정 중 에러 (주문 동기화는 완료):`, euErr.message);
      errors.push(`EU 자동 배정: ${euErr.message}`);
    }

    // B2B 거래처 자동 매칭 (새 주문 insert 이후 실행)
    let b2bMatched = 0;
    try {
      const matcher = require('./b2bBuyerMatcher');
      const r = await matcher.matchRecent();
      b2bMatched = r.matched || 0;
      if (b2bMatched > 0) console.log(`[orderSync] B2B 자동 매칭: ${b2bMatched}건`);
    } catch (e) {
      console.warn('[orderSync] b2b match fail:', e.message);
    }

    return {
      synced: allOrders.length,
      newOrders: newOrders.length,
      duplicates,
      supabaseUpserted,
      shipped: shippedCount || 0,
      euAssigned,
      b2bMatched,
      errors,
    };
  }

  /**
   * eBay 주문 가져오기 — AwaitingShipment(결제완료+미배송) 주문만 수집
   * 날짜 기반 조회(getSellerTransactions)를 제거하고 배송 대기 주문만 가져옴
   */
  async fetchEbayOrders() {
    const awaitingOrders = await this.ebay.getAwaitingShipmentOrders();

    const seen = new Set();
    const result = [];

    for (const o of awaitingOrders) {
      if (!o.ebayOrderId || seen.has(o.ebayOrderId)) continue;
      seen.add(o.ebayOrderId);
      result.push({
        orderDate: o.createdDate ? o.createdDate.split('T')[0] : '',
        platform: 'eBay',
        orderId: o.ebayOrderId,
        sku: o.sku || '',
        title: o.title || '',
        quantity: o.quantity || 1,
        amount: o.price || 0,
        currency: 'USD',
        buyerName: o.shippingName || o.buyerUserId || '',
        country: o.shippingCountry || '',
        street: o.shippingStreet || '',
        city: o.shippingCity || '',
        province: o.shippingState || '',
        zipCode: o.shippingZip || '',
        phone: this.cleanPhone(o.shippingPhone),
        countryCode: o.shippingCountry || '',
        email: o.buyerEmail || '',
      });
    }

    return result;
  }

  /**
   * Shopify 주문 가져오기 — 최근 N일 내 unfulfilled(미배송) 주문만
   * 날짜 필터 없으면 과거 수년치 unfulfilled가 전부 딸려 옴 (Shopify는 수동 close 안 하면 open 유지)
   */
  async fetchShopifyOrders(days = 30) {
    const createdAtMin = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
    const orders = await this.shopify.getOrders({
      fulfillment_status: 'unfulfilled',
      status: 'open',
      created_at_min: createdAtMin,
    });

    const result = [];
    for (const order of orders) {
      if (order.cancelled_at) continue;

      const shipping = order.shipping_address || {};
      const lineItems = order.line_items || [];

      for (const item of lineItems) {
        result.push({
          orderDate: order.created_at ? order.created_at.split('T')[0] : '',
          platform: 'Shopify',
          orderId: `${order.order_number || order.id}-${item.id}`,
          sku: item.sku || '',
          title: item.title || item.name || '',
          quantity: item.quantity || 1,
          amount: parseFloat(item.price) || 0,
          currency: order.currency || 'USD',
          buyerName: shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
          country: shipping.country_code || shipping.country || '',
          // 배송 주소
          street: [shipping.address1, shipping.address2].filter(Boolean).join(' '),
          city: shipping.city || '',
          province: shipping.province || '',
          zipCode: shipping.zip || '',
          phone: shipping.phone || '',
          countryCode: shipping.country_code || '',
          email: order.email || '',
        });
      }
    }

    return result;
  }

  /**
   * "주문 배송" 시트가 없으면 생성 + 헤더 기록
   */
  async ensureSheet() {
    try {
      await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A1:A1`);
    } catch (err) {
      if (err.message.includes('Unable to parse range') || err.message.includes('not found')) {
        console.log(`시트 '${SHEET_NAME}' 생성 중...`);
        await this.sheets.createSheet(SPREADSHEET_ID, SHEET_NAME);
        await this.sheets.writeData(SPREADSHEET_ID, `${SHEET_NAME}!A1:T1`, [HEADERS]);
        console.log(`✅ 시트 '${SHEET_NAME}' 생성 + 헤더 기록 완료`);
      } else {
        throw err;
      }
    }
  }

  /**
   * 전화번호 정리: +제거, 비정상 값(Invalid Request 등) 필터링
   */
  cleanPhone(raw) {
    const phone = (raw || '').replace(/^\+/, '').trim();
    if (!phone || /invalid|request|error/i.test(phone)) return '';
    return phone;
  }

  /**
   * 기존 데이터 행 수 반환 (헤더 제외)
   */
  async getExistingRowCount() {
    try {
      const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:A`);
      return rows ? Math.max(0, rows.length - 1) : 0; // 헤더 제외
    } catch {
      return 0;
    }
  }

  /**
   * 기존 시트에서 주문번호(C열) 읽어서 Set으로 반환 (중복 방지)
   */
  async getExistingOrderIds() {
    const ids = new Set();
    try {
      const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!C:C`);
      for (const row of rows) {
        if (row[0] && row[0] !== '주문번호') {
          ids.add(row[0]);
        }
      }
    } catch {
      // 시트가 비어있거나 에러 → 빈 Set
    }
    return ids;
  }

  /**
   * 시트의 OrderNo (C열) → 1-based row index 매핑.
   * shipped 자동 제거 (해당 row 비우기) 시 어떤 row 를 clear 할지 알아야 함.
   */
  async getExistingOrderRows() {
    const map = new Map();
    try {
      const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!C:C`);
      for (let i = 0; i < (rows || []).length; i++) {
        const cell = rows[i][0];
        if (cell && cell !== '주문번호') {
          map.set(cell, i + 1); // 1-based row number
        }
      }
    } catch { /* empty */ }
    return map;
  }

  /**
   * C열에서 주문번호로 시트 행 번호 찾기 (1-based)
   */
  async findOrderRow(orderNo) {
    const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!C:C`);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i][0] === orderNo) return i + 1; // 1-based
    }
    console.warn(`⚠️ findOrderRow: 주문번호 "${orderNo}" 시트에서 찾지 못함`);
    return null;
  }

  /**
   * 시트에서 최근 주문 N건 읽기 (배송 주소 포함)
   */
  async getRecentOrders(limit = 50) {
    try {
      const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`);
      if (!rows || rows.length <= 1) return { headers: HEADERS, orders: [] };

      const headers = rows[0];
      const dataRows = rows.slice(1);

      const startIdx = Math.max(0, dataRows.length - limit);
      const recent = [];
      for (let i = dataRows.length - 1; i >= startIdx; i--) {
        const obj = { _rowIndex: i + 2 };
        headers.forEach((h, j) => obj[h] = dataRows[i][j] || '');
        // 주소 필드가 헤더에 없는 경우 (이전 데이터 호환)
        if (!obj.Street && dataRows[i][13]) obj.Street = dataRows[i][13];
        if (!obj.City && dataRows[i][14]) obj.City = dataRows[i][14];
        if (!obj.Province && dataRows[i][15]) obj.Province = dataRows[i][15];
        if (!obj.ZipCode && dataRows[i][16]) obj.ZipCode = dataRows[i][16];
        if (!obj.Phone && dataRows[i][17]) obj.Phone = dataRows[i][17];
        if (!obj.CountryCode && dataRows[i][18]) obj.CountryCode = dataRows[i][18];
        if (!obj.Email && dataRows[i][19]) obj.Email = dataRows[i][19];
        recent.push(obj);
      }

      return {
        headers,
        orders: recent,
        total: dataRows.length,
      };
    } catch {
      return { headers: HEADERS, orders: [], total: 0 };
    }
  }

  /**
   * 특정 주문의 배송사 설정 (K열) + 상태를 READY로 변경 (M열)
   * @param {number} rowIndex - 시트 행 번호 (1-based)
   * @param {string} carrier - 배송사명
   */
  async setCarrier(rowIndex, carrier) {
    await this.sheets.writeData(
      SPREADSHEET_ID,
      `${SHEET_NAME}!K${rowIndex}:M${rowIndex}`,
      [[carrier, '', 'READY']]
    );
    console.log(`✅ 행 ${rowIndex}: 배송사 "${carrier}" 설정`);
  }

  /**
   * 특정 주문 행의 전체 데이터 읽기 (캐리어 시트 생성용)
   * @param {number} rowIndex - 시트 행 번호 (1-based)
   */
  async getOrderRow(rowIndex) {
    const rows = await this.sheets.readData(
      SPREADSHEET_ID,
      `${SHEET_NAME}!A${rowIndex}:T${rowIndex}`
    );
    if (!rows || rows.length === 0) {
      console.warn(`⚠️ getOrderRow(${rowIndex}): 행 데이터 없음`);
      return null;
    }

    // Google Sheets API는 빈 후행 셀을 생략하므로 20열로 패딩
    const row = rows[0];
    while (row.length < 20) row.push('');

    // #ERROR! 등 시트 에러 값 정리
    const clean = (v) => (v && !String(v).startsWith('#')) ? v : '';

    const order = {
      orderDate: row[0] || '',
      platform: row[1] || '',
      orderId: row[2] || '',
      sku: row[3] || '',
      title: row[4] || '',
      quantity: row[5] || 1,
      amount: row[6] || 0,
      currency: row[7] || '',
      buyerName: row[8] || '',
      country: row[9] || '',
      carrier: row[10] || '',
      trackingNo: row[11] || '',
      status: row[12] || '',
      street: clean(row[13]),
      city: clean(row[14]),
      province: clean(row[15]),
      zipCode: clean(row[16]),
      phone: clean(row[17]),
      countryCode: clean(row[18]),
      email: clean(row[19]),
    };

    // 주소 데이터 유무 로그
    const hasAddr = order.street || order.city || order.countryCode;
    if (!hasAddr) {
      console.warn(`⚠️ getOrderRow(${rowIndex}): 주소 데이터 없음 (주문: ${order.orderId})`);
    }
    console.log(`📦 getOrderRow(${rowIndex}): ${order.orderId} | ${order.buyerName} | ${order.countryCode} | ${order.city}`);

    return order;
  }

  /**
   * 주소 누락된 eBay 주문에 대해 주소 백필
   * (주소 컬럼 추가 이전에 동기화된 주문 복구용)
   */
  async backfillAddresses() {
    // 1. 시트에서 전체 데이터 읽기
    const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`);
    if (!rows || rows.length <= 1) return { updated: 0, skipped: 0 };

    // 2. 주소 없는 eBay 주문 행 찾기
    const missingRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < 20) row.push('');
      const platform = row[1] || '';
      const orderId = row[2] || '';
      const street = row[13] || '';
      const city = row[14] || '';
      const countryCode = row[18] || '';

      if (platform === 'eBay' && orderId && !street && !city && !countryCode) {
        missingRows.push({ rowIndex: i + 1, orderId }); // 1-based
      }
    }

    if (missingRows.length === 0) {
      console.log('주소 누락된 eBay 주문 없음');
      return { updated: 0, skipped: 0 };
    }

    console.log(`주소 누락 eBay 주문 ${missingRows.length}건 발견, API에서 주소 가져오는 중...`);

    // 3. eBay API에서 최근 30일 트랜잭션 가져오기
    const transactions = await this.ebay.getSellerTransactions(30);
    if (transactions._apiError) {
      console.error('eBay API 에러:', transactions._apiError);
      return { updated: 0, skipped: missingRows.length, error: transactions._apiError };
    }

    // orderId → address 매핑 (orderId = itemId-transactionId)
    const addrMap = new Map();
    for (const txn of transactions) {
      const id = `${txn.itemId}-${txn.transactionId}`;
      if (txn.shippingStreet || txn.shippingCity || txn.shippingCountry) {
        addrMap.set(id, txn);
      }
    }

    // 4. 주소 업데이트
    let updated = 0;
    let skipped = 0;
    for (const { rowIndex, orderId } of missingRows) {
      const txn = addrMap.get(orderId);
      if (!txn) {
        skipped++;
        continue;
      }

      const addrRow = [
        [txn.shippingStreet || ''].join(''),    // N: Street
        txn.shippingCity || '',                   // O: City
        txn.shippingState || '',                  // P: Province
        txn.shippingZip || '',                    // Q: ZipCode
        this.cleanPhone(txn.shippingPhone),      // R: Phone
        txn.shippingCountry || '',                // S: CountryCode
        txn.buyerEmail || '',                     // T: Email
      ];

      await this.sheets.writeData(
        SPREADSHEET_ID,
        `${SHEET_NAME}!N${rowIndex}:T${rowIndex}`,
        [addrRow]
      );

      // buyerName도 업데이트 (username → 실제 이름)
      if (txn.shippingName) {
        await this.sheets.writeData(
          SPREADSHEET_ID,
          `${SHEET_NAME}!I${rowIndex}`,
          [[txn.shippingName]]
        );
      }

      // 국가(J열)도 업데이트
      if (txn.shippingCountry) {
        await this.sheets.writeData(
          SPREADSHEET_ID,
          `${SHEET_NAME}!J${rowIndex}`,
          [[txn.shippingCountry]]
        );
      }

      updated++;
      console.log(`✅ 행 ${rowIndex}: ${orderId} → ${txn.shippingName} (${txn.shippingCountry})`);
    }

    console.log(`백필 완료: ${updated}건 업데이트, ${skipped}건 스킵`);
    return { updated, skipped, total: missingRows.length };
  }

  /**
   * 기존 eBay 주문번호를 실제 eBay OrderID로 마이그레이션
   * (itemId-transactionId → 19-XXXXX-XXXXX)
   */
  async backfillOrderIds() {
    // 1. 시트에서 전체 데이터 읽기
    const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`);
    if (!rows || rows.length <= 1) return { updated: 0, skipped: 0 };

    // 2. old format eBay 주문 찾기 (숫자-숫자 형식, XX-XXXXX-XXXXX가 아닌 것)
    const oldFormatRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < 20) row.push('');
      const platform = row[1] || '';
      const orderId = row[2] || '';

      // eBay이고, old format (숫자-숫자, 하이픈이 1개)인 경우
      if (platform === 'eBay' && orderId && /^\d+-\d+$/.test(orderId)) {
        oldFormatRows.push({ rowIndex: i + 1, orderId });
      }
    }

    if (oldFormatRows.length === 0) {
      console.log('마이그레이션 필요한 eBay 주문 없음');
      return { updated: 0, skipped: 0 };
    }

    console.log(`old format eBay 주문 ${oldFormatRows.length}건 발견, API에서 실제 주문번호 가져오는 중...`);

    // 3. eBay API에서 최근 30일 트랜잭션 가져오기
    const transactions = await this.ebay.getSellerTransactions(30);
    if (transactions._apiError) {
      console.error('eBay API 에러:', transactions._apiError);
      return { updated: 0, skipped: oldFormatRows.length, error: transactions._apiError };
    }

    // itemId-transactionId → ebayOrderId 매핑
    const idMap = new Map();
    for (const txn of transactions) {
      const legacyId = `${txn.itemId}-${txn.transactionId}`;
      if (txn.ebayOrderId) {
        idMap.set(legacyId, txn.ebayOrderId);
      }
    }

    // 4. 배치 업데이트 준비
    const batchData = [];
    let skipped = 0;
    for (const { rowIndex, orderId } of oldFormatRows) {
      const newId = idMap.get(orderId);
      if (!newId) {
        skipped++;
        continue;
      }
      batchData.push({
        range: `${SHEET_NAME}!C${rowIndex}`,
        values: [[newId]],
      });
      console.log(`📝 행 ${rowIndex}: ${orderId} → ${newId}`);
    }

    if (batchData.length > 0) {
      await this.sheets.batchWriteData(SPREADSHEET_ID, batchData);
    }

    const updated = batchData.length;
    console.log(`주문번호 마이그레이션 완료: ${updated}건 업데이트, ${skipped}건 스킵`);
    return { updated, skipped, total: oldFormatRows.length };
  }

  /**
   * eBay 구매자명이 user ID인 주문의 실제 이름 복구
   * (shippingName이 비어서 buyerUserId가 들어간 주문 수정)
   */
  async backfillBuyerNames() {
    const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`);
    if (!rows || rows.length <= 1) return { updated: 0, skipped: 0 };

    // ID 같은 이름 찾기: 공백 없고, ASCII만, 3자 이상
    const idRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < 20) row.push('');
      const platform = row[1] || '';
      const orderId = row[2] || '';
      const buyerName = row[8] || '';

      if (platform === 'eBay' && orderId && buyerName.length > 2
          && !buyerName.includes(' ') && /^[\x00-\x7F]+$/.test(buyerName)) {
        idRows.push({ rowIndex: i + 1, orderId, currentName: buyerName });
      }
    }

    if (idRows.length === 0) {
      console.log('ID 형식 구매자명 없음');
      return { updated: 0, skipped: 0 };
    }

    console.log(`ID 형식 구매자명 ${idRows.length}건 발견, eBay API에서 실제 이름 가져오는 중...`);

    const transactions = await this.ebay.getSellerTransactions(30);
    if (transactions._apiError) {
      return { updated: 0, skipped: idRows.length, error: transactions._apiError };
    }

    // ebayOrderId → shippingName, legacyId → shippingName 매핑
    const nameMap = new Map();
    for (const txn of transactions) {
      if (txn.shippingName && txn.shippingName.includes(' ')) {
        if (txn.ebayOrderId) nameMap.set(txn.ebayOrderId, txn.shippingName);
        nameMap.set(`${txn.itemId}-${txn.transactionId}`, txn.shippingName);
      }
    }

    const batchData = [];
    let skipped = 0;
    for (const { rowIndex, orderId, currentName } of idRows) {
      const realName = nameMap.get(orderId);
      if (!realName) { skipped++; continue; }
      batchData.push({ range: `${SHEET_NAME}!I${rowIndex}`, values: [[realName]] });
      console.log(`📝 행 ${rowIndex}: ${currentName} → ${realName}`);
    }

    if (batchData.length > 0) {
      await this.sheets.batchWriteData(SPREADSHEET_ID, batchData);
    }

    console.log(`구매자명 수정 완료: ${batchData.length}건 업데이트, ${skipped}건 스킵`);
    return { updated: batchData.length, skipped, total: idRows.length };
  }

  /**
   * 시트의 #ERROR! 전화번호를 eBay API에서 가져온 정상 값으로 교체
   */
  async fixPhoneErrors() {
    const rows = await this.sheets.readData(SPREADSHEET_ID, `${SHEET_NAME}!A:T`);
    if (!rows || rows.length <= 1) return { updated: 0, skipped: 0 };

    // #ERROR! 전화번호가 있는 eBay 행 찾기
    const errorRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < 20) row.push('');
      const platform = row[1] || '';
      const orderId = row[2] || '';
      const phone = row[17] || '';

      const isBadPhone = String(phone).startsWith('#') || /invalid|request|error/i.test(phone);
      if (platform === 'eBay' && orderId && isBadPhone) {
        errorRows.push({ rowIndex: i + 1, orderId });
      }
    }

    if (errorRows.length === 0) return { updated: 0, skipped: 0 };

    console.log(`#ERROR! 전화번호 ${errorRows.length}건 발견, eBay API에서 수정 중...`);

    const transactions = await this.ebay.getSellerTransactions(30);
    if (transactions._apiError) {
      return { updated: 0, skipped: errorRows.length, error: transactions._apiError };
    }

    // ebayOrderId → phone 매핑 + legacyId → phone 매핑
    const phoneMap = new Map();
    for (const txn of transactions) {
      const phone = this.cleanPhone(txn.shippingPhone);
      if (phone) {
        if (txn.ebayOrderId) phoneMap.set(txn.ebayOrderId, phone);
        phoneMap.set(`${txn.itemId}-${txn.transactionId}`, phone);
      }
    }

    const batchData = [];
    let skipped = 0;
    for (const { rowIndex, orderId } of errorRows) {
      const phone = phoneMap.get(orderId) || '';  // 못 찾으면 빈칸으로라도 덮어쓰기
      batchData.push({ range: `${SHEET_NAME}!R${rowIndex}`, values: [[phone]] });
      if (!phone) skipped++;
    }

    if (batchData.length > 0) {
      await this.sheets.batchWriteData(SPREADSHEET_ID, batchData);
    }

    console.log(`전화번호 수정 완료: ${batchData.length}건 업데이트, ${skipped}건 스킵`);
    return { updated: batchData.length, skipped, total: errorRows.length };
  }
}

module.exports = OrderSync;
