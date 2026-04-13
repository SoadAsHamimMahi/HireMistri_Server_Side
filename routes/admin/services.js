const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { adminRateLimiter } = require('../../middleware/rateLimiter');
const { collections } = require('../../config/db');

const router = Router();

    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;
        const categoryId = req.query.categoryId;
        const q = categoryId ? { categoryId: String(categoryId) } : {};
        const [list, total] = await Promise.all([
          collections.services.find(q).sort({ name: 1 }).skip(skip).limit(limit).toArray(),
          collections.services.countDocuments(q),
        ]);
        res.json({ list, total, page, limit });
      } catch (err) {
        console.error('GET /api/admin/services failed:', err);
        res.status(500).json({ error: 'Failed to fetch services' });
      }
    });
    router.patch('/:id', authenticateAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
        const doc = await collections.services.findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ error: 'Service not found' });
        res.json(doc);
      } catch (err) {
        console.error('GET /api/admin/services/:id failed:', err);
        res.status(500).json({ error: 'Failed to fetch service' });
      }
    });
    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const body = req.body || {};
        const doc = {
          name: String(body.name || '').trim(),
          slug: String((body.slug || body.name || '').toLowerCase().replace(/\s+/g, '-')).trim() || null,
          categoryId: body.categoryId ? String(body.categoryId) : null,
          description: String(body.description || '').trim(),
          isActive: body.isActive !== false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await collections.services.insertOne(doc);
        res.status(201).json({ id: result.insertedId, ...doc });
      } catch (err) {
        console.error('POST /api/admin/services failed:', err);
        res.status(500).json({ error: 'Create failed' });
      }
    });
    router.patch('/:id', authenticateAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
        const body = req.body || {};
        const $set = { updatedAt: new Date() };
        if (body.name !== undefined) $set.name = String(body.name).trim();
        if (body.slug !== undefined) $set.slug = String(body.slug).trim();
        if (body.categoryId !== undefined) $set.categoryId = body.categoryId ? String(body.categoryId) : null;
        if (body.description !== undefined) $set.description = String(body.description).trim();
        if (typeof body.isActive === 'boolean') $set.isActive = body.isActive;
        const result = await collections.services.updateOne({ _id: new ObjectId(id) }, { $set });
        if (result.matchedCount === 0) return res.status(404).json({ error: 'Service not found' });
        res.json({ ok: true });
      } catch (err) {
        console.error('PATCH /api/admin/services/:id failed:', err);
        res.status(500).json({ error: 'Update failed' });
      }
    });
    router.post('/bulk', authenticateAdmin, adminRateLimiter('admin_bulk', 500), async (req, res) => {
      try {
        const { ids, update } = req.body || {};
        if (!Array.isArray(ids) || !update || typeof update !== 'object') {
          return res.status(400).json({ error: 'ids array and update object required' });
        }
        const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        const $set = { updatedAt: new Date() };
        if (typeof update.isActive === 'boolean') $set.isActive = update.isActive;
        if (update.categoryId !== undefined) $set.categoryId = update.categoryId ? String(update.categoryId) : null;
        const result = await collections.services.updateMany({ _id: { $in: objectIds } }, { $set });
        await logAdminAction(req, 'services_bulk', 'services', { count: ids.length, modified: result.modifiedCount });
        res.json({ ok: true, matched: result.matchedCount, modified: result.modifiedCount });
      } catch (err) {
        console.error('POST /api/admin/services/bulk failed:', err);
        res.status(500).json({ error: 'Bulk update failed' });
      }
    });

module.exports = router;
