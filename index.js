// index.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const {
  sendApplicationReceivedEmail,
  sendApplicationStatusEmail,
  sendJobStatusEmail,
  sendNewMessageEmail,
} = require('./utils/emailService');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());




// Simple request logger (useful while debugging)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Track lastActiveAt for authenticated users
app.use(async (req, res, next) => {
  // Extract uid from common patterns: /api/users/:uid, /api/auth/sync body, etc.
  let uid = null;
  if (req.params?.uid) {
    uid = req.params.uid;
  } else if (req.body?.uid) {
    uid = req.body.uid;
  } else if (req.query?.uid) {
    uid = req.query.uid;
  }
  
  // Update lastActiveAt if we have a uid and usersCollection is ready
  if (uid && usersCollection) {
    try {
      await usersCollection.updateOne(
        { uid: String(uid) },
        { $set: { lastActiveAt: new Date() } },
        { upsert: false } // Don't create if doesn't exist
      );
    } catch (e) {
      // Silently fail - don't block request
      console.warn('Failed to update lastActiveAt:', e.message);
    }
  }
  
  next();
});

// -------- Uploads folder ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
  console.log('📂 Created uploads folder automatically');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// serve uploads as static
app.use('/uploads', express.static(uploadsDir));

// -------- Mongo client ------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3zws6aa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// Optional Firebase Admin (for identity backfill)
let admin = null;
if (process.env.FIREBASE_CONFIG) {
  try {
    admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      admin.initializeApp();
    }
    console.log('🔥 Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase init failed:', e);
    admin = null;
  }
}

// declare vars to assign after connect
let db;
let usersCollection;
let jobsCollection;
let applicationsCollection;
let browseJobsCollection;
let notificationsCollection;
let savedJobsCollection;

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    db = client.db('hiremistriDB');
    usersCollection = db.collection('users');
    jobsCollection = db.collection('jobs');
    applicationsCollection = db.collection('applications');
    browseJobsCollection = db.collection('browseJobs');
    messagesCollection = db.collection('messages');
    notificationsCollection = db.collection('notifications');
    savedJobsCollection = db.collection('savedJobs');

    // ---------- indexes ----------
    await usersCollection.createIndex({ uid: 1 }, { unique: true, sparse: true });
    await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true });

    await applicationsCollection.createIndex({ jobId: 1 });
    await applicationsCollection.createIndex({ workerId: 1 });
    await applicationsCollection.createIndex({ clientId: 1 });
    await applicationsCollection.createIndex({ workerEmail: 1 });
    await applicationsCollection.createIndex({ clientEmail: 1 });
    // prevent duplicate apply by the same worker to the same job
    await applicationsCollection.createIndex(
      { jobId: 1, workerId: 1 },
      { unique: true, sparse: true }
    );

    // Messages indexes
    await messagesCollection.createIndex({ conversationId: 1, createdAt: 1 });
    await messagesCollection.createIndex({ senderId: 1 });
    await messagesCollection.createIndex({ recipientId: 1 });
    await messagesCollection.createIndex({ jobId: 1 });

    // Notifications indexes
    await notificationsCollection.createIndex({ userId: 1, read: 1, createdAt: -1 });
    await notificationsCollection.createIndex({ userId: 1, createdAt: -1 });

    // Saved Jobs indexes
    await savedJobsCollection.createIndex({ userId: 1, jobId: 1 }, { unique: true });
    await savedJobsCollection.createIndex({ userId: 1, savedAt: -1 });

    // ---------- helpers ----------
    function pruneEmpty(obj) {
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) pruneEmpty(v);
        const isEmptyObj = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
        if (v === '' || v === undefined || isEmptyObj) delete obj[k];
      });
      return obj;
    }

    // Helper function to create and emit notification
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

        const result = await notificationsCollection.insertOne(notification);
        const insertedNotification = await notificationsCollection.findOne({ _id: result.insertedId });

        // Emit notification via WebSocket to the user's room
        io.to(`user_${userId}`).emit('new_notification', insertedNotification);

        return insertedNotification;
      } catch (err) {
        console.error('❌ Failed to create notification:', err);
        return null;
      }
    }

    // build a $set from only allowed keys that are present on req.body
    function buildUserSet(body = {}) {
      const allowed = [
        'firstName', 'lastName', 'displayName', 'phone', 'headline', 'bio',
        'skills', 'isAvailable', 'profileCover', 'address1', 'address2',
        'city', 'country', 'zip', 'workExperience', 'role', 'email'
      ];

      const set = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
          set[k] = body[k];
        }
      }

      // normalize
      if (Array.isArray(set.skills)) {
        set.skills = set.skills.map(s => String(s).trim()).filter(Boolean);
      }
      if (Object.prototype.hasOwnProperty.call(set, 'isAvailable')) {
        set.isAvailable = !!set.isAvailable;
      }
      if (Object.prototype.hasOwnProperty.call(set, 'workExperience')) {
        const n = Number(set.workExperience);
        set.workExperience = Number.isFinite(n) ? n : 0;
      }
      if (typeof set.email === 'string') set.email = set.email.toLowerCase().trim();

      return pruneEmpty(set);
    }

    // helper: try to fetch worker identity from usersCollection or Firebase Admin
    async function getWorkerIdentity(workerId, { usersCollection }) {
      const out = { email: '', name: '', phone: '' };

      // 1) users collection (recommended, if you keep profiles)
      if (usersCollection) {
        const u = await usersCollection.findOne({ uid: workerId });
        if (u) {
          out.email = (u.email || out.email).toLowerCase().trim();
          // prefer displayName, or fall back to first+last
          const name =
            u.displayName ||
            [u.firstName, u.lastName].filter(Boolean).join(' ') ||
            '';
          out.name = (name || out.name).trim();
          out.phone = (u.phone || out.phone).trim();
          if (out.email && out.name && out.phone) return out;
        }
      }

      // 2) Firebase Admin (if available)
      if (admin?.apps?.length) {
        try {
          const rec = await admin.auth().getUser(workerId);
          if (rec) {
            out.email = (rec.email || out.email).toLowerCase().trim();
            out.name = (rec.displayName || out.name).trim();
            out.phone = (rec.phoneNumber || out.phone).trim();
          }
        } catch (e) {
          // ignore
        }
      }

      return out;
    }

    // Compute profile stats used by both client + worker UIs
    // NOTE: Reviews are not implemented yet, so rating fields default to 0.
    async function computeUserStats(uid) {
      const safeUid = String(uid || '').trim();
      if (!safeUid) return null;

      // Get user role to compute role-specific stats
      const userDoc = await usersCollection.findOne({ uid: safeUid }).catch(() => null);
      const userRole = userDoc?.role || 'worker';

      const [
        jobsPostedBrowse,
        jobsPostedLegacy,
        appsAsWorker,
        appsAsClient,
        jobsAsClient,
      ] = await Promise.all([
        browseJobsCollection.countDocuments({ clientId: safeUid }),
        // legacy jobs collection (may be unused in most flows)
        jobsCollection.countDocuments({ clientId: safeUid }).catch(() => 0),
        applicationsCollection
          .find({ workerId: safeUid })
          .project({ status: 1, createdAt: 1, updatedAt: 1, acceptedAt: 1, completedAt: 1 })
          .toArray(),
        applicationsCollection
          .find({ clientId: safeUid })
          .project({ status: 1, createdAt: 1, updatedAt: 1, jobId: 1 })
          .toArray(),
        browseJobsCollection
          .find({ clientId: safeUid })
          .project({ status: 1, createdAt: 1, updatedAt: 1, _id: 1 })
          .toArray(),
      ]);

      const normStatus = (s) => String(s || '').toLowerCase();

      // Worker stats
      const workerStatusCounts = (appsAsWorker || []).reduce((acc, a) => {
        const st = normStatus(a.status || 'pending') || 'pending';
        acc[st] = (acc[st] || 0) + 1;
        return acc;
      }, {});

      const workerApplicationsTotal = (appsAsWorker || []).length;
      const workerAccepted = workerStatusCounts.accepted || 0;
      const workerCompleted = workerStatusCounts.completed || 0;

      // Calculate worker response time (time from application creation to acceptance)
      const acceptedApps = (appsAsWorker || []).filter(a => normStatus(a.status) === 'accepted');
      let workerResponseTimeHours = null;
      if (acceptedApps.length > 0) {
        const responseTimes = acceptedApps
          .map(a => {
            const created = a.createdAt ? new Date(a.createdAt) : null;
            const accepted = a.acceptedAt ? new Date(a.acceptedAt) : (a.updatedAt ? new Date(a.updatedAt) : null);
            if (created && accepted && accepted > created) {
              return (accepted - created) / (1000 * 60 * 60); // hours
            }
            return null;
          })
          .filter(t => t !== null);
        if (responseTimes.length > 0) {
          const avg = responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length;
          workerResponseTimeHours = Math.round(avg * 10) / 10; // Round to 1 decimal
        }
      }

      // Client stats
      const totalJobsPosted = Number(jobsPostedBrowse || 0) + Number(jobsPostedLegacy || 0);
      const jobsStatusCounts = (jobsAsClient || []).reduce((acc, j) => {
        const st = normStatus(j.status || 'active') || 'active';
        acc[st] = (acc[st] || 0) + 1;
        return acc;
      }, {});

      const jobsCompleted = jobsStatusCounts.completed || 0;
      const jobsCancelled = jobsStatusCounts.cancelled || 0;
      const totalJobsWithStatus = totalJobsPosted || 1; // Avoid division by zero
      const clientCancellationRate = totalJobsPosted > 0
        ? Math.min(100, Math.round((jobsCancelled / totalJobsPosted) * 100))
        : 0;

      // Client hire rate: accepted applications / total applications received
      const appsAsClientTotal = (appsAsClient || []).length;
      const appsAccepted = (appsAsClient || []).filter(a => normStatus(a.status) === 'accepted').length;
      const clientHireRate = appsAsClientTotal > 0
        ? Math.min(100, Math.round((appsAccepted / appsAsClientTotal) * 100))
        : 0;

      // Base stats (shared)
      const baseStats = {
        totalJobsPosted,
        averageRating: 0, // placeholder until reviews exist
      };

      // Role-specific stats
      if (userRole === 'worker') {
        return {
          ...baseStats,
          // Worker-facing
          applicationsAsWorker: workerApplicationsTotal,
          workerStatusCounts,
          workerActiveOrders: workerAccepted,
          workerCompletedJobs: workerCompleted,
          workerResponseRate: workerApplicationsTotal > 0
            ? Math.min(100, Math.round((workerAccepted / workerApplicationsTotal) * 100))
            : 0,
          workerResponseTimeHours,
          // On-time rate requires dueDate/completedAt on jobs - placeholder for now
          workerOnTimeRate: null,
        };
      } else {
        // Client-facing
        return {
          ...baseStats,
          applicationsAsClient: appsAsClientTotal,
          clientJobsCompleted: jobsCompleted,
          clientHireRate,
          clientCancellationRate,
          clientNoShowRate: 0, // Requires explicit tracking - placeholder
        };
      }
    }

    // ---------- Routes start ----------

    app.get('/', (_req, res) => {
      res.send('🚀 HireMistri API is running...');
    });

    // ===== USERS =====

    // Get a user (single definition; no duplicate)
    app.get('/api/users/:uid', async (req, res) => {
      try {
        const uid = String(req.params.uid);
        const doc = await usersCollection.findOne({ uid });
        if (!doc) return res.status(404).json({ error: 'User not found' });
        const stats = await computeUserStats(uid);
        res.json({
          ...doc,
          // Backward compatible fields used by existing UIs
          totalJobsPosted: stats?.totalJobsPosted || 0,
          averageRating: stats?.averageRating || 0,
          // New structured stats object
          stats: stats || {},
        });
      } catch (err) {
        console.error('GET /api/users/:uid failed:', err);
        res.status(500).json({ error: 'Failed to fetch user' });
      }
    });

    // Public profile: safe fields only + computed stats
    app.get('/api/users/:uid/public', async (req, res) => {
      try {
        const uid = String(req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const doc = await usersCollection.findOne({ uid });
        if (!doc) return res.status(404).json({ error: 'User not found' });

        const stats = await computeUserStats(uid);

        const publicDoc = {
          uid: doc.uid,
          role: doc.role || 'user',
          displayName:
            doc.displayName ||
            [doc.firstName, doc.lastName].filter(Boolean).join(' ').trim() ||
            'User',
          firstName: doc.firstName || '',
          lastName: doc.lastName || '',
          headline: doc.headline || '',
          bio: doc.bio || '',
          skills: Array.isArray(doc.skills) ? doc.skills : [],
          isAvailable: !!doc.isAvailable,
          profileCover: doc.profileCover || '',
          // Location: only city/country (privacy-safe)
          city: doc.city || '',
          country: doc.country || '',
          // Verification badges (public-safe)
          emailVerified: !!doc.emailVerified,
          phoneVerified: !!doc.phoneVerified,
          // Account transparency
          createdAt: doc.createdAt || null,
          updatedAt: doc.updatedAt || null,
          lastActiveAt: doc.lastActiveAt || null,
          // Worker-specific public fields
          ...(doc.role === 'worker' ? {
            servicesOffered: doc.servicesOffered || null,
            serviceArea: doc.serviceArea || null,
            experienceYears: doc.experienceYears || doc.workExperience || null,
            languages: Array.isArray(doc.languages) ? doc.languages : [],
            pricing: doc.pricing || null,
            portfolio: Array.isArray(doc.portfolio) ? doc.portfolio : [],
            certifications: Array.isArray(doc.certifications) ? doc.certifications : [],
          } : {}),
          // Client-specific public fields
          ...(doc.role === 'client' ? {
            preferences: doc.preferences || null,
          } : {}),
          // Backward compatible fields (public-safe)
          totalJobsPosted: stats?.totalJobsPosted || 0,
          averageRating: stats?.averageRating || 0,
          // New structured stats object
          stats: stats || {},
        };

        res.json(publicDoc);
      } catch (err) {
        console.error('GET /api/users/:uid/public failed:', err);
        res.status(500).json({ error: 'Failed to fetch public profile' });
      }
    });

    // First-login sync: only create if missing (no destructive $set)
    app.post('/api/auth/sync', async (req, res) => {
      try {
        const { uid, email, role } = req.body || {};
        if (!uid) return res.status(400).json({ error: 'uid required' });

        // Validate role if provided
        const validRole = role && ['worker', 'client'].includes(String(role).toLowerCase())
          ? String(role).toLowerCase()
          : 'worker'; // Default to worker for backward compatibility

        await usersCollection.updateOne(
          { uid: String(uid) },
          {
            $setOnInsert: {
              uid: String(uid),
              createdAt: new Date(),
              role: validRole,
              ...(email ? { email: String(email).toLowerCase().trim() } : {})
            }
          },
          { upsert: true }
        );

        const doc = await usersCollection.findOne({ uid: String(uid) });
        res.json(doc);
      } catch (e) {
        console.error('POST /api/auth/sync failed:', e);
        res.status(500).json({ error: 'sync failed' });
      }
    });

    // Shared handler for PATCH/PUT (non-destructive upsert)
    const patchUserHandler = async (req, res) => {
      try {
        const uid = String(req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const now = new Date();
        const body = req.body || {};
        const allowUnset = String(req.query.allowUnset || '').toLowerCase() === 'true';

        const allowed = new Set([
          'firstName', 'lastName', 'displayName', 'phone', 'headline', 'bio',
          'skills', 'isAvailable', 'profileCover', 'address1', 'address2',
          'city', 'country', 'zip', 'workExperience', 'role', 'email',
          // New trust fields
          'emailVerified', 'phoneVerified', 'lastActiveAt',
          // Worker-specific fields
          'servicesOffered', 'serviceArea', 'experienceYears', 'certifications',
          'languages', 'pricing', 'portfolio',
          // Client-specific fields
          'preferences'
        ]);

        const existing = (await usersCollection.findOne({ uid })) || { uid, createdAt: now };

        const $set = {};
        const $unset = {};

        for (const [k, vRaw] of Object.entries(body)) {
          if (!allowed.has(k)) continue;

          const v = (k === 'email' && typeof vRaw === 'string')
            ? vRaw.toLowerCase().trim()
            : vRaw;

          // Handle arrays (skills, languages, portfolio, certifications)
          if (Array.isArray(v)) {
            if (k === 'skills' || k === 'languages') {
              const cleaned = v.map(s => String(s).trim()).filter(Boolean);
              if (cleaned.length) $set[k] = cleaned;
            } else if (k === 'portfolio' || k === 'certifications') {
              // Validate array of objects
              if (v.length > 0 && v.every(item => typeof item === 'object')) {
                $set[k] = v;
              }
            } else {
              // Generic array handling
              if (v.length) $set[k] = v;
            }
            continue;
          }

          // Handle booleans and numbers
          if (typeof v === 'boolean' || typeof v === 'number') {
            $set[k] = v;
            continue;
          }

          // Handle strings
          if (typeof v === 'string') {
            const t = v.trim();
            if (t) $set[k] = t;
            else if (allowUnset && t === '' && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

          // Handle null
          if (v === null) {
            if (allowUnset && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

          // Handle objects (servicesOffered, serviceArea, pricing, preferences)
          if (v && typeof v === 'object') {
            if (Object.keys(v).length) $set[k] = v;
          }
        }

        $set.updatedAt = now;

        const updateDoc = { $set, $setOnInsert: { uid, createdAt: existing.createdAt || now } };
        if (Object.keys($unset).length) updateDoc.$unset = $unset;

        // If nothing to change (only updatedAt), just return current doc
        if (Object.keys($set).length === 1 && Object.keys($unset).length === 0) {
          return res.json(existing);
        }

        await usersCollection.updateOne({ uid }, updateDoc, { upsert: true });
        const doc = await usersCollection.findOne({ uid });
        return res.json(doc);
      } catch (err) {
        console.error('PATCH /api/users/:uid failed:', err);
        if (err?.code === 11000) {
          return res.status(409).json({ error: 'Duplicate key (email must be unique)' });
        }
        return res.status(500).json({ error: 'Update failed' });
      }
    };

    app.patch('/api/users/:uid', patchUserHandler);
    app.put('/api/users/:uid', patchUserHandler);

    // Avatar upload
    app.post('/api/users/:uid/avatar', upload.single('avatar'), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const uid = String(req.params.uid);
        const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

        await usersCollection.updateOne(
          { uid },
          {
            $set: { profileCover: publicUrl, updatedAt: new Date() },
            $setOnInsert: { uid, createdAt: new Date() }
          },
          { upsert: true }
        );

        res.json({ url: publicUrl });
      } catch (e) {
        console.error('POST /api/users/:uid/avatar failed:', e);
        res.status(500).json({ error: 'Upload failed' });
      }
    });

    // ===== JOBS =====
    app.get('/api/jobs', async (_req, res) => {
      try {
        const jobs = await jobsCollection.find().toArray();
        res.json(jobs);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch jobs' });
      }
    });

    app.get('/api/jobs/:jobId', async (req, res) => {
      const { jobId } = req.params;
      try {
        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch job' });
      }
    });

    app.post('/api/jobs', async (req, res) => {
      try {
        const result = await jobsCollection.insertOne(req.body);
        res.status(201).json({ message: 'Job posted', jobId: result.insertedId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to post job' });
      }
    });

    // ===== APPLICATIONS =====

    // ===== APPLICATIONS =====

    // Create/update a proposal (one per worker per job)
    app.post('/api/applications', async (req, res) => {
      try {
        const b = req.body || {};

        // helpers
        const str = (v) => (v == null ? '' : String(v));
        const s = (v) => str(v).trim();
        const mail = (v) => s(v).toLowerCase();

        // required
        const jobId = s(b.jobId);
        const workerId = s(b.workerId);
        if (!jobId) {
          return res.status(400).json({ error: 'jobId is required' });
        }
        if (!workerId) {
          return res.status(400).json({ error: 'workerId is required' });
        }

        // incoming (may be blank)
        let workerEmailIn = mail(b.workerEmail || b.postedByEmail);
        let workerNameIn = s(b.workerName);
        let workerPhoneIn = s(b.workerPhone);

        let clientIdIn = s(b.clientId);
        let clientEmailIn = mail(b.clientEmail);

        // existing doc (to decide $set vs $setOnInsert)
        const existing = await applicationsCollection.findOne({ jobId, workerId });
        const isNew = !existing;

        // Validation: If updating existing application, only allow if status is "pending"
        if (!isNew && existing) {
          const currentStatus = (existing.status || 'pending').toLowerCase();
          if (currentStatus !== 'pending') {
            return res.status(400).json({ 
              error: 'Cannot edit application. Only pending applications can be edited.' 
            });
          }
          // Verify ownership
          if (existing.workerId !== workerId) {
            return res.status(403).json({ error: 'You do not have permission to edit this application' });
          }
        }

        // backfill client from job if jobId looks like ObjectId
        if (ObjectId.isValid(jobId) && (!clientIdIn || !clientEmailIn)) {
          const _id = new ObjectId(jobId);
          const jobDoc =
            (await browseJobsCollection.findOne({ _id })) ||
            (await jobsCollection.findOne({ _id }));
          if (jobDoc) {
            if (!clientIdIn) clientIdIn = s(jobDoc.clientId || jobDoc.postedByUid);
            if (!clientEmailIn) clientEmailIn = mail(jobDoc.postedByEmail || jobDoc.email);
          }
        }

        // backfill worker from users/Firebase only if missing on doc
        const needsWorkerBackfill =
          (!workerEmailIn || !workerNameIn || !workerPhoneIn) &&
          (!existing || !existing.workerEmail || !existing.workerName || !existing.workerPhone);

        if (needsWorkerBackfill) {
          const backfill = await getWorkerIdentity(workerId, { usersCollection });
          workerEmailIn = workerEmailIn || backfill.email;
          workerNameIn = workerNameIn || backfill.name;
          workerPhoneIn = workerPhoneIn || backfill.phone;
        }

        const now = new Date();
        const $set = { updatedAt: now };
        const $setOnInsert = { jobId, workerId, createdAt: now, status: 'pending' };

        // optional status & proposalText
        if ('status' in b) {
          (isNew ? $setOnInsert : $set).status = s(b.status);
        }
        if ('proposalText' in b || 'text' in b) {
          const val = s(b.proposalText || b.text);
          (isNew ? $setOnInsert : $set).proposalText = val;
        }

        // helper to avoid writing same key in both operators
        const setIf = (k, v) => {
          if (v || v === 0 || v === false) (isNew ? $setOnInsert : $set)[k] = v;
        };

        // client identity
        setIf('clientId', clientIdIn);
        setIf('clientEmail', clientEmailIn);

        // worker identity (+legacy mirror)
        if (workerEmailIn) {
          setIf('workerEmail', workerEmailIn);
          setIf('postedByEmail', workerEmailIn);
        }
        setIf('workerName', workerNameIn);
        setIf('workerPhone', workerPhoneIn);

        // upsert (unique index on {jobId, workerId} prevents dup applies)
        const result = await applicationsCollection.updateOne(
          { jobId, workerId },
          { $set, $setOnInsert },
          { upsert: true }
        );

        const doc = await applicationsCollection.findOne({ jobId, workerId });
        
        // Send email notification to client if this is a new application
        if (result.upsertedId && doc) {
          try {
            // Get job details for email
            let jobTitle = 'Your Job';
            let clientEmail = doc.clientEmail;
            let clientName = 'Client';
            
            if (ObjectId.isValid(jobId)) {
              const jobDoc = await browseJobsCollection.findOne({ _id: new ObjectId(jobId) });
              if (jobDoc) {
                jobTitle = jobDoc.title || jobTitle;
                clientEmail = clientEmail || jobDoc.postedByEmail || jobDoc.email;
                // Try to get client name from users collection
                if (doc.clientId) {
                  const clientUser = await usersCollection.findOne({ uid: doc.clientId });
                  if (clientUser) {
                    clientName = clientUser.displayName || 
                                [clientUser.firstName, clientUser.lastName].filter(Boolean).join(' ') || 
                                clientName;
                    clientEmail = clientEmail || clientUser.email;
                  }
                }
              }
            }
            
            const workerName = doc.workerName || 'A worker';
            
            if (clientEmail) {
              // Send email asynchronously (don't block response)
              sendApplicationReceivedEmail(clientEmail, clientName, jobTitle, workerName)
                .catch(err => console.error('Failed to send application received email:', err));
            }
          } catch (emailErr) {
            console.error('Error sending application received email:', emailErr);
            // Don't fail the request if email fails
          }
        }
        
        return res.status(result.upsertedId ? 201 : 200).json({ ok: true, application: doc });
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: 'You already applied to this job.' });
        }
        console.error('POST /api/applications failed:', err);
        return res.status(500).json({ error: err?.message || 'Failed to submit proposal' });
      }
    });

    // Get a specific application by jobId and workerId
    app.get('/api/applications/:jobId/:workerId', async (req, res) => {
      try {
        const { jobId, workerId } = req.params;
        const application = await applicationsCollection.findOne({ 
          jobId: String(jobId), 
          workerId: String(workerId) 
        });
        
        if (!application) {
          return res.status(404).json({ error: 'Application not found' });
        }
        
        res.json(application);
      } catch (err) {
        console.error('GET /api/applications/:jobId/:workerId failed:', err);
        res.status(500).json({ error: 'Failed to fetch application' });
      }
    });

    // All proposals for a job (for client side) - FIXED VERSION
    app.get('/api/job-applications/:jobId', async (req, res) => {
      try {
        const { jobId } = req.params;
        
        // Get applications for the job
        const apps = await applicationsCollection
          .find({ jobId: String(jobId) })
          .sort({ createdAt: -1 })
          .toArray();

        // Enrich each application with worker details
        const enrichedApps = await Promise.all(
          apps.map(async (app) => {
            let workerName = app.workerName || 'Unknown Worker';
            let workerEmail = app.workerEmail || 'No email';
            let workerPhone = app.workerPhone || 'No phone';

            // Try to get additional worker details from users collection
            if (app.workerId) {
              try {
                const worker = await usersCollection.findOne({ uid: app.workerId });
                if (worker) {
                  workerName = worker.displayName || 
                              [worker.firstName, worker.lastName].filter(Boolean).join(' ') || 
                              workerName;
                  workerEmail = worker.email || workerEmail;
                  workerPhone = worker.phone || workerPhone;
                }
              } catch (err) {
                console.error('Failed to fetch worker details:', err);
                // Keep the existing values
              }
            }

            return {
              ...app,
              workerName,
              workerEmail,
              workerPhone
            };
          })
        );

        res.json(enrichedApps);
      } catch (err) {
        console.error('GET /api/job-applications/:jobId failed:', err);
        res.status(500).json({ error: 'Failed to fetch proposals' });
      }
    });

    // Get all applications for jobs posted by a client
    app.get('/api/client-applications/:clientId', async (req, res) => {
      try {
        const clientId = req.params.clientId;
        if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

        const Applications = db.collection('applications');
        const BrowseJobs = db.collection('browseJobs');
        const Jobs = db.collection('jobs');

        // First, get all job IDs posted by this client
        const clientJobs = await BrowseJobs.find({ clientId }).project({ _id: 1 }).toArray();
        const clientJobIds = clientJobs.map(j => String(j._id));

        if (clientJobIds.length === 0) {
          return res.json([]);
        }

        const pipeline = [
          { $match: { jobId: { $in: clientJobIds } } },
          { $sort: { createdAt: -1, _id: -1 } },
          {
            $addFields: {
              jobIdObj: {
                $convert: { input: '$jobId', to: 'objectId', onError: null, onNull: null }
              }
            }
          },
          {
            $lookup: {
              from: BrowseJobs.collectionName,
              let: { jIdObj: '$jobIdObj' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } },
                { $project: { title: 1, location: 1, budget: 1, category: 1, clientId: 1 } }
              ],
              as: 'bj'
            }
          },
          {
            $lookup: {
              from: Jobs.collectionName,
              let: { jIdObj: '$jobIdObj' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } },
                { $project: { title: 1, location: 1, budget: 1, category: 1 } }
              ],
              as: 'j'
            }
          },
          {
            $addFields: {
              jobDoc: {
                $cond: [
                  { $gt: [{ $size: '$bj' }, 0] },
                  { $first: '$bj' },
                  { $first: '$j' }
                ]
              }
            }
          },
          {
            $project: {
              _id: 1,
              jobId: 1,
              workerId: 1,
              clientId: 1,
              status: 1,
              proposalText: 1,
              createdAt: 1,
              updatedAt: 1,
              title: '$jobDoc.title',
              location: '$jobDoc.location',
              budget: '$jobDoc.budget',
              category: '$jobDoc.category',
            }
          }
        ];

        const rows = await Applications.aggregate(pipeline).toArray();

        const normalized = rows.map(a => ({
          ...a,
          title: a.title ?? 'Untitled Job',
          location: a.location ?? 'N/A',
          budget: a.budget ?? null,
          category: a.category ?? '',
          createdAt: a.createdAt || a.updatedAt || null,
          status: (a.status || 'pending').toLowerCase(),
        }));

        res.json(normalized);
      } catch (err) {
        console.error('GET /api/client-applications error:', err);
        res.status(500).json({ error: 'Failed to load applications' });
      }
    });

    app.get('/api/my-applications/:uid', async (req, res) => {
      try {
        const workerId = req.params.uid;
        if (!workerId) return res.status(400).json({ error: 'Missing workerId' });

        const Applications = db.collection('applications');
        const BrowseJobs = db.collection('browseJobs');  // NEW: also check here
        const Jobs = db.collection('jobs');

        const pipeline = [
          { $match: { workerId } },
          { $sort: { createdAt: -1, _id: -1 } },

          // Compute an ObjectId version of jobId when possible
          {
            $addFields: {
              jobIdObj: {
                $convert: { input: '$jobId', to: 'objectId', onError: null, onNull: null }
              }
            }
          },

          // Try browseJobs first
          {
            $lookup: {
              from: BrowseJobs.collectionName,
              let: { jIdObj: '$jobIdObj' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } },
                { $project: { title: 1, location: 1, budget: 1, category: 1 } }
              ],
              as: 'bj'
            }
          },

          // Then try jobs
          {
            $lookup: {
              from: Jobs.collectionName,
              let: { jIdObj: '$jobIdObj' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } },
                { $project: { title: 1, location: 1, budget: 1, category: 1 } }
              ],
              as: 'j'
            }
          },

          // Prefer browseJobs doc if found, otherwise jobs doc
          {
            $addFields: {
              jobDoc: {
                $cond: [
                  { $gt: [{ $size: '$bj' }, 0] },
                  { $first: '$bj' },
                  { $first: '$j' }
                ]
              }
            }
          },

          // Final shape
          {
            $project: {
              _id: 1,
              jobId: 1,
              workerId: 1,
              clientId: 1,
              status: 1,
              proposalText: 1,
              createdAt: 1,
              updatedAt: 1,

              title: '$jobDoc.title',
              location: '$jobDoc.location',
              budget: '$jobDoc.budget',
              category: '$jobDoc.category',
            }
          }
        ];

        const rows = await Applications.aggregate(pipeline).toArray();

        // Normalize for UI
        const normalized = rows.map(a => ({
          ...a,
          title: a.title ?? 'Untitled Job',
          location: a.location ?? 'N/A',
          budget: a.budget ?? null,      // may be string "4000" or number 4000—both OK for your UI
          category: a.category ?? '',
          createdAt: a.createdAt || a.updatedAt || null,
          status: (a.status || 'pending').toLowerCase(),
          workerName: a.workerName || 'Unknown Worker',
          workerEmail: a.workerEmail || 'No email',
          workerPhone: a.workerPhone || 'No phone',
        }));

        res.json(normalized);
      } catch (err) {
        console.error('GET /api/my-applications error:', err);
        res.status(500).json({ error: 'Failed to load applications' });
      }
    });


    app.get('/health', (_req, res) => res.json({ ok: true }));

   


    // Update application status (accept/reject/complete, etc.)
    app.patch('/api/applications/:id/status', async (req, res) => {
      try {
        const { id } = req.params;
        const statusIn = String(req.body?.status || '').toLowerCase().trim();
        const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);

        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
        if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });

        const _id = new ObjectId(id);
        const upd = await applicationsCollection.updateOne(
          { _id },
          { $set: { status: statusIn, updatedAt: new Date() } }
        );

        if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });

        const doc = await applicationsCollection.findOne({ _id });
        res.json(doc);
      } catch (err) {
        console.error('PATCH /api/applications/:id/status failed:', err);
        res.status(500).json({ error: 'Failed to update status' });
      }
    });

    // Aliases for updating application status to support client fallbacks
    // PATCH /api/applications/:id (recommended)
    app.patch('/api/applications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const statusIn = String(req.body?.status || '').toLowerCase().trim();
        const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);

        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
        if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });

        const _id = new ObjectId(id);
        
        // Get the application before updating to check if status changed
        const oldDoc = await applicationsCollection.findOne({ _id });
        if (!oldDoc) {
          return res.status(404).json({ error: 'Application not found' });
        }
        
        const oldStatus = (oldDoc.status || 'pending').toLowerCase();
        const statusChanged = oldStatus !== statusIn;
        
        const upd = await applicationsCollection.updateOne(
          { _id },
          { $set: { status: statusIn, updatedAt: new Date() } }
        );

        if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });

        const doc = await applicationsCollection.findOne({ _id });
        
        // Send email notification and create in-app notification to worker if status changed to accepted/rejected
        if (statusChanged && (statusIn === 'accepted' || statusIn === 'rejected')) {
          try {
            // Get job details
            let jobTitle = 'the job';
            if (ObjectId.isValid(doc.jobId)) {
              const jobDoc = await browseJobsCollection.findOne({ _id: new ObjectId(doc.jobId) });
              if (jobDoc) {
                jobTitle = jobDoc.title || jobTitle;
              }
            }
            
            // Get worker email and name
            let workerEmail = doc.workerEmail;
            let workerName = doc.workerName || 'Worker';
            
            if (doc.workerId) {
              const workerUser = await usersCollection.findOne({ uid: doc.workerId });
              if (workerUser) {
                workerName = workerUser.displayName || 
                            [workerUser.firstName, workerUser.lastName].filter(Boolean).join(' ') || 
                            workerName;
                workerEmail = workerEmail || workerUser.email;
              }
            }
            
            // Create in-app notification
            if (doc.workerId) {
              const statusText = statusIn === 'accepted' ? 'accepted' : 'rejected';
              await createNotification(
                doc.workerId,
                `Application ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}`,
                `Your application for "${jobTitle}" has been ${statusText}.`,
                statusIn === 'accepted' ? 'success' : 'info',
                doc.jobId,
                `/jobs/${doc.jobId}`
              );
            }
            
            if (workerEmail) {
              // Send email asynchronously (don't block response)
              sendApplicationStatusEmail(workerEmail, workerName, jobTitle, statusIn)
                .catch(err => console.error('Failed to send application status email:', err));
            }
          } catch (emailErr) {
            console.error('Error sending application status email:', emailErr);
            // Don't fail the request if email fails
          }
        }
        
        res.json(doc);
      } catch (err) {
        console.error('PATCH /api/applications/:id failed:', err);
        res.status(500).json({ error: 'Failed to update status' });
      }
    });

    // PUT /api/applications/:id (alias)
    app.put('/api/applications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const statusIn = String(req.body?.status || '').toLowerCase().trim();
        const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);

        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
        if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });

        const _id = new ObjectId(id);
        const upd = await applicationsCollection.updateOne(
          { _id },
          { $set: { status: statusIn, updatedAt: new Date() } }
        );

        if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });

        const doc = await applicationsCollection.findOne({ _id });
        res.json(doc);
      } catch (err) {
        console.error('PUT /api/applications/:id failed:', err);
        res.status(500).json({ error: 'Failed to update status' });
      }
    });

    // ===== APPLICATION NOTES/COMMENTS =====

    // Add a note/comment to an application
    app.post('/api/applications/:id/notes', async (req, res) => {
      try {
        const { id } = req.params;
        const { userId, userName, note } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid application id' });
        }

        if (!userId || !note || !note.trim()) {
          return res.status(400).json({ error: 'userId and note are required' });
        }

        const _id = new ObjectId(id);
        const application = await applicationsCollection.findOne({ _id });
        
        if (!application) {
          return res.status(404).json({ error: 'Application not found' });
        }

        // Verify user has permission (either client or worker)
        if (application.clientId !== userId && application.workerId !== userId) {
          return res.status(403).json({ error: 'You do not have permission to add notes to this application' });
        }

        // Initialize notes array if it doesn't exist
        const notes = application.notes || [];
        const newNote = {
          _id: new ObjectId(),
          userId,
          userName: userName || 'User',
          note: String(note).trim(),
          createdAt: new Date(),
        };

        notes.push(newNote);

        await applicationsCollection.updateOne(
          { _id },
          { $set: { notes, updatedAt: new Date() } }
        );

        res.status(201).json({ message: 'Note added successfully', note: newNote });
      } catch (err) {
        console.error('❌ Failed to add note:', err);
        res.status(500).json({ error: 'Failed to add note' });
      }
    });

    // Get notes for an application
    app.get('/api/applications/:id/notes', async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid application id' });
        }

        const _id = new ObjectId(id);
        const application = await applicationsCollection.findOne({ _id });
        
        if (!application) {
          return res.status(404).json({ error: 'Application not found' });
        }

        res.json({ notes: application.notes || [] });
      } catch (err) {
        console.error('❌ Failed to fetch notes:', err);
        res.status(500).json({ error: 'Failed to fetch notes' });
      }
    });

    // Delete a note from an application
    app.delete('/api/applications/:id/notes/:noteId', async (req, res) => {
      try {
        const { id, noteId } = req.params;
        const { userId } = req.body;

        if (!ObjectId.isValid(id) || !ObjectId.isValid(noteId)) {
          return res.status(400).json({ error: 'Invalid application or note id' });
        }

        if (!userId) {
          return res.status(400).json({ error: 'userId is required' });
        }

        const _id = new ObjectId(id);
        const application = await applicationsCollection.findOne({ _id });
        
        if (!application) {
          return res.status(404).json({ error: 'Application not found' });
        }

        const notes = application.notes || [];
        const noteIndex = notes.findIndex(n => String(n._id) === noteId);

        if (noteIndex === -1) {
          return res.status(404).json({ error: 'Note not found' });
        }

        // Verify user owns the note
        if (notes[noteIndex].userId !== userId) {
          return res.status(403).json({ error: 'You do not have permission to delete this note' });
        }

        notes.splice(noteIndex, 1);

        await applicationsCollection.updateOne(
          { _id },
          { $set: { notes, updatedAt: new Date() } }
        );

        res.json({ message: 'Note deleted successfully', deleted: true });
      } catch (err) {
        console.error('❌ Failed to delete note:', err);
        res.status(500).json({ error: 'Failed to delete note' });
      }
    });

    // Delete application (withdrawal by worker)
    app.delete('/api/applications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { workerId } = req.body; // Worker ID from request body (should be authenticated user's ID)

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid application id' });
        }

        if (!workerId) {
          return res.status(400).json({ error: 'workerId is required' });
        }

        const _id = new ObjectId(id);

        // Find the application
        const application = await applicationsCollection.findOne({ _id });
        if (!application) {
          return res.status(404).json({ error: 'Application not found' });
        }

        // Verify ownership - only the worker who submitted can delete
        if (application.workerId !== workerId) {
          return res.status(403).json({ error: 'You do not have permission to delete this application' });
        }

        // Prevent deletion if status is "accepted" or "completed"
        const status = (application.status || 'pending').toLowerCase();
        if (status === 'accepted' || status === 'completed') {
          return res.status(400).json({ 
            error: 'Cannot withdraw an accepted or completed application. Please contact the client.' 
          });
        }

        // Get job details to fetch clientId for notification
        let clientId = application.clientId;
        let jobTitle = 'the job';
        let jobId = application.jobId;

        if (jobId && ObjectId.isValid(jobId)) {
          const job = await browseJobsCollection.findOne({ _id: new ObjectId(jobId) });
          if (job) {
            clientId = clientId || job.clientId || job.postedByUid;
            jobTitle = job.title || jobTitle;
          }
        }

        // Delete the application
        const result = await applicationsCollection.deleteOne({ _id });
        if (result.deletedCount === 0) {
          return res.status(404).json({ error: 'Application not found' });
        }

        // Create notification for the client if clientId exists
        if (clientId) {
          const notification = {
            userId: clientId,
            type: 'application_withdrawn',
            title: 'Application Withdrawn',
            message: `${application.workerName || 'A worker'} withdrew their application for "${jobTitle}"`,
            jobId: jobId || null,
            applicationId: String(id),
            workerId: application.workerId,
            workerName: application.workerName || 'Unknown Worker',
            read: false,
            createdAt: new Date(),
          };

          await notificationsCollection.insertOne(notification);
        }

        res.json({ 
          message: '✅ Application withdrawn successfully',
          deleted: true 
        });
      } catch (err) {
        console.error('❌ DELETE /api/applications/:id failed:', err);
        res.status(500).json({ error: 'Failed to withdraw application' });
      }
    });

    // POST /api/applications/update-status (alias)
    app.post('/api/applications/update-status', async (req, res) => {
      try {
        const { applicationId, status } = req.body || {};
        const statusIn = String(status || '').toLowerCase().trim();
        const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);

        if (!ObjectId.isValid(applicationId)) return res.status(400).json({ error: 'Invalid application id' });
        if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });

        const _id = new ObjectId(applicationId);
        const upd = await applicationsCollection.updateOne(
          { _id },
          { $set: { status: statusIn, updatedAt: new Date() } }
        );

        if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });

        const doc = await applicationsCollection.findOne({ _id });
        res.json(doc);
      } catch (err) {
        console.error('POST /api/applications/update-status failed:', err);
        res.status(500).json({ error: 'Failed to update status' });
      }
    });




    // ===== BROWSE JOBS =====
    app.get('/api/browse-jobs', async (req, res) => {
      try {
        const {
          clientId, 
          email, 
          status, 
          sort,
          // Advanced search filters
          skills,
          dateFrom,
          dateTo,
          budgetMin,
          budgetMax,
          categories,
          lat,
          lng,
          radius,
          sortBy
        } = req.query;
        
        const filter = {};

        // Filter by client
        if (clientId) filter.clientId = String(clientId);
        if (email) filter.postedByEmail = String(email).toLowerCase();

        // Status filter
        if (status) {
          const statusLower = String(status).toLowerCase();
          if (statusLower === 'all') {
            // Don't filter by status - return all jobs
          } else {
            filter.status = statusLower;
          }
        } else {
          filter.status = { $ne: 'completed' };
        }

        // Skills filter (comma-separated, matches any)
        if (skills) {
          const skillsArray = String(skills).split(',').map(s => s.trim()).filter(Boolean);
          if (skillsArray.length > 0) {
            // Match if job skills array contains any of the requested skills (case-insensitive)
            filter.$or = filter.$or || [];
            filter.$or.push({
              skills: { $in: skillsArray.map(s => new RegExp(s, 'i')) }
            });
          }
        }

        // Date range filter
        if (dateFrom || dateTo) {
          filter.date = {};
          if (dateFrom) {
            filter.date.$gte = String(dateFrom);
          }
          if (dateTo) {
            filter.date.$lte = String(dateTo);
          }
        }

        // Budget range filter
        if (budgetMin || budgetMax) {
          filter.budget = {};
          if (budgetMin) {
            filter.budget.$gte = Number(budgetMin);
          }
          if (budgetMax) {
            filter.budget.$lte = Number(budgetMax);
          }
        }

        // Multiple categories filter (comma-separated)
        if (categories) {
          const categoriesArray = String(categories).split(',').map(c => c.trim()).filter(Boolean);
          if (categoriesArray.length > 0) {
            filter.category = { $in: categoriesArray };
          }
        }

        // Location radius search (requires lat, lng, and radius)
        let jobs = [];
        if (lat && lng && radius) {
          const userLat = Number(lat);
          const userLng = Number(lng);
          const radiusKm = Number(radius);
          
          // Get all jobs first, then filter by distance
          jobs = await browseJobsCollection.find(filter).toArray();
          
          // Calculate distance for each job (Haversine formula)
          jobs = jobs.map(job => {
            if (job.latitude && job.longitude) {
              const jobLat = Number(job.latitude);
              const jobLng = Number(job.longitude);
              
              // Haversine formula
              const R = 6371; // Earth's radius in km
              const dLat = (jobLat - userLat) * Math.PI / 180;
              const dLng = (jobLng - userLng) * Math.PI / 180;
              const a = 
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(userLat * Math.PI / 180) * Math.cos(jobLat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
              const distance = R * c;
              
              return { ...job, _distance: distance };
            }
            return { ...job, _distance: null };
          });
          
          // Filter by radius
          jobs = jobs.filter(job => job._distance !== null && job._distance <= radiusKm);
          
          // Sort by distance if requested
          if (sortBy === 'distance') {
            jobs.sort((a, b) => (a._distance || Infinity) - (b._distance || Infinity));
          } else {
            // Default sorting
            jobs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          }
        } else {
          // Standard query without radius search
          let findQuery = browseJobsCollection.find(filter);
          
          // Sorting
          if (sort === 'oldest') {
            findQuery = findQuery.sort({ createdAt: 1 });
          } else {
            findQuery = findQuery.sort({ createdAt: -1 });
          }
          
          jobs = await findQuery.toArray();
        }

        res.json(jobs);
      } catch (err) {
        console.error('GET /api/browse-jobs failed:', err);
        res.status(500).json({ error: 'Failed to fetch browse jobs' });
      }
    });

    // Get job recommendations for a user
    app.get('/api/jobs/recommendations/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        if (!userId) {
          return res.status(400).json({ error: 'User ID is required' });
        }

        // Get user profile
        const user = await usersCollection.findOne({ uid: userId });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Get user skills and location
        const userSkills = user.skills || [];
        const userLocation = user.location || null; // { lat, lng, address }

        // Get jobs user has already applied to
        const userApplications = await applicationsCollection.find({ workerId: userId }).toArray();
        const appliedJobIds = userApplications.map(app => app.jobId);

        // Query active jobs
        const allJobs = await browseJobsCollection.find({
          status: 'active',
          _id: { $nin: appliedJobIds.map(id => new ObjectId(id)) }
        }).toArray();

        // Score each job
        const scoredJobs = allJobs.map(job => {
          let score = 0;
          const reasons = [];

          // Skills matching
          if (userSkills.length > 0 && Array.isArray(job.skills)) {
            const matchingSkills = job.skills.filter(skill => 
              userSkills.some(us => 
                String(us).toLowerCase() === String(skill).toLowerCase()
              )
            );
            if (matchingSkills.length > 0) {
              score += matchingSkills.length * 10;
              reasons.push(`Matches ${matchingSkills.length} skill${matchingSkills.length > 1 ? 's' : ''}`);
            }
          }

          // Location proximity
          if (userLocation && userLocation.lat && userLocation.lng && job.location) {
            // Try to extract coordinates from job (if stored)
            const jobLat = job.lat || job.latitude || job.locationLat;
            const jobLng = job.lng || job.longitude || job.locationLng;
            
            if (jobLat && jobLng) {
              // Haversine formula for distance
              const R = 6371; // Earth radius in km
              const dLat = (jobLat - userLocation.lat) * Math.PI / 180;
              const dLng = (jobLng - userLocation.lng) * Math.PI / 180;
              const a = 
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(userLocation.lat * Math.PI / 180) *
                Math.cos(jobLat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
              const distance = R * c;

              if (distance <= 10) {
                score += 20;
                reasons.push(`Very close (${distance.toFixed(1)} km)`);
              } else if (distance <= 25) {
                score += 10;
                reasons.push(`Nearby (${distance.toFixed(1)} km)`);
              } else if (distance <= 50) {
                score += 5;
                reasons.push(`Within range (${distance.toFixed(1)} km)`);
              }
            }
          }

          // Recent jobs (posted within 7 days)
          if (job.createdAt) {
            const daysSincePosted = (new Date() - new Date(job.createdAt)) / (1000 * 60 * 60 * 24);
            if (daysSincePosted <= 7) {
              score += 5;
              reasons.push('Recently posted');
            }
          }

          return {
            ...job,
            recommendationScore: score,
            recommendationReasons: reasons,
          };
        });

        // Sort by score (descending) and return top 10
        const recommendations = scoredJobs
          .filter(job => job.recommendationScore > 0) // Only jobs with some match
          .sort((a, b) => b.recommendationScore - a.recommendationScore)
          .slice(0, 10);

        res.json(recommendations);
      } catch (err) {
        console.error('❌ Failed to get job recommendations:', err);
        res.status(500).json({ error: 'Failed to get job recommendations' });
      }
    });

    app.get('/api/browse-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        console.log('🔍 Fetching job with ID:', id);
        
        if (!id) {
          return res.status(400).json({ error: 'Job ID is required' });
        }
        
        if (!ObjectId.isValid(id)) {
          console.log('❌ Invalid ObjectId format:', id);
          return res.status(400).json({ error: 'Invalid job ID format' });
        }
        
        const job = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) {
          console.log('❌ Job not found in database:', id);
          return res.status(404).json({ error: 'Job not found' });
        }
        
        console.log('✅ Job found:', job.title);
        res.json(job);
      } catch (e) {
        console.error('GET /api/browse-jobs/:id failed:', e);
        res.status(500).json({ error: 'Failed to fetch job' });
      }
    });

    app.post('/api/browse-jobs', async (req, res) => {
      try {
        const { expiresAt, ...jobData } = req.body;
        
        // Validate expiration date if provided
        if (expiresAt) {
          const expirationDate = new Date(expiresAt);
          if (isNaN(expirationDate.getTime())) {
            return res.status(400).json({ error: 'Invalid expiration date format' });
          }
          if (expirationDate <= new Date()) {
            return res.status(400).json({ error: 'Expiration date must be in the future' });
          }
        }

        const jobDoc = {
          ...jobData,
          status: 'active',
          date: new Date().toISOString().split('T')[0],
          createdAt: new Date(),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          autoCloseEnabled: !!expiresAt,
        };

        const result = await browseJobsCollection.insertOne(jobDoc);
        res.status(201).json({ message: '✅ Job posted successfully', jobId: result.insertedId });
      } catch (err) {
        console.error('❌ Failed to post job:', err);
        res.status(500).json({ error: 'Failed to post job' });
      }
    });

    app.post('/api/browse-jobs/upload', upload.array('images', 10), (req, res) => {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
      const base = `${req.protocol}://${req.get('host')}`;
      const imageUrls = req.files.map((file) => `${base}/uploads/${file.filename}`);
      res.json({ imageUrls });
    });

    // Update job (PATCH/PUT)
    app.patch('/api/browse-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { clientId, status } = req.body;
        
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const job = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }

        // Validate ownership if clientId is provided
        if (clientId && job.clientId && job.clientId !== clientId) {
          return res.status(403).json({ error: 'You do not have permission to update this job' });
        }

        // Validate status transitions if status is being updated
        if (status) {
          const currentStatus = (job.status || 'active').toLowerCase();
          const newStatus = String(status).toLowerCase();
          const allowedStatuses = ['active', 'on-hold', 'cancelled', 'completed'];
          
          if (!allowedStatuses.includes(newStatus)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` });
          }

          // Status transition rules
          if (currentStatus === 'cancelled' || currentStatus === 'completed') {
            return res.status(400).json({ 
              error: `Cannot change status from ${currentStatus}. This is a final state.` 
            });
          }

          if (currentStatus === 'on-hold' && newStatus === 'active') {
            // Allowed: on-hold → active
          } else if (currentStatus === 'active' && ['on-hold', 'cancelled', 'completed'].includes(newStatus)) {
            // Allowed: active → on-hold, cancelled, completed
          } else if (currentStatus === 'on-hold' && ['cancelled'].includes(newStatus)) {
            // Allowed: on-hold → cancelled
          } else if (currentStatus !== newStatus) {
            return res.status(400).json({ 
              error: `Invalid status transition from ${currentStatus} to ${newStatus}` 
            });
          }
        }

        // Handle expiration date if provided
        if (req.body.expiresAt !== undefined) {
          if (req.body.expiresAt === null || req.body.expiresAt === '') {
            // Clear expiration
            req.body.expiresAt = null;
            req.body.autoCloseEnabled = false;
          } else {
            const expirationDate = new Date(req.body.expiresAt);
            if (isNaN(expirationDate.getTime())) {
              return res.status(400).json({ error: 'Invalid expiration date format' });
            }
            if (expirationDate <= new Date()) {
              return res.status(400).json({ error: 'Expiration date must be in the future' });
            }
            req.body.expiresAt = expirationDate;
            req.body.autoCloseEnabled = true;
          }
        }

        // Prepare update data (exclude _id and createdAt)
        const updateData = { ...req.body };
        delete updateData._id;
        delete updateData.createdAt;
        delete updateData.clientId; // Don't allow changing clientId
        updateData.updatedAt = new Date();

        const result = await browseJobsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'Job not found' });
        }

        const updatedJob = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        
        // Send email notification and create in-app notification to client if job status changed
        if (status && job.status !== newStatus) {
          try {
            let clientEmail = null;
            let clientName = 'Client';
            const jobTitle = updatedJob.title || 'Your Job';
            
            // Get client email from users collection
            if (updatedJob.clientId) {
              const clientUser = await usersCollection.findOne({ uid: updatedJob.clientId });
              if (clientUser) {
                clientEmail = clientUser.email;
                clientName = clientUser.displayName || 
                            [clientUser.firstName, clientUser.lastName].filter(Boolean).join(' ') || 
                            clientName;
              }
            }
            
            // Fallback to job email if available
            if (!clientEmail && updatedJob.postedByEmail) {
              clientEmail = updatedJob.postedByEmail;
            }
            
            // Create in-app notification
            if (updatedJob.clientId) {
              await createNotification(
                updatedJob.clientId,
                'Job Status Updated',
                `Your job "${jobTitle}" status has been updated to ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}.`,
                'info',
                id,
                `/My-Posted-Job-Details/${id}`
              );
            }
            
            if (clientEmail) {
              // Send email asynchronously (don't block response)
              sendJobStatusEmail(clientEmail, clientName, jobTitle, newStatus)
                .catch(err => console.error('Failed to send job status email:', err));
            }
          } catch (emailErr) {
            console.error('Error sending job status email:', emailErr);
            // Don't fail the request if email fails
          }
        }
        
        res.json({ message: '✅ Job updated successfully', job: updatedJob });
      } catch (err) {
        console.error('❌ Failed to update job:', err);
        res.status(500).json({ error: 'Failed to update job' });
      }
    });

    app.put('/api/browse-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const job = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }

        // Prepare update data (preserve _id and createdAt)
        const updateData = { ...req.body };
        delete updateData._id;
        if (job.createdAt) {
          updateData.createdAt = job.createdAt;
        }
        updateData.updatedAt = new Date();

        const result = await browseJobsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'Job not found' });
        }

        const updatedJob = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        res.json({ message: '✅ Job updated successfully', job: updatedJob });
      } catch (err) {
        console.error('❌ Failed to update job:', err);
        res.status(500).json({ error: 'Failed to update job' });
      }
    });

    // Delete job
    app.delete('/api/browse-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const job = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }

        // Optionally: Check if job has accepted applications before deleting
        // For now, we'll allow deletion but could add this check later
        const hasAcceptedApplications = await applicationsCollection.findOne({
          jobId: String(id),
          status: 'accepted'
        });

        if (hasAcceptedApplications) {
          return res.status(400).json({ 
            error: 'Cannot delete job with accepted applications. Please complete or cancel the job first.' 
          });
        }

        const result = await browseJobsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: 'Job not found' });
        }

        // Optionally: Delete related applications
        await applicationsCollection.deleteMany({ jobId: String(id) });

        res.json({ message: '✅ Job deleted successfully' });
      } catch (err) {
        console.error('❌ Failed to delete job:', err);
        res.status(500).json({ error: 'Failed to delete job' });
      }
    });

    // ===== MESSAGING =====

    // Helper function to generate conversation ID
    const getConversationId = (userId1, userId2, jobId) => {
      const ids = [userId1, userId2].sort();
      return jobId ? `${jobId}_${ids.join('_')}` : ids.join('_');
    };

    // Get conversations for a user
    app.get('/api/messages/conversations', async (req, res) => {
      try {
        const { userId } = req.query;
        if (!userId) {
          return res.status(400).json({ error: 'userId is required' });
        }

        // Get all unique conversations for this user
        const conversations = await messagesCollection
          .aggregate([
            {
              $match: {
                $or: [{ senderId: userId }, { recipientId: userId }]
              }
            },
            {
              $sort: { createdAt: -1 }
            },
            {
              $group: {
                _id: '$conversationId',
                lastMessage: { $first: '$$ROOT' },
                unreadCount: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ['$recipientId', userId] }, { $eq: ['$read', false] }] },
                      1,
                      0
                    ]
                  }
                }
              }
            },
            {
              $sort: { 'lastMessage.createdAt': -1 }
            }
          ])
          .toArray();

        res.json(conversations);
      } catch (err) {
        console.error('❌ Failed to fetch conversations:', err);
        res.status(500).json({ error: 'Failed to fetch conversations' });
      }
    });

    // Get messages for a conversation
    app.get('/api/messages/conversation/:conversationId', async (req, res) => {
      try {
        const { conversationId } = req.params;
        const { userId } = req.query;

        if (!userId) {
          return res.status(400).json({ error: 'userId is required' });
        }

        const messages = await messagesCollection
          .find({ conversationId })
          .sort({ createdAt: 1 })
          .toArray();

        // Mark messages as read
        await messagesCollection.updateMany(
          {
            conversationId,
            recipientId: userId,
            read: false
          },
          {
            $set: { read: true, readAt: new Date() }
          }
        );

        res.json(messages);
      } catch (err) {
        console.error('❌ Failed to fetch messages:', err);
        res.status(500).json({ error: 'Failed to fetch messages' });
      }
    });

    // Send a message
    app.post('/api/messages', async (req, res) => {
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

        const result = await messagesCollection.insertOne(newMessage);
        const insertedMessage = await messagesCollection.findOne({ _id: result.insertedId });

        // Send email notification and create in-app notification to recipient (asynchronously, don't block response)
        (async () => {
          try {
            let recipientEmail = null;
            let recipientName = insertedMessage.recipientName || 'User';
            let jobTitle = null;
            
            // Get recipient email from users collection
            if (recipientId) {
              const recipientUser = await usersCollection.findOne({ uid: recipientId });
              if (recipientUser) {
                recipientEmail = recipientUser.email;
                recipientName = recipientUser.displayName || 
                               [recipientUser.firstName, recipientUser.lastName].filter(Boolean).join(' ') || 
                               recipientName;
              }
            }
            
            // Get job title if jobId exists
            if (jobId && ObjectId.isValid(jobId)) {
              const jobDoc = await browseJobsCollection.findOne({ _id: new ObjectId(jobId) });
              if (jobDoc) {
                jobTitle = jobDoc.title;
              }
            }
            
            const senderName = insertedMessage.senderName || 'Someone';
            
            // Create in-app notification
            if (recipientId) {
              await createNotification(
                recipientId,
                'New Message',
                `You have a new message from ${senderName}${jobTitle ? ` about "${jobTitle}"` : ''}`,
                'info',
                jobId,
                null // Link will be handled by the frontend based on jobId
              );
            }
            
            if (recipientEmail) {
              sendNewMessageEmail(recipientEmail, recipientName, senderName, jobTitle)
                .catch(err => console.error('Failed to send new message email:', err));
            }
          } catch (emailErr) {
            console.error('Error sending new message email:', emailErr);
          }
        })();

        res.status(201).json(insertedMessage);
      } catch (err) {
        console.error('❌ Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message' });
      }
    });

    // Mark messages as read
    app.patch('/api/messages/read', async (req, res) => {
      try {
        const { conversationId, userId } = req.body;

        if (!conversationId || !userId) {
          return res.status(400).json({ error: 'conversationId and userId are required' });
        }

        const result = await messagesCollection.updateMany(
          {
            conversationId,
            recipientId: userId,
            read: false
          },
          {
            $set: { read: true, readAt: new Date() }
          }
        );

        res.json({ updated: result.modifiedCount });
      } catch (err) {
        console.error('❌ Failed to mark messages as read:', err);
        res.status(500).json({ error: 'Failed to mark messages as read' });
      }
    });

    // ===== NOTIFICATIONS =====

    // Get notifications for a user
    app.get('/api/notifications/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;

        if (!userId) {
          return res.status(400).json({ error: 'userId is required' });
        }

        // Fetch notifications sorted by newest first
        const notifications = await notificationsCollection
          .find({ userId })
          .sort({ createdAt: -1 })
          .limit(parseInt(limit))
          .toArray();

        // Count unread notifications
        const unreadCount = await notificationsCollection.countDocuments({
          userId,
          read: false
        });

        res.json({
          notifications,
          unreadCount
        });
      } catch (err) {
        console.error('❌ Failed to fetch notifications:', err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
      }
    });

    // Mark notification as read
    app.patch('/api/notifications/:id/read', async (req, res) => {
      try {
        const { id } = req.params;
        const { userId } = req.body; // Optional: verify ownership

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid notification id' });
        }

        const _id = new ObjectId(id);

        // Optional: Verify ownership if userId provided
        const updateQuery = { _id };
        if (userId) {
          updateQuery.userId = userId;
        }

        const result = await notificationsCollection.updateOne(
          updateQuery,
          {
            $set: { read: true, readAt: new Date() }
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification marked as read', updated: true });
      } catch (err) {
        console.error('❌ Failed to mark notification as read:', err);
        res.status(500).json({ error: 'Failed to mark notification as read' });
      }
    });

    // Delete notification
    app.delete('/api/notifications/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { userId } = req.body; // Optional: verify ownership

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid notification id' });
        }

        const _id = new ObjectId(id);

        // Optional: Verify ownership if userId provided
        const deleteQuery = { _id };
        if (userId) {
          deleteQuery.userId = userId;
        }

        const result = await notificationsCollection.deleteOne(deleteQuery);

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification deleted successfully', deleted: true });
      } catch (err) {
        console.error('❌ Failed to delete notification:', err);
        res.status(500).json({ error: 'Failed to delete notification' });
      }
    });

    // ===== SAVED JOBS / BOOKMARKS =====

    // Save a job
    app.post('/api/saved-jobs', async (req, res) => {
      try {
        const { userId, jobId } = req.body;

        if (!userId || !jobId) {
          return res.status(400).json({ error: 'userId and jobId are required' });
        }

        // Validate job exists
        if (ObjectId.isValid(jobId)) {
          const job = await browseJobsCollection.findOne({ _id: new ObjectId(jobId) });
          if (!job) {
            return res.status(404).json({ error: 'Job not found' });
          }
        }

        // Check if already saved
        const existing = await savedJobsCollection.findOne({ userId, jobId });
        if (existing) {
          return res.status(409).json({ error: 'Job is already saved' });
        }

        // Save the job
        const result = await savedJobsCollection.insertOne({
          userId,
          jobId,
          savedAt: new Date()
        });

        res.status(201).json({ 
          message: 'Job saved successfully', 
          savedJob: { _id: result.insertedId, userId, jobId, savedAt: new Date() }
        });
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({ error: 'Job is already saved' });
        }
        console.error('❌ Failed to save job:', err);
        res.status(500).json({ error: 'Failed to save job' });
      }
    });

    // Get all saved jobs for a user
    app.get('/api/saved-jobs/:userId', async (req, res) => {
      try {
        const { userId } = req.params;

        if (!userId) {
          return res.status(400).json({ error: 'userId is required' });
        }

        // Get saved jobs
        const savedJobs = await savedJobsCollection
          .find({ userId })
          .sort({ savedAt: -1 })
          .toArray();

        // Get full job details for each saved job
        const jobsWithDetails = await Promise.all(
          savedJobs.map(async (saved) => {
            if (ObjectId.isValid(saved.jobId)) {
              const job = await browseJobsCollection.findOne({ _id: new ObjectId(saved.jobId) });
              return job ? { ...job, savedAt: saved.savedAt, savedJobId: saved._id } : null;
            }
            return null;
          })
        );

        const validJobs = jobsWithDetails.filter(job => job !== null);
        res.json(validJobs);
      } catch (err) {
        console.error('❌ Failed to fetch saved jobs:', err);
        res.status(500).json({ error: 'Failed to fetch saved jobs' });
      }
    });

    // Check if a job is saved
    app.get('/api/saved-jobs/check/:userId/:jobId', async (req, res) => {
      try {
        const { userId, jobId } = req.params;

        if (!userId || !jobId) {
          return res.status(400).json({ error: 'userId and jobId are required' });
        }

        const savedJob = await savedJobsCollection.findOne({ userId, jobId });
        res.json({ 
          saved: !!savedJob, 
          savedJobId: savedJob ? String(savedJob._id) : null 
        });
      } catch (err) {
        console.error('❌ Failed to check saved job:', err);
        res.status(500).json({ error: 'Failed to check saved job' });
      }
    });

    // Unsave a job
    app.delete('/api/saved-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { userId } = req.body; // Optional: verify ownership

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid saved job id' });
        }

        const _id = new ObjectId(id);

        // Verify ownership if userId provided
        const deleteQuery = { _id };
        if (userId) {
          deleteQuery.userId = userId;
        }

        const result = await savedJobsCollection.deleteOne(deleteQuery);

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: 'Saved job not found' });
        }

        res.json({ message: 'Job unsaved successfully', deleted: true });
      } catch (err) {
        console.error('❌ Failed to unsave job:', err);
        res.status(500).json({ error: 'Failed to unsave job' });
      }
    });

    // ---------- WebSocket handlers ----------
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
          const result = await messagesCollection.insertOne(newMessage);
          const insertedMessage = await messagesCollection.findOne({ _id: result.insertedId });

          // Emit to sender's room (for confirmation/UI update)
          io.to(`user_${senderId}`).emit('new_message', insertedMessage);
          // Emit to recipient's room
          io.to(`user_${recipientId}`).emit('new_message', insertedMessage);

          // Also emit to the conversation room if it exists
          io.to(conversationId).emit('new_message', insertedMessage);
          
          // Send email notification and create in-app notification to recipient (asynchronously, don't block)
          (async () => {
            try {
              let recipientEmail = null;
              let recipientName = insertedMessage.recipientName || 'User';
              let jobTitle = null;
              
              // Get recipient email from users collection
              if (recipientId) {
                const recipientUser = await usersCollection.findOne({ uid: recipientId });
                if (recipientUser) {
                  recipientEmail = recipientUser.email;
                  recipientName = recipientUser.displayName || 
                                 [recipientUser.firstName, recipientUser.lastName].filter(Boolean).join(' ') || 
                                 recipientName;
                }
              }
              
              // Get job title if jobId exists
              if (jobId && ObjectId.isValid(jobId)) {
                const jobDoc = await browseJobsCollection.findOne({ _id: new ObjectId(jobId) });
                if (jobDoc) {
                  jobTitle = jobDoc.title;
                }
              }
              
              const senderName = insertedMessage.senderName || 'Someone';
              
              // Create in-app notification
              if (recipientId) {
                await createNotification(
                  recipientId,
                  'New Message',
                  `You have a new message from ${senderName}${jobTitle ? ` about "${jobTitle}"` : ''}`,
                  'info',
                  jobId,
                  null // Link will be handled by the frontend based on jobId
                );
              }
              
              if (recipientEmail) {
                sendNewMessageEmail(recipientEmail, recipientName, senderName, jobTitle)
                  .catch(err => console.error('Failed to send new message email:', err));
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
        if (!conversationId || !userId || !senderId) {
          return;
        }
        try {
          await messagesCollection.updateMany(
            {
              conversationId,
              recipientId: userId,
              senderId: senderId, // Only mark messages from this sender as read
              read: false
            },
            {
              $set: { read: true, readAt: new Date() }
            }
          );
          // Optionally emit a 'messages_read' event to update sender's UI
          io.to(`user_${senderId}`).emit('messages_read', { conversationId, readerId: userId });
        } catch (err) {
          console.error('❌ Failed to mark messages as read via WebSocket:', err);
        }
      });

      socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
      });
    });

    // ---------- error handlers (must be after routes) ----------

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: `Endpoint ${req.url} not found` });
    });

    // Global error handler
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      console.error('Server Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // ---------- Routes end ----------

    // Schedule job expiration task (runs daily at midnight)
    cron.schedule('0 0 * * *', async () => {
      try {
        console.log('🕐 Running scheduled job expiration task...');
        const now = new Date();
        
        // Find jobs that have expired
        const expiredJobs = await browseJobsCollection.find({
          expiresAt: { $lte: now },
          status: { $nin: ['completed', 'cancelled'] },
          autoCloseEnabled: true,
        }).toArray();

        if (expiredJobs.length > 0) {
          console.log(`📅 Found ${expiredJobs.length} expired job(s) to close`);
          
          for (const job of expiredJobs) {
            // Update job status to completed
            await browseJobsCollection.updateOne(
              { _id: job._id },
              { $set: { status: 'completed', updatedAt: new Date() } }
            );

            // Create notification for job owner
            if (job.clientId) {
              await createNotification(
                job.clientId,
                'Job Expired',
                `Your job "${job.title || 'Untitled Job'}" has expired and has been automatically closed.`,
                'info',
                `/My-Posted-Job-Details/${job._id}`,
                job._id.toString()
              );

              // Send email notification
              try {
                const clientUser = await usersCollection.findOne({ uid: job.clientId });
                if (clientUser && clientUser.email) {
                  await sendJobStatusEmail(
                    clientUser.email,
                    clientUser.displayName || 'Client',
                    job.title || 'Your Job',
                    'completed',
                    'expired'
                  );
                }
              } catch (emailErr) {
                console.error('Failed to send expiration email:', emailErr);
              }
            }

            console.log(`✅ Expired job "${job.title || job._id}" has been closed`);
          }
        } else {
          console.log('✅ No expired jobs found');
        }
      } catch (err) {
        console.error('❌ Error in job expiration task:', err);
      }
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`⚡ WebSocket server running on ws://localhost:${PORT}`);
      console.log(`⏰ Job expiration task scheduled (runs daily at midnight)`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
