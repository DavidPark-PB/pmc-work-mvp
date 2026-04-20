/**
 * 주간 회의 → AI 액션아이템 추출 + 주간 플랜 자동 분배.
 */
const axios = require('axios');
const { getClient } = require('../db/supabaseClient');
const meetingRepo = require('../db/weeklyMeetingRepository');
const planRepo = require('../db/weeklyPlanRepository');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** 활성 staff 목록 */
async function loadStaff() {
  const { data, error } = await getClient().from('users')
    .select('id, display_name, platform, role')
    .eq('is_active', true);
  if (error) return [];
  return (data || []).map(u => ({
    id: u.id, displayName: u.display_name, platform: u.platform || null, role: u.role,
  }));
}

/**
 * 회의록 → 직원별 액션아이템 추출. 결과는 meetingRepo.markExtracted으로 저장.
 */
async function extractActionItems(meetingId) {
  const meeting = await meetingRepo.getById(meetingId);
  if (!meeting) throw new Error('회의를 찾을 수 없습니다');

  const notes = [meeting.summary, meeting.rawNotes].filter(Boolean).join('\n\n');
  if (!notes.trim()) {
    throw new Error('회의 요약이나 원본 메모를 입력하세요');
  }

  const staff = await loadStaff();
  if (staff.length === 0) throw new Error('활성 직원이 없습니다');

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // Gemini 없이는 빈 배열로 저장 — 관리자가 수동 입력
    return meetingRepo.markExtracted(meetingId, []);
  }

  const prompt = `다음은 PMC(한국 이커머스 회사)의 주간 회의록입니다. 회의록에서 각 직원별 액션아이템(할 일)을 추출하세요.

활성 직원 목록 (이 중에서만 매칭):
${staff.map(s => `- ${s.displayName}${s.platform ? ` (${s.platform} 담당)` : ''}`).join('\n')}

회의 주기: 2주 (다음 회의까지 이 기간 내 할 일)

회의록:
"""
${notes.slice(0, 6000)}
"""

규칙:
- 각 직원별로 구체적인 할 일을 추출
- 직원 목록에 없는 이름이 언급되면 무시
- "공동으로 X를 하자"처럼 불분명하면 담당자 추측 대신 skip
- priority: 긴급/중요한 건 "high", 일반은 "normal", 여유 있는 건 "low"
- 제목은 한 줄로 간결하게 (최대 80자)
- notes에는 배경/방법 등 부가 설명 (선택)

출력 (JSON only, 다른 텍스트 금지):
[
  { "userName": "정확한 직원 이름", "title": "할 일 제목", "priority": "high|normal|low", "notes": "추가 설명 (선택)" }
]
액션아이템 없으면 빈 배열 [].`;

  try {
    const r = await axios.post(`${GEMINI_URL}?key=${key}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }, { timeout: 45000, validateStatus: () => true });

    if (r.status !== 200) {
      const msg = r.data?.error?.message || `Gemini error ${r.status}`;
      throw new Error('AI 호출 실패: ' + msg);
    }
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : [];
    }
    if (!Array.isArray(parsed)) parsed = parsed.items || parsed.actionItems || [];

    // userName → userId 매핑
    const byName = new Map(staff.map(s => [s.displayName, s.id]));
    const actionItems = parsed.map(it => ({
      id: Math.random().toString(36).slice(2, 10),
      userId: byName.get(it.userName) || null,
      userName: it.userName || null,
      title: String(it.title || '').trim().slice(0, 300),
      priority: ['high', 'normal', 'low'].includes(it.priority) ? it.priority : 'normal',
      notes: it.notes ? String(it.notes).trim().slice(0, 1000) : null,
    })).filter(x => x.title && x.userId);  // userId 매핑 안 되면 제외 (관리자가 수동 추가 가능)

    return meetingRepo.markExtracted(meetingId, actionItems);
  } catch (e) {
    console.warn('[weeklyMeetingExtractor] AI fail:', e.message);
    throw e;
  }
}

/**
 * 회의의 action_items를 주간 플랜에 배포.
 * cycleWeeks=2면 해당 주 + 다음 주. 재배포 멱등 (sourceMeetingId로 식별).
 */
async function distributeToPlans(meetingId) {
  const meeting = await meetingRepo.getById(meetingId);
  if (!meeting) throw new Error('회의를 찾을 수 없습니다');
  if (!meeting.actionItems || meeting.actionItems.length === 0) {
    throw new Error('배포할 액션아이템이 없습니다. AI 분석 먼저 실행하세요.');
  }

  const baseWeekStart = planRepo.weekStartOf(meeting.meetingDate);
  const weeks = [baseWeekStart];
  if (meeting.cycleWeeks === 2) {
    const d = new Date(baseWeekStart + 'T00:00:00');
    d.setDate(d.getDate() + 7);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    weeks.push(`${y}-${m}-${dd}`);
  }

  // 직원별로 아이템 그룹핑
  const byUser = new Map();
  for (const it of meeting.actionItems) {
    if (!it.userId || !it.title) continue;
    if (!byUser.has(it.userId)) byUser.set(it.userId, []);
    byUser.get(it.userId).push(it);
  }

  let distributedUsers = 0;
  let distributedItems = 0;

  for (const [userId, items] of byUser) {
    for (const weekStart of weeks) {
      const plan = await planRepo.getOrCreateCurrent(userId, weekStart);
      // 기존에 이 meeting에서 온 항목들 제거 (재배포 멱등)
      const kept = (plan.items || []).filter(x => x.sourceMeetingId !== meeting.id);
      const nowIso = new Date().toISOString();
      const newItems = items.map(it => ({
        id: Math.random().toString(36).slice(2, 10),
        title: it.title,
        priority: it.priority || 'normal',
        status: 'pending',
        result: null,
        sourceMeetingId: meeting.id,
        notes: it.notes || null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }));
      await planRepo.update(plan.id, { items: [...kept, ...newItems] });
      distributedItems += newItems.length;
    }
    distributedUsers++;
  }

  const updated = await meetingRepo.markDistributed(meetingId);
  return {
    meeting: updated,
    distributedUsers,
    distributedItems,
    weeks,
  };
}

module.exports = { extractActionItems, distributeToPlans };
