// routes/auth.js — /api/auth/sync
const { Router } = require('express');
const { collections } = require('../config/db');

const router = Router();

router.post('/sync', async (req, res) => {
  try {
    const { uid, email, role } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'uid required' });
    const validRole = role && ['worker', 'client'].includes(String(role).toLowerCase())
      ? String(role).toLowerCase()
      : 'worker';

    await collections.users.updateOne(
      { uid: String(uid) },
      {
        $setOnInsert: {
          uid: String(uid),
          createdAt: new Date(),
          role: validRole,
          ...(validRole === 'worker' ? { dueBalance: 0, isApplyBlocked: false } : {}),
          ...(email ? { email: String(email).toLowerCase().trim() } : {}),
        },
      },
      { upsert: true }
    );

    const doc = await collections.users.findOne({ uid: String(uid) });
    res.json(doc);
  } catch (e) {
    console.error('POST /api/auth/sync failed:', e);
    res.status(500).json({ error: 'sync failed' });
  }
});

module.exports = router;
