/**
 * src/web/routes/operationsBriefing.js — Daily Operations Briefing read API (PR O1)
 *
 * 라우트:
 *   GET /api/ops-briefing/today  — 오늘 운영 요약
 *
 * 권한: 로그인한 모든 사용자 (admin / staff). 정책 §1-A 정합 — staff 도 운영 상황 파악 필요.
 *
 * 정책:
 *   - read-only. DB 변경 0건.
 *   - 외부 API (eBay/Shopify/Telegram) 호출 0건.
 *   - service (operationsBriefing.getTodayBriefing) 가 각 섹션별 try/catch 처리.
 *     일부 섹션 실패해도 200 응답 — recommendations 에 안내 포함.
 *   - 진짜 unexpected error 만 500.
 *
 * 무수정 약속:
 *   - safetyExec / safetyUndo / migration / schema 무수정
 *   - Phase 1/2 라우트 무수정
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const opsBriefing = require('../../services/operationsBriefing');

const router = express.Router();

router.use(requireAuth);

// GET /api/ops-briefing/today
router.get('/today', async (req, res) => {
  try {
    const briefing = await opsBriefing.getTodayBriefing();
    res.json(briefing);
  } catch (e) {
    console.error('[opsBriefing] route unexpected:', e.message);
    res.status(500).json({ error: '오늘 운영 브리핑 조회 실패' });
  }
});

module.exports = router;
