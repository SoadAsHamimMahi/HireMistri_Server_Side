// routes/admin/dashboard.js — /api/admin/me, /api/admin/stats, /api/admin/revenue-stats
const { Router } = require('express');
const { authenticateAdmin } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

router.get('/me', authenticateAdmin, (req, res) => {
  try {
    if (!req.user || !req.adminUser) {
      console.error('GET /api/admin/me: req.user or req.adminUser missing');
      return res.status(500).json({ error: 'Admin auth state missing' });
    }
    res.json({
      ok: true,
      user: { uid: req.user.uid, email: req.user.email || '' },
      permissions: req.adminUser.permissions || ['*'],
    });
  } catch (err) {
    console.error('GET /api/admin/me failed:', err);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// Dashboard stats (two definitions exist in original; keep the richer one first)
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const [
      totalProviders,
      verifiedProviders,
      suspendedProviders,
      totalBookings,
      pendingBookings,
      totalCustomers,
      activeServices,
      openQueries,
    ] = await Promise.all([
      collections.users.countDocuments({ role: 'worker' }),
      collections.users.countDocuments({ role: 'worker', isVerified: true }),
      collections.users.countDocuments({ role: 'worker', isSuspended: true }),
      collections.applications.countDocuments({}),
      collections.applications.countDocuments({ status: 'pending' }),
      collections.users.countDocuments({ role: 'client' }),
      collections.services.countDocuments({ isActive: true }),
      collections.userQueries.countDocuments({ status: 'open' }),
    ]);

    res.json({
      providers: { total: totalProviders, verified: verifiedProviders, unverified: totalProviders - verifiedProviders, suspended: suspendedProviders },
      bookings: { total: totalBookings, pending: pendingBookings },
      customers: { total: totalCustomers },
      services: { active: activeServices },
      support: { openQueries },
    });
  } catch (err) {
    console.error('GET /api/admin/stats failed:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/revenue-stats', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const pipeline = [
      { $match: { type: 'platform_fee_debit', createdAt: { $gte: startDate } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ];

    const stats = await collections.ledgers.aggregate(pipeline).toArray();
    const result = [];
    const curr = new Date(startDate);
    const end = new Date();

    while (curr <= end) {
      const dateStr = curr.toISOString().split('T')[0];
      const entry = stats.find((s) => s._id === dateStr);
      result.push({ date: dateStr, revenue: entry ? entry.revenue : 0, count: entry ? entry.count : 0 });
      curr.setDate(curr.getDate() + 1);
    }

    res.json(result);
  } catch (err) {
    console.error('GET /api/admin/revenue-stats failed:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
