/**
 * CSCategoryClassifier — 메시지 → 카테고리 7종 분류 (PR CS-G1)
 *
 * 정책 (사장님 spec):
 *   - 1차 단순 키워드 매칭. AI X (그룹 3 의 톤 다듬기에서만 AI).
 *   - 우선순위 (사장님 짚을 점 A): fraud_suspect > complaint > pre_purchase > shipping > refund > stock > thanks
 *     (pre_purchase 키워드가 매우 특이적이라 shipping 보다 위)
 *   - 매칭 다중일 때 detectedCategory = 최우선 1개. candidates = 매칭된 모든 카테고리 (우선순위 정렬).
 *   - 매칭 0건 → { detectedCategory: null, candidates: [] } (UI 가 직원 수동 select)
 */
'use strict';

// 카테고리별 키워드 룰 (영문 lowercase 매칭)
const RULES = {
  fraud_suspect: [
    /never\s+received/i,             // INR scam (트래킹 delivered + never received)
    /\bpartial\s+refund\s+please\b/i,
    /\bwill\s+leave\s+(?:negative|bad)\b/i,
    /\bsend\s+(?:another|me)\s+(?:one|item)\s+(?:for\s+)?free\b/i,
    /\bthreat(?:en)?\b/i,
  ],
  complaint: [
    /\bdamaged\b/i, /\bbroken\b/i, /\bterrible\b/i,
    /\bscam\b/i, /\blie\b/i, /\bfraud\b/i, /\bawful\b/i,
    /\bworst\b/i, /\bdisappoint(?:ed|ing)?\b/i,
    /파손/i, /불량/i, /화\s*나/i,
  ],
  pre_purchase: [
    /\bdo\s+you\s+have\b/i,
    /\bcan\s+you\b/i,
    /\bis\s+it\s+possible\b/i,
    /\bbefore\s+i\s+buy\b/i,
    /\bship\s+to\s+\w+/i,             // "Do you ship to Canada?" 같은 사전 질문
    /\b(do\s+you|will\s+you)\s+(sell|carry|stock)\b/i,
  ],
  shipping: [
    /\bwhere\s+is\b/i, /\bwhen\s+(?:will|do)\b/i,
    /\bship(?:ped|ping|s)?\b/i, /\btracking\b/i, /\bdelivery\b/i, /\bdeliver(?:ed)?\b/i,
    /배송/i, /발송/i, /언제\s*도착/i, /송장/i,
  ],
  refund: [
    /\brefund\b/i, /\bmoney\s+back\b/i, /\breturn\b/i,
    /환불/i, /반품/i,
  ],
  stock: [
    /\bin\s+stock\b/i, /\bavailable\b/i, /\brestock\b/i, /\bback\s+in\s+stock\b/i,
    /재고/i, /입고/i,
  ],
  thanks: [
    /\bthank\b/i, /\bthanks\b/i, /\bthx\b/i, /\bgreat\b/i, /\bawesome\b/i, /\blove\s+it\b/i,
    /감사/i, /고마워/i, /최고/i,
  ],
};

// 우선순위 (사장님 짚을 점 A)
const PRIORITY = ['fraud_suspect', 'complaint', 'pre_purchase', 'shipping', 'refund', 'stock', 'thanks'];

/**
 * @param {string} message — 고객 메시지
 * @returns {{ detectedCategory: string|null, candidates: string[] }}
 */
function classify(message) {
  const text = String(message || '');
  if (!text.trim()) return { detectedCategory: null, candidates: [] };

  const matched = [];
  for (const cat of PRIORITY) {
    const rules = RULES[cat] || [];
    if (rules.some(re => re.test(text))) matched.push(cat);
  }

  return {
    detectedCategory: matched[0] || null,
    candidates: matched,
  };
}

module.exports = { classify, PRIORITY, RULES };
