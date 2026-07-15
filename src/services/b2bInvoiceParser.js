/**
 * 수기 인보이스 파싱 — PDF/이미지를 Claude 에 넘겨 구조화 JSON 으로 추출.
 * 카탈로그 자동 매칭 없이 raw 텍스트 필드만 반환 (사용자가 저장 전 검토/수정).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MODEL_FALLBACK = 'claude-haiku-4-5-20251001';

const PROMPT = `당신은 B2B 인보이스/견적서 파서입니다. 이미지 또는 PDF 에서 다음 JSON 스키마로 데이터를 추출하세요. 값이 명확하지 않으면 빈 문자열/0. 추측은 하지 마세요.

{
  "docType": "INVOICE" 또는 "QUOTE" (문서 제목에 Quote/Quotation 있으면 QUOTE, Invoice 면 INVOICE, 불명확 시 INVOICE),
  "invoiceNo": "문서번호 (예: INV-12345, Q-2026-001)",
  "invoiceDate": "YYYY-MM-DD (발행일)",
  "dueDate": "YYYY-MM-DD (만기일/유효일, 없으면 빈 문자열)",
  "buyerName": "구매자명/회사명",
  "buyerAddress": "구매자 주소",
  "buyerEmail": "구매자 이메일 (있으면)",
  "buyerPhone": "구매자 전화 (있으면)",
  "buyerVat": "VAT 번호 (있으면)",
  "buyerEori": "EORI 번호 (있으면)",
  "currency": "USD / EUR / KRW / JPY 중 (없으면 USD)",
  "items": [
    {
      "sku": "상품 코드 (없으면 빈 문자열)",
      "name": "상품명",
      "qty": 숫자 (수량),
      "price": 숫자 (단가),
      "total": 숫자 (행별 합계, 없으면 qty*price)
    }
  ],
  "subtotal": 숫자,
  "tax": 숫자 (없으면 0),
  "shipping": 숫자 (배송비, 없으면 0),
  "total": 숫자 (총액),
  "paymentTerms": "지불 조건 (있으면, 예: 100% T/T in advance)",
  "notes": "기타 특이사항 (있으면)"
}

**규칙**:
- JSON 만 출력 (코드블록·설명·markdown 금지)
- 금액은 숫자 (쉼표/통화기호 제거)
- 날짜는 YYYY-MM-DD
- 항목이 10개 초과면 상위 10개만
- 문서에 없는 필드는 빈 문자열 "" (undefined/null 금지)`;

function _isImage(mime) { return /^image\/(jpeg|png|webp|gif)$/i.test(mime || ''); }
function _isPdf(mime) { return /^application\/pdf$/i.test(mime || ''); }

// PDF 매직 바이트 검증 — Anthropic 이 non-PDF 를 400 으로 거부하기 전 우리가 먼저 잡음.
// PDF 는 항상 '%PDF-' (25 50 44 46 2D) 로 시작. xlsx 를 확장자만 .pdf 로 바꾼 케이스 등 조기 감지.
function _looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D;
}

// axios 에러에서 Anthropic API 응답 body 의 상세 원인 추출.
// e.response.data.error.{type,message} 가 표준. 이거 그대로 던지면 사장님이 화면에서 원인 확인 가능.
class ParseError extends Error {
  constructor(message, { status = 500, anthropicType, anthropicRequestId } = {}) {
    super(message);
    this.name = 'ParseError';
    this.status = status;
    this.anthropicType = anthropicType;
    this.anthropicRequestId = anthropicRequestId;
  }
}

function _extractAnthropicError(e) {
  const status = e.response?.status;
  const body = e.response?.data;
  const anthErr = body?.error;
  if (anthErr?.message) {
    return {
      status,
      type: anthErr.type || null,
      message: anthErr.message,
      requestId: e.response?.headers?.['request-id'] || null,
    };
  }
  // JSON 아닌 응답 (HTML 에러 페이지 등)
  const raw = typeof body === 'string' ? body.slice(0, 300) : (body ? JSON.stringify(body).slice(0, 300) : e.message);
  return { status, type: null, message: raw, requestId: e.response?.headers?.['request-id'] || null };
}

async function parseManualInvoice(buffer, mimeType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ParseError('ANTHROPIC_API_KEY 가 config/.env 에 설정되지 않았습니다', { status: 503 });
  if (!buffer || !buffer.length) throw new ParseError('파일이 비어있습니다', { status: 400 });

  const mt = (mimeType || '').toLowerCase();
  const base64 = Buffer.from(buffer).toString('base64');

  let contentBlock;
  if (_isPdf(mt)) {
    // PDF magic byte 검증 — Anthropic 에 보내기 전 조기 감지 (사장님 보고 2026-07-03: xlsx 를
    // PDF 확장자로 저장한 경우 등에서 400 이 원인 불명으로 남던 문제)
    if (!_looksLikePdf(buffer)) {
      throw new ParseError(
        '파일이 유효한 PDF 형식이 아닙니다 (매직 바이트 %PDF- 없음). ' +
        '엑셀/워드로 저장한 파일이면 "다른 이름으로 저장 → PDF" 로 다시 저장하거나, 파일 자체를 첨부해주세요.',
        { status: 400 }
      );
    }
    // Anthropic 한도: 32MB (base64 후) / 600 페이지 — 여기서 크기만 사전 체크
    if (base64.length > 32 * 1024 * 1024) {
      throw new ParseError(
        `PDF 가 너무 큽니다 (base64 ${Math.round(base64.length / 1024 / 1024)}MB, 한도 32MB). PDF 를 압축하거나 페이지를 줄여주세요.`,
        { status: 400 }
      );
    }
    contentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    };
  } else if (_isImage(mt)) {
    contentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mt, data: base64 },
    };
  } else {
    throw new ParseError(`지원하지 않는 파일 형식: ${mt || 'unknown'} (PDF·JPG·PNG·WEBP 만 지원)`, { status: 400 });
  }

  const callAPI = async (model) => axios.post(ANTHROPIC_API_URL, {
    model,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [contentBlock, { type: 'text', text: PROMPT }],
    }],
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 90000,
  });

  let resp;
  let firstErr = null;
  try {
    resp = await callAPI(MODEL);
  } catch (e) {
    firstErr = _extractAnthropicError(e);
    console.warn(`[b2bInvoiceParser] ${MODEL} 실패 (${firstErr.status} ${firstErr.type || ''}): ${firstErr.message}`);
    // 400 (invalid_request_error / permission_error) 는 fallback 도 같은 결과 → 즉시 throw
    if (firstErr.status && firstErr.status >= 400 && firstErr.status < 500) {
      throw new ParseError(
        `Anthropic API ${firstErr.status}: ${firstErr.message}`,
        { status: firstErr.status, anthropicType: firstErr.type, anthropicRequestId: firstErr.requestId }
      );
    }
    // 5xx / 네트워크 문제만 fallback
    try {
      resp = await callAPI(MODEL_FALLBACK);
    } catch (e2) {
      const err2 = _extractAnthropicError(e2);
      console.error(`[b2bInvoiceParser] ${MODEL_FALLBACK} 도 실패 (${err2.status}): ${err2.message}`);
      throw new ParseError(
        `AI 파싱 실패 — 두 모델 모두 에러. ${MODEL}: ${firstErr.message} / ${MODEL_FALLBACK}: ${err2.message}`,
        { status: err2.status || 502, anthropicType: err2.type, anthropicRequestId: err2.requestId }
      );
    }
  }

  const text = resp.data?.content?.[0]?.text || '';
  const parsed = _extractJson(text);
  if (!parsed) throw new ParseError(`AI 응답 파싱 실패. 원문: ${text.slice(0, 300)}`, { status: 502 });

  return _normalize(parsed);
}

function _extractJson(text) {
  // Claude 는 보통 JSON 만 반환하지만 가끔 ```json 블록 감싸거나 앞뒤 설명 추가
  const trimmed = String(text).trim();
  // fenced block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // 첫 { 부터 마지막 } 까지
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  try { return JSON.parse(trimmed); } catch {}
  return null;
}

function _toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,\s$€¥₩₹£]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function _normalize(raw) {
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 20).map(it => ({
    sku: String(it.sku || '').trim(),
    name: String(it.name || '').trim(),
    qty: _toNum(it.qty),
    price: _toNum(it.price),
    total: _toNum(it.total) || (_toNum(it.qty) * _toNum(it.price)),
  })).filter(it => it.name || it.sku) : [];

  const subtotal = _toNum(raw.subtotal) || items.reduce((s, i) => s + i.total, 0);
  const tax = _toNum(raw.tax);
  const shipping = _toNum(raw.shipping);
  const total = _toNum(raw.total) || subtotal + tax + shipping;

  return {
    docType: /QUOTE/i.test(raw.docType || '') ? 'QUOTE' : 'INVOICE',
    invoiceNo: String(raw.invoiceNo || '').trim(),
    invoiceDate: _normalizeDate(raw.invoiceDate),
    dueDate: _normalizeDate(raw.dueDate),
    buyerName: String(raw.buyerName || '').trim(),
    buyerAddress: String(raw.buyerAddress || '').trim(),
    buyerEmail: String(raw.buyerEmail || '').trim(),
    buyerPhone: String(raw.buyerPhone || '').trim(),
    buyerVat: String(raw.buyerVat || '').trim(),
    buyerEori: String(raw.buyerEori || '').trim(),
    currency: String(raw.currency || 'USD').toUpperCase().slice(0, 3),
    items,
    subtotal,
    tax,
    shipping,
    total,
    paymentTerms: String(raw.paymentTerms || '').trim(),
    notes: String(raw.notes || '').trim(),
  };
}

function _normalizeDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try Date parse
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return '';
}

module.exports = { parseManualInvoice, ParseError };
