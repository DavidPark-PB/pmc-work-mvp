/**
 * Supabase Client Singleton
 * Service-role key for server-side full access
 *
 * Phase 8B-1 addition — READ-ONLY batch cache via AsyncLocalStorage.
 *   `withReadCache(fn)` runs `fn` with a fresh Map cache that memoizes
 *   identical read queries. Terminators cached: `.then` (await), `.maybeSingle`,
 *   `.single`. Write terminators (insert / update / upsert / delete) NEVER
 *   cached — always pass through to the real query.
 *
 *   Cache lifetime = ONE `withReadCache` call. Never leaks across runs.
 *   Nesting supported (inner run gets its own cache).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@supabase/supabase-js');

let _client = null;
const _readCacheALS = new AsyncLocalStorage();

function _rawClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in config/.env');
    }
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

function getClient() {
  const store = _readCacheALS.getStore();
  if (!store) return _rawClient();
  return _wrapClientWithCache(_rawClient(), store);
}

/**
 * Run `fn` under a fresh per-batch read cache. Returns `{ value, stats }`.
 * `stats` shape: `{ hits, misses, per_table: {name: {hits, misses}} }`.
 */
async function withReadCache(fn) {
  const cache = new Map();
  const stats = { hits: 0, misses: 0, per_table: {} };
  const value = await _readCacheALS.run({ cache, stats }, async () => fn());
  return { value, stats };
}

// ─── memoization internals ───────────────────────────────

function _wrapClientWithCache(client, store) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') return (table) => _wrapQuery(client, table, store);
      return Reflect.get(target, prop, receiver);
    },
  });
}

function _wrapQuery(client, table, store) {
  const recorded = [];
  const proxy = new Proxy({}, {
    get(_, prop) {
      // `.then` — await terminator (whole query resolves to `{data, error}`)
      if (prop === 'then') {
        return function (resolve, reject) {
          _memoize(store, table, recorded, 'await',
            () => Promise.resolve(_replayReadChain(client, table, recorded))
          ).then(resolve, reject);
        };
      }
      // `.maybeSingle` / `.single` — read terminators
      if (prop === 'maybeSingle' || prop === 'single') {
        return function () {
          return _memoize(store, table, recorded, prop,
            () => _replayReadChain(client, table, recorded)[prop]()
          );
        };
      }
      // Write terminators — always pass through, NEVER cached
      if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
        return function (...args) {
          let q = client.from(table);
          for (const [m, ...a] of recorded) q = q[m](...a);
          return q[prop](...args);
        };
      }
      // Chain-recording method
      return function (...args) {
        recorded.push([prop, ...args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function _replayReadChain(client, table, recorded) {
  let q = client.from(table);
  for (const [m, ...a] of recorded) q = q[m](...a);
  return q;
}

function _memoize(store, table, recorded, terminator, factory) {
  const key = _cacheKey(table, recorded, terminator);
  if (key == null) {
    _tally(store, table, 'miss');
    return factory();   // uncacheable · pass through
  }
  if (store.cache.has(key)) {
    _tally(store, table, 'hit');
    return store.cache.get(key);
  }
  _tally(store, table, 'miss');
  const p = factory();
  store.cache.set(key, p);
  return p;
}

function _cacheKey(table, recorded, terminator) {
  try {
    return JSON.stringify([table, recorded, terminator]);
  } catch { return null; }
}

function _tally(store, table, kind) {
  if (kind === 'hit') store.stats.hits++;
  else store.stats.misses++;
  const b = store.stats.per_table[table] || (store.stats.per_table[table] = { hits: 0, misses: 0 });
  if (kind === 'hit') b.hits++; else b.misses++;
}

// ─── legacy helpers ──────────────────────────────────────

function isSupabaseEnabled() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}
function getDbSource() { return 'supabase'; }
function isDualWrite() { return false; }

module.exports = { getClient, isSupabaseEnabled, getDbSource, isDualWrite, withReadCache };
