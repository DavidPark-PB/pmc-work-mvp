/**
 * SuspiciousBuyerMatcher — 분석된 메시지 + 추출된 변수 → 진상 DB 매칭 (PR CS-G2-B)
 *
 * 정책:
 *   - extractedVars (BuyerExtractor 결과: buyerName) + 메시지 텍스트의 이메일 정규식 + caller 가 전달한 platformIds
 *   - 한 건만 매칭되어도 경고 (사장님 spec)
 *   - 결과는 internal shape 으로 반환 (caller 가 admin/staff 결정)
 */
'use strict';

const buyerRepo = require('../../db/suspiciousBuyerRepository');

// 메시지 텍스트에서 이메일 추출 (단순 정규식)
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function _extractEmails(text) {
  if (!text) return [];
  const matches = String(text).match(EMAIL_RE) || [];
  return [...new Set(matches.map(s => s.toLowerCase()))];
}

/**
 * @param {Object} input
 * @param {string} [input.message]            — 원본 고객 메시지
 * @param {string} [input.buyerName]          — BuyerExtractor 결과
 * @param {Object} [input.platformIds]        — { ebay, shopify, ... } — caller 가 알면 전달
 * @returns {Promise<{matches: Array, primary: Object|null}>}
 *   matches  = 매칭된 진상 바이어 internal shape 배열
 *   primary  = 첫 번째 매칭 (UI 의 경고 카드용). 없으면 null
 */
async function findMatches({ message, buyerName, platformIds } = {}) {
  const emails = _extractEmails(message);
  const allMatches = [];
  const seen = new Set();

  // email 마다 한 번씩 호출
  for (const email of emails) {
    const rows = await buyerRepo.findMatches({ email });
    for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); allMatches.push(r); }
  }

  // platformIds 직접 매칭
  if (platformIds && typeof platformIds === 'object') {
    const rows = await buyerRepo.findMatches({ platformIds });
    for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); allMatches.push(r); }
  }

  // 이름 매칭 (정확도 낮음 — 보조)
  if (buyerName) {
    const rows = await buyerRepo.findMatches({ name: buyerName });
    for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); allMatches.push(r); }
  }

  return {
    matches: allMatches,
    primary: allMatches[0] || null,
    extractedEmails: emails,
  };
}

module.exports = { findMatches };
