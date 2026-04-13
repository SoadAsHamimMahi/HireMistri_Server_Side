// routes/admin/finance.js — ledgers, payment-requests, settlements, cash-collections, due-payments, transactions
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

// ---- Ledgers ----
router.get('/ledgers', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.ledgers.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.ledgers.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/ledgers failed:', err);
    res.status(500).json({ error: 'Failed to fetch ledgers' });
  }
});

// ---- Due Payments ----
router.get('/due-payments', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const query = { isDuePayment: true, status: 'PENDING_VERIFICATION' };
    const [list, total] = await Promise.all([
      collections.paymentRequests.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.paymentRequests.countDocuments(query),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/due-payments failed:', err);
    res.status(500).json({ error: 'Failed to fetch due payments' });
  }
});

// ---- Payment Requests ----
router.get('/payment-requests', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const query = { isDuePayment: { $ne: true } };
    const [list, total] = await Promise.all([
      collections.paymentRequests.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.paymentRequests.countDocuments(query),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/payment-requests failed:', err);
    res.status(500).json({ error: 'Failed to fetch payment requests' });
  }
});

router.post('/payment-requests', authenticateAdmin, async (req, res) => {
  try {
    const { providerId, amount, reason } = req.body || {};
    const doc = {
      providerId: String(providerId || ''),
      amount: Number(amount) || 0,
      reason: String(reason || '').trim(),
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await collections.paymentRequests.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) {
    console.error('POST /api/admin/payment-requests failed:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

router.patch('/payment-requests/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    const statusIn = String(status || '').toLowerCase();
    if (!['pending', 'approved', 'rejected'].includes(statusIn)) return res.status(400).json({ error: 'Invalid status' });
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.paymentRequests.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: statusIn, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    await logAdminAction(req, 'payment_request_status', 'paymentRequests', { requestId: id, status: statusIn });
    res.json({ ok: true, status: statusIn });
  } catch (err) {
    console.error('PATCH /api/admin/payment-requests/:id failed:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ---- Settlements ----
router.get('/settlements', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.settlements.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.settlements.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/settlements failed:', err);
    res.status(500).json({ error: 'Failed to fetch settlements' });
  }
});

router.post('/settlements', authenticateAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const doc = { providerId: String(body.providerId || ''), amount: Number(body.amount) || 0, status: 'pending', createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.settlements.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) {
    console.error('POST /api/admin/settlements failed:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

router.patch('/settlements/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    const statusIn = String(status || '').toLowerCase();
    if (!['pending', 'completed', 'failed'].includes(statusIn)) return res.status(400).json({ error: 'Invalid status' });
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.settlements.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: statusIn, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    await logAdminAction(req, 'settlement_status', 'settlements', { settlementId: id, status: statusIn });
    res.json({ ok: true, status: statusIn });
  } catch (err) {
    console.error('PATCH /api/admin/settlements/:id failed:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ---- Transactions ----
router.get('/transactions', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.transactions.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.transactions.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/transactions failed:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ---- Cash Collections ----
router.get('/cash-collections', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.cashCollections.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.cashCollections.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/cash-collections failed:', err);
    res.status(500).json({ error: 'Failed to fetch cash collections' });
  }
});

router.post('/cash-collections', authenticateAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const doc = { amount: Number(body.amount) || 0, collectedBy: String(body.collectedBy || '').trim(), status: 'recorded', createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.cashCollections.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) {
    console.error('POST /api/admin/cash-collections failed:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

// ---- Worker Job Requests (admin view) ----
router.get('/worker-job-requests', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const statusIn = req.query.status;
    const q = statusIn ? { status: statusIn } : {};
    const [list, total] = await Promise.all([
      collections.workerJobRequests.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.workerJobRequests.countDocuments(q),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/worker-job-requests failed:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
