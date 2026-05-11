/**
 * BuyerExtractor — 메시지 텍스트에서 buyer_name / order_id / tracking_number 추출 (PR CS-G1)
 *
 * 정책 (사장님 짚을 점 B/3):
 *   - 추출 결과는 input 필드에 값으로 채움 (placeholder 아님). UI 가 🤖 아이콘 표시.
 *   - 추출 실패해도 OK — UI 가 직원 직접 입력 받음.
 *   - 정규식 단순. AI X.
 */
'use strict';

// 주문번호: "order #ABC-1234", "order ABC1234", "주문번호 ABC1234"
const ORDER_REGEXES = [
  /order(?:\s*#)?\s*([A-Z0-9][A-Z0-9-]{4,30})/i,
  /(?:주문|order\s*number)\s*(?:번호\s*)?:?\s*([A-Z0-9][A-Z0-9-]{4,30})/i,
];

// 트래킹: "tracking 1Z999AA10123456784", "tracking number XYZ123"
const TRACKING_REGEXES = [
  /tracking(?:\s*(?:number|#))?\s*:?\s*([A-Z0-9]{8,40})/i,
  /(?:송장\s*(?:번호)?|운송장)\s*:?\s*([A-Z0-9]{8,40})/i,
];

// buyer 이름: "Hi, this is John Smith", "I am Jane", "from John Doe"
// 영문 이름 (First Last) 만 단순 추출. 한국어/한자는 식별 어려워 omit (직원이 입력).
const NAME_REGEXES = [
  /\b(?:i\s+am|this\s+is|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
  /\bbest\s+regards,\s*\n?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
];

function _firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * @param {string} message
 * @returns {{ buyerName: string|null, orderId: string|null, trackingNumber: string|null }}
 */
function extract(message) {
  const text = String(message || '');
  if (!text.trim()) return { buyerName: null, orderId: null, trackingNumber: null };

  return {
    buyerName:      _firstMatch(text, NAME_REGEXES),
    orderId:        _firstMatch(text, ORDER_REGEXES),
    trackingNumber: _firstMatch(text, TRACKING_REGEXES),
  };
}

module.exports = { extract };
