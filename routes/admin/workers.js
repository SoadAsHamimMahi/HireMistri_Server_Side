// routes/admin/workers.js — /api/admin/workers/* (registration review)
const { Router } = require('express');
const { collections } = require('../../config/db');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { sendWorkerRegistrationApprovedEmail, sendWorkerRegistrationRejectedEmail } = require('../../utils/emailService');

const router = Router();

// List pending (or filtered) worker registrations
router.get('/registrations', authenticateAdmin, async (req, res) => {
  try {
    const { status = 'pending_review', page = 1, limit = 20, search = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const filter = { role: 'worker' };
    if (status && status !== 'all') filter.workerAccountStatus = status;
    if (search) {
      const r = new RegExp(search.trim(), 'i');
      filter.$or = [{ firstName: r }, { lastName: r }, { fullLegalName: r }, { email: r }, { phone: r }];
    }
    const projection = {
      uid: 1, firstName: 1, lastName: 1, fullLegalName: 1, email: 1, phone: 1,
      city: 1, district: 1, profileCover: 1, servicesOffered: 1,
      workerAccountStatus: 1, registrationSubmittedAt: 1, registrationReviewedAt: 1,
      registrationRejectionReason: 1, createdAt: 1,
    };
    const [list, total] = await Promise.all([
      collections.users.find(filter).project(projection).sort({ registrationSubmittedAt: -1 }).skip(skip).limit(limitNum).toArray(),
      collections.users.countDocuments(filter),
    ]);
    res.json({ list, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('GET /api/admin/workers/registrations failed:', e);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// Get single worker registration detail
router.get('/:uid/registration', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const userDoc = await collections.users.findOne({ uid });
    if (!userDoc) return res.status(404).json({ error: 'Worker not found' });
    res.json(userDoc);
  } catch (e) {
    console.error('GET /api/admin/workers/:uid/registration failed:', e);
    res.status(500).json({ error: 'Failed to fetch worker registration' });
  }
});

// Approve or reject a worker registration
router.patch('/:uid/registration', authenticateAdmin, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const { action, rejectionReason = '' } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }
    const userDoc = await collections.users.findOne({ uid });
    if (!userDoc) return res.status(404).json({ error: 'Worker not found' });

    const now = new Date();
    let updateSet = { registrationReviewedAt: now, updatedAt: now };
    if (action === 'approve') { updateSet.workerAccountStatus = 'approved'; updateSet.isVerified = true; }
    else { updateSet.workerAccountStatus = 'rejected'; updateSet.registrationRejectionReason = String(rejectionReason).trim(); }

    await collections.users.updateOne({ uid }, { $set: updateSet });
    await logAdminAction(req, `registration_${action}d`, 'worker', { uid, rejectionReason: rejectionReason || undefined });

    const workerEmail = userDoc.email;
    const workerName = [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ') || userDoc.fullLegalName || 'Worker';
    try {
      if (action === 'approve') {
        sendWorkerRegistrationApprovedEmail(workerEmail, workerName).catch(e => console.warn('Approval email failed:', e.message));
      } else {
        sendWorkerRegistrationRejectedEmail(workerEmail, workerName, rejectionReason).catch(e => console.warn('Rejection email failed:', e.message));
      }
    } catch (emailErr) {
      console.warn('Email send error (non-blocking):', emailErr.message);
    }

    res.json({ success: true, uid, workerAccountStatus: updateSet.workerAccountStatus });
  } catch (e) {
    console.error('PATCH /api/admin/workers/:uid/registration failed:', e);
    res.status(500).json({ error: 'Failed to update registration status' });
  }
});

module.exports = router;
