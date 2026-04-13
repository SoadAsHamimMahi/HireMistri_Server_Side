// routes/admin/providers.js — /api/admin/providers/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin } = require('../../middleware/auth');
const { logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');
const { computeUserStats } = require('../../utils/helpers');

const router = Router();

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const q = { role: 'worker' };
    if (status === 'active') q.isSuspended = { $ne: true };
    if (status === 'suspended') q.isSuspended = true;

    const search = req.query.search;
    if (search) {
      const regex = new RegExp(search, 'i');
      q.$or = [{ firstName: regex }, { lastName: regex }, { displayName: regex }, { email: regex }];
    }

    const [list, total] = await Promise.all([
      collections.users.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.users.countDocuments(q),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/providers failed:', err);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

router.get('/:uid', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const doc = await collections.users.findOne({ uid, role: 'worker' });
    if (!doc) return res.status(404).json({ error: 'Provider not found' });
    const stats = await computeUserStats(uid);
    res.json({ ...doc, stats: stats || {} });
  } catch (err) {
    console.error('GET /api/admin/providers/:uid failed:', err);
    res.status(500).json({ error: 'Failed to fetch provider' });
  }
});

router.patch('/:uid/status', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const { status } = req.body || {};
    const s = String(status || '').toLowerCase();
    if (!['active', 'suspended'].includes(s)) return res.status(400).json({ error: 'Invalid status' });
    const result = await collections.users.updateOne(
      { uid, role: 'worker' },
      { $set: { isSuspended: s === 'suspended', updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Provider not found' });
    await logAdminAction(req, 'provider_status', 'providers', { providerUid: uid, status: s });
    res.json({ ok: true, status: s });
  } catch (err) {
    console.error('PATCH /api/admin/providers/:uid/status failed:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.patch('/:uid/verify', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const { isVerified } = req.body || {};
    const v = !!isVerified;
    const result = await collections.users.updateOne(
      { uid, role: 'worker' },
      { $set: { isVerified: v, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Provider not found' });
    await logAdminAction(req, 'provider_verify', 'providers', { providerUid: uid, isVerified: v });
    res.json({ ok: true, isVerified: v });
  } catch (err) {
    console.error('PATCH /api/admin/providers/:uid/verify failed:', err);
    res.status(500).json({ error: 'Verification update failed' });
  }
});

router.post('/:uid/due', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const { action, amount, reason } = req.body || {};

    let user = await collections.users.findOne({ uid });
    if (!user && ObjectId.isValid(uid)) {
      user = await collections.users.findOne({ _id: new ObjectId(uid) });
    }
    if (!user || user.role !== 'worker') return res.status(404).json({ error: 'Worker not found' });

    let currentDue = Number(user.dueBalance) || 0;
    let newDue = currentDue;
    let numAmount = Math.abs(Number(amount) || 0);

    if (action === 'add') newDue += numAmount;
    else if (action === 'subtract') { newDue -= numAmount; if (newDue < 0) newDue = 0; }
    else if (action === 'clear') { numAmount = currentDue; newDue = 0; }
    else return res.status(400).json({ error: 'Invalid action. Use add, subtract, or clear.' });

    await collections.users.updateOne({ _id: user._id }, { $set: { dueBalance: newDue, updatedAt: new Date() } });

    const direction = action === 'add' ? 'DEBIT' : 'CREDIT';
    if (numAmount > 0) {
      await collections.ledgers.insertOne({
        workerId: user.uid,
        type: 'ADMIN_MANUAL_ADJUSTMENT',
        direction,
        amount: numAmount,
        reason: reason || `Admin manually ${action === 'clear' ? 'cleared' : action + 'ed'} dues`,
        adminEmail: req.adminUser?.email || 'admin',
        createdAt: new Date(),
      });
    }

    await logAdminAction(req, 'provider_due_update', 'providers', { providerId: user._id.toString(), action, amount: numAmount, newDue });
    res.json({ ok: true, dueBalance: newDue });
  } catch (err) {
    console.error('POST /api/admin/providers/:uid/due failed:', err);
    res.status(500).json({ error: 'Failed to update due balance' });
  }
});

module.exports = router;
