// routes/notifications.js — /api/notifications/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');

const router = Router();

// Get notifications for a user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const notifications = await collections.notifications
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    const unreadCount = await collections.notifications.countDocuments({ userId, read: false });

    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('❌ Failed to fetch notifications:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.patch('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid notification id' });

    const query = { _id: new ObjectId(id) };
    if (userId) query.userId = userId;

    const result = await collections.notifications.updateOne(query, { $set: { read: true, readAt: new Date() } });

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Notification not found' });

    res.json({ message: 'Notification marked as read', updated: true });
  } catch (err) {
    console.error('❌ Failed to mark notification as read:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Delete notification
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid notification id' });

    const query = { _id: new ObjectId(id) };
    if (userId) query.userId = userId;

    const result = await collections.notifications.deleteOne(query);

    if (result.deletedCount === 0) return res.status(404).json({ error: 'Notification not found' });

    res.json({ message: 'Notification deleted successfully', deleted: true });
  } catch (err) {
    console.error('❌ Failed to delete notification:', err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;
