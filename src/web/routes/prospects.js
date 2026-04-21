/**
 * TCG 리드 API (/api/prospects) — admin 전용.
 * cold(리스트업) / active(contacted+replied+negotiating) / converted / dead
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/prospectRepository');

const router = express.Router();

router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  try { res.json(await repo.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/followups', async (req, res) => {
  try { res.json({ data: await repo.listFollowups() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const data = await repo.list({
      statusGroup: req.query.statusGroup || undefined,   // cold | active | converted | dead
      status: req.query.status || undefined,
      platform: req.query.platform || undefined,
      search: req.query.search || undefined,
      limit: Math.min(1000, parseInt(req.query.limit, 10) || 500),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '리드를 찾을 수 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const created = await repo.create(req.body || {}, req.user?.id);
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await repo.update(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /:id/activate — cold → contacted */
router.post('/:id/activate', async (req, res) => {
  try {
    const data = await repo.activate(parseInt(req.params.id, 10));
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /:id/contact — 연락 기록 + 상태 변경 */
router.post('/:id/contact', async (req, res) => {
  try {
    const { status, summary, nextFollowUp } = req.body || {};
    const data = await repo.logContact(parseInt(req.params.id, 10), { status, summary, nextFollowUp });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /:id/dead — 중단 (보관) */
router.post('/:id/dead', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const data = await repo.markDead(parseInt(req.params.id, 10), reason);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /:id/convert — B2B 바이어로 전환.
 * body: { name, company?, email?, whatsapp?, phone?, address?, country?, currency?, paymentTerms?, notes? }
 * 비워둔 필드는 prospect에서 자동 채움. buyer_id는 자동 채번.
 */
router.post('/:id/convert', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const prospect = await repo.getById(id);
    if (!prospect) return res.status(404).json({ error: '리드를 찾을 수 없습니다' });
    if (prospect.status === 'converted') {
      return res.status(400).json({ error: '이미 B2B 바이어로 전환된 리드입니다' });
    }

    const B2BRepo = require('../../db/b2bRepository');
    const b2bRepo = new B2BRepo();
    const buyerId = await b2bRepo.getNextBuyerId();

    const body = req.body || {};
    const buyerData = {
      BuyerID: buyerId,
      Name: (body.name || prospect.company || prospect.name || '').trim(),
      Contact: body.contact ?? prospect.name ?? '',
      Email: body.email ?? prospect.email ?? '',
      WhatsApp: body.whatsapp ?? prospect.whatsapp ?? '',
      Phone: body.phone ?? prospect.phone ?? '',
      Address: body.address ?? '',
      Country: body.country ?? prospect.country ?? '',
      Currency: body.currency || 'USD',
      PaymentTerms: body.paymentTerms || 'Net 30',
      Notes: (body.notes || prospect.notes || '').slice(0, 2000),
      TotalOrders: 0,
      TotalRevenue: 0,
      ExternalIds: {},
      ShippingRule: {},
    };

    const buyer = await b2bRepo.createBuyer(buyerData);
    const updatedProspect = await repo.markConverted(id, buyerId);
    res.json({ data: updatedProspect, buyer, buyerId });
  } catch (e) {
    console.error('[prospects/convert] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
