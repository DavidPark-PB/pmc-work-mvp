/**
 * 퀀트 SKU 점수 관리 엔진
 * 100점 만점: 순마진(30) + 회전율(25) + 경쟁(15) + 배송효율(15) + 가격안정(15)
 * A/B/C/D 등급 자동 분류 + 30일 퇴출룰
 */

const fs = require('fs');
const path = require('path');

const SCORES_PATH = path.join(__dirname, '../../data/sku-scores.json');
const PRICE_HISTORY_PATH = path.join(__dirname, '../../data/price-history.json');

class SkuScorer {
  constructor() {
    this._data = null;
    this._priceHistory = null;
  }

  // --- Data Loading ---

  load() {
    try {
      const raw = fs.readFileSync(SCORES_PATH, 'utf8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = { lastUpdated: null, scores: {} };
    }
    return this._data;
  }

  save() {
    this._data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(SCORES_PATH, JSON.stringify(this._data, null, 2), 'utf8');
  }

  _ensureLoaded() {
    if (!this._data) this.load();
  }

  loadPriceHistory() {
    try {
      const raw = fs.readFileSync(PRICE_HISTORY_PATH, 'utf8');
      this._priceHistory = JSON.parse(raw);
    } catch {
      this._priceHistory = { lastUpdated: null, snapshots: {} };
    }
    return this._priceHistory;
  }

  savePriceHistory() {
    this._priceHistory.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PRICE_HISTORY_PATH, JSON.stringify(this._priceHistory, null, 2), 'utf8');
  }

  _ensurePriceHistory() {
    if (!this._priceHistory) this.loadPriceHistory();
  }

  // --- 개별 점수 계산 ---

  /**
   * ① 예상 순마진 점수 (30점 만점)
   * margin = (settlement - totalCost) / settlement * 100
   */
  calcNetMarginScore(marginPct) {
    if (marginPct === null || marginPct === undefined || isNaN(marginPct)) {
      return { value: null, points: null, max: 30, tier: 'no_data' };
    }
    const m = parseFloat(marginPct);
    let points, tier;
    if (m >= 20)      { points = 30; tier = '20%+'; }
    else if (m >= 15) { points = 25; tier = '15-19%'; }
    else if (m >= 10) { points = 18; tier = '10-14%'; }
    else if (m >= 5)  { points = 10; tier = '5-9%'; }
    else              { points = 0;  tier = '<5%'; }
    return { value: +m.toFixed(1), points, max: 30, tier };
  }

  /**
   * ② 회전율 점수 (25점 만점)
   * 최근 30일 판매량 기준
   */
  calcTurnoverScore(sales30d) {
    if (sales30d === null || sales30d === undefined) {
      return { value: null, points: null, max: 25, tier: 'no_data' };
    }
    const s = parseInt(sales30d) || 0;
    let points, tier;
    if (s >= 20)     { points = 25; tier = '20+'; }
    else if (s >= 10) { points = 18; tier = '10-19'; }
    else if (s >= 5)  { points = 12; tier = '5-9'; }
    else if (s >= 1)  { points = 5;  tier = '1-4'; }
    else              { points = 0;  tier = '0'; }
    return { value: s, points, max: 25, tier };
  }

  /**
   * ③ 경쟁 강도 점수 (15점 만점)
   * 경쟁 셀러 수 기준 (수동 입력)
   */
  calcCompetitionScore(competitorCount) {
    if (competitorCount === null || competitorCount === undefined) {
      return { value: null, points: null, max: 15, tier: 'manual_required' };
    }
    const c = parseInt(competitorCount);
    let points, tier;
    if (c <= 5)       { points = 15; tier = '5명이하'; }
    else if (c <= 10) { points = 10; tier = '6-10명'; }
    else if (c <= 20) { points = 5;  tier = '11-20명'; }
    else              { points = 0;  tier = '20명+'; }
    return { value: c, points, max: 15, tier };
  }

  /**
   * ④ 배송 구조 효율 점수 (15점 만점)
   * 묶음 판매 가능 수 (포켓몬 7개+ 구조 등)
   */
  calcShippingEfficiencyScore(bundleItemCount) {
    if (bundleItemCount === null || bundleItemCount === undefined) {
      return { value: null, points: null, max: 15, tier: 'manual_required' };
    }
    const b = parseInt(bundleItemCount);
    let points, tier;
    if (b >= 7)      { points = 15; tier = '7개+'; }
    else if (b >= 5) { points = 10; tier = '5-6개'; }
    else if (b >= 1) { points = 3;  tier = '단품'; }
    else             { points = 0;  tier = '손해구조'; }
    return { value: b, points, max: 15, tier };
  }

  /**
   * ⑤ 가격 안정성 점수 (15점 만점)
   * 30일 가격 변동폭 기준 (max deviation from mean)
   */
  calcPriceStabilityScore(priceHistory) {
    if (!priceHistory || priceHistory.length < 7) {
      return { value: null, points: null, max: 15, tier: 'insufficient_data' };
    }

    const prices = priceHistory.map(p => p.price).filter(p => p > 0);
    if (prices.length < 7) {
      return { value: null, points: null, max: 15, tier: 'insufficient_data' };
    }

    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const maxDeviation = Math.max(...prices.map(p => Math.abs(p - mean)));
    const fluctuationPct = mean > 0 ? (maxDeviation / mean * 100) : 0;

    let points, tier;
    if (fluctuationPct <= 5)       { points = 15; tier = '±5%이내'; }
    else if (fluctuationPct <= 10) { points = 10; tier = '±10%'; }
    else if (fluctuationPct <= 20) { points = 5;  tier = '±20%'; }
    else                           { points = 0;  tier = '급락/급등'; }
    return { value: +fluctuationPct.toFixed(1), points, max: 15, tier };
  }

  // --- 종합 점수 계산 ---

  /**
   * 단일 SKU 종합 점수 계산
   * @param {string} sku
   * @param {Object} externalData - { marginPct, sales30d, competitorCount, bundleItemCount, priceHistory }
   * @param {Object} productInfo - { title, sellingPrice, purchasePrice }
   */
  calculateTotalScore(sku, externalData, productInfo = {}) {
    this._ensureLoaded();

    const existing = this._data.scores[sku] || {};
    const overrides = existing.manualOverrides || {};

    // 경쟁/배송은 수동 오버라이드 우선
    const competitorCount = overrides.competitorCount ?? externalData.competitorCount ?? null;
    const bundleItemCount = overrides.bundleItemCount ?? externalData.bundleItemCount ?? null;

    // 5개 항목 점수 계산
    const scores = {
      netMargin: this.calcNetMarginScore(externalData.marginPct),
      turnover: this.calcTurnoverScore(externalData.sales30d),
      competition: this.calcCompetitionScore(competitorCount),
      shippingEfficiency: this.calcShippingEfficiencyScore(bundleItemCount),
      priceStability: this.calcPriceStabilityScore(externalData.priceHistory),
    };

    // 총점 + 정규화 (null 항목 제외)
    let totalScore = 0;
    let maxPossibleScore = 0;
    Object.values(scores).forEach(s => {
      if (s.points !== null && s.points !== undefined) {
        totalScore += s.points;
        maxPossibleScore += s.max;
      }
    });

    // 최소 분모 55 (마진30+회전25) — 데이터 1개만으로 100점 되는 것 방지
    const MIN_DENOMINATOR = 55;
    const effectiveDenominator = Math.max(maxPossibleScore, MIN_DENOMINATOR);
    const normalizedScore = effectiveDenominator > 0 ? (totalScore / effectiveDenominator * 100) : 0;
    const classification = this.getClassification(normalizedScore);
    const marginVal = scores.netMargin.value;
    const purchaseDecision = this.getPurchaseDecision(normalizedScore, marginVal);

    // 퇴출 룰 체크
    const autoRetirement = this._checkRetirementForSku(
      sku, externalData.sales30d, normalizedScore, marginVal, existing.autoRetirement
    );

    // 이력 업데이트
    const today = new Date().toISOString().split('T')[0];
    const history = existing.history || [];
    // 같은 날짜면 덮어쓰기, 아니면 추가
    const todayIdx = history.findIndex(h => h.date === today);
    const historyEntry = { date: today, totalScore, normalizedScore: +normalizedScore.toFixed(1), classification };
    if (todayIdx >= 0) {
      history[todayIdx] = historyEntry;
    } else {
      history.push(historyEntry);
    }
    // 최근 90일만 보관
    while (history.length > 90) history.shift();

    const entry = {
      sku,
      title: productInfo.title || existing.title || '',
      rawData: {
        sellingPrice: externalData.sellingPrice || null,
        purchasePrice: externalData.purchasePrice || null,
        platformFees: externalData.platformFees || null,
        netMarginPct: marginVal,
        sales30d: externalData.sales30d ?? null,
        competitorCount,
        bundleItemCount,
        priceFluctuationPct: scores.priceStability.value,
      },
      scores,
      totalScore,
      maxPossibleScore,
      normalizedScore: +normalizedScore.toFixed(1),
      classification,
      purchaseDecision,
      autoRetirement,
      manualOverrides: overrides,
      history,
      calculatedAt: new Date().toISOString(),
    };

    this._data.scores[sku] = entry;
    return entry;
  }

  /**
   * 전체 SKU 일괄 재계산
   * @param {Object} externalData - { salesBySku, dashboardData, priceHistoryMap }
   */
  recalculateAll(externalData) {
    this._ensureLoaded();
    this._ensurePriceHistory();

    const { salesBySku = {}, dashboardData = [], priceHistoryMap } = externalData;
    const snapshots = priceHistoryMap || this._priceHistory.snapshots || {};

    // 시트 데이터 SKU→row 맵 (SKU + eBay Item ID 이중 매핑)
    const sheetMap = {};
    dashboardData.forEach(row => {
      if (row.sku) sheetMap[row.sku] = row;
      if (row.itemId) sheetMap[row.itemId] = row;  // eBay ItemID로도 조회
    });

    // 모든 알려진 SKU 수집 (시트 + 판매 데이터가 있는 것만)
    const allSkus = new Set();
    dashboardData.forEach(row => { if (row.sku) allSkus.add(row.sku); });
    // 기존 점수 중 manual override가 있는 것은 보존
    Object.entries(this._data.scores).forEach(([sku, entry]) => {
      if (entry.manualOverrides && Object.keys(entry.manualOverrides).length > 0) {
        allSkus.add(sku);
      }
    });
    // eBay 판매 SKU 추가 (시트 매칭 시도)
    Object.keys(salesBySku).forEach(sku => allSkus.add(sku));

    // 기존 데이터 초기화 (manual override만 보존)
    const oldScores = this._data.scores;
    this._data.scores = {};

    let calculated = 0;
    let skipped = 0;
    for (const sku of allSkus) {
      const sheet = sheetMap[sku] || {};
      const sales = salesBySku[sku] || { units: 0, revenue: 0 };
      const history = snapshots[sku] || [];

      // 마진 계산: 시트에 margin 있으면 사용, 없으면 settlement 기반 계산
      let marginPct = null;
      if (sheet.margin && !isNaN(parseFloat(sheet.margin))) {
        marginPct = parseFloat(sheet.margin);
      } else if (sheet.settlement && sheet.totalCost) {
        const s = parseFloat(sheet.settlement) || 0;
        const c = parseFloat(sheet.totalCost) || 0;
        if (s > 0) marginPct = ((s - c) / s) * 100;
      }

      // 의미있는 데이터 체크: 마진 > 0 이거나 판매 > 0 이어야 점수 계산
      const hasMeaningfulMargin = marginPct !== null && marginPct > 0;
      const hasMeaningfulSales = sales.units > 0;
      const hasManualOverride = oldScores[sku]?.manualOverrides && Object.keys(oldScores[sku].manualOverrides).length > 0;
      if (!hasMeaningfulMargin && !hasMeaningfulSales && !hasManualOverride) {
        skipped++;
        continue;
      }

      // 기존 manual override 복원
      if (oldScores[sku]?.manualOverrides) {
        this._data.scores[sku] = { manualOverrides: oldScores[sku].manualOverrides };
      }

      this.calculateTotalScore(sku, {
        marginPct,
        sales30d: sales.units,
        sellingPrice: parseFloat(sheet.priceUSD) || null,
        purchasePrice: parseFloat(sheet.purchase) || null,
        platformFees: sheet.fee || null,
        priceHistory: history,
      }, {
        title: sheet.title || '',
      });

      calculated++;
    }

    console.log(`[SKU Scorer] 계산: ${calculated}개, 스킵(데이터없음): ${skipped}개`);
    this.save();
    return { calculated, summary: this.getSummary() };
  }

  // --- 분류 ---

  getClassification(normalizedScore) {
    if (normalizedScore >= 80) return 'A';
    if (normalizedScore >= 65) return 'B';
    if (normalizedScore >= 50) return 'C';
    return 'D';
  }

  getPurchaseDecision(normalizedScore, netMarginPct) {
    const allowed = normalizedScore >= 70 && netMarginPct !== null && netMarginPct >= 12;
    const reasons = [];
    if (normalizedScore < 70) reasons.push(`점수 ${normalizedScore.toFixed(1)} < 70`);
    if (netMarginPct === null) reasons.push('마진 데이터 없음');
    else if (netMarginPct < 12) reasons.push(`마진 ${netMarginPct.toFixed(1)}% < 12%`);
    return { allowed, reason: allowed ? '매입 조건 충족' : reasons.join(', ') };
  }

  // --- 퇴출 관리 ---

  _checkRetirementForSku(sku, sales30d, normalizedScore, marginPct, prevRetirement = {}) {
    const actions = [];
    const today = new Date().toISOString().split('T')[0];

    // 룰 1: 30일 판매 0 → 가격 5% 인상
    const zeroSalesDays = (sales30d === 0 || sales30d === null) ? 30 : 0;
    if (zeroSalesDays >= 30) {
      actions.push({ action: 'price_increase_5pct', reason: '30일 판매 0' });
    }

    // 룰 2: 점수 50 미만 14일 지속 → 비활성화
    let lowScoreStartDate = prevRetirement.lowScoreStartDate || null;
    if (normalizedScore < 50) {
      if (!lowScoreStartDate) lowScoreStartDate = today;
      const daysBelowThreshold = Math.floor(
        (new Date(today) - new Date(lowScoreStartDate)) / 86400000
      );
      if (daysBelowThreshold >= 14) {
        actions.push({ action: 'deactivate', reason: `점수 50 미만 ${daysBelowThreshold}일 지속` });
      }
    } else {
      lowScoreStartDate = null;
    }

    // 룰 3: 마진 ≤ 5% → 마진 검토 플래그
    const marginFlagged = marginPct !== null && marginPct <= 5;
    if (marginFlagged) {
      actions.push({ action: 'margin_review', reason: `순마진 ${marginPct?.toFixed(1)}% ≤ 5%` });
    }

    return { zeroSalesDays, lowScoreStartDate, marginFlagged, actions };
  }

  /**
   * 전체 퇴출 대상 조회
   */
  checkRetirementRules() {
    this._ensureLoaded();
    const actions = [];
    for (const [sku, entry] of Object.entries(this._data.scores)) {
      if (entry.autoRetirement && entry.autoRetirement.actions.length > 0) {
        entry.autoRetirement.actions.forEach(a => {
          actions.push({ sku, title: entry.title, ...a, normalizedScore: entry.normalizedScore });
        });
      }
    }
    return actions;
  }

  // --- 조회 ---

  getScoreBySku(sku) {
    this._ensureLoaded();
    return this._data.scores[sku] || null;
  }

  getAllScores() {
    this._ensureLoaded();
    return Object.values(this._data.scores).sort((a, b) => (b.normalizedScore || 0) - (a.normalizedScore || 0));
  }

  getByClassification(cls) {
    return this.getAllScores().filter(s => s.classification === cls);
  }

  getSummary() {
    const all = this.getAllScores();
    const byClassification = { A: 0, B: 0, C: 0, D: 0 };
    let scoreSum = 0;
    let purchaseAllowed = 0;
    let retirementCandidates = 0;

    all.forEach(s => {
      byClassification[s.classification] = (byClassification[s.classification] || 0) + 1;
      scoreSum += s.normalizedScore || 0;
      if (s.purchaseDecision?.allowed) purchaseAllowed++;
      if (s.autoRetirement?.actions?.length > 0) retirementCandidates++;
    });

    return {
      total: all.length,
      byClassification,
      avgScore: all.length > 0 ? +(scoreSum / all.length).toFixed(1) : 0,
      purchaseAllowed,
      retirementCandidates,
    };
  }

  getHistory(sku) {
    this._ensureLoaded();
    const entry = this._data.scores[sku];
    return entry ? entry.history || [] : [];
  }

  // --- 수동 오버라이드 ---

  setManualOverride(sku, overrides) {
    this._ensureLoaded();
    if (!this._data.scores[sku]) {
      this._data.scores[sku] = { manualOverrides: {} };
    }
    const entry = this._data.scores[sku];
    if (!entry.manualOverrides) entry.manualOverrides = {};

    if (overrides.competitorCount !== undefined) {
      entry.manualOverrides.competitorCount = overrides.competitorCount;
    }
    if (overrides.bundleItemCount !== undefined) {
      entry.manualOverrides.bundleItemCount = overrides.bundleItemCount;
    }
    if (overrides.notes !== undefined) {
      entry.manualOverrides.notes = overrides.notes;
    }

    this.save();
    return entry;
  }

  // --- 가격 히스토리 ---

  addPriceSnapshot(sku, price, platform = 'ebay') {
    this._ensurePriceHistory();
    const today = new Date().toISOString().split('T')[0];

    if (!this._priceHistory.snapshots[sku]) {
      this._priceHistory.snapshots[sku] = [];
    }

    const history = this._priceHistory.snapshots[sku];
    // 같은 날짜+플랫폼이면 덮어쓰기
    const existing = history.findIndex(h => h.date === today && h.platform === platform);
    if (existing >= 0) {
      history[existing].price = price;
    } else {
      history.push({ date: today, price, platform });
    }

    // 최근 90일만 보관
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    this._priceHistory.snapshots[sku] = history.filter(h => h.date >= cutoffStr);
  }

  savePriceSnapshots() {
    this.savePriceHistory();
  }

  getPriceHistory(sku) {
    this._ensurePriceHistory();
    return this._priceHistory.snapshots[sku] || [];
  }
}

module.exports = SkuScorer;
