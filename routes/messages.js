// routes/messages.js — /api/messages/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');
const { getConversationId } = require('../utils/helpers');
const { createNotification } = require('../utils/notifications');
const { sendNewMessageEmail } = require('../utils/emailService');

const router = Router();

// Get conversations for a user
router.get('/conversations', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const conversations = await collections.messages
      .aggregate([
        { $match: { $or: [{ senderId: userId }, { recipientId: userId }] } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$conversationId',
            lastMessage: { $first: '$$ROOT' },
            unreadCount: {
              $sum: {
                $cond: [{ $and: [{ $eq: ['$recipientId', userId] }, { $eq: ['$read', false] }] }, 1, 0],
              },
            },
          },
        },
        { $sort: { 'lastMessage.createdAt': -1 } },
      ])
      .toArray();

    res.json(conversations);
  } catch (err) {
    console.error('❌ Failed to fetch conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get messages for a conversation
router.get('/conversation/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const messages = await collections.messages
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .toArray();

    await collections.messages.updateMany(
      { conversationId, recipientId: userId, read: false },
      { $set: { read: true, readAt: new Date() } }
    );

    res.json(messages);
  } catch (err) {
    console.error('❌ Failed to fetch messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message (HTTP, mirrors WebSocket)
router.post('/', async (req, res) => {
  try {
    const { senderId, recipientId, jobId, message, senderName, recipientName } = req.body;
    if (!senderId || !recipientId || !message) {
      return res.status(400).json({ error: 'senderId, recipientId, and message are required' });
    }

    const conversationId = getConversationId(senderId, recipientId, jobId);
    const newMessage = {
      conversationId,
      senderId,
      recipientId,
      jobId: jobId || null,
      message: String(message).trim(),
      senderName: senderName || '',
      recipientName: recipientName || '',
      read: false,
      createdAt: new Date(),
    };

    const result = await collections.messages.insertOne(newMessage);
    const insertedMessage = await collections.messages.findOne({ _id: result.insertedId });

    // Async: email + in-app notification
    (async () => {
      try {
        let recipientEmail = null;
        let resolvedRecipientName = insertedMessage.recipientName || 'User';
        let jobTitle = null;

        if (recipientId) {
          const recipientUser = await collections.users.findOne({ uid: recipientId });
          if (recipientUser) {
            recipientEmail = recipientUser.email;
            resolvedRecipientName =
              recipientUser.displayName ||
              [recipientUser.firstName, recipientUser.lastName].filter(Boolean).join(' ') ||
              resolvedRecipientName;
          }
        }

        if (jobId && ObjectId.isValid(jobId)) {
          const jobDoc = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
          if (jobDoc) jobTitle = jobDoc.title;
        }

        const resolvedSenderName = insertedMessage.senderName || 'Someone';

        if (recipientId) {
          await createNotification(
            recipientId,
            'New Message',
            `You have a new message from ${resolvedSenderName}${jobTitle ? ` about "${jobTitle}"` : ''}`,
            'info',
            jobId,
            null
          );
        }

        if (recipientEmail) {
          sendNewMessageEmail(recipientEmail, resolvedRecipientName, resolvedSenderName, jobTitle).catch(() => {});
        }
      } catch (e) {
        console.error('Error in async message notification:', e);
      }
    })();

    res.status(201).json(insertedMessage);
  } catch (err) {
    console.error('❌ Failed to send message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark messages as read
router.patch('/read', async (req, res) => {
  try {
    const { conversationId, userId } = req.body;
    if (!conversationId || !userId) {
      return res.status(400).json({ error: 'conversationId and userId are required' });
    }
    const result = await collections.messages.updateMany(
      { conversationId, recipientId: userId, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error('❌ Failed to mark messages as read:', err);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

module.exports = router;
