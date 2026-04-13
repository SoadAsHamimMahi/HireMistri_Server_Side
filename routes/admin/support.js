// routes/admin/support.js — /api/admin/support/tickets/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

// List tickets
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const statusIn = req.query.status;
    const roleIn = req.query.role;
    const q = {};
    if (statusIn === 'open' || statusIn === 'closed') q.status = statusIn;
    if (roleIn === 'client' || roleIn === 'worker') q.userRole = roleIn;
    const [list, total] = await Promise.all([
      collections.supportTickets.find(q).sort({ lastMessageAt: -1 }).skip(skip).limit(limit).toArray(),
      collections.supportTickets.countDocuments(q),
    ]);
    res.json({ list, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/support/tickets failed:', err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get ticket messages
router.get('/:ticketId/messages', authenticateAdmin, async (req, res) => {
  try {
    const { ticketId } = req.params;
    if (!ObjectId.isValid(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' });
    const ticket = await collections.supportTickets.findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const messages = await collections.supportMessages.find({ ticketId: new ObjectId(ticketId) }).sort({ createdAt: 1 }).toArray();
    const userMsgIds = messages.filter(m => m.senderType === 'user').map(m => m._id);
    if (userMsgIds.length) {
      await collections.supportMessages.updateMany({ _id: { $in: userMsgIds } }, { $set: { readByAdmin: true } });
    }
    await collections.supportTickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { unreadForAdmin: 0, updatedAt: new Date() } }
    );
    res.json({ ticket, messages });
  } catch (err) {
    console.error('GET /api/admin/support/tickets/:ticketId/messages failed:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Reply to a ticket
router.post('/:ticketId/messages', authenticateAdmin, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!ObjectId.isValid(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' });
    const ticket = await collections.supportTickets.findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
    const now = new Date();
    const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    const msgDoc = {
      ticketId: new ObjectId(ticketId), senderType: 'admin', senderId: req.user.uid,
      message, createdAt: now, readByUser: false, readByAdmin: true,
    };
    const result = await collections.supportMessages.insertOne(msgDoc);
    await collections.supportTickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { lastMessageAt: now, lastMessagePreview: preview, updatedAt: now, unreadForUser: (ticket.unreadForUser || 0) + 1 } }
    );
    res.status(201).json({ message: { ...msgDoc, _id: result.insertedId } });
  } catch (err) {
    console.error('POST /api/admin/support/tickets/:ticketId/messages failed:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Close/reopen a ticket
router.patch('/:ticketId', authenticateAdmin, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Status must be open or closed' });
    if (!ObjectId.isValid(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' });
    const result = await collections.supportTickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { status, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    await logAdminAction(req, 'ticket_status_change', 'supportTickets', { ticketId, status });
    res.json({ ok: true, status });
  } catch (err) {
    console.error('PATCH /api/admin/support/tickets/:ticketId/status failed:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
