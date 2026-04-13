// routes/admin/cms.js — /api/admin/home/*, /api/admin/subscription/*, /api/admin/media/*, /api/admin/system/*, /api/admin/promo/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { adminRateLimiter, ADMIN_BULK_MAX, ADMIN_BACKUP_MAX } = require('../../middleware/rateLimiter');
const { collections } = require('../../config/db');

const router = Router();

// ---- Home CMS – Sliders ----
router.get('/home/sliders', authenticateAdmin, async (req, res) => {
  try { res.json({ list: await collections.sliders.find({}).sort({ order: 1 }).toArray() }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch sliders' }); }
});
router.post('/home/sliders', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { title: String(b.title || '').trim(), imageUrl: String(b.imageUrl || '').trim(), linkUrl: String(b.linkUrl || '').trim(), order: Number(b.order) || 0, isActive: b.isActive !== false, createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.sliders.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.patch('/home/sliders/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const $set = { updatedAt: new Date() };
    if (b.title !== undefined) $set.title = String(b.title).trim();
    if (b.imageUrl !== undefined) $set.imageUrl = String(b.imageUrl).trim();
    if (b.linkUrl !== undefined) $set.linkUrl = String(b.linkUrl).trim();
    if (typeof b.order === 'number') $set.order = b.order;
    if (typeof b.isActive === 'boolean') $set.isActive = b.isActive;
    const result = await collections.sliders.updateOne({ _id: new ObjectId(id) }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});
router.delete('/home/sliders/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.sliders.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// ---- Home CMS – Featured ----
router.get('/home/featured', authenticateAdmin, async (req, res) => {
  try { res.json({ list: await collections.featuredSection.find({}).sort({ order: 1 }).toArray() }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch featured' }); }
});
router.post('/home/featured', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { title: String(b.title || '').trim(), subtitle: String(b.subtitle || '').trim(), imageUrl: String(b.imageUrl || '').trim(), linkUrl: String(b.linkUrl || '').trim(), order: Number(b.order) || 0, isActive: b.isActive !== false, createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.featuredSection.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.patch('/home/featured/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const $set = { updatedAt: new Date() };
    if (b.title !== undefined) $set.title = String(b.title).trim();
    if (b.subtitle !== undefined) $set.subtitle = String(b.subtitle).trim();
    if (b.imageUrl !== undefined) $set.imageUrl = String(b.imageUrl).trim();
    if (b.linkUrl !== undefined) $set.linkUrl = String(b.linkUrl).trim();
    if (typeof b.order === 'number') $set.order = b.order;
    if (typeof b.isActive === 'boolean') $set.isActive = b.isActive;
    const result = await collections.featuredSection.updateOne({ _id: new ObjectId(id) }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});
router.delete('/home/featured/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.featuredSection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// ---- Subscription Plans ----
router.get('/subscription/plans', authenticateAdmin, async (req, res) => {
  try { res.json({ list: await collections.subscriptionPlans.find({}).sort({ order: 1 }).toArray() }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch plans' }); }
});
router.post('/subscription/plans', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { name: String(b.name || '').trim(), price: Number(b.price) || 0, interval: ['month', 'year'].includes(b.interval) ? b.interval : 'month', features: Array.isArray(b.features) ? b.features : [], isActive: b.isActive !== false, order: Number(b.order) || 0, createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.subscriptionPlans.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.patch('/subscription/plans/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const $set = { updatedAt: new Date() };
    if (b.name !== undefined) $set.name = String(b.name).trim();
    if (typeof b.price === 'number') $set.price = b.price;
    if (['month', 'year'].includes(b.interval)) $set.interval = b.interval;
    if (Array.isArray(b.features)) $set.features = b.features;
    if (typeof b.isActive === 'boolean') $set.isActive = b.isActive;
    if (typeof b.order === 'number') $set.order = b.order;
    const result = await collections.subscriptionPlans.updateOne({ _id: new ObjectId(id) }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});
router.get('/subscription/subscriptions', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.userSubscriptions.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.userSubscriptions.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch subscriptions' }); }
});

// ---- Media – Gallery ----
router.get('/media/gallery', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      collections.gallery.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.gallery.countDocuments({}),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch gallery' }); }
});
router.post('/media/gallery', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { url: String(b.url || '').trim(), caption: String(b.caption || '').trim(), category: String(b.category || '').trim(), createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.gallery.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.delete('/media/gallery/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.gallery.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// ---- System – FAQs ----
router.get('/system/faqs', authenticateAdmin, async (req, res) => {
  try { res.json({ list: await collections.faqs.find({}).sort({ order: 1 }).toArray() }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch FAQs' }); }
});
router.post('/system/faqs', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { question: String(b.question || '').trim(), answer: String(b.answer || '').trim(), order: Number(b.order) || 0, isActive: b.isActive !== false, createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.faqs.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.patch('/system/faqs/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const $set = { updatedAt: new Date() };
    if (b.question !== undefined) $set.question = String(b.question).trim();
    if (b.answer !== undefined) $set.answer = String(b.answer).trim();
    if (typeof b.order === 'number') $set.order = b.order;
    if (typeof b.isActive === 'boolean') $set.isActive = b.isActive;
    const result = await collections.faqs.updateOne({ _id: new ObjectId(id) }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});
router.delete('/system/faqs/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.faqs.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// ---- System – Admin Users ----
router.get('/system/users', authenticateAdmin, async (req, res) => {
  try { res.json({ list: await collections.adminUsers.find({}).sort({ createdAt: -1 }).toArray() }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch system users' }); }
});
router.post('/system/users', authenticateAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const doc = { uid: String(b.uid || '').trim(), email: String(b.email || '').trim().toLowerCase(), permissions: Array.isArray(b.permissions) ? b.permissions : ['*'], createdAt: new Date(), updatedAt: new Date() };
    if (!doc.uid) return res.status(400).json({ error: 'uid required' });
    const result = await collections.adminUsers.insertOne(doc);
    res.status(201).json({ id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});
router.patch('/system/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const $set = { updatedAt: new Date() };
    if (Array.isArray(b.permissions)) $set.permissions = b.permissions;
    const result = await collections.adminUsers.updateOne({ _id: new ObjectId(id) }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});
router.delete('/system/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await collections.adminUsers.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// ---- System – Backup ----
router.get('/system/backup', authenticateAdmin, async (req, res) => res.json({ list: [], message: 'Backup metadata - integrate with your backup solution' }));
router.post('/system/backup', authenticateAdmin, adminRateLimiter('admin_backup', ADMIN_BACKUP_MAX), async (req, res) => {
  try {
    await logAdminAction(req, 'backup_trigger', 'system', {});
    res.json({ ok: true, message: 'Backup triggered - integrate with your backup solution' });
  } catch (err) { res.status(500).json({ error: 'Backup trigger failed' }); }
});

// ---- Promo – Email Campaign ----
router.post('/promo/email/send', authenticateAdmin, adminRateLimiter('admin_email_campaign', ADMIN_BULK_MAX), async (req, res) => {
  try {
    const { subject, htmlBody, targetAudience = 'all' } = req.body || {};
    if (!subject || !htmlBody) return res.status(400).json({ error: 'subject and htmlBody are required' });
    if (!['all', 'clients', 'workers'].includes(targetAudience)) return res.status(400).json({ error: 'Invalid targetAudience' });
    const { sendEmail } = require('../../utils/emailService');
    let userQuery = {};
    if (targetAudience === 'clients') userQuery = { role: 'client' };
    else if (targetAudience === 'workers') userQuery = { role: 'worker' };
    const users = await collections.users.find(userQuery, { projection: { uid: 1, email: 1, firstName: 1, lastName: 1 } }).toArray();
    let sentCount = 0;
    let failCount = 0;
    for (const user of users) {
      if (user.email) {
        const result = await sendEmail(user.email, subject, htmlBody);
        if (result.success) sentCount++;
        else failCount++;
      }
    }
    const record = { subject, targetAudience, sentCount, failCount, totalTargeted: users.length, sentBy: req.user.uid, status: failCount === 0 ? 'success' : (sentCount === 0 ? 'failed' : 'partial'), createdAt: new Date() };
    await collections.db.collection('emailCampaigns').insertOne(record);
    await logAdminAction(req, 'send_email_campaign', 'emailCampaigns', { subject, targetAudience, sentCount, failCount });
    res.json({ ok: true, sentCount, failCount, totalTargeted: users.length });
  } catch (err) {
    console.error('POST /api/admin/promo/email/send failed:', err);
    res.status(500).json({ error: 'Email send failed' });
  }
});

module.exports = router;
