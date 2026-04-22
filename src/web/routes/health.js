/**
 * 시스템 헬스체크 — GET /api/health
 * 인증 없이 접근 가능 (Fly health check·모니터링 용도).
 * 민감 데이터는 응답에 포함하지 않음 — ok/error 및 간단한 hint만.
 */
const express = require('express');
const router = express.Router();

const CHECK_TIMEOUT_MS = 5000;

// 주요 테이블 목록 — 마이그레이션 적용 여부 체크
const EXPECTED_TABLES = [
  'users', 'expenses', 'inventory_purchases',
  'weekly_plans', 'weekly_meetings', 'cs_templates',
  'resources', 'b2b_buyers', 'b2b_invoices',
  'b2b_shipments', 'b2b_payments',
  'purchase_requests', 'purchase_request_attachments',
  'competitors', 'prospects',
];

// 필요한 Storage 버킷
const EXPECTED_BUCKETS = ['task-attachments', 'expense-receipts'];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout (${label})`)), ms)),
  ]);
}

async function checkDb() {
  const t0 = Date.now();
  try {
    const { getClient } = require('../../db/supabaseClient');
    const { error } = await withTimeout(
      getClient().from('users').select('id', { count: 'exact', head: true }).limit(1),
      CHECK_TIMEOUT_MS, 'db'
    );
    if (error) throw error;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkMigrations() {
  const { getClient } = require('../../db/supabaseClient');
  const db = getClient();
  const missing = [];
  const applied = [];
  await Promise.all(EXPECTED_TABLES.map(async tbl => {
    try {
      const { error } = await withTimeout(
        db.from(tbl).select('*', { count: 'exact', head: true }).limit(1),
        CHECK_TIMEOUT_MS, `table ${tbl}`
      );
      if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
        missing.push(tbl);
      } else if (error) {
        // 다른 에러는 "알 수 없음"으로 분류
        missing.push(`${tbl} (error: ${error.code || 'unknown'})`);
      } else {
        applied.push(tbl);
      }
    } catch (e) {
      missing.push(`${tbl} (${e.message})`);
    }
  }));
  return { ok: missing.length === 0, applied, missing };
}

async function checkSheets() {
  const t0 = Date.now();
  try {
    const cat = require('../../services/catalogService');
    const tabs = await withTimeout(cat.listTabs(), CHECK_TIMEOUT_MS, 'sheets');
    return { ok: true, latencyMs: Date.now() - t0, tabs: tabs.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkEbay() {
  try {
    const EbayAPI = require('../../api/ebayAPI');
    const api = new EbayAPI();
    const result = await withTimeout(api.getActiveListings(1, 1), CHECK_TIMEOUT_MS, 'ebay');
    return { ok: true, total: result.totalEntries || 0 };
  } catch (e) {
    const msg = String(e.message || '');
    return { ok: false, error: msg, hint: /401|auth/i.test(msg) ? '토큰 만료 가능성 — re-auth 필요' : null };
  }
}

async function checkShopify() {
  try {
    const { getClient } = require('../../db/supabaseClient');
    // DB 캐시만 체크 (라이브 API 호출 안 함 — 429 방지)
    const { count, error } = await withTimeout(
      getClient().from('shopify_products').select('*', { count: 'exact', head: true }),
      CHECK_TIMEOUT_MS, 'shopify'
    );
    if (error && error.code === '42P01') return { ok: false, error: 'shopify_products 테이블 없음 (마이그레이션 필요)' };
    if (error) throw error;
    return { ok: true, dbCount: count || 0, note: 'DB 캐시 기준 (라이브 토큰 체크 안 함)' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkNaver() {
  try {
    const NaverAPI = require('../../api/naverAPI');
    const api = new NaverAPI();
    const token = await withTimeout(api.getToken(), CHECK_TIMEOUT_MS, 'naver');
    return { ok: !!token };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkStorage() {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const result = {};
    await Promise.all(EXPECTED_BUCKETS.map(async name => {
      try {
        const { error } = await withTimeout(
          getClient().storage.from(name).list('', { limit: 1 }),
          CHECK_TIMEOUT_MS, `bucket ${name}`
        );
        result[name] = error ? { ok: false, error: error.message } : { ok: true };
      } catch (e) {
        result[name] = { ok: false, error: e.message };
      }
    }));
    const ok = Object.values(result).every(r => r.ok);
    return { ok, buckets: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function checkInvoiceTemplate() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '../../../templates/b2b_invoice_master.xlsx');
    const exists = fs.existsSync(p);
    return exists ? { ok: true, size: fs.statSync(p).size } : { ok: false, error: '파일 없음' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function checkEnv() {
  const required = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'SHOPIFY_STORE_URL', 'SHOPIFY_ACCESS_TOKEN',
    'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET',
    'EBAY_APP_ID', 'EBAY_DEV_ID', 'EBAY_CERT_ID',
    'GEMINI_API_KEY',
  ];
  const missing = required.filter(k => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

router.get('/', async (req, res) => {
  const t0 = Date.now();

  const [db, migrations, sheets, ebay, shopify, naver, storage] = await Promise.all([
    checkDb().catch(e => ({ ok: false, error: e.message })),
    checkMigrations().catch(e => ({ ok: false, error: e.message })),
    checkSheets().catch(e => ({ ok: false, error: e.message })),
    checkEbay().catch(e => ({ ok: false, error: e.message })),
    checkShopify().catch(e => ({ ok: false, error: e.message })),
    checkNaver().catch(e => ({ ok: false, error: e.message })),
    checkStorage().catch(e => ({ ok: false, error: e.message })),
  ]);

  const invoiceTemplate = checkInvoiceTemplate();
  const env = checkEnv();

  const checks = { db, migrations, sheets, ebay, shopify, naver, storage, invoiceTemplate, env };
  const allOk = Object.values(checks).every(c => c.ok);
  const someOk = Object.values(checks).some(c => c.ok);
  const status = allOk ? 'ok' : someOk ? 'degraded' : 'down';

  res.status(allOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    checks,
  });
});

module.exports = router;
