// index.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());




// Simple request logger (useful while debugging)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
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

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    db = client.db('hiremistriDB');
    usersCollection = db.collection('users');
    jobsCollection = db.collection('jobs');
    applicationsCollection = db.collection('applications');
    browseJobsCollection = db.collection('browseJobs');

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
        res.json(doc);
      } catch (err) {
        console.error('GET /api/users/:uid failed:', err);
        res.status(500).json({ error: 'Failed to fetch user' });
      }
    });

    // First-login sync: only create if missing (no destructive $set)
    app.post('/api/auth/sync', async (req, res) => {
      try {
        const { uid, email } = req.body || {};
        if (!uid) return res.status(400).json({ error: 'uid required' });

        await usersCollection.updateOne(
          { uid: String(uid) },
          {
            $setOnInsert: {
              uid: String(uid),
              createdAt: new Date(),
              role: 'worker',
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
          'city', 'country', 'zip', 'workExperience', 'role', 'email'
        ]);

        const existing = (await usersCollection.findOne({ uid })) || { uid, createdAt: now };

        const $set = {};
        const $unset = {};

        for (const [k, vRaw] of Object.entries(body)) {
          if (!allowed.has(k)) continue;

          const v = (k === 'email' && typeof vRaw === 'string')
            ? vRaw.toLowerCase().trim()
            : vRaw;

          if (k === 'skills' && Array.isArray(v)) {
            const cleaned = v.map(s => String(s).trim()).filter(Boolean);
            if (cleaned.length) $set[k] = cleaned;
            continue;
          }

          if (typeof v === 'boolean' || typeof v === 'number') {
            $set[k] = v;
            continue;
          }

          if (typeof v === 'string') {
            const t = v.trim();
            if (t) $set[k] = t;
            else if (allowUnset && t === '' && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

          if (v === null) {
            if (allowUnset && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

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
        if (!jobId) return res.status(400).json({ error: 'jobId is required' });
        if (!workerId) return res.status(400).json({ error: 'workerId is required' });

        // incoming (may be blank)
        let workerEmailIn = mail(b.workerEmail || b.postedByEmail);
        let workerNameIn = s(b.workerName);
        let workerPhoneIn = s(b.workerPhone);

        let clientIdIn = s(b.clientId);
        let clientEmailIn = mail(b.clientEmail);

        // existing doc (to decide $set vs $setOnInsert)
        const existing = await applicationsCollection.findOne({ jobId, workerId });
        const isNew = !existing;

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
        return res.status(result.upsertedId ? 201 : 200).json({ ok: true, application: doc });
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: 'You already applied to this job.' });
        }
        console.error('POST /api/applications failed:', err);
        return res.status(500).json({ error: err?.message || 'Failed to submit proposal' });
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




    // ===== BROWSE JOBS =====
    app.get('/api/browse-jobs', async (req, res) => {
      try {
        const { clientId, email } = req.query;
        const filter = {};
        if (clientId) filter.clientId = String(clientId);
        if (email) filter.postedByEmail = String(email).toLowerCase();

        const jobs = await browseJobsCollection.find(filter).toArray();
        res.json(jobs);
      } catch (err) {
        console.error('GET /api/browse-jobs failed:', err);
        res.status(500).json({ error: 'Failed to fetch browse jobs' });
      }
    });

    app.get('/api/browse-jobs/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(404).json({ error: 'Job not found' });
        const job = await browseJobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
      } catch (e) {
        console.error('GET /api/browse-jobs/:id failed:', e);
        res.status(500).json({ error: 'Failed to fetch job' });
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

    app.post('/api/browse-jobs', async (req, res) => {
      try {
        const result = await browseJobsCollection.insertOne({
          ...req.body,
          status: 'active',
          date: new Date().toISOString().split('T')[0],
          createdAt: new Date(),
        });
        res.status(201).json({ message: '✅ Job posted successfully', jobId: result.insertedId });
      } catch (err) {
        console.error('❌ Failed to post job:', err);
        res.status(500).json({ error: 'Failed to post job' });
      }
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

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
