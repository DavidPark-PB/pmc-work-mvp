/**
 * 상품 이미지 URL 정리 — 플랫폼에 보내기 전 마지막 방어선
 *
 * CSV 원본에는 한 칸에 URL 여러 개가 공백이나 '|||' 로 붙어 있는 경우가 있다.
 * 그대로 보내면 eBay가 "Input data for tag <Item.PictureDetails.PictureURL[n]> is invalid" 로 거부한다.
 */

/** eBay 무료 사진 최대 장수 */
export const MAX_IMAGE_URLS = 24;

/** 여러 URL이 붙은 문자열을 나누고, http(s) URL만 순서대로 남긴다 (중복 제거) */
export function normalizeImageUrls(raw: unknown[], limit = MAX_IMAGE_URLS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    for (const piece of value.split(/[\s|]+/)) {
      const url = piece.trim().replace(/[),.]+$/, '');
      if (!/^https?:\/\/\S+$/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
