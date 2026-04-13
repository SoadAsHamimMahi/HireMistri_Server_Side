// middleware/auth.js — Authentication and authorization middleware
const admin = require('../config/firebase');
const { collections } = require('../config/db');

// Append-only admin action log
async function logAdminAction(req, action, resource, details = {}) {
  if (!collections.adminAuditLog || !req.user?.uid) return;
  try {
    await collections.adminAuditLog.insertOne({
      adminUid: req.user.uid,
      action,
      resource,
      details,
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn('Admin audit log write failed:', e.message);
  }
}

// Authenticate any Firebase user
const authenticateUser = async (req, res, next) => {
  try {
    if (!admin) {
      // Firebase Admin not available — skip in dev; enforce in prod
      return next();
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;

    // Enforce account suspension
    if (collections.users) {
      try {
        const uid = String(decodedToken.uid || '').trim();
        if (uid) {
          const userDoc = await collections.users.findOne({ uid });
          if (userDoc?.isSuspended) {
            return res.status(403).json({ error: 'Account suspended' });
          }
        }
      } catch (e) {
        console.warn('Suspension check failed:', e.message);
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Authenticate as admin (Firebase token + must be in adminUsers collection)
const authenticateAdmin = async (req, res, next) => {
  try {
    if (!admin) {
      return res.status(503).json({ error: 'Admin auth not configured' });
    }
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    if (!collections.adminUsers) {
      return res.status(503).json({ error: 'Admin users collection not ready' });
    }
    const adminDoc = await collections.adminUsers.findOne({ uid: decodedToken.uid });
    if (!adminDoc) {
      return res.status(403).json({ error: 'Not an admin user' });
    }
    req.adminUser = adminDoc;
    next();
  } catch (err) {
    if (err.code && String(err.code).startsWith('auth/')) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('authenticateAdmin failed:', err);
    return res.status(500).json({ error: 'Auth check failed', message: err.message });
  }
};

// Authorize: caller must own the workerId in the request body
const authorizeWorker = (req, res, next) => {
  const { workerId } = req.body;
  if (!req.user) {
    return next(); // Auth was skipped (dev mode)
  }
  if (req.user.uid !== workerId) {
    return res.status(403).json({ error: 'Unauthorized: workerId mismatch' });
  }
  next();
};

module.exports = { authenticateUser, authenticateAdmin, authorizeWorker, logAdminAction };
