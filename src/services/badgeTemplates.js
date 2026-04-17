/**
 * SVG badge templates — 캔바 스타일 뱃지 (신제품/재고입고/세일 등) 무료 생성.
 *
 * Sharp가 SVG 버퍼를 래스터(PNG)로 합성할 수 있어서 외부 의존 없이 즉시 PNG 출력.
 * 자주 쓰는 한국 커머스 키워드 10종 × 4가지 스타일 = 40가지 변형을 프로그래매틱하게 제공.
 *
 * Gemini 결제 미연결이어도 이 라이브러리는 무조건 동작.
 */

// 자주 쓰는 한국 커머스 키워드 → 영문 레이블 쌍.
// 서브레이블은 이중 언어 뱃지용 작은 글씨.
const KEYWORD_MAP = {
  '신제품':   { main: 'NEW',          sub: '신제품' },
  '재고입고': { main: 'IN STOCK',     sub: '재고입고' },
  '세일':     { main: 'SALE',         sub: '특가' },
  '할인':     { main: '% OFF',        sub: '할인' },
  '품절임박': { main: 'LOW STOCK',    sub: '품절임박' },
  '예약':     { main: 'PRE-ORDER',    sub: '예약판매' },
  '한정':     { main: 'LIMITED',      sub: '한정수량' },
  'BEST':     { main: 'BEST',         sub: '베스트' },
  '무료배송': { main: 'FREE SHIPPING', sub: '무료배송' },
  '마감임박': { main: 'ENDING SOON',  sub: '마감임박' },
};

const STYLE_PRESETS = {
  // 빨간 원형 뱃지 — 눈에 띄는 포인트
  redCircle: {
    label: '빨간 원형',
    build: ({ main, sub }) => circleBadge({ main, sub, fg: '#fff', bg: '#e53935', ring: '#fff' }),
  },
  // 노란 리본 — SALE/할인 느낌
  yellowRibbon: {
    label: '노란 리본',
    build: ({ main, sub }) => ribbonBadge({ main, sub, fg: '#5a3a00', bg: '#ffc107', shadow: '#b28400' }),
  },
  // 검정 사각 — 모던·미니멀
  blackTag: {
    label: '검정 사각',
    build: ({ main, sub }) => tagBadge({ main, sub, fg: '#fff', bg: '#111', accent: '#ffd740' }),
  },
  // 별 폭발 모양 — 강한 어텐션
  starburst: {
    label: '별모양',
    build: ({ main, sub }) => starburstBadge({ main, sub, fg: '#fff', bg: '#d81b60' }),
  },
};

/** 키워드 목록 (UI 칩) */
function listKeywords() {
  return Object.keys(KEYWORD_MAP);
}

/** 스타일 목록 (UI 드롭다운) */
function listStyles() {
  return Object.entries(STYLE_PRESETS).map(([k, v]) => ({ key: k, label: v.label }));
}

/**
 * 한국어 키워드 또는 자유 텍스트 입력받아 SVG 문자열 반환.
 * 자유 텍스트는 main으로만 렌더 (sub 없음).
 */
function getBadgeSvg({ keyword, style = 'redCircle', customText = null }) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.redCircle;
  let content;
  if (customText && customText.trim()) {
    content = { main: customText.trim().slice(0, 20), sub: null };
  } else {
    const entry = KEYWORD_MAP[keyword];
    if (!entry) return null;
    content = entry;
  }
  return preset.build(content);
}

// ---------- SVG 빌더 (512×512 기준, 썸네일에서 리사이즈됨) ----------

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function circleBadge({ main, sub, fg, bg, ring }) {
  const mainText = escapeXml(main);
  const subText = sub ? escapeXml(sub) : null;
  const mainFontSize = mainText.length > 8 ? 54 : 72;
  const mainY = subText ? 240 : 280;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <circle cx="256" cy="256" r="230" fill="${bg}" stroke="${ring}" stroke-width="8"/>
  <circle cx="256" cy="256" r="200" fill="none" stroke="${ring}" stroke-width="2" stroke-dasharray="6 6" opacity="0.55"/>
  <text x="256" y="${mainY}" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="900" font-size="${mainFontSize}" fill="${fg}" letter-spacing="2">${mainText}</text>
  ${subText ? `<text x="256" y="310" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="700" font-size="32" fill="${fg}" opacity="0.92">${subText}</text>` : ''}
</svg>`;
}

function ribbonBadge({ main, sub, fg, bg, shadow }) {
  const mainText = escapeXml(main);
  const subText = sub ? escapeXml(sub) : null;
  const mainFontSize = mainText.length > 10 ? 56 : 74;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <polygon points="40,360 40,152 256,60 472,152 472,360 256,452" fill="${shadow}" transform="translate(8 10)" opacity="0.35"/>
  <polygon points="40,350 40,150 256,58 472,150 472,350 256,450" fill="${bg}"/>
  <polygon points="70,330 70,170 256,88 442,170 442,330 256,432" fill="none" stroke="${fg}" stroke-width="4" opacity="0.3"/>
  <text x="256" y="${subText ? 230 : 278}" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="900" font-size="${mainFontSize}" fill="${fg}" letter-spacing="4">${mainText}</text>
  ${subText ? `<text x="256" y="295" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="700" font-size="34" fill="${fg}" opacity="0.85">${subText}</text>` : ''}
</svg>`;
}

function tagBadge({ main, sub, fg, bg, accent }) {
  const mainText = escapeXml(main);
  const subText = sub ? escapeXml(sub) : null;
  const mainFontSize = mainText.length > 10 ? 54 : 68;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="48" y="144" width="416" height="224" rx="16" fill="${bg}"/>
  <rect x="64" y="160" width="384" height="192" rx="8" fill="none" stroke="${fg}" stroke-width="3" opacity="0.25"/>
  <rect x="64" y="160" width="8" height="192" fill="${accent}"/>
  <text x="256" y="${subText ? 244 : 278}" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="900" font-size="${mainFontSize}" fill="${fg}" letter-spacing="3">${mainText}</text>
  ${subText ? `<text x="256" y="308" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="600" font-size="30" fill="${accent}">${subText}</text>` : ''}
</svg>`;
}

function starburstBadge({ main, sub, fg, bg }) {
  // 20-point starburst via SVG path — 강한 세일/포인트 뱃지
  const mainText = escapeXml(main);
  const subText = sub ? escapeXml(sub) : null;
  const mainFontSize = mainText.length > 8 ? 54 : 72;
  const points = buildStarburstPoints(256, 256, 230, 190, 20);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <polygon points="${points}" fill="${bg}"/>
  <circle cx="256" cy="256" r="168" fill="${bg}"/>
  <circle cx="256" cy="256" r="152" fill="none" stroke="${fg}" stroke-width="3" stroke-dasharray="4 4" opacity="0.5"/>
  <text x="256" y="${subText ? 246 : 280}" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="900" font-size="${mainFontSize}" fill="${fg}" letter-spacing="2">${mainText}</text>
  ${subText ? `<text x="256" y="306" text-anchor="middle" font-family="'Noto Sans KR', Arial, sans-serif" font-weight="700" font-size="30" fill="${fg}" opacity="0.92">${subText}</text>` : ''}
</svg>`;
}

function buildStarburstPoints(cx, cy, outer, inner, spikes) {
  const pts = [];
  const total = spikes * 2;
  for (let i = 0; i < total; i++) {
    const angle = (Math.PI * 2 * i) / total - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

module.exports = { KEYWORD_MAP, STYLE_PRESETS, listKeywords, listStyles, getBadgeSvg };
