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
const { saveToken } = require('../services/tokenStore');

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
    if (!api.refreshToken) {
      console.warn('[TokenRefresh] eBay: no refresh token configured');
      return;
    }
    const newToken = await api.refreshAccessToken();
    // Save to DB instead of .env
    await saveToken('ebay', {
      accessToken: newToken,
      refreshToken: process.env.EBAY_REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h from now
    });
    process.env.EBAY_USER_TOKEN = newToken;
    console.log('[TokenRefresh] eBay token refreshed and saved to DB');
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
