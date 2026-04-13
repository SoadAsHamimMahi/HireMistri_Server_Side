// routes/workers.js — /api/workers/* registration routes; /api/admin/workers/* are in admin/workers.js
const { Router } = require('express');
const { collections } = require('../config/db');
const { isValidBdMobile, isValidNid } = require('../utils/validators');
const { authenticateUser } = require('../middleware/auth');
const { logAdminAction } = require('../middleware/auth');
const { sendWorkerRegistrationApprovedEmail, sendWorkerRegistrationRejectedEmail } = require('../utils/emailService');

const router = Router();

// Submit worker registration
router.post('/registration/submit', async (req, res) => {
  try {
    const uid = req.user?.uid || req.body?.uid;
    if (!uid) return res.status(401).json({ error: 'Authentication required' });

    const b = req.body || {};
    const s = (v) => String(v || '').trim();

    const existing = await collections.users.findOne({ uid });
    if (existing?.workerAccountStatus === 'pending_review') {
      return res.status(409).json({ code: 'ALREADY_SUBMITTED', error: 'Registration already submitted and under review.' });
    }
    if (existing?.workerAccountStatus === 'approved') {
      return res.status(409).json({ code: 'ALREADY_APPROVED', error: 'Your account is already approved.' });
    }

    const missing = [];
    if (!s(b.fullLegalName)) missing.push('fullLegalName');
    if (!s(b.phone)) missing.push('phone');
    if (!s(b.city)) missing.push('city');
    if (!s(b.district)) missing.push('district');
    if (!s(b.nidNumber)) missing.push('nidNumber');
    if (!s(b.emergencyContactName)) missing.push('emergencyContactName');
    if (!s(b.emergencyContactPhone)) missing.push('emergencyContactPhone');
    if (!s(b.emergencyContactNidNumber)) missing.push('emergencyContactNidNumber');
    if (!s(b.payoutWalletProvider)) missing.push('payoutWalletProvider');
    if (!s(b.payoutWalletNumber)) missing.push('payoutWalletNumber');
    if (!b.termsAcceptedAt) missing.push('termsAcceptedAt');
    if (!b.privacyAcceptedAt) missing.push('privacyAcceptedAt');
    if (!b.ageConfirmedAt) missing.push('ageConfirmedAt');
    if (!s(b.termsVersion)) missing.push('termsVersion');
    if (!s(b.privacyVersion)) missing.push('privacyVersion');

    const userDoc = existing || {};
    if (!userDoc.nidFrontImageUrl && !s(b.nidFrontImageUrl)) missing.push('nidFrontImageUrl (upload NID front first)');
    if (!userDoc.nidBackImageUrl && !s(b.nidBackImageUrl)) missing.push('nidBackImageUrl (upload NID back first)');
    if (!userDoc.profileCover && !s(b.profileCover)) missing.push('profileCover (upload profile photo first)');
    if (!userDoc.emergencyContactNidFrontUrl && !s(b.emergencyContactNidFrontUrl)) missing.push('emergencyContactNidFrontUrl');
    if (!userDoc.emergencyContactNidBackUrl && !s(b.emergencyContactNidBackUrl)) missing.push('emergencyContactNidBackUrl');

    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });

    if (!isValidBdMobile(b.phone)) return res.status(400).json({ error: 'Invalid phone number. Must be a valid Bangladesh mobile number (e.g. 01XXXXXXXXX).' });
    if (!isValidBdMobile(b.emergencyContactPhone)) return res.status(400).json({ error: 'Invalid emergency contact phone number.' });
    if (!isValidBdMobile(b.payoutWalletNumber)) return res.status(400).json({ error: 'Invalid payout wallet number.' });
    if (!isValidNid(b.nidNumber)) return res.status(400).json({ error: 'Invalid NID number. Must be 10 or 17 digits.' });
    const validWalletProviders = ['bkash', 'nagad', 'rocket'];
    if (!validWalletProviders.includes(s(b.payoutWalletProvider).toLowerCase())) return res.status(400).json({ error: 'Invalid payout wallet provider. Must be bkash, nagad, or rocket.' });

    const now = new Date();
    const updatePayload = {
      fullLegalName: s(b.fullLegalName), phone: s(b.phone), city: s(b.city), district: s(b.district),
      nidNumber: s(b.nidNumber), emergencyContactName: s(b.emergencyContactName),
      emergencyContactPhone: s(b.emergencyContactPhone), emergencyContactNidNumber: s(b.emergencyContactNidNumber),
      emergencyContactNidFrontUrl: s(b.emergencyContactNidFrontUrl), emergencyContactNidBackUrl: s(b.emergencyContactNidBackUrl),
      payoutWalletProvider: s(b.payoutWalletProvider).toLowerCase(), payoutWalletNumber: s(b.payoutWalletNumber),
      termsAcceptedAt: new Date(b.termsAcceptedAt), privacyAcceptedAt: new Date(b.privacyAcceptedAt),
      ageConfirmedAt: new Date(b.ageConfirmedAt), termsVersion: s(b.termsVersion), privacyVersion: s(b.privacyVersion),
      workerAccountStatus: 'pending_review', registrationSubmittedAt: now, updatedAt: now, role: 'worker',
    };

    if (s(b.bio)) updatePayload.bio = s(b.bio);
    if (b.experienceYears != null) updatePayload.experienceYears = Number(b.experienceYears) || 0;
    if (s(b.firstName)) updatePayload.firstName = s(b.firstName);
    if (s(b.lastName)) updatePayload.lastName = s(b.lastName);
    if (s(b.country)) updatePayload.country = s(b.country);
    if (b.servicesOffered) updatePayload.servicesOffered = b.servicesOffered;

    await collections.users.updateOne({ uid }, { $set: updatePayload, $setOnInsert: { uid, createdAt: now } }, { upsert: true });
    console.log(`📋 Worker registration submitted: uid=${uid}, name=${updatePayload.fullLegalName}`);
    res.json({ success: true, workerAccountStatus: 'pending_review' });
  } catch (e) {
    console.error('POST /api/workers/registration/submit failed:', e);
    res.status(500).json({ error: 'Registration submission failed' });
  }
});

// Admin: List worker registrations
router.get('/admin/registrations', async (req, res) => {
  // This is actually mounted under /api/admin — see admin/workers.js
  res.status(404).json({ error: 'Not found' });
});

module.exports = router;
