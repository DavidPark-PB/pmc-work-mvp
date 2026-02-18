require('dotenv').config({ path: './config/.env' });
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const apiRoutes = require('./src/web/routes/api');
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPMC 대시보드 서버: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api\n`);
});
