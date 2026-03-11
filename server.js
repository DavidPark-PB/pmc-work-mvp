require('dotenv').config({ path: './config/.env' });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTO_PORT = process.env.AUTO_PORT || 3001;

// uploads 디렉토리 생성
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ccorea-auto automation server proxy (:3001)
app.use('/api/auto', createProxyMiddleware({
  target: `http://localhost:${AUTO_PORT}/api`,
  pathRewrite: { '^/api/auto': '' },
  changeOrigin: true,
  onProxyRes: (proxyRes) => {
    // SSE streaming support
    proxyRes.headers['X-Accel-Buffering'] = 'no';
  },
  onError: (err, req, res) => {
    res.status(502).json({ error: 'Automation server unavailable', detail: err.message });
  }
}));

// Proxy page routes for automation UI (non-API)
app.use('/auto', createProxyMiddleware({
  target: `http://localhost:${AUTO_PORT}`,
  pathRewrite: { '^/auto': '' },
  changeOrigin: true,
  onError: (err, req, res) => {
    res.status(502).json({ error: 'Automation server unavailable', detail: err.message });
  }
}));

const apiRoutes = require('./src/web/routes/api');
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPMC 대시보드 서버: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api\n`);

  // SKU 점수 자동 업데이트 (매일 02:00)
  const { scheduleSkuScoreUpdate } = require('./src/jobs/collectSkuData');
  const now = new Date();
  const next2AM = new Date(now);
  next2AM.setHours(2, 0, 0, 0);
  if (next2AM <= now) next2AM.setDate(next2AM.getDate() + 1);
  const delay = next2AM - now;
  setTimeout(() => {
    scheduleSkuScoreUpdate();
    setInterval(scheduleSkuScoreUpdate, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`SKU 점수 자동 업데이트: ${next2AM.toLocaleString('ko-KR')} 예약됨`);
});
