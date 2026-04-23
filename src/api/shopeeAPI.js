require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');
const crypto = require('crypto');

function _isInvalidToken(result) {
  const err = result?.error;
  return err === 'invalid_access_token' || err === 'invalid_acceess_token';
}

// Shop·merchant 재인증 없이는 절대 회복 불가능한 에러 — dead 플래그로 격리해 반복 호출 차단.
// (Shopee 보안 시스템이 반복 실패를 abnormal behavior 로 플래그)
function _isPermanentShopeeError(body) {
  if (!body) return false;
  const err = String(body.error || '');
  const msg = String(body.message || '');
  if (err === 'refresh_token_expired' || err === 'refresh_token_not_exist') return true;
  if (err === 'error_auth' || err === 'error_shop_auth' || err === 'invalid_partner_shop') return true;
  if (/refresh_token.*expire/i.test(msg)) return true;
  if (/no\s+linked/i.test(msg)) return true;                // "Partner and shop has no linked"
  if (/shop.*not.*found|invalid.*shop_id/i.test(msg)) return true;
  return false;
}

/**
 * Shopee Open Platform API 클래스 (CB 셀러용)
 * Shopee Partner API를 사용하여 동남아 시장 상품 관리
 * CB(Cross-Border) 셀러는 merchant_id + global_product API 사용
 */
class ShopeeAPI {
  constructor() {
    this.partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    this.partnerKey = process.env.SHOPEE_PARTNER_KEY;
    this.merchantId = parseInt(process.env.SHOPEE_MERCHANT_ID);

    // Merchant-level token (정보 API)
    this.accessToken = process.env.SHOPEE_ACCESS_TOKEN;
    this.refreshToken = process.env.SHOPEE_REFRESH_TOKEN;

    // Shop-level token (상품/주문 API)
    this.shopAccessToken = process.env.SHOPEE_SHOP_ACCESS_TOKEN || process.env.SHOPEE_ACCESS_TOKEN;
    this.shopRefreshToken = process.env.SHOPEE_SHOP_REFRESH_TOKEN || process.env.SHOPEE_REFRESH_TOKEN;
    this.shopIds = (process.env.SHOPEE_SHOP_IDS || '')
      .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

    // Per-shop tokens: SHOPEE_SHOP_{shopId}_ACCESS_TOKEN
    this.shopTokens = {};
    for (const shopId of this.shopIds) {
      const at = process.env[`SHOPEE_SHOP_${shopId}_ACCESS_TOKEN`];
      const rt = process.env[`SHOPEE_SHOP_${shopId}_REFRESH_TOKEN`];
      if (at) this.shopTokens[shopId] = { accessToken: at, refreshToken: rt };
    }
    // Fallback: if no per-shop tokens, use global shop token for first shop
    if (Object.keys(this.shopTokens).length === 0 && this.shopAccessToken && this.shopIds[0]) {
      this.shopTokens[this.shopIds[0]] = {
        accessToken: this.shopAccessToken,
        refreshToken: this.shopRefreshToken,
      };
    }

    this.baseUrl = process.env.SHOPEE_ENV === 'test'
      ? 'https://openplatform.sandbox.test-stable.shopee.sg'
      : 'https://partner.shopeemobile.com';
  }

  _signMerchant(path, timestamp) {
    return crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${timestamp}${this.accessToken}${this.merchantId}`)
      .digest('hex');
  }

  _signShop(path, timestamp, shopId) {
    return crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${timestamp}${this.shopAccessToken}${shopId}`)
      .digest('hex');
  }

  _signPublic(path, timestamp) {
    return crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${timestamp}`)
      .digest('hex');
  }

  // 하위 호환성 유지
  generateSignature(path, timestamp, useShopId = false) {
    return useShopId
      ? this._signShop(path, timestamp, this.shopIds[0])
      : this._signMerchant(path, timestamp);
  }

  async request(method, path, data = null) {
    return this._merchantRequest(method, path, data);
  }

  async shopRequest(method, path, data = null, shopId = null) {
    return this._shopRequest(method, path, data, shopId || this.shopIds[0]);
  }

  async _merchantRequest(method, path, data, _retried = false) {
    await this._ensureLoaded();
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this._signMerchant(path, timestamp);
    const url = `${this.baseUrl}${path}`;
    const params = { partner_id: this.partnerId, timestamp, sign, access_token: this.accessToken, merchant_id: this.merchantId };

    const result = await this._exec(method, url, params, data);
    if (!_retried && _isInvalidToken(result)) {
      await this._refreshTokens();
      return this._merchantRequest(method, path, data, true);
    }
    return result;
  }

  async _shopRequest(method, path, data, shopId, _retried = false) {
    await this._ensureLoaded();
    const token = this.shopTokens[shopId]?.accessToken || this.shopAccessToken;
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${timestamp}${token}${shopId}`)
      .digest('hex');
    const url = `${this.baseUrl}${path}`;
    const params = { partner_id: this.partnerId, timestamp, sign, access_token: token, shop_id: shopId };
    const result = await this._exec(method, url, params, data);
    if (!_retried && _isInvalidToken(result)) {
      await this._refreshTokens();
      return this._shopRequest(method, path, data, shopId, true);
    }
    return result;
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    const { loadToken } = require('../services/tokenStore');
    try {
      const merchant = await loadToken('shopee');
      if (merchant?.accessToken && merchant?.refreshToken) {
        this.accessToken = merchant.accessToken;
        this.refreshToken = merchant.refreshToken;
      }
      this._merchantDeadUntil = merchant?.metadata?.deadUntil || null;
      this._shopDeadUntil = {};
      for (const shopId of this.shopIds) {
        const saved = await loadToken(`shopee_shop_${shopId}`);
        if (saved?.accessToken && saved?.refreshToken) {
          this.shopTokens[shopId] = {
            accessToken: saved.accessToken,
            refreshToken: saved.refreshToken,
          };
        }
        this._shopDeadUntil[shopId] = saved?.metadata?.deadUntil || null;
      }
      const firstShop = this.shopTokens[this.shopIds[0]];
      if (firstShop) {
        this.shopAccessToken = firstShop.accessToken;
        this.shopRefreshToken = firstShop.refreshToken;
      }
    } catch (e) {
      console.warn('Shopee token load from DB failed:', e.message);
    }
  }

  _isDead(deadUntil) {
    if (!deadUntil) return false;
    return new Date(deadUntil).getTime() > Date.now();
  }

  hasUsableTokens() {
    if (!this._merchantDeadUntil && this.accessToken) {
      if (!this._isDead(this._merchantDeadUntil)) return true;
    }
    for (const shopId of this.shopIds) {
      const t = this.shopTokens[shopId];
      if (t?.accessToken && !this._isDead(this._shopDeadUntil?.[shopId])) return true;
    }
    return false;
  }

  async _refreshTokens() {
    await this._ensureLoaded();
    const { saveToken, loadToken } = require('../services/tokenStore');
    const refreshPath = '/api/v2/auth/access_token/get';
    const DEAD_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h cooldown after expired refresh

    const markDead = async (platformKey, existing, reason) => {
      const deadUntil = new Date(Date.now() + DEAD_WINDOW_MS).toISOString();
      try {
        await saveToken(platformKey, {
          accessToken: existing?.accessToken || null,
          refreshToken: existing?.refreshToken || null,
          expiresAt: existing?.expiresAt || null,
          metadata: { deadUntil, reason, markedAt: new Date().toISOString() },
        });
      } catch (e) { console.warn(`[shopee] markDead ${platformKey}:`, e.message); }
      console.warn(`[shopee] ${platformKey} marked dead until ${deadUntil} (${reason}) — Shopee Partner Console 재인증 필요`);
    };

    // Refresh merchant token
    const merchantCurrent = await loadToken('shopee');
    if (merchantCurrent?.metadata?.deadUntil && new Date(merchantCurrent.metadata.deadUntil).getTime() > Date.now()) {
      console.log(`[shopee] merchant refresh skipped (dead until ${merchantCurrent.metadata.deadUntil}) — /api/shopee/oauth-url 로 재인증`);
    } else if (!this.refreshToken) {
      console.warn('[shopee] merchant refresh_token 없음 — skip');
    } else {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = this._signPublic(refreshPath, timestamp);
        const r = await axios.post(`${this.baseUrl}${refreshPath}`, {
          refresh_token: this.refreshToken,
          merchant_id: this.merchantId,
          partner_id: this.partnerId,
        }, { params: { partner_id: this.partnerId, timestamp, sign } });

        if (_isPermanentShopeeError(r.data)) {
          await markDead('shopee', { accessToken: this.accessToken, refreshToken: this.refreshToken }, 'refresh_token_expired');
        } else if (r.data?.error || !r.data?.access_token) {
          console.error('Shopee merchant refresh rejected:', r.data?.error, r.data?.message);
        } else {
          this.accessToken = r.data.access_token;
          this.refreshToken = r.data.refresh_token;
          process.env.SHOPEE_ACCESS_TOKEN = this.accessToken;
          process.env.SHOPEE_REFRESH_TOKEN = this.refreshToken;
          await saveToken('shopee', {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
            metadata: null, // clear dead flag on success
          });
          this._merchantDeadUntil = null;
        }
      } catch (e) {
        const body = e.response?.data;
        if (_isPermanentShopeeError(body)) {
          await markDead('shopee', { accessToken: this.accessToken, refreshToken: this.refreshToken }, body?.error || 'permanent_error');
        } else {
          console.error('Shopee merchant token refresh failed:', body || e.message);
        }
      }
    }

    // Refresh each shop token individually (each shop has independent refresh_token)
    let refreshedCount = 0;
    for (const shopId of this.shopIds) {
      const shopToken = this.shopTokens[shopId];
      if (!shopToken?.refreshToken) continue;

      const key = `shopee_shop_${shopId}`;
      const saved = await loadToken(key);
      if (saved?.metadata?.deadUntil && new Date(saved.metadata.deadUntil).getTime() > Date.now()) {
        console.log(`[shopee] shop ${shopId} refresh skipped (dead until ${saved.metadata.deadUntil})`);
        continue;
      }

      try {
        const ts2 = Math.floor(Date.now() / 1000);
        const sign2 = this._signPublic(refreshPath, ts2);
        const r2 = await axios.post(`${this.baseUrl}${refreshPath}`, {
          refresh_token: shopToken.refreshToken,
          shop_id: shopId,
          partner_id: this.partnerId,
        }, { params: { partner_id: this.partnerId, timestamp: ts2, sign: sign2 } });

        if (_isPermanentShopeeError(r2.data)) {
          await markDead(key, shopToken, r2.data?.error || 'permanent_error');
          this._shopDeadUntil[shopId] = new Date(Date.now() + DEAD_WINDOW_MS).toISOString();
          continue;
        }
        if (r2.data?.error || !r2.data?.access_token) {
          console.error(`Shopee shop ${shopId} refresh rejected:`, r2.data?.error, r2.data?.message);
          continue;
        }

        this.shopTokens[shopId] = { accessToken: r2.data.access_token, refreshToken: r2.data.refresh_token };
        process.env[`SHOPEE_SHOP_${shopId}_ACCESS_TOKEN`] = r2.data.access_token;
        process.env[`SHOPEE_SHOP_${shopId}_REFRESH_TOKEN`] = r2.data.refresh_token;
        await saveToken(key, {
          accessToken: r2.data.access_token,
          refreshToken: r2.data.refresh_token,
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
          metadata: null, // clear dead flag on success
        });
        this._shopDeadUntil[shopId] = null;
        refreshedCount++;
      } catch (e) {
        const body = e.response?.data;
        if (_isPermanentShopeeError(body)) {
          await markDead(key, shopToken, body?.error || 'permanent_error');
          this._shopDeadUntil[shopId] = new Date(Date.now() + DEAD_WINDOW_MS).toISOString();
        } else {
          console.error(`Shopee shop ${shopId} refresh error:`, body?.message || e.message);
        }
      }
    }

    // Update default shop token pointer
    const firstShop = this.shopTokens[this.shopIds[0]];
    if (firstShop) {
      this.shopAccessToken = firstShop.accessToken;
      this.shopRefreshToken = firstShop.refreshToken;
      process.env.SHOPEE_SHOP_ACCESS_TOKEN = firstShop.accessToken;
      process.env.SHOPEE_SHOP_REFRESH_TOKEN = firstShop.refreshToken;
    }
    console.log(`✅ Shopee tokens auto-refreshed (${refreshedCount}/${this.shopIds.length} shops)`);
  }

  async _exec(method, url, params, data) {
    try {
      const config = { method, url, params, timeout: 15000 };
      if (data && method === 'GET') {
        Object.assign(config.params, data);
      } else if (data) {
        config.data = data;
        config.headers = { 'Content-Type': 'application/json' };
      }
      const response = await axios(config);
      return response.data;
    } catch (error) {
      const body = error.response?.data;
      // Shopee returns 4xx with { error: 'invalid_acceess_token' } on expiry.
      // Return the body so the caller can detect it and trigger a refresh+retry.
      if (_isInvalidToken(body)) return body;
      console.error(`Shopee API 오류 [${url}]:`, body || error.message);
      throw error;
    }
  }

  /**
   * 카테고리 목록 조회
   */
  async getCategories(language = 'en') {
    return this.request('GET', '/api/v2/global_product/get_category', { language });
  }

  /**
   * 글로벌 상품 등록
   */
  async addGlobalItem(itemData) {
    return this.request('POST', '/api/v2/global_product/add_global_item', itemData);
  }

  /**
   * 글로벌 상품 수정
   */
  async updateGlobalItem(itemData) {
    return this.request('POST', '/api/v2/global_product/update_global_item', itemData);
  }

  /**
   * 글로벌 상품 삭제
   */
  async deleteGlobalItem(globalItemId) {
    return this.request('POST', '/api/v2/global_product/delete_global_item', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 글로벌 모델 목록 조회
   */
  async getGlobalModelList(globalItemId) {
    return this.request('GET', '/api/v2/global_product/get_global_model_list', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 발행 가능한 샵 목록 조회
   */
  async getPublishableShop(globalItemId) {
    return this.request('GET', '/api/v2/global_product/get_publishable_shop', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 글로벌 상품을 샵에 발행
   */
  async publishGlobalItem(globalItemId, shopRegionPublishInfo) {
    return this.request('POST', '/api/v2/global_product/publish_global_item', {
      global_item_id: globalItemId,
      shop_region_publish_info: shopRegionPublishInfo,
    });
  }

  /**
   * 머천트 정보 조회
   */
  async getMerchantInfo() {
    return this.request('GET', '/api/v2/merchant/get_merchant_info');
  }

  /**
   * 특정 shop 상품 목록 (item_id 목록만)
   */
  async getProducts(offset = 0, pageSize = 50, status = 'NORMAL', shopId = null) {
    const sid = shopId || this.shopIds[0];
    return this._shopRequest('GET', '/api/v2/product/get_item_list', {
      offset, page_size: pageSize, item_status: status,
    }, sid);
  }

  /**
   * 상품 목록 + 상세 정보 배치 조회
   */
  async getProductsWithDetails(offset = 0, pageSize = 50, status = 'NORMAL', shopId = null) {
    const sid = shopId || this.shopIds[0];
    const listData = await this.getProducts(offset, pageSize, status, sid);
    const items = listData.response?.item || [];
    if (items.length === 0) return [];

    const itemIds = items.map(i => i.item_id).join(',');
    const detailData = await this._shopRequest('GET', '/api/v2/product/get_item_base_info', {
      item_id_list: itemIds,
    }, sid);
    const result = detailData.response?.item_list || [];
    return result;
  }

  /**
   * 모든 shop 상품 수 조회 (총 상품 수 확인용)
   */
  async getAllShopsTotalCount() {
    const results = [];
    for (const shopId of this.shopIds) {
      try {
        const data = await this._shopRequest('GET', '/api/v2/product/get_item_list', {
          offset: 0, page_size: 1, item_status: 'NORMAL',
        }, shopId);
        results.push({ shopId, total: data.response?.total_count || 0 });
      } catch (e) {
        results.push({ shopId, total: 0 });
      }
    }
    return results;
  }

  /**
   * 상품 상세 조회 (shop-level)
   */
  async getProductDetail(itemId, shopId = null) {
    const sid = shopId || this.shopIds[0];
    return this._shopRequest('GET', '/api/v2/product/get_item_base_info', {
      item_id_list: itemId,
    }, sid);
  }

  /**
   * 가격 업데이트 (shop-level)
   */
  async updatePrice(itemId, price, modelId = null, shopId = null) {
    const sid = shopId || this.shopIds[0];
    const body = { item_id: itemId, price_list: [{ model_id: modelId || 0, current_price: price }] };
    return this._shopRequest('POST', '/api/v2/product/update_price', body, sid);
  }

  /**
   * 재고 업데이트 (shop-level)
   */
  async updateStock(itemId, stock, modelId = null, shopId = null) {
    const sid = shopId || this.shopIds[0];
    const body = {
      item_id: itemId,
      stock_list: [{ model_id: modelId || 0, seller_stock: [{ stock }] }],
    };
    return this._shopRequest('POST', '/api/v2/product/update_stock', body, sid);
  }

  /**
   * 주문 목록 조회 (shop-level)
   */
  async getOrders(timeFrom, timeTo, status = 'READY_TO_SHIP', shopId = null) {
    const sid = shopId || this.shopIds[0];
    return this._shopRequest('GET', '/api/v2/order/get_order_list', {
      time_range_field: 'create_time',
      time_from: timeFrom || Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
      time_to: timeTo || Math.floor(Date.now() / 1000),
      page_size: 100,
      order_status: status,
    }, sid);
  }

  /**
   * 매출 요약 (모든 shop 합산, days 기간)
   * Revenue summary across all shops
   */
  async getRevenueSummary(days = 30) {
    // Shopee order API max time range = 15 days; get_order_list max 100/page;
    // use next_cursor to page through; exclude CANCELLED/IN_CANCEL to match
    // Seller Centre "Paid Orders" style figures.
    const MAX_WINDOW = 15 * 86400;
    const PAGE_SIZE = 100;
    // Matches what Shopee Business Insights counts as revenue:
    // paid/shipped/completed. CANCELLED and IN_CANCEL are excluded so a
    // buyer-initiated cancel no longer inflates the dashboard.
    const EXCLUDED_STATUSES = new Set(['CANCELLED', 'IN_CANCEL']);

    const { toUsd } = require('../services/fxRates');
    const now = Math.floor(Date.now() / 1000);
    let totalRevenue = 0;
    let totalOrders = 0;
    let skippedCancelled = 0;
    const dailySales = {};

    const authorizedShops = this.shopIds.filter(id => this.shopTokens[id]);
    if (authorizedShops.length === 0) {
      console.warn('Shopee: no authorized shops found');
      return { platform: 'Shopee', revenue: 0, orders: 0, currency: 'USD', days, dailySales: {} };
    }

    for (const shopId of authorizedShops) {
      let windowEnd = now;
      const rangeStart = now - days * 86400;
      while (windowEnd > rangeStart) {
        const windowStart = Math.max(windowEnd - MAX_WINDOW, rangeStart);
        try {
          // Collect all order_sn for this window, following next_cursor until !more
          const orderSns = [];
          const createTimeMap = {};
          let cursor = '';
          let safety = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (safety++ > 200) {
              console.warn(`Shopee shop ${shopId}: pagination safety break at 200 pages`);
              break;
            }
            const params = {
              time_range_field: 'create_time',
              time_from: windowStart,
              time_to: windowEnd,
              page_size: PAGE_SIZE,
            };
            if (cursor) params.cursor = cursor;
            const listData = await this._shopRequest('GET', '/api/v2/order/get_order_list', params, shopId);

            if (listData?.error && listData.error !== '') {
              console.warn(`Shopee shop ${shopId} order list error: ${listData.error} - ${listData.message}`);
              break;
            }

            const resp = listData?.response || {};
            for (const o of resp.order_list || []) {
              if (!o?.order_sn) continue;
              orderSns.push(o.order_sn);
              createTimeMap[o.order_sn] = o.create_time;
            }
            if (!resp.more || !resp.next_cursor) break;
            cursor = resp.next_cursor;
          }

          // Shopee max 50 order SNs per get_order_detail call
          for (let i = 0; i < orderSns.length; i += 50) {
            const batch = orderSns.slice(i, i + 50);
            const detailData = await this._shopRequest('GET', '/api/v2/order/get_order_detail', {
              order_sn_list: batch.join(','),
              response_optional_fields: 'total_amount,currency,order_status',
            }, shopId);
            const orders = detailData?.response?.order_list || [];
            for (const o of orders) {
              const status = String(o.order_status || '').toUpperCase();
              if (EXCLUDED_STATUSES.has(status)) {
                skippedCancelled++;
                continue;
              }
              const amount = parseFloat(o.total_amount || 0);
              const currency = (o.currency || '').toUpperCase();
              const amountUsd = await toUsd(amount, currency);

              totalRevenue += amountUsd;
              totalOrders++;

              const ts = createTimeMap[o.order_sn] || o.create_time;
              const date = ts
                ? new Date(ts * 1000).toISOString().slice(0, 10)
                : new Date().toISOString().slice(0, 10);
              if (!dailySales[date]) dailySales[date] = { revenue: 0, orders: 0 };
              dailySales[date].revenue += amountUsd;
              dailySales[date].orders++;
            }
          }
        } catch (e) {
          console.warn(`Shopee shop ${shopId} window error:`, e.message);
          break;
        }
        windowEnd = windowStart;
      }
    }

    return {
      platform: 'Shopee',
      revenue: totalRevenue,
      orders: totalOrders,
      skippedCancelled,
      currency: 'USD',
      days,
      dailySales,
    };
  }
}

module.exports = ShopeeAPI;
