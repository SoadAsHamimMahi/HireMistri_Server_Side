const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;
        const { adminUid, action } = req.query;
        const q = {};
        if (adminUid) q.adminUid = adminUid;
        if (action) q.action = action;

        const [list, total] = await Promise.all([
          collections.adminAuditLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          collections.adminAuditLog.countDocuments(q),
        ]);
        res.json({ ok: true, list, total });
      } catch (err) {
        console.error('GET /api/admin/audit-logs failed:', err);
        res.status(500).json({ error: 'Fetch failed' });
      }
    });

module.exports = router;
