// routes/users.js — /api/users/*, /api/auth/*, /api/workers/*, /api/browse-workers, /api/browse-clients
const { Router } = require('express');
const { collections } = require('../config/db');
const { authenticateUser } = require('../middleware/auth');
const { upload, nidUploadMiddleware } = require('../middleware/upload');
const { computeUserStats, getWorkerIdentity } = require('../utils/helpers');
const { isValidBdMobile, isValidNid } = require('../utils/validators');
const { sendWorkerRegistrationApprovedEmail, sendWorkerRegistrationRejectedEmail } = require('../utils/emailService');

const router = Router();

// ---- Create User ----
router.post('/', async (req, res) => {
  try {
    const now = new Date();
    const body = req.body || {};
    const uid = String(body.uid || '').trim();
    const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';

    if (!uid) return res.status(400).json({ error: 'uid is required' });
    if (!email) return res.status(400).json({ error: 'email is required' });

    const existingByUid = await collections.users.findOne({ uid });
    if (existingByUid) {
      return res.status(200).json(existingByUid);
    }

    const existingByEmail = await collections.users.findOne({ email });
    if (existingByEmail && String(existingByEmail.uid || '') !== uid) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const doc = {
      uid,
      email,
      role: String(body.role || 'client').trim() || 'client',
      firstName: String(body.firstName || '').trim(),
      lastName: String(body.lastName || '').trim(),
      displayName:
        String(body.displayName || '').trim() ||
        [body.firstName, body.lastName].filter(Boolean).map((v) => String(v).trim()).join(' ').trim() ||
        'User',
      phone: String(body.phone || '').trim(),
      createdAt: body.createdAt ? new Date(body.createdAt) : now,
      updatedAt: now,
    };

    await collections.users.insertOne(doc);
    return res.status(201).json(doc);
  } catch (err) {
    console.error('POST /api/users failed:', err);
    if (err?.code === 11000) return res.status(409).json({ error: 'Duplicate key (uid/email must be unique)' });
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// ---- User Profile ----
router.get('/:uid', async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const doc = await collections.users.findOne({ uid });
    if (!doc) return res.status(404).json({ error: 'User not found' });
    const stats = await computeUserStats(uid);
    res.json({ ...doc, totalJobsPosted: stats?.totalJobsPosted || 0, averageRating: stats?.averageRating || 0, stats: stats || {} });
  } catch (err) {
    console.error('GET /api/users/:uid failed:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.get('/:uid/public', async (req, res) => {
  try {
    const uid = String(req.params.uid || '').trim();
    if (!uid) return res.status(400).json({ error: 'Missing uid' });
    const doc = await collections.users.findOne({ uid });
    if (!doc) return res.status(404).json({ error: 'User not found' });
    const stats = await computeUserStats(uid);
    const publicDoc = {
      uid: doc.uid, role: doc.role || 'user',
      displayName: ([doc.firstName, doc.lastName].filter(Boolean).join(' ').trim()) || (doc.displayName && doc.displayName !== 'User' ? doc.displayName : 'User'),
      firstName: doc.firstName || '', lastName: doc.lastName || '',
      headline: doc.headline || '', bio: doc.bio || '',
      skills: Array.isArray(doc.skills) ? doc.skills : [],
      isAvailable: !!doc.isAvailable, profileCover: doc.profileCover || '',
      city: doc.city || '', country: doc.country || '',
      emailVerified: !!doc.emailVerified, phoneVerified: !!doc.phoneVerified,
      createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null, lastActiveAt: doc.lastActiveAt || null,
      ...((doc.role === 'worker' || doc.workerAccountStatus) ? {
        servicesOffered: doc.servicesOffered || null, serviceArea: doc.serviceArea || null,
        experienceYears: doc.experienceYears || doc.workExperience || null,
        languages: Array.isArray(doc.languages) ? doc.languages : [],
        pricing: doc.pricing || null, portfolio: Array.isArray(doc.portfolio) ? doc.portfolio : [],
        certifications: Array.isArray(doc.certifications) ? doc.certifications : [],
        workerAccountStatus: doc.workerAccountStatus || null,
      } : {}),
      ...(doc.role === 'client' ? { preferences: doc.preferences || null } : {}),
      totalJobsPosted: stats?.totalJobsPosted || 0, averageRating: stats?.averageRating || 0, stats: stats || {},
    };
    res.json(publicDoc);
  } catch (err) {
    console.error('GET /api/users/:uid/public failed:', err);
    res.status(500).json({ error: 'Failed to fetch public profile' });
  }
});

router.get('/:uid/contact', authenticateUser, async (req, res) => {
  try {
    const targetUid = String(req.params.uid || '').trim();
    const callerUid = req.user?.uid;
    if (!targetUid || !callerUid) return res.status(400).json({ error: 'Missing uid or not authenticated' });
    if (callerUid === targetUid) return res.status(400).json({ error: 'Cannot fetch own contact' });
    const hasAccepted = await collections.applications.findOne({
      status: 'accepted',
      $or: [{ clientId: callerUid, workerId: targetUid }, { clientId: targetUid, workerId: callerUid }],
    });
    if (!hasAccepted) return res.status(403).json({ error: 'Contact details are only shared after a job is accepted' });
    const doc = await collections.users.findOne({ uid: targetUid });
    if (!doc) return res.status(404).json({ error: 'User not found' });
    res.json({ phone: doc.phone || '', email: doc.email || '' });
  } catch (err) {
    console.error('GET /api/users/:uid/contact failed:', err);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// ---- PATCH/PUT User ----
const patchUserHandler = async (req, res) => {
  try {
    const uid = String(req.params.uid || '').trim();
    if (!uid) return res.status(400).json({ error: 'Missing uid' });
    const now = new Date();
    const body = req.body || {};
    const allowUnset = String(req.query.allowUnset || '').toLowerCase() === 'true';
    const allowed = new Set(['firstName', 'lastName', 'displayName', 'phone', 'headline', 'bio',
      'skills', 'isAvailable', 'profileCover', 'address1', 'address2', 'city', 'country', 'zip',
      'workExperience', 'role', 'email', 'emailVerified', 'phoneVerified', 'lastActiveAt',
      'servicesOffered', 'serviceArea', 'experienceYears', 'certifications', 'languages', 'pricing', 'portfolio', 'preferences']);
    const existing = (await collections.users.findOne({ uid })) || { uid, createdAt: now };
    const $set = {};
    const $unset = {};
    for (const [k, vRaw] of Object.entries(body)) {
      if (!allowed.has(k)) continue;
      const v = (k === 'email' && typeof vRaw === 'string') ? vRaw.toLowerCase().trim() : vRaw;
      if (Array.isArray(v)) {
        if (k === 'skills' || k === 'languages') {
          const cleaned = v.map(s => String(s).trim()).filter(Boolean);
          if (cleaned.length) $set[k] = cleaned;
        } else if (k === 'portfolio' || k === 'certifications') {
          if (v.length > 0 && v.every(item => typeof item === 'object')) $set[k] = v;
        } else if (v.length) $set[k] = v;
        continue;
      }
      if (typeof v === 'boolean' || typeof v === 'number') { $set[k] = v; continue; }
      if (typeof v === 'string') {
        const t = v.trim();
        if (t) $set[k] = t;
        else if (allowUnset && t === '' && existing[k] !== undefined) $unset[k] = '';
        continue;
      }
      if (v === null) { if (allowUnset && existing[k] !== undefined) $unset[k] = ''; continue; }
      if (v && typeof v === 'object') { if (Object.keys(v).length) $set[k] = v; }
    }
    $set.updatedAt = now;
    const updateDoc = { $set, $setOnInsert: { uid, createdAt: existing.createdAt || now } };
    if (Object.keys($unset).length) updateDoc.$unset = $unset;
    if (Object.keys($set).length === 1 && Object.keys($unset).length === 0) return res.json(existing);
    await collections.users.updateOne({ uid }, updateDoc, { upsert: true });
    const doc = await collections.users.findOne({ uid });
    const nameChanged = ['displayName', 'firstName', 'lastName'].some(k => $set[k] !== undefined);
    if (nameChanged) {
      const newName = (doc.displayName || [doc.firstName, doc.lastName].filter(Boolean).join(' ').trim() || '').trim();
      if (newName) {
        await collections.applications.updateMany({ workerId: uid }, { $set: { workerName: newName, updatedAt: now } }).catch(() => {});
      }
    }
    return res.json(doc);
  } catch (err) {
    console.error('PATCH /api/users/:uid failed:', err);
    if (err?.code === 11000) return res.status(409).json({ error: 'Duplicate key (email must be unique)' });
    return res.status(500).json({ error: 'Update failed' });
  }
};
router.patch('/:uid', patchUserHandler);
router.put('/:uid', patchUserHandler);

// ---- Avatar upload ----
router.post('/:uid/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const uid = String(req.params.uid);
    const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    await collections.users.updateOne({ uid }, { $set: { profileCover: publicUrl, updatedAt: new Date() }, $setOnInsert: { uid, createdAt: new Date() } }, { upsert: true });
    res.json({ url: publicUrl });
  } catch (e) {
    console.error('POST /api/users/:uid/avatar failed:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---- NID uploads ----
async function handleNidUpload(side, req, res) {
  nidUploadMiddleware(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const uid = String(req.params.uid);
      if (req.user && req.user.uid !== uid) return res.status(403).json({ error: 'Unauthorized' });
      const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const fieldMap = { front: 'nidFrontImageUrl', back: 'nidBackImageUrl', emergencyFront: 'emergencyContactNidFrontUrl', emergencyBack: 'emergencyContactNidBackUrl' };
      const field = fieldMap[side] || 'emergencyContactNidImageUrl';
      await collections.users.updateOne({ uid }, { $set: { [field]: publicUrl, updatedAt: new Date() }, $setOnInsert: { uid, createdAt: new Date() } }, { upsert: true });
      res.json({ url: publicUrl, side });
    } catch (e) {
      console.error(`POST /api/users/:uid/nid/${side} failed:`, e);
      res.status(500).json({ error: 'NID upload failed' });
    }
  });
}
router.post('/:uid/nid/front', (req, res) => handleNidUpload('front', req, res));
router.post('/:uid/nid/back', (req, res) => handleNidUpload('back', req, res));
router.post('/:uid/nid/emergencyFront', (req, res) => handleNidUpload('emergencyFront', req, res));
router.post('/:uid/nid/emergencyBack', (req, res) => handleNidUpload('emergencyBack', req, res));

module.exports = router;
