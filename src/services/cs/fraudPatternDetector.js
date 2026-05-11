/**
 * FraudPatternDetector — 메시지에서 5 위험 신호 감지 (PR CS-G2-B)
 *
 * 사장님 spec 5 신호:
 *   1. "I never received" + 트래킹 delivered → 🚩 INR scam
 *   2. "broken/damaged" + 사진 첨부 없음 → 🚩 파손 사기 의심
 *   3. "negative feedback" 협박 → 🚩 협박
 *   4. "partial refund" + 첫 거래 → 🚩 부분환불 사기
 *   5. "send another one for free" → 🚩 재발송 사기
 *
 * 정책:
 *   - 룰 기반 (AI X)
 *   - "트래킹 delivered" / "사진 첨부 없음" / "첫 거래" 같은 컨텍스트는
 *     caller 가 hint 로 전달 (없으면 keyword 만으로 의심도 lowered)
 *   - severity: 'critical' | 'high' | 'medium'
 */
'use strict';

// 룰 정의: { type, severity, baseRe, requiresContext, descriptionKey }
const RULES = [
  {
    type: 'inr_scam',
    severity: 'critical',
    description: '🚩 INR scam — "받지 못함" 주장 + 트래킹 delivered 가능성',
    test: (text, hints) => {
      const hit = /\b(?:never|haven'?t|did\s+not|didn'?t)\s+(?:received?|got|gotten)\b/i.test(text)
        || /\b(?:not\s+(?:arrived|delivered)|missing\s+package)\b/i.test(text)
        || /(받지\s*못|도착\s*안|안\s*받았)/i.test(text);
      if (!hit) return false;
      // hints.trackingDelivered=true 면 critical, 없으면 high
      return hints?.trackingDelivered === true ? 'critical' : 'high';
    },
  },
  {
    type: 'broken_no_photo',
    severity: 'high',
    description: '🚩 파손 사기 의심 — 파손 주장 + 사진 첨부 없음',
    test: (text, hints) => {
      const hit = /\b(?:broken|damaged|cracked|destroyed)\b/i.test(text)
        || /(파손|망가|깨졌)/i.test(text);
      if (!hit) return false;
      // hints.hasPhotos=false 면 high, true 면 medium
      return hints?.hasPhotos === false ? 'high' : 'medium';
    },
  },
  {
    type: 'feedback_threat',
    severity: 'critical',
    description: '🚩 협박 — 부정적 피드백 / 디스퓨트 위협',
    test: (text) => {
      const hit = /\b(?:negative\s+feedback|leave\s+(?:bad|negative))\b/i.test(text)
        || /\b(?:open\s+a\s+case|paypal\s+dispute|chargeback)\b/i.test(text)
        || /(부정\s*적\s*피드백|악\s*평|디스퓨트)/i.test(text);
      return hit ? 'critical' : false;
    },
  },
  {
    type: 'partial_refund_scam',
    severity: 'medium',
    description: '🚩 부분환불 사기 가능성 — 부분환불 요청',
    test: (text, hints) => {
      const hit = /\b(?:partial\s+refund)\b/i.test(text)
        || /(부분\s*환불)/i.test(text);
      if (!hit) return false;
      // hints.firstTransaction=true 면 high
      return hints?.firstTransaction === true ? 'high' : 'medium';
    },
  },
  {
    type: 'free_resend',
    severity: 'high',
    description: '🚩 재발송 사기 — 무료 재발송 요청',
    test: (text) => {
      const hit = /\bsend\s+(?:another|me)\s+(?:one|item)\s+(?:for\s+)?free\b/i.test(text)
        || /\bresend\s+(?:for\s+)?free\b/i.test(text)
        || /(무료\s*재\s*발송)/i.test(text);
      return hit ? 'high' : false;
    },
  },
];

/**
 * @param {string} message
 * @param {Object} [hints] — { trackingDelivered, hasPhotos, firstTransaction }
 * @returns {Array<{type, severity, description}>}
 */
function detect(message, hints = {}) {
  const text = String(message || '');
  if (!text.trim()) return [];

  const found = [];
  for (const rule of RULES) {
    const result = rule.test(text, hints);
    if (result) {
      found.push({
        type: rule.type,
        severity: typeof result === 'string' ? result : rule.severity,
        description: rule.description,
      });
    }
  }
  // critical → high → medium 정렬
  const order = { critical: 0, high: 1, medium: 2 };
  found.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));
  return found;
}

module.exports = { detect, RULES };
