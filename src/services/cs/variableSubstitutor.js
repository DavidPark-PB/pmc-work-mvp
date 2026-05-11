/**
 * VariableSubstitutor — 템플릿 본문 + 영업 옵션 → 합쳐진 텍스트 (PR CS-G1)
 *
 * 정책:
 *   - {placeholder} → vars[snake_case] 치환 (예: {buyer_name} → vars.buyer_name)
 *   - 미치환 placeholder 는 [buyer_name] 같은 빈 표시로 (사장님 spec)
 *   - 영업 옵션 다중일 때 단락 구분 (\n\n) 으로 결합 (사장님 짚을 점 G)
 *   - 본문 변수와 sales snippet 변수 모두 같은 vars 로 치환 (예: {stock_count})
 */
'use strict';

/**
 * camelCase → snake_case 변환 (BuyerExtractor 결과 buyerName → buyer_name 매칭용)
 */
function _toSnake(s) {
  return String(s).replace(/[A-Z]/g, c => '_' + c.toLowerCase()).replace(/^_/, '');
}

/**
 * 단일 텍스트 (본문 또는 snippet) 의 {placeholder} 를 vars 로 치환.
 * vars 는 camelCase / snake_case 둘 다 받음.
 */
function substitute(text, vars = {}) {
  if (!text) return '';
  // vars 를 snake_case 로 정규화
  const normalized = {};
  for (const [k, v] of Object.entries(vars || {})) {
    normalized[_toSnake(k)] = v;
  }
  return String(text).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (full, key) => {
    const snake = key.toLowerCase();
    const val = normalized[snake];
    if (val == null || String(val).trim() === '') {
      return `[${snake}]`;  // 미치환 = bracket 빈 표시 (직원 인지)
    }
    return String(val);
  });
}

/**
 * 본문 + 영업 옵션 snippet 들 결합.
 *
 * @param {string} templateBody
 * @param {Array<string>} salesSnippets  — 이미 정렬된 snippet 텍스트 배열
 * @param {Object} vars                  — buyer_name / order_id 등
 * @returns {string} 합쳐진 본문
 */
function combine(templateBody, salesSnippets = [], vars = {}) {
  const parts = [];
  if (templateBody) parts.push(substitute(templateBody, vars));
  for (const snip of salesSnippets || []) {
    if (snip && String(snip).trim()) parts.push(substitute(snip, vars));
  }
  return parts.join('\n\n');
}

module.exports = { substitute, combine };
