/**
 * parsers - 크롤링 데이터 파싱 유틸리티
 * 원본: MrCrawler/mr-crawler/lib/parsers/utils.ts
 *
 * 기능: 가격 파싱, 숫자 추출, 평점 파싱, URL 변환, 재고 상태 파싱
 */
const crypto = require('crypto');

/** 상품 ID 생성 (URL 또는 이름 기반 해시) */
function generateProductId(identifier) {
  return crypto.createHash('md5').update(identifier).digest('hex').slice(0, 12);
}

/**
 * 가격 문자열에서 숫자 추출
 * "₩12,345" -> 12345
 * "12,345원" -> 12345
 * "$99.99" -> 99.99
 */
function parsePrice(priceText) {
  if (!priceText) return 0;

  const cleaned = priceText.replace(/[^\d.,]/g, '');

  // 한국 원화 형식 (콤마 = 천단위 구분자)
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    return parseInt(cleaned.replace(/,/g, ''), 10) || 0;
  }

  // 달러/유로 형식 (마침표 = 소수점)
  if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      return parseFloat(cleaned.replace(/,/g, '')) || 0;
    }
    return parseInt(cleaned.replace(/[.,]/g, ''), 10) || 0;
  }

  return parseInt(cleaned, 10) || 0;
}

/** 숫자 문자열에서 정수 추출: "리뷰 1,234개" -> 1234 */
function parseNumber(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[^\d]/g, '');
  return parseInt(cleaned, 10) || 0;
}

/** 평점 파싱: "4.5 / 5" -> 4.5, "★★★★☆" -> 4 */
function parseRating(ratingText) {
  if (!ratingText) return undefined;

  const numMatch = ratingText.match(/(\d+\.?\d*)/);
  if (numMatch) {
    const rating = parseFloat(numMatch[1]);
    if (rating > 5) return Math.round((rating / 2) * 10) / 10;
    return rating;
  }

  const filledStars = (ratingText.match(/★|⭐/g) || []).length;
  if (filledStars > 0) return filledStars;

  return undefined;
}

/** 상대 URL → 절대 URL 변환 */
function toAbsoluteUrl(relativeUrl, baseUrl) {
  if (!relativeUrl) return '';
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
  if (relativeUrl.startsWith('//')) return 'https:' + relativeUrl;
  try {
    const base = new URL(baseUrl);
    return new URL(relativeUrl, base.origin).href;
  } catch {
    return relativeUrl;
  }
}

/** 텍스트 정제 (공백 정리) */
function cleanText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').replace(/[\n\r\t]/g, ' ').trim();
}

/** 재고 상태 파싱 */
function parseStockStatus(text) {
  if (!text) return true;
  const lowerText = text.toLowerCase();
  const outOfStockKeywords = [
    '품절', 'sold out', 'out of stock', '재고없음', '재고 없음',
    '일시품절', '매진', 'unavailable', '구매불가',
  ];
  return !outOfStockKeywords.some((keyword) => lowerText.includes(keyword));
}

/** 통화 코드 추출 */
function parseCurrency(priceText) {
  if (priceText.includes('$')) return 'USD';
  if (priceText.includes('€')) return 'EUR';
  if (priceText.includes('£')) return 'GBP';
  if (priceText.includes('¥')) return 'JPY';
  if (priceText.includes('₩') || priceText.includes('원')) return 'KRW';
  return 'KRW';
}

module.exports = {
  generateProductId,
  parsePrice,
  parseNumber,
  parseRating,
  toAbsoluteUrl,
  cleanText,
  parseStockStatus,
  parseCurrency,
};
