const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');
const { computeUserStats } = require('../../utils/helpers');

const router = Router();

    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        // Customers are not always stored with role='client' (e.g. /api/auth/sync defaults role to 'worker').
        // For admin, treat "customers" as any uid that appears as a clientId/poster in jobs/browseJobs,
        // plus any user explicitly marked role='client'.
        // NOTE: MongoDB Stable API strict mode can reject `distinct` (APIStrictError).
        // Use aggregation-based distinct to stay compatible with serverApi { strict: true }.
        const distinctStrings = async (collection, field, match = {}) => {
          const docs = await collection
            .aggregate([
              {
                $match: {
                  ...match,
                  [field]: { $exists: true, $ne: null, $ne: '' },
                },
              },
              { $group: { _id: `$${field}` } },
            ])
            .toArray();
          return docs.map((d) => String(d._id || '').trim()).filter(Boolean);
        };

        const [clientRoleUids, jobClientIds, browseClientIds, browsePostedByUids] = await Promise.all([
          distinctStrings(collections.users, 'uid', { role: 'client' }),
          distinctStrings(collections.jobs, 'clientId'),
          distinctStrings(collections.browseJobs, 'clientId'),
          distinctStrings(collections.browseJobs, 'postedByUid'),
        ]);

        const uidSet = new Set(
          [...clientRoleUids, ...jobClientIds, ...browseClientIds, ...browsePostedByUids]
            .map((x) => (x == null ? '' : String(x).trim()))
            .filter(Boolean)
        );
        const allUids = Array.from(uidSet);

        const query = { uid: { $in: allUids } };
        const [list, total] = await Promise.all([
          collections.users.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          collections.users.countDocuments(query),
        ]);

        res.json({ list, total, page, limit });
      } catch (err) {
        console.error('GET /api/admin/customers failed:', err);
        res.status(500).json({ error: 'Failed to fetch customers' });
      }
    });
    router.get('/:uid', authenticateAdmin, async (req, res) => {
      try {
        const uid = String(req.params.uid);
        const doc = await collections.users.findOne({ uid });
        if (!doc) return res.status(404).json({ error: 'Customer not found' });
        const stats = await computeUserStats(uid);
        res.json({ ...doc, stats: stats || {} });
      } catch (err) {
        console.error('GET /api/admin/customers/:uid failed:', err);
        res.status(500).json({ error: 'Failed to fetch customer' });
      }
    });
    router.get('/:uid/transactions', authenticateAdmin, async (req, res) => {
      try {
        const uid = String(req.params.uid);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;
        const [list, total] = await Promise.all([
          collections.transactions.find({ userId: uid }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          collections.transactions.countDocuments({ userId: uid }),
        ]);
        res.json({ list, total, page, limit });
      } catch (err) {
        console.error('GET /api/admin/customers/:uid/transactions failed:', err);
        res.status(500).json({ error: 'Failed to fetch transactions' });
      }
    });
    router.get('/:uid/addresses', authenticateAdmin, async (req, res) => {
      try {
        const uid = String(req.params.uid);
        const doc = await collections.users.findOne({ uid });
        if (!doc) return res.status(404).json({ error: 'Customer not found' });
        const addresses = Array.isArray(doc.addresses) ? doc.addresses : [];
        res.json({ list: addresses });
      } catch (err) {
        console.error('GET /api/admin/customers/:uid/addresses failed:', err);
        res.status(500).json({ error: 'Failed to fetch addresses' });
      }
    });

module.exports = router;
