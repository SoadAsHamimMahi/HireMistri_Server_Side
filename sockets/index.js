// sockets/index.js — All Socket.IO event handlers
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');
const { getConversationId } = require('../utils/helpers');
const { createNotification } = require('../utils/notifications');
const {
  sendNewMessageEmail,
} = require('../utils/emailService');

function setupSockets(io) {
  io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // Join user room
    socket.on('join_user', (userId) => {
      socket.join(`user_${userId}`);
      console.log(`👤 User ${userId} joined room: user_${userId}`);
    });

    // Send message via WebSocket
    socket.on('message:send', async (data) => {
      const { senderId, recipientId, jobId, message, senderName, recipientName } = data;
      if (!senderId || !recipientId || !message) {
        socket.emit('message_error', { error: 'senderId, recipientId, and message are required' });
        return;
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

      try {
        const result = await collections.messages.insertOne(newMessage);
        const insertedMessage = await collections.messages.findOne({ _id: result.insertedId });

        io.to(`user_${senderId}`).emit('new_message', insertedMessage);
        io.to(`user_${recipientId}`).emit('new_message', insertedMessage);
        io.to(conversationId).emit('new_message', insertedMessage);

        // Async: notifications + email
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
              sendNewMessageEmail(recipientEmail, resolvedRecipientName, resolvedSenderName, jobTitle)
                .catch((err) => console.error('Failed to send new message email:', err));
            }
          } catch (emailErr) {
            console.error('Error sending new message email:', emailErr);
          }
        })();
      } catch (err) {
        console.error('❌ Failed to send message via WebSocket:', err);
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // Typing indicators
    socket.on('typing:start', (data) => {
      io.to(`user_${data.recipientId}`).emit('user_typing', { userId: data.senderId, typing: true });
    });

    socket.on('typing:stop', (data) => {
      io.to(`user_${data.recipientId}`).emit('user_typing', { userId: data.senderId, typing: false });
    });

    // Mark messages as read
    socket.on('message:read', async (data) => {
      const { conversationId, userId, senderId } = data;
      if (!conversationId || !userId || !senderId) return;
      try {
        await collections.messages.updateMany(
          { conversationId, recipientId: userId, senderId, read: false },
          { $set: { read: true, readAt: new Date() } }
        );
        io.to(`user_${senderId}`).emit('messages_read', { conversationId, readerId: userId });
      } catch (err) {
        console.error('❌ Failed to mark messages as read via WebSocket:', err);
      }
    });

    // Live location sharing
    const isLocationParticipant = async (jobId, userId) => {
      if (!ObjectId.isValid(jobId) || !userId) return false;
      const app = await collections.applications.findOne({
        jobId: String(jobId),
        $or: [{ workerId: String(userId) }, { clientId: String(userId) }],
      });
      if (app) return true;
      const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
      if (job && (String(job.clientId) === String(userId) || String(job.targetWorkerId) === String(userId))) return true;
      return false;
    };

    socket.on('location:join', async (data) => {
      const { jobId, userId } = data || {};
      if (!jobId || !userId) {
        socket.emit('location_error', { error: 'jobId and userId required' });
        return;
      }
      try {
        const allowed = await isLocationParticipant(jobId, userId);
        if (!allowed) {
          socket.emit('location_error', { error: 'Not a participant for this job' });
          return;
        }
        socket.join(`location_job_${jobId}`);
      } catch (err) {
        console.error('location:join failed:', err);
        socket.emit('location_error', { error: 'Failed to join location room' });
      }
    });

    socket.on('location:update', async (data) => {
      const { jobId, userId, lat, lng, timestamp } = data || {};
      if (!jobId || !userId || lat === undefined || lng === undefined) {
        socket.emit('location_error', { error: 'Missing jobId, userId, lat, or lng' });
        return;
      }
      const numLat = parseFloat(lat);
      const numLng = parseFloat(lng);
      if (isNaN(numLat) || isNaN(numLng)) {
        socket.emit('location_error', { error: 'Invalid lat/lng' });
        return;
      }
      try {
        const allowed = await isLocationParticipant(jobId, userId);
        if (!allowed) {
          socket.emit('location_error', { error: 'Not a participant for this job' });
          return;
        }
        socket.to(`location_job_${jobId}`).emit('location:peer', {
          jobId: String(jobId),
          userId: String(userId),
          lat: numLat,
          lng: numLng,
          timestamp: timestamp || new Date(),
        });
      } catch (err) {
        console.error('location:update failed:', err);
        socket.emit('location_error', { error: 'Failed to broadcast location' });
      }
    });

    socket.on('location:stop', (data) => {
      const { jobId } = data || {};
      if (jobId) socket.leave(`location_job_${jobId}`);
    });

    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);
    });
  });
}

module.exports = setupSockets;
