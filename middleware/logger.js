// middleware/logger.js — Request logging + lastActiveAt tracking middleware
const { collections } = require('../config/db');

// Simple request logger
const requestLogger = (req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
};

// Track lastActiveAt for authenticated users
const trackLastActive = async (req, res, next) => {
  let uid = null;
  if (req.params?.uid) {
    uid = req.params.uid;
  } else if (req.body?.uid) {
    uid = req.body.uid;
  } else if (req.query?.uid) {
    uid = req.query.uid;
  }

  if (uid && collections.users) {
    try {
      await collections.users.updateOne(
        { uid: String(uid) },
        { $set: { lastActiveAt: new Date() } },
        { upsert: false }
      );
    } catch (e) {
      console.warn('Failed to update lastActiveAt:', e.message);
    }
  }

  next();
};

module.exports = { requestLogger, trackLastActive };
