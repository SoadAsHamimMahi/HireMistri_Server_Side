// routes/support.js — /api/support/tickets/* (user-facing)
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateUser } = require('../middleware/auth');
const { collections } = require('../config/db');

const router = Router();

// Create a ticket
router.post('/tickets', authenticateUser, async (req, res) => {
  try {
    const uid = String(req.user?.uid || '').trim();
    if (!uid) return res.status(401).json({ error: 'Authentication required' });
    const userDoc = await collections.users.findOne({ uid });
    const userRole = (userDoc?.role === 'worker') ? 'worker' : 'client';
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
    const now = new Date();
    const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    const ticket = { userId: uid, userRole, subject, status: 'open', createdAt: now, updatedAt: now, lastMessageAt: now, lastMessagePreview: preview, unreadForAdmin: 1, unreadForUser: 0 };
    const result = await collections.supportTickets.insertOne(ticket);
    const msgDoc = { ticketId: result.insertedId, senderType: 'user', senderId: uid, message, createdAt: now, readByUser: true, readByAdmin: false };
    await collections.supportMessages.insertOne(msgDoc);
    res.status(201).json({ ticket: { ...ticket, _id: result.insertedId }, messageId: msgDoc._id });
  } catch (err) {
    console.error('POST /api/support/tickets failed:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// List user's tickets
router.get('/tickets', authenticateUser, async (req, res) => {
  try {
    const uid = String(req.user?.uid || '').trim();
    if (!uid) return res.status(401).json({ error: 'Authentication required' });
    const status = req.query.status;
    const query = { userId: uid };
    if (status === 'open' || status === 'closed') query.status = status;
    const list = await collections.supportTickets.find(query).sort({ lastMessageAt: -1 }).toArray();
    res.json({ list });
  } catch (err) {
    console.error('GET /api/support/tickets failed:', err);
    res.status(500).json({ error: 'Failed to list tickets' });
  }
});

// Get ticket messages (user view)
router.get('/tickets/:ticketId/messages', authenticateUser, async (req, res) => {
  try {
    const uid = String(req.user?.uid || '').trim();
    const { ticketId } = req.params;
    if (!ObjectId.isValid(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' });
    const ticket = await collections.supportTickets.findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.userId !== uid) return res.status(403).json({ error: 'Not your ticket' });
    const messages = await collections.supportMessages.find({ ticketId: new ObjectId(ticketId) }).sort({ createdAt: 1 }).toArray();
    const adminMsgIds = messages.filter(m => m.senderType === 'admin').map(m => m._id);
    if (adminMsgIds.length) await collections.supportMessages.updateMany({ _id: { $in: adminMsgIds } }, { $set: { readByUser: true } });
    await collections.supportTickets.updateOne({ _id: new ObjectId(ticketId) }, { $set: { unreadForUser: 0, updatedAt: new Date() } });
    res.json({ ticket, messages });
  } catch (err) {
    console.error('GET /api/support/tickets/:ticketId/messages failed:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Reply to a ticket (user)
router.post('/tickets/:ticketId/messages', authenticateUser, async (req, res) => {
  try {
    const uid = String(req.user?.uid || '').trim();
    const { ticketId } = req.params;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!ObjectId.isValid(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' });
    const ticket = await collections.supportTickets.findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.userId !== uid) return res.status(403).json({ error: 'Not your ticket' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
    const now = new Date();
    const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    const msgDoc = { ticketId: new ObjectId(ticketId), senderType: 'user', senderId: uid, message, createdAt: now, readByUser: true, readByAdmin: false };
    const result = await collections.supportMessages.insertOne(msgDoc);
    await collections.supportTickets.updateOne(
      { _id: new ObjectId(ticketId) },
      { $set: { lastMessageAt: now, lastMessagePreview: preview, updatedAt: now, unreadForAdmin: (ticket.unreadForAdmin || 0) + 1 } }
    );
    res.status(201).json({ message: { ...msgDoc, _id: result.insertedId } });
  } catch (err) {
    console.error('POST /api/support/tickets/:ticketId/messages failed:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
