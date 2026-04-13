// utils/messaging.js — Conversation ID helpers and system message sender
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');

let _io = null;

function setIo(io) {
  _io = io;
}

// Generate a stable conversationId for two users + optional job
async function findOrCreateConversationId(jobId, clientId, workerId) {
  try {
    if (!clientId || !workerId) return null;

    const sortedIds = [String(clientId), String(workerId)].sort();

    let conversationId;
    if (jobId && ObjectId.isValid(jobId)) {
      conversationId = `${String(jobId)}_${sortedIds.join('_')}`;
    } else {
      conversationId = sortedIds.join('_');
    }

    // Check if conversation already exists
    await collections.messages.findOne({ conversationId });

    // Return the generated ID — conversation is lazily created on first message
    return conversationId;
  } catch (err) {
    console.error('❌ Failed to find or create conversationId:', err);
    return null;
  }
}

// Insert a system-generated chat message and emit via WebSocket
async function sendSystemMessage(conversationId, senderId, recipientId, jobId, message, options = {}) {
  try {
    if (!conversationId && jobId && senderId && recipientId) {
      let clientId = senderId;
      let workerId = recipientId;

      if (jobId && ObjectId.isValid(jobId)) {
        const jobDoc = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
        if (jobDoc) {
          if (jobDoc.clientId) {
            clientId = String(jobDoc.clientId);
            if (String(senderId) !== clientId) {
              workerId = String(senderId);
            } else {
              workerId = String(recipientId);
            }
          }
        }
      }

      conversationId = await findOrCreateConversationId(jobId, clientId, workerId);
    }

    if (!conversationId) {
      console.warn('⚠️ Cannot send system message: missing conversationId');
      return null;
    }

    if (!senderId || !recipientId) {
      console.warn('⚠️ Cannot send system message: missing senderId or recipientId');
      return null;
    }

    const systemMessage = {
      conversationId: String(conversationId),
      senderId: String(senderId),
      recipientId: String(recipientId),
      jobId: jobId ? String(jobId) : null,
      message: String(message),
      senderName: 'System',
      recipientName: '',
      read: false,
      createdAt: new Date(),
      isSystemMessage: true,
    };

    const result = await collections.messages.insertOne(systemMessage);
    const insertedMessage = await collections.messages.findOne({ _id: result.insertedId });

    if (_io) {
      _io.to(`user_${senderId}`).emit('new_message', insertedMessage);
      _io.to(`user_${recipientId}`).emit('new_message', insertedMessage);
      _io.to(conversationId).emit('new_message', insertedMessage);
    }

    return insertedMessage;
  } catch (err) {
    console.error('❌ Failed to send system message:', err);
    return null; // Don't throw — system messages should not fail parent operations
  }
}

module.exports = { findOrCreateConversationId, sendSystemMessage, setIo };
