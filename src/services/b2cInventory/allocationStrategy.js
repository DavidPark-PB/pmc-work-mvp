'use strict';
/**
 * allocationStrategy.js — B2C · Phase 6 · Queue plan allocation.
 *
 * GLOBAL_PRIORITY (default): 이번까지 사용한 순수 priority 정렬 (P0>P1>P2, score DESC, ...)
 * BALANCED_CHANNEL         : 4채널 (coupang/naver/11st/gmarket) 에 균형있게 분배.
 *                            단, P0 우선순위를 심각히 훼손하지 않도록:
 *                              · P0 우선 처리 (P0 안에서 채널 round-robin)
 *                              · 그 뒤 P1 (P1 안에서 round-robin)
 *                              · 각 채널 몫은 slots/4 · 부족한 채널이 있으면 다른 채널로 넘김
 *
 * Pure functions · testable.
 */

const AUTO_CHANNELS = ['coupang', 'naver', '11st', 'gmarket'];
const LEVEL_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

//   candidates 는 이미 필터링 완료된 배열 (eligible + NONE/ERROR + P3 제외 등)
//   returns 정렬된 배열 (top `slots` 를 자르면 됨)
function allocateGlobalPriority(candidates) {
  const arr = candidates.slice();
  arr.sort((a, b) => {
    const ra = LEVEL_RANK[a.priority_level] ?? 9;
    const rb = LEVEL_RANK[b.priority_level] ?? 9;
    if (ra !== rb) return ra - rb;
    const sa = Number(a.priority_score) || 0;
    const sb = Number(b.priority_score) || 0;
    if (sa !== sb) return sb - sa;
    const va = Number(a.inventory_value_krw) || 0;
    const vb = Number(b.inventory_value_krw) || 0;
    if (va !== vb) return vb - va;
    const es = (Number(a.ebay_sales_90d) || 0) + (Number(a.shopify_sales_90d) || 0);
    const eb = (Number(b.ebay_sales_90d) || 0) + (Number(b.shopify_sales_90d) || 0);
    if (es !== eb) return eb - es;
    return (Number(a.sku_master_id) || 0) - (Number(b.sku_master_id) || 0);
  });
  return arr;
}

//   BALANCED_CHANNEL:
//     1) P0 그룹 우선 처리 · P0 안에서 channel round-robin (priority_score DESC)
//     2) 그 뒤 P1 그룹 · 마찬가지 round-robin
//     3) 그 뒤 P2 그룹
//     * 각 채널 몫이 정해져 있어도 다른 채널이 부족하면 넘김 (deterministic)
//     * 결과 배열은 위에서 아래로 자를 수 있는 이미 정렬된 순서
function allocateBalancedChannel(candidates, targetChannels = AUTO_CHANNELS) {
  //   Group by level, within level group by channel (channel 안에서 score DESC)
  const byLevel = new Map();
  for (const c of candidates) {
    const lvl = c.priority_level;
    if (!byLevel.has(lvl)) byLevel.set(lvl, {});
    const grp = byLevel.get(lvl);
    if (!grp[c.channel]) grp[c.channel] = [];
    grp[c.channel].push(c);
  }
  //   Sort inside each channel bucket
  for (const grp of byLevel.values()) {
    for (const ch of Object.keys(grp)) {
      grp[ch].sort((a, b) => {
        const sa = Number(a.priority_score) || 0;
        const sb = Number(b.priority_score) || 0;
        if (sa !== sb) return sb - sa;
        const va = Number(a.inventory_value_krw) || 0;
        const vb = Number(b.inventory_value_krw) || 0;
        if (va !== vb) return vb - va;
        return (Number(a.sku_master_id) || 0) - (Number(b.sku_master_id) || 0);
      });
    }
  }

  //   Interleave by level order · within level round-robin channels
  const out = [];
  const levelOrder = ['p0', 'p1', 'p2', 'p3'];
  for (const lvl of levelOrder) {
    const grp = byLevel.get(lvl);
    if (!grp) continue;
    //   round-robin until every channel bucket empty
    while (targetChannels.some(ch => grp[ch] && grp[ch].length > 0)) {
      for (const ch of targetChannels) {
        if (grp[ch] && grp[ch].length > 0) {
          out.push(grp[ch].shift());
        }
      }
    }
  }
  return out;
}

//   Distribution — 결과 배열에서 앞 N 개의 channel 분포를 계산 (Preview 용)
function distribution(sortedCandidates, take) {
  const cut = sortedCandidates.slice(0, take);
  const dist = { total: cut.length, byLevel: {}, byChannel: {}, byLevelChannel: {} };
  for (const c of cut) {
    dist.byLevel[c.priority_level] = (dist.byLevel[c.priority_level] || 0) + 1;
    dist.byChannel[c.channel] = (dist.byChannel[c.channel] || 0) + 1;
    const k = `${c.priority_level}||${c.channel}`;
    dist.byLevelChannel[k] = (dist.byLevelChannel[k] || 0) + 1;
  }
  return dist;
}

module.exports = {
  AUTO_CHANNELS,
  LEVEL_RANK,
  allocateGlobalPriority,
  allocateBalancedChannel,
  distribution,
  STRATEGIES: ['GLOBAL_PRIORITY', 'BALANCED_CHANNEL'],
};
