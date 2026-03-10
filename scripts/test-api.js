const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/api', require('../src/web/routes/api.js'));
const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = 'http://localhost:' + port;
  let pass = 0, fail = 0;

  async function test(name, url, method, body) {
    try {
      const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(base + url, opts);
      const data = await res.json();
      if (res.ok && !data.error) { pass++; console.log('PASS ' + name); }
      else { fail++; console.log('FAIL ' + name + ': ' + (data.error || res.status)); }
    } catch(e) { fail++; console.log('FAIL ' + name + ': ' + e.message); }
  }

  await test('platform-registry', '/api/platform-registry');
  await test('margin-calc', '/api/analysis/margin-calc', 'POST', { purchasePrice: 10000, weight: 0.5 });
  await test('dashboard-summary', '/api/dashboard/summary');
  await test('sync-history', '/api/sync/history');
  await test('export-status', '/api/products/export-status');

  console.log('\nResults: ' + pass + ' pass, ' + fail + ' fail');
  server.close(() => process.exit(fail > 0 ? 1 : 0));
});
