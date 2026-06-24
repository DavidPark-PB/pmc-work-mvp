/**
 * tokenRefresh.js
 * Periodic token refresh for APIs with expiring OAuth tokens.
 * - Shopee: access token expires every 4 hours
 * - eBay: access token expires every 2 hours
 * Runs every 3 hours via setInterval in server.js.
 *
 * Tokens are saved to DB (platform_tokens table) instead of .env file.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

async function refreshShopeeTokens() {
  try {
    const ShopeeAPI = require('../api/shopeeAPI');
    const api = new ShopeeAPI();
    await api._refreshTokens();
    console.log('[TokenRefresh] Shopee tokens refreshed');
  } catch (e) {
    console.error('[TokenRefresh] Shopee refresh failed:', e.message);
  }
}

async function refreshEbayToken() {
  try {
    const EbayAPI = require('../api/ebayAPI');
    const api = new EbayAPI();
    // 최신 refresh_token 을 DB 에서 먼저 로드 (env 가 rotation 된 옛 값일 수도)
    await api._ensureToken();
    if (!api.refreshToken) {
      console.warn('[TokenRefresh] eBay: no refresh token configured');
      return;
    }
    // refreshAccessToken 자체가 DB 저장 + process.env 갱신 + rotation 처리.
    await api.refreshAccessToken();
    console.log('[TokenRefresh] eBay token refreshed');
  } catch (e) {
    console.error('[TokenRefresh] eBay refresh failed:', e.message);
  }
}

async function refreshAlibabaToken() {
  try {
    const AlibabaAPI = require('../api/alibabaAPI');
    const api = new AlibabaAPI();
    if (!process.env.ALIBABA_REFRESH_TOKEN) {
      console.warn('[TokenRefresh] Alibaba: no refresh token configured');
      return;
    }
    await api.refreshToken();
    console.log('[TokenRefresh] Alibaba token refreshed');
  } catch (e) {
    // Refresh token may be expired — requires browser re-auth
    console.warn('[TokenRefresh] Alibaba refresh failed (re-auth needed?):', e.message);
  }
}

async function refreshAllTokens() {
  console.log('[TokenRefresh] Starting token refresh cycle...');
  await Promise.allSettled([
    refreshShopeeTokens(),
    refreshEbayToken(),
    refreshAlibabaToken(),
  ]);
  console.log('[TokenRefresh] Done');
}

module.exports = { refreshAllTokens };
