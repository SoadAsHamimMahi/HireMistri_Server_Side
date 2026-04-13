// utils/notifications.js — createNotification helper (uses DB + Socket.IO)
const { collections } = require('../config/db');

let _io = null;

function setIo(io) {
  _io = io;
}

async function createNotification(userId, title, message, type = 'info', jobId = null, link = null) {
  if (!userId) return null;

  try {
    const notification = {
      userId,
      title,
      message,
      type, // 'info', 'success', 'warning', 'error'
      jobId: jobId || null,
      link: link || null,
      read: false,
      createdAt: new Date(),
    };

    const result = await collections.notifications.insertOne(notification);
    const insertedNotification = await collections.notifications.findOne({ _id: result.insertedId });

    // Emit via WebSocket if io is available
    if (_io) {
      _io.to(`user_${userId}`).emit('new_notification', insertedNotification);
    }

    return insertedNotification;
  } catch (err) {
    console.error('❌ Failed to create notification:', err);
    return null;
  }
}

module.exports = { createNotification, setIo };
