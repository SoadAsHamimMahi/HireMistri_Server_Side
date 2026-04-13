const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const list = await collections.categories.find({}).sort({ name: 1 }).toArray();
        res.json({ list });
      } catch (err) {
        console.error('GET /api/admin/categories failed:', err);
        res.status(500).json({ error: 'Failed to fetch categories' });
      }
    });
    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const body = req.body || {};
        const doc = {
          name: String(body.name || '').trim(),
          slug: String((body.slug || body.name || '').toLowerCase().replace(/\s+/g, '-')).trim() || null,
          isActive: body.isActive !== false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await collections.categories.insertOne(doc);
        res.status(201).json({ id: result.insertedId, ...doc });
      } catch (err) {
        console.error('POST /api/admin/categories failed:', err);
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
        if (typeof body.isActive === 'boolean') $set.isActive = body.isActive;
        const result = await collections.categories.updateOne({ _id: new ObjectId(id) }, { $set });
        if (result.matchedCount === 0) return res.status(404).json({ error: 'Category not found' });
        res.json({ ok: true });
      } catch (err) {
        console.error('PATCH /api/admin/categories/:id failed:', err);
        res.status(500).json({ error: 'Update failed' });
      }
    });

module.exports = router;
