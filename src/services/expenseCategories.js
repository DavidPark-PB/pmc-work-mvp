/**
 * 지출 카테고리 — 비즈니스에 맞춰 11종.
 * AI 분류 프롬프트, UI 드롭다운, 집계 차트 색상이 모두 여기서 파생된다.
 */
const CATEGORIES = [
  { key: '운송', label: '운송/배송', color: '#1565c0', hint: '국제배송, 택배, 퀵, 포워딩' },
  { key: '임대료', label: '임대료', color: '#6a1b9a', hint: '사무실, 창고, 공유오피스' },
  { key: '마케팅', label: '마케팅', color: '#d81b60', hint: '광고, 프로모션, 인플루언서' },
  { key: '인건비', label: '인건비', color: '#2e7d32', hint: '직원 급여, 외주비' },
  { key: '소프트웨어', label: '소프트웨어', color: '#0288d1', hint: 'SaaS 구독, API 사용료' },
  { key: '재료비', label: '재료비/재고', color: '#ef6c00', hint: '상품 매입, 포장재, 소모품' },
  { key: '수수료', label: '수수료/세금', color: '#616161', hint: '플랫폼 수수료, PG, 세금' },
  { key: '공과금', label: '공과금', color: '#455a64', hint: '전기, 수도, 가스, 통신' },
  { key: '접대식비', label: '접대/식비', color: '#c62828', hint: '회식, 거래처 미팅, 음식' },
  { key: '교통', label: '교통', color: '#00838f', hint: '택시, 지하철, 주차, 톨게이트' },
  { key: '기타', label: '기타', color: '#8d6e63', hint: '위에 없는 지출' },
];

const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function isValid(key) {
  return CATEGORY_KEYS.includes(key);
}

function normalize(key) {
  if (!key) return '기타';
  const s = String(key).trim();
  return isValid(s) ? s : '기타';
}

module.exports = { CATEGORIES, CATEGORY_KEYS, CATEGORY_MAP, isValid, normalize };
