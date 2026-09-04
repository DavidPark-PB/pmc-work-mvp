/**
 * tokenRefresh.js
 * Periodic token refresh for APIs with expiring OAuth tokens.
 * - Shopee: access token expires every 4 hours
 * - eBay: access token expires every 2 hours
 * Runs every 3 hours via setInterval in server.js.
 *
 * Tokens are saved to DB (platform_tokens table) instead of .env file.
 *
 * R1-C1 (2026-09-05) · Refactor R1-C1 · cross-process refresh serialization.
 *   Each provider wrapper is now guarded by a per-provider scheduler lease
 *   under keys `scheduler:refresh-token:<provider>`. During a Railway
 *   rolling deploy two Node processes can overlap for a short window; if
 *   both hit refreshAllTokens with the same current refresh_token, the
 *   provider (eBay/Shopee/Alibaba) rotates and the losing instance's
 *   subsequently-stored token becomes invalid → cascading 401s until the
 *   next successful refresh. Per-provider leases prevent both processes
 *   from calling the provider at all.
 *
 *   Channel isolation is preserved: a Shopee lock/failure never blocks
 *   eBay or Alibaba refresh. Provider clients (ebayAPI/shopeeAPI/
 *   alibabaAPI) are NOT modified in this commit — the lease sits at the
 *   wrapper level here.
 *
 *   Residual TOCTOU: the OAuth HTTP request and the DB lease are not in
 *   one distributed transaction. If a process pauses after acquiring the
 *   lease but before axios.post fires long enough for lease expiry, a
 *   second process could take over and both would fire the provider
 *   request. Heartbeat + generous TTL + short critical section between
 *   lease acquire and axios.post shrink this window. This is NOT
 *   exactly-once refresh — it is best-effort cross-process serialized.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { withLease } = require('../services/schedulerLock');

//   R1-C1 · TTL/heartbeat conservative · OAuth POST rarely exceeds 15s
//   (per-client axios timeout), but 300s TTL absorbs Railway pauses and
//   any client-internal retry. heartbeatSec 30s = TTL/10.
const REFRESH_TTL_SEC       = 300;
const REFRESH_HEARTBEAT_SEC = 30;

//   Per-provider distributed lock keys.
const LEASE_KEYS = Object.freeze({
  ebay:    'scheduler:refresh-token:ebay',
  shopee:  'scheduler:refresh-token:shopee',
  alibaba: 'scheduler:refresh-token:alibaba',
});

/**
 * Internal · fire the provider refresh under a per-provider lease.
 * Legacy try/catch inside the provider fn is PRESERVED — the lease adds
 * cross-process serialization only, it does not replace error handling.
 *
 * @param {'ebay'|'shopee'|'alibaba'} channel
 * @param {Function} providerFn  the existing per-provider refresh wrapper
 * @returns {Promise<{channel, status, error?}>}
 *   status:
 *     'refreshed'        · lease acquired and fn ran to completion (fn may
 *                          still have caught a provider error internally)
 *     'skipped_locked'   · another process/run holds the lease
 *     'lease_infra_error'· acquire RPC itself failed (fail-closed policy)
 */
async function _refreshUnderLease(channel, providerFn) {
  const key = LEASE_KEYS[channel];
  const leaseResult = await withLease(
    key,
    {
      ttlSec: REFRESH_TTL_SEC,
      heartbeatSec: REFRESH_HEARTBEAT_SEC,
      failPolicy: 'closed',
    },
    async (_ctx) => {
      //   Existing wrapper handles provider errors and returns undefined.
      //   The lease exists solely to prevent cross-process double-call.
      await providerFn();
    }
  );

  if (leaseResult.ran) {
    return { channel, status: 'refreshed' };
  }
  //   Distinguish acquire RPC error from a normal SKIP_LOCKED. Both share
  //   `acquired=false, ran=false`; only the RPC error path carries `.error`.
  //   Check `.error` FIRST — order matters for the correct status code.
  if (leaseResult.error) {
    return {
      channel,
      status: 'lease_infra_error',
      error: leaseResult.error && leaseResult.error.message
        ? leaseResult.error.message
        : String(leaseResult.error),
    };
  }
  return { channel, status: 'skipped_locked' };
}

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

/**
 * Refresh all providers · each guarded by its own distributed lease
 * (R1-C1). Channel isolation preserved via Promise.allSettled: a lease
 * error on one provider never blocks the others. Returns per-channel
 * status objects for logging; callers historically ignore the return
 * value (server.js fire-and-forget) so no legacy caller breaks.
 */
async function refreshAllTokens() {
  console.log('[TokenRefresh] Starting token refresh cycle...');
  //   Test hook · unit tests inject fakes without touching real API clients.
  //   Production always uses the module-scope defaults.
  const providers = refreshAllTokens._providers || {
    ebay:    refreshEbayToken,
    shopee:  refreshShopeeTokens,
    alibaba: refreshAlibabaToken,
  };
  const results = await Promise.allSettled([
    _refreshUnderLease('ebay',    providers.ebay),
    _refreshUnderLease('shopee',  providers.shopee),
    _refreshUnderLease('alibaba', providers.alibaba),
  ]);
  //   Normalise settlements to plain per-channel objects for observability.
  const summary = results.map(r =>
    r.status === 'fulfilled' ? r.value : { channel: 'unknown', status: 'settled_error', error: String(r.reason) }
  );
  const brief = summary.map(s => `${s.channel}=${s.status}`).join(' ');
  console.log(`[TokenRefresh] Done · ${brief}`);
  return summary;
}

/**
 * Defense-in-depth outer wrapper (R1-C1). server.js calls this instead of
 * refreshAllTokens directly. refreshAllTokens itself is protected by
 * Promise.allSettled + inner try/catch, so this wrapper should never see
 * a rejection · but the belt-and-suspenders catch converts any surprise
 * throw into a logged error rather than an unhandledRejection warning.
 *
 * Owner rule (R1-C1): NO global process.on('unhandledRejection') handler.
 * Local wrapper only.
 *
 * @param {string} trigger  free-form label ('boot' | 'interval' | test)
 * @returns {Promise<Array<{channel, status, error?}> | {error: true, trigger}>}
 */
async function safeRefreshAllTokens(trigger = 'unknown') {
  try {
    //   Route through module.exports so tests (and any legitimate future
    //   monkey-patch by an admin tool) can override refreshAllTokens
    //   without needing to intercept a closure-captured reference.
    return await module.exports.refreshAllTokens();
  } catch (err) {
    console.error(
      `[TokenRefresh] unexpected outer failure trigger=${trigger}:`,
      (err && err.message) ? err.message : String(err)
    );
    return { error: true, trigger };
  }
}

module.exports = {
  refreshAllTokens,
  safeRefreshAllTokens,
  //   R1-C1 · exposed for tests only. Do not use from other callers.
  _LEASE_KEYS: LEASE_KEYS,
  _REFRESH_TTL_SEC: REFRESH_TTL_SEC,
  _REFRESH_HEARTBEAT_SEC: REFRESH_HEARTBEAT_SEC,
};
