/**
 * CS 위험 정책 룰 — 사장님이 명시한 7가지 핵심 정책.
 *
 * 입력: 고객 메시지 (영문/한글)
 * 출력: 매칭된 정책 태그 + 위험도 + AI 분석 시 강제 포함시킬 prompt 힌트
 *
 * 키워드/regex 기반의 deterministic 1차 detect. AI 분석에 컨텍스트로 주입돼서
 * Claude 가 risk_tags / required_reply_points / forbidden_reply_points 정확히 채우게 함.
 *
 * 정책 종류 (사장님 spec):
 *  1. fake_customs_declaration  — 허위 세관신고 요청
 *  2. customs_liability_shift   — 통관비 책임 전가
 *  3. missing_tax_id            — 세금번호 미제출 리스크
 *  4. case_open_threat          — 케이스 오픈 협박
 *  5. excessive_refund          — 과도한 환불 요구
 *  6. address_change            — 주소 변경 요구
 *  7. payer_recipient_mismatch  — 결제자와 수취인 불일치
 *
 * 사용처:
 *   - csMessageAnalyzer 가 호출 → 결과를 prompt 에 포함
 *   - csReplyGenerator 가 호출 → 한글 지시문에 정책 대응 누락 시 경고
 */
'use strict';

// 각 정책의 매칭 룰 — keywords(영/한 OR 매칭) + regex(고급 패턴) + severity
const POLICIES = [
  {
    tag: 'fake_customs_declaration',
    label: '허위 세관신고 요청',
    severity: 'critical',
    keywords: [
      // 영어
      'gift', 'mark as gift', 'declare as gift', 'low value',
      'declare low', 'declare lower', 'lower value', 'less than',
      'undervalue', 'under-declare', 'reduce customs', 'avoid customs',
      'avoid tax', 'no tax', 'tax free', 'wrong invoice',
      // 한글
      '선물로', '낮게 신고', '낮춰서', '저가신고', '세관 회피', '세금 회피',
      '낮은 금액', '실제보다 낮게', '인보이스 조작',
    ],
    requiredReplyPoint:
      'PMC 는 모든 발송 시 실거래 금액으로 정확한 세관 신고를 합니다. 가격 낮춰 신고·gift 표시 등 허위 신고는 정중하게 거절',
    forbiddenReplyPoint:
      '"OK" / "noted" / "we will mark as gift" 같이 동의 또는 검토 여지를 주는 표현 절대 금지',
  },
  {
    tag: 'customs_liability_shift',
    label: '통관비 책임 전가',
    severity: 'high',
    keywords: [
      'pay customs', 'pay for customs', 'who pays customs', 'cover customs',
      'customs fee', 'customs cost', 'customs charge', 'duty', 'duties',
      'import tax', 'import fee', 'import charge',
      '관세', '통관료', '통관비', '관세 부담', '관세 누가',
    ],
    requiredReplyPoint:
      '관세·통관비는 도착국 구매자 부담임을 명확히 (international shipping standard). 동의 시에만 진행',
    forbiddenReplyPoint:
      '판매자가 관세를 부담한다거나 환불해준다고 약속하는 표현 금지',
  },
  {
    tag: 'missing_tax_id',
    label: '세금번호 미제출',
    severity: 'high',
    keywords: [
      // 영어 (브라질 CPF, EU IOSS, 인도네시아 NPWP 등)
      'cpf', 'tax id', 'tax number', 'tax registration', 'ioss', 'vat number',
      'eori', 'npwp', 'rfc', 'tin number',
      'no tax id', "don't have tax", 'without tax id',
      // 한글
      '세금번호', '세금번호 없', '브라질 cpf', '관세번호',
    ],
    requiredReplyPoint:
      '브라질 CPF, EU IOSS 등 도착국이 요구하는 세금번호 없으면 통관 보류·반송 위험을 사전 명시. 미제출 시 발송 불가 또는 위험 동의서 필요',
    forbiddenReplyPoint:
      '세금번호 없이 그냥 보내준다는 약속, 또는 통관 문제 책임지겠다는 약속 금지',
  },
  {
    tag: 'case_open_threat',
    label: '케이스 오픈 협박',
    severity: 'critical',
    keywords: [
      'open a case', 'open case', 'file a case', 'file a claim',
      'negative feedback', 'negative review', 'bad review', 'leave feedback',
      'leave a review', 'paypal dispute', 'ebay dispute', 'chargeback',
      'report to', 'report you', 'lawyer', 'legal action',
      '케이스 오픈', '클레임', '신고', '소송', '변호사',
    ],
    requiredReplyPoint:
      '사실 관계 확인 후 정당한 사유면 정중히 해결책 제안. 협박에 굴해서 부당한 환불·할인은 절대 거절. 증빙(추적, 사진) 제시',
    forbiddenReplyPoint:
      '협박이 무서워서 "환불해드릴게요" 같은 즉답 금지. 사과 표현 과도 금지 (책임 인정으로 해석됨)',
  },
  {
    tag: 'excessive_refund',
    label: '과도한 환불 요구',
    severity: 'high',
    keywords: [
      'full refund', '100% refund', 'refund and keep', 'keep the item',
      'damaged', 'broken', 'never arrived', 'never received', 'lost in transit',
      'wrong item', 'not as described', 'partial refund',
      '전액 환불', '100프로 환불', '제품도 가지고', '환불 가능',
    ],
    requiredReplyPoint:
      '증빙(사진·동영상·추적번호) 요구 후 사실 확인. 정당한 손상/오배송이면 합리적 보상. 증빙 없으면 거절 또는 부분 보상',
    forbiddenReplyPoint:
      '증빙 없이 전액 환불 약속 금지. "물건은 가지고 환불받으세요" 같은 표현 금지 (사기 인센티브)',
  },
  {
    tag: 'address_change',
    label: '주소 변경 요구',
    severity: 'high',
    keywords: [
      'change address', 'change shipping', 'change delivery', 'new address',
      'different address', 'forward to', 'redirect',
      'ship to different', 'send to another',
      '주소 변경', '주소 수정', '다른 주소', '주소 바꿔',
    ],
    requiredReplyPoint:
      '발송 전이면 동일 국가 한정 1회 무료 변경 가능, 발송 후엔 변경 불가 안내. 다른 국가/사람 주소로 변경은 무조건 거절 (사기 패턴)',
    forbiddenReplyPoint:
      '발송 후 주소 변경 동의 금지. 결제 주소와 다른 곳으로 변경 허용 금지',
  },
  {
    tag: 'payer_recipient_mismatch',
    label: '결제자 수취인 불일치',
    severity: 'medium',
    keywords: [
      'send to my friend', 'send to my brother', 'send to my', 'gift to',
      'on behalf of', 'paid by', 'paid for me', "friend's payment",
      '대신 결제', '친구가 결제', '결제자', '수취인 다름',
    ],
    requiredReplyPoint:
      '결제자와 수취인이 다르면 카드 도용·사기 가능성 — 결제자 본인 인증(셀카+카드 부분 사진 등) 요청 후 검토',
    forbiddenReplyPoint:
      '본인 확인 없이 그대로 발송 금지. "괜찮습니다" 같이 안심시키는 표현 금지',
  },
];

/**
 * 메시지를 정책 룰에 매칭. 매칭된 정책들의 tag·요약 반환.
 *
 * @param {string} message
 * @returns {{
 *   matched: Array<{tag, label, severity, matchedKeywords: string[]}>,
 *   maxSeverity: 'critical'|'high'|'medium'|'low'|null,
 *   forcePromptHints: { required: string[], forbidden: string[] }
 * }}
 */
function detect(message) {
  const text = String(message || '').toLowerCase();
  if (!text.trim()) {
    return { matched: [], maxSeverity: null, forcePromptHints: { required: [], forbidden: [] } };
  }

  const matched = [];
  for (const p of POLICIES) {
    const hits = p.keywords.filter(kw => text.includes(kw.toLowerCase()));
    if (hits.length > 0) {
      matched.push({
        tag: p.tag,
        label: p.label,
        severity: p.severity,
        matchedKeywords: hits.slice(0, 3), // 상위 3개만 보고
      });
    }
  }

  // severity max — critical > high > medium > low
  const order = { critical: 4, high: 3, medium: 2, low: 1 };
  const maxSeverity = matched.length === 0
    ? null
    : matched.reduce((max, m) => (order[m.severity] || 0) > (order[max] || 0) ? m.severity : max, 'low');

  // AI 가 reply 만들 때 강제로 포함/금지시킬 힌트
  const required = matched.map(m => POLICIES.find(p => p.tag === m.tag)?.requiredReplyPoint).filter(Boolean);
  const forbidden = matched.map(m => POLICIES.find(p => p.tag === m.tag)?.forbiddenReplyPoint).filter(Boolean);

  return {
    matched,
    maxSeverity,
    forcePromptHints: { required, forbidden },
  };
}

/**
 * 한국어 답변 지시문이 매칭된 정책의 requiredReplyPoint 를 충분히 다루는지 검사.
 * 단순 키워드 검사 — '관세', '구매자 부담', '거절' 등이 포함됐는지 확인.
 *
 * @param {string} koreanDraft  - 사용자의 한국어 답변 지시문
 * @param {Array} matchedPolicies - detect() 결과의 matched
 * @returns {Array<{tag, label, message}>}  - 누락된 정책 (경고 대상)
 */
function findUncoveredPolicies(koreanDraft, matchedPolicies) {
  if (!matchedPolicies || matchedPolicies.length === 0) return [];
  const draft = String(koreanDraft || '').toLowerCase();
  if (!draft.trim()) {
    // 빈 지시문이면 모두 누락 처리
    return matchedPolicies.map(m => ({
      tag: m.tag,
      label: m.label,
      message: `고객이 ${m.label} 관련 메시지를 보냈는데 답변 지시문이 비어있습니다.`,
    }));
  }

  // 각 정책별 필수 키워드가 한국어 지시문에 있는지 확인.
  // 단순한 휴리스틱 — 너무 엄격하면 false positive 많음.
  const coverageCheck = {
    fake_customs_declaration: ['신고', '거절', '불가', '안 됩', '안 됨', '안돼', '못 함'],
    customs_liability_shift: ['관세', '통관', '구매자', '부담', '책임'],
    missing_tax_id: ['세금번호', '세금', 'cpf', 'ioss', '통관', '반송'],
    case_open_threat: ['증빙', '추적', '확인', '사실', '정당'],
    excessive_refund: ['증빙', '사진', '확인', '검토'],
    address_change: ['발송', '변경', '동일', '국가', '거절'],
    payer_recipient_mismatch: ['본인', '확인', '인증', '결제자'],
  };

  const uncovered = [];
  for (const m of matchedPolicies) {
    const expected = coverageCheck[m.tag] || [];
    if (expected.length === 0) continue;
    const covered = expected.some(kw => draft.includes(kw));
    if (!covered) {
      uncovered.push({
        tag: m.tag,
        label: m.label,
        message: `고객이 ${m.label} 관련 메시지를 보냈는데 답변 지시문에 대응 내용이 없습니다.`,
      });
    }
  }
  return uncovered;
}

module.exports = {
  POLICIES,
  detect,
  findUncoveredPolicies,
};
