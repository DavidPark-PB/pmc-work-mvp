'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR           = path.join(__dirname, '../../data');
const SNAPSHOTS_FILE     = path.join(DATA_DIR, 'sku-snapshots.json');
const SKU_STATS_FILE     = path.join(DATA_DIR, 'sku-stats.json');
const EXPANSION_QUEUE_FILE = path.join(DATA_DIR, 'expansion-queue.json');

// 히트 판정 기준
const THRESHOLD_INTEREST  = { days: 3, count: 3 };  // 관심
const THRESHOLD_EXPANSION = { days: 7, count: 7 };  // 확장 + 큐 자동 등록

// ── 파일 유틸 ──────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return defaultVal;
}

function writeJSON(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── 스냅샷 ─────────────────────────────────────────────────
/**
 * Google Sheets 에서 읽은 SKU 목록으로 스냅샷을 저장한다.
 * @param {Array<{sku, title, platform, salesCount}>} rows
 */
function takeSnapshot(rows) {
  const snapshots = readJSON(SNAPSHOTS_FILE, []);

  const snapshot = {
    timestamp: new Date().toISOString(),
    data: {},
  };
  for (const r of rows) {
    if (!r.sku) continue;
    snapshot.data[r.sku] = {
      salesCount: r.salesCount || 0,
      title: r.title || '',
      platform: r.platform || '',
    };
  }

  snapshots.push(snapshot);

  // 30일 이상 된 스냅샷 정리
  const cutoff = Date.now() - 30 * 86400_000;
  writeJSON(SNAPSHOTS_FILE, snapshots.filter(s => new Date(s.timestamp).getTime() >= cutoff));
}

/**
 * 특정 days 이전의 스냅샷 중 가장 최근 것을 반환.
 * 없으면 null.
 */
function _snapshotBefore(snapshots, days) {
  const cutoff = Date.now() - days * 86400_000;
  const old = snapshots.filter(s => new Date(s.timestamp).getTime() <= cutoff);
  return old.length > 0 ? old[old.length - 1] : null;
}

// ── 집계 ───────────────────────────────────────────────────
/**
 * 저장된 스냅샷으로 3일/7일 판매 델타를 계산하고
 * SkuStats + ExpansionQueue 를 갱신한다.
 * @returns {object[]} 최신 SkuStats 배열
 */
function aggregateFromSnapshots() {
  const snapshots = readJSON(SNAPSHOTS_FILE, []);
  if (!snapshots.length) return [];

  const latest = snapshots[snapshots.length - 1];
  const snap3d = _snapshotBefore(snapshots, THRESHOLD_INTEREST.days);
  const snap7d = _snapshotBefore(snapshots, THRESHOLD_EXPANSION.days);

  const map = {};

  for (const [sku, info] of Object.entries(latest.data)) {
    const curr       = info.salesCount;
    // 기준선이 없으면 0 으로 설정 (첫 집계)
    const base3d     = snap3d ? (snap3d.data[sku]?.salesCount ?? curr) : curr;
    const base7d     = snap7d ? (snap7d.data[sku]?.salesCount ?? curr) : curr;

    map[sku] = {
      sku,
      title:       info.title,
      platform:    info.platform,
      salesTotal:  curr,            // 누적 판매 수 (랭킹 fallback)
      count3d:     Math.max(0, curr - base3d),
      count7d:     Math.max(0, curr - base7d),
      has3dBase:   !!snap3d,
      has7dBase:   !!snap7d,
      status:      'normal',
      lastUpdated: latest.timestamp,
    };
  }

  // 상태 분류 + 큐 자동 등록
  const queue    = readJSON(EXPANSION_QUEUE_FILE, []);
  const queueMap = new Map(queue.map(q => [q.sku, q]));
  const now      = new Date().toISOString();

  for (const s of Object.values(map)) {
    // 7일 기준 데이터가 없을 때는 salesTotal 로 판정
    const eff7d = s.has7dBase ? s.count7d : s.salesTotal;
    const eff3d = s.has3dBase ? s.count3d : s.salesTotal;

    if (eff7d >= THRESHOLD_EXPANSION.count) {
      s.status = 'expansion';
      if (!queueMap.has(s.sku)) {
        const entry = {
          sku: s.sku, title: s.title,
          count3d: s.count3d, count7d: s.count7d, salesTotal: s.salesTotal,
          status: 'pending', addedAt: now,
          approvedAt: null, exportedAt: null,
        };
        queue.push(entry);
        queueMap.set(s.sku, entry);
      } else {
        Object.assign(queueMap.get(s.sku), {
          count3d: s.count3d, count7d: s.count7d, salesTotal: s.salesTotal,
        });
      }
    } else if (eff3d >= THRESHOLD_INTEREST.count) {
      s.status = 'interest';
    }
  }

  const result = Object.values(map);
  writeJSON(SKU_STATS_FILE, result);
  writeJSON(EXPANSION_QUEUE_FILE, queue);
  return result;
}

// ── SkuStats 조회 ──────────────────────────────────────────
/**
 * 랭킹 정렬 조회.
 * has7dBase 가 없을 때는 salesTotal 로 정렬.
 */
function getSkuStats({ sort = 'auto', order = 'desc', status } = {}) {
  let stats = readJSON(SKU_STATS_FILE, []);
  if (status) stats = stats.filter(s => s.status === status);

  const has7dBase = stats.some(s => s.has7dBase);
  const effectiveSort = sort === 'auto'
    ? (has7dBase ? 'count7d' : 'salesTotal')
    : sort;

  return stats.sort((a, b) => {
    const va = a[effectiveSort] ?? 0;
    const vb = b[effectiveSort] ?? 0;
    return order === 'desc' ? vb - va : va - vb;
  });
}

// ── ExpansionQueue 조회 ────────────────────────────────────
function getExpansionQueue({ status } = {}) {
  let queue = readJSON(EXPANSION_QUEUE_FILE, []);
  if (status) queue = queue.filter(q => q.status === status);
  return queue.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
}

// ── 큐 상태 변경 ──────────────────────────────────────────
function updateQueueStatus(sku, newStatus) {
  const queue = readJSON(EXPANSION_QUEUE_FILE, []);
  const item  = queue.find(q => q.sku === sku);
  if (!item) return null;
  item.status = newStatus;
  if (newStatus === 'approved') item.approvedAt  = new Date().toISOString();
  if (newStatus === 'exported') item.exportedAt  = new Date().toISOString();
  writeJSON(EXPANSION_QUEUE_FILE, queue);
  return item;
}

// ── Export ─────────────────────────────────────────────────
function exportQueue() {
  const queue    = readJSON(EXPANSION_QUEUE_FILE, []);
  const approved = queue.filter(q => q.status === 'approved');
  const now      = new Date().toISOString();
  for (const item of queue) {
    if (item.status === 'approved') {
      item.status     = 'exported';
      item.exportedAt = now;
    }
  }
  writeJSON(EXPANSION_QUEUE_FILE, queue);
  return approved;
}

module.exports = {
  takeSnapshot,
  aggregateFromSnapshots,
  getSkuStats,
  getExpansionQueue,
  updateQueueStatus,
  exportQueue,
};
