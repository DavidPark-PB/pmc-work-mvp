/**
 * 실시간 알림 스트림 (Server-Sent Events)
 * GET /api/events/stream — 로그인 유저 전용. 본인 id로 이벤트 수신.
 */
const express = require('express');
const hub = require('../../services/sseHub');

const router = express.Router();

router.get('/stream', (req, res) => {
  if (!req.user) return res.status(401).end();

  // SSE 헤더
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // 클라이언트 재연결 간격 권고 (ms)
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'connected', at: Date.now() })}\n\n`);

  hub.register(req.user.id, res);

  // 25초마다 keep-alive (프록시가 idle 연결 끊는 것 방지)
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    hub.unregister(req.user.id, res);
  });
});

// 디버그용 — admin만
router.get('/stats', (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'admin only' });
  res.json(hub.stats());
});

module.exports = router;
