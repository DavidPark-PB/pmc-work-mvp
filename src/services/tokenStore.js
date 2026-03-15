/**
 * tokenStore.js
 * DB-based platform token storage (Supabase).
 * Mirrors automation/src/lib/token-store.ts for the main Express app.
 * Tokens are saved to DB on refresh; process.env is updated in-memory only.
 */

const { getClient } = require('../db/supabaseClient');

/**
 * Load token from DB. Returns null if not found.
 * @param {string} platform - e.g. 'ebay', 'shopee', 'alibaba'
 */
async function loadToken(platform) {
  try {
    const db = getClient();
    const { data, error } = await db.from('platform_tokens')
      .select('access_token, refresh_token, expires_at, metadata')
      .eq('platform', platform)
      .single();
    if (error || !data) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      metadata: data.metadata,
    };
  } catch (e) {
    console.warn(`[tokenStore] ${platform} load failed:`, e.message);
    return null;
  }
}

/**
 * Save (upsert) token to DB.
 * @param {string} platform
 * @param {Object} data
 * @param {string} data.accessToken
 * @param {string} [data.refreshToken]
 * @param {Date|string} [data.expiresAt]
 * @param {Object} [data.metadata]
 */
async function saveToken(platform, { accessToken, refreshToken, expiresAt, metadata }) {
  try {
    const db = getClient();
    const row = {
      platform,
      access_token: accessToken,
      refresh_token: refreshToken || null,
      expires_at: expiresAt || null,
      metadata: metadata || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from('platform_tokens')
      .upsert(row, { onConflict: 'platform' });
    if (error) throw error;
    console.log(`[tokenStore] ${platform} token saved to DB`);
  } catch (e) {
    console.error(`[tokenStore] ${platform} save failed:`, e.message);
  }
}

module.exports = { loadToken, saveToken };
