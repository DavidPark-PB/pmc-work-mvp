/**
 * 카드명세서 CSV 파서 — 한국 주요 카드사(신한/국민/삼성/현대/하나/롯데 등) 포맷을
 * 헤더 키워드로 자동 감지해 공통 스키마로 변환.
 *
 * 출력: [{ paidAt: 'YYYY-MM-DD', amount: number, currency: 'KRW'|..., merchant, cardLast4, rawRow }]
 */
const iconv = require('iconv-lite');
const Papa = require('papaparse');

// 한국어 헤더 후보들 (소문자 + 공백 제거 후 비교)
const FIELD_ALIASES = {
  paidAt: ['이용일', '이용일자', '거래일', '거래일자', '승인일', '승인일자', '결제일', '결제일자', '일자', 'date'],
  merchant: ['가맹점명', '가맹점', '이용처', '이용가맹점', '사용처', '가맹점이름', 'merchant'],
  amount: ['이용금액', '청구금액', '승인금액', '결제금액', '거래금액', '금액', 'amount'],
  card: ['카드번호', '카드뒷자리', '카드', 'cardno', 'card', '카드번호뒷4자리'],
  memo: ['메모', '내역', '적요', '거래구분', 'memo'],
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-()]/g, '');
}

// UTF-8 / UTF-8 BOM / CP949(EUC-KR) 중 자동 감지
function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  // BOM check
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  // UTF-8 유효성 검사
  const utf8Attempt = buf.toString('utf8');
  const invalidCount = (utf8Attempt.match(/\uFFFD/g) || []).length;
  if (invalidCount === 0) return utf8Attempt;
  // 한글 많이 깨지면 CP949 시도
  try {
    return iconv.decode(buf, 'cp949');
  } catch {
    return utf8Attempt;
  }
}

function parseCsvText(text) {
  const r = Papa.parse(text, { skipEmptyLines: true });
  return r.data || [];
}

// 헤더 행 찾기: FIELD_ALIASES 중 2개 이상 일치하는 행
function detectHeaderRowIdx(rows) {
  const searchLimit = Math.min(rows.length, 20);
  for (let i = 0; i < searchLimit; i++) {
    const row = rows[i] || [];
    let hits = 0;
    for (const aliases of Object.values(FIELD_ALIASES)) {
      if (row.some(cell => aliases.some(a => norm(cell).includes(norm(a))))) hits++;
    }
    if (hits >= 2) return i;
  }
  return -1;
}

function mapColumns(headerRow) {
  const map = {};
  headerRow.forEach((cell, idx) => {
    const n = norm(cell);
    if (!n) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some(a => n.includes(norm(a)))) {
        map[field] = idx;
        return;
      }
    }
  });
  return map;
}

// 날짜 파싱: "2026-04-15", "2026/04/15", "2026.04.15", "26.04.15", "4월 15일" 등
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // ISO/표준형
  let m = str.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // 2자리 연도
  m = str.match(/(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) {
    const yy = parseInt(m[1], 10);
    const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${fullYear}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  // YYYYMMDD
  m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseAmount(s) {
  if (s == null) return NaN;
  const cleaned = String(s).replace(/[^0-9\-.]/g, '');
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : NaN; // 청구금액이 음수로 찍히는 경우도 있음
}

function extractCardLast4(s) {
  if (!s) return null;
  // "1234-5678-****-9012" → 9012
  const m = String(s).match(/(\d{4})(?!.*\d{4})/);
  return m ? m[1] : null;
}

/**
 * 메인 파서. buf는 Buffer, result는 구조화된 행 + 경고.
 */
function parseExpenseCsvBuffer(buf) {
  const text = decodeBuffer(buf);
  const rows = parseCsvText(text);
  if (rows.length < 2) {
    return { ok: false, error: 'CSV에 데이터가 없습니다', rows: [] };
  }
  const headerIdx = detectHeaderRowIdx(rows);
  if (headerIdx < 0) {
    return { ok: false, error: '헤더 행을 찾을 수 없습니다. 카드명세서 CSV인지 확인하세요.', rows: [] };
  }
  const mapping = mapColumns(rows[headerIdx]);
  if (mapping.paidAt === undefined || mapping.amount === undefined) {
    return { ok: false, error: '날짜·금액 컬럼을 찾을 수 없습니다', rows: [] };
  }

  const out = [];
  const warnings = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const paidAt = parseDate(r[mapping.paidAt]);
    const amount = parseAmount(r[mapping.amount]);
    if (!paidAt || !Number.isFinite(amount) || amount === 0) continue; // skip noise
    const merchant = String(r[mapping.merchant] ?? '').trim();
    const memo = mapping.memo != null ? String(r[mapping.memo] ?? '').trim() : '';
    const cardLast4 = mapping.card != null ? extractCardLast4(r[mapping.card]) : null;
    out.push({
      paidAt,
      amount,
      currency: 'KRW',
      merchant: merchant || null,
      memo: memo || null,
      cardLast4,
      rawRow: r,
    });
  }

  if (out.length === 0) {
    return { ok: false, error: '유효한 거래 행을 찾을 수 없습니다', rows: [], warnings };
  }
  return { ok: true, rows: out, headerRow: rows[headerIdx], mapping, warnings };
}

module.exports = { parseExpenseCsvBuffer };
