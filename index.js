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

// -------- Uploads folder ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
  console.log('📂 Created uploads folder automatically');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// serve uploads as static
app.use('/uploads', express.static(uploadsDir));

// -------- Mongo client ------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3zws6aa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

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

    // ---------- Routes start ----------

    app.get('/', (_req, res) => {
      res.send('🚀 HireMistri API is running...');
    });

    // ===== USERS =====
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

    // Upsert user (create if missing, update if exists)
    // app.put('/api/users/:uid', async (req, res) => {
    //   try {
    //     const uid = String(req.params.uid);
    //     const b = req.body || {};
    //     const update = {
    //       $set: {
    //         uid,
    //         email: String(b.email || '').toLowerCase(),
    //         displayName: b.displayName || '',
    //         firstName: b.firstName || '',
    //         lastName: b.lastName || '',
    //         phone: b.phone || '',
    //         role: (b.role || 'worker').toLowerCase(),
    //         updatedAt: new Date(),
    //       },
    //       $setOnInsert: { createdAt: new Date() },
    //     };
    //     const result = await usersCollection.updateOne({ uid }, update, { upsert: true });
    //     res.json({ ok: true, upsertedId: result.upsertedId || null });
    //   } catch (err) {
    //     console.error('PUT /api/users/:uid failed:', err);
    //     res.status(500).json({ error: 'Failed to upsert user' });
    //   }
    // });

    // // Optional legacy POST (if any client still calls POST /api/users)
    // app.post('/api/users', async (req, res) => {
    //   try {
    //     const b = req.body || {};
    //     if (!b.uid || !b.email) {
    //       return res.status(400).json({ error: 'uid and email are required' });
    //     }
    //     await usersCollection.insertOne({
    //       uid: String(b.uid),
    //       email: String(b.email).toLowerCase(),
    //       displayName: b.displayName || '',
    //       firstName: b.firstName || '',
    //       lastName: b.lastName || '',
    //       phone: b.phone || '',
    //       role: (b.role || 'worker').toLowerCase(),
    //       createdAt: new Date(),
    //       updatedAt: new Date(),
    //     });
    //     res.status(201).json({ message: 'User created' });
    //   } catch (err) {
    //     console.error('POST /api/users failed:', err);
    //     res.status(500).json({ error: 'Failed to create user' });
    //   }
    // });

    // ---- Edit worker Profile (users) ----
    // ---------- indexes ----------
    await usersCollection.createIndex({ uid: 1 }, { unique: true, sparse: true });
    await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true });

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
        'city', 'country', 'zip', 'workExperience', 'role'
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

      return pruneEmpty(set);
    }

    // ---------- routes ----------

    // GET a user
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

    // PATCH (non-destructive upsert)
    // ---------- SAFE UPDATE (non-destructive) ----------
    app.patch('/api/users/:uid', async (req, res) => {
      try {
        const uid = String(req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const now = new Date();
        const body = req.body || {};
        const allowUnset = String(req.query.allowUnset || '').toLowerCase() === 'true';

        // whitelist keys we allow to update
        const allowed = new Set([
          'firstName', 'lastName', 'displayName', 'phone', 'headline', 'bio',
          'skills', 'isAvailable', 'profileCover', 'address1', 'address2',
          'city', 'country', 'zip', 'workExperience', 'role', 'email'
        ]);

        // current doc for comparison (prevents wipe)
        const existing = await usersCollection.findOne({ uid }) || { uid, createdAt: now };

        const $set = {};
        const $unset = {};

        // merge only provided & non-empty values
        for (const [k, vRaw] of Object.entries(body)) {
          if (!allowed.has(k)) continue;

          // email normalization
          const v = (k === 'email' && typeof vRaw === 'string')
            ? vRaw.toLowerCase().trim()
            : vRaw;

          // arrays: keep only truthy strings
          if (k === 'skills' && Array.isArray(v)) {
            const cleaned = v.map(s => String(s).trim()).filter(Boolean);
            if (cleaned.length) $set[k] = cleaned;
            continue;
          }

          // booleans/numbers are OK as is
          if (typeof v === 'boolean' || typeof v === 'number') {
            $set[k] = v;
            continue;
          }

          // strings: skip empty (prevents erasing good data)
          if (typeof v === 'string') {
            const t = v.trim();
            if (t) $set[k] = t;
            else if (allowUnset && t === '' && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

          // null -> unset only if explicitly allowed
          if (v === null) {
            if (allowUnset && existing[k] !== undefined) $unset[k] = '';
            continue;
          }

          // other objects (e.g. profileCover already string URL) — set if not empty object
          if (v && typeof v === 'object') {
            if (Object.keys(v).length) $set[k] = v;
          }
        }

        // Always update updatedAt
        $set.updatedAt = now;

        const updateDoc = { $set, $setOnInsert: { uid, createdAt: existing.createdAt || now } };
        if (Object.keys($unset).length) updateDoc.$unset = $unset;

        // If nothing to change, just return the current doc
        if (Object.keys($set).length === 1 && Object.keys($unset).length === 0) { // only updatedAt present
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
    });

    // Keep PUT for old clients but route it through PATCH logic
    app.put('/api/users/:uid', (req, res, next) => {
      req.method = 'PATCH';
      next();
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


    // Avatar upload (kept, minor tidy)
    app.post('/api/users/:uid/avatar', upload.single('avatar'), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const uid = String(req.params.uid);
        const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

        await usersCollection.updateOne(
          { uid },
          { $set: { profileCover: publicUrl, updatedAt: new Date() }, $setOnInsert: { uid, createdAt: new Date() } },
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
    app.get('/api/applications', async (_req, res) => {
      try {
        const apps = await applicationsCollection.find().toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });

    app.get('/api/applications/:workerId', async (req, res) => {
      const { workerId } = req.params;
      try {
        const apps = await applicationsCollection
          .find({ workerId: workerId.trim() })
          .toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });



    // Good defaults for proposals/applications
    // ===== APPLICATIONS =====
    // helpful indexes
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

    // List all (debug)
    app.get('/api/applications', async (_req, res) => {
      try {
        const apps = await applicationsCollection.find().toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });

    // List a worker's applications
    app.get('/api/applications/:workerId', async (req, res) => {
      const { workerId } = req.params;
      try {
        const apps = await applicationsCollection
          .find({ workerId: String(workerId || '').trim() })
          .toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });


    // OPTIONAL: if you have these, keep the requires near the top of your server:
    const { ObjectId } = require('mongodb');
    let admin; try { admin = require('firebase-admin'); } catch (_) { admin = null; }

    // helper: try to fetch worker identity from usersCollection or Firebase Admin
    async function getWorkerIdentity(workerId, { usersCollection }) {
      const out = { email: '', name: '', phone: '' };

      // 1) users collection (recommended, if you keep profiles)
      if (usersCollection) {
        const u = await usersCollection.findOne({ uid: workerId });
        if (u) {
          out.email = (u.email || out.email).toLowerCase().trim();
          out.name = (u.name || out.name).trim();
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

    // Create/update a proposal (one per worker per job)

    app.post('/api/applications', async (req, res) => {
      try {
        const b = req.body || {};

        const jobId = String(b.jobId || '').trim();
        const workerId = String(b.workerId || '').trim();
        if (!jobId || !workerId) {
          return res.status(400).json({ error: 'jobId and workerId are required' });
        }

        // Cleaners
        const str = (v) => (v == null ? '' : String(v));
        const s = (v) => str(v).trim();
        const mail = (v) => s(v).toLowerCase();

        // Incoming (may be empty)
        let workerEmailIn = mail(b.workerEmail || b.postedByEmail);
        let workerNameIn = s(b.workerName);
        let workerPhoneIn = s(b.workerPhone);

        let clientIdIn = s(b.clientId);
        let clientEmailIn = mail(b.clientEmail);

        // Pull any existing application so we don't overwrite fields
        const existing = await applicationsCollection.findOne({ jobId, workerId });

        // If missing client info, derive from the job doc
        if (ObjectId.isValid(jobId) && (!clientIdIn || !clientEmailIn)) {
          const _id = new ObjectId(jobId);
          const j =
            (await browseJobsCollection.findOne({ _id })) ||
            (await jobsCollection.findOne({ _id }));
          if (j) {
            if (!clientIdIn) clientIdIn = s(j.clientId || j.postedByUid);
            if (!clientEmailIn) clientEmailIn = mail(j.postedByEmail || j.email);
          }
        }

        // If worker identity still missing (either first insert or older rows),
        // try to backfill from usersCollection / Firebase Admin once.
        if ((!workerEmailIn || !workerNameIn || !workerPhoneIn) &&
          (!existing || !existing.workerEmail || !existing.workerName || !existing.workerPhone)) {
          const backfill = await getWorkerIdentity(workerId, { usersCollection });
          workerEmailIn = workerEmailIn || backfill.email;
          workerNameIn = workerNameIn || backfill.name;
          workerPhoneIn = workerPhoneIn || backfill.phone;
        }

        const now = new Date();

        // Build $set carefully: only change what we intend to change
        const $set = {
          updatedAt: now,
        };

        // Status if provided; default only for new docs
        if (b.status) {
          $set.status = s(b.status);
        }

        // Keep proposalText if request included (avoid blanking on status-only updates)
        if ('proposalText' in b || 'text' in b) {
          $set.proposalText = s(b.proposalText || b.text);
        }

        // Update client info if present
        if (clientIdIn) $set.clientId = clientIdIn;
        if (clientEmailIn) $set.clientEmail = clientEmailIn;

        // Only set worker identity if provided/backfilled this time
        if (workerEmailIn) {
          $set.workerEmail = workerEmailIn;
          $set.postedByEmail = workerEmailIn; // backward compat mirror
        }
        if (workerNameIn) $set.workerName = workerNameIn;
        if (workerPhoneIn) $set.workerPhone = workerPhoneIn;

        // For first insert
        const $setOnInsert = {
          jobId,
          workerId,
          createdAt: now,
          status: b.status ? s(b.status) : 'pending',
        };

        if ('proposalText' in $set) $setOnInsert.proposalText = $set.proposalText;
        if (clientIdIn) $setOnInsert.clientId = clientIdIn;
        if (clientEmailIn) $setOnInsert.clientEmail = clientEmailIn;
        if (workerEmailIn) { $setOnInsert.workerEmail = workerEmailIn; $setOnInsert.postedByEmail = workerEmailIn; }
        if (workerNameIn) $setOnInsert.workerName = workerNameIn;
        if (workerPhoneIn) $setOnInsert.workerPhone = workerPhoneIn;

        const result = await applicationsCollection.updateOne(
          { jobId, workerId },
          { $set, $setOnInsert },
          { upsert: true }
        );

        const doc = await applicationsCollection.findOne({ jobId, workerId });
        res.status(result.upsertedId ? 201 : 200).json({ ok: true, application: doc });
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: 'You already applied to this job.' });
        }
        console.error('POST /api/applications failed:', err);
        res.status(500).json({ error: 'Failed to submit proposal' });
      }
    });



    // All proposals for a job (for client side)
    app.get('/api/job-applications/:jobId', async (req, res) => {
      try {
        const { jobId } = req.params;
        const apps = await applicationsCollection
          .find({ jobId: String(jobId) })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(apps);
      } catch (err) {
        console.error('GET /api/job-applications/:jobId failed:', err);
        res.status(500).json({ error: 'Failed to fetch proposals' });
      }
    });


    // GET /api/my-applications/:workerId  → applications with basic job info
    app.get('/api/my-applications/:workerId', async (req, res) => {
      try {
        const workerId = String(req.params.workerId || '').trim();
        if (!workerId) return res.status(400).json({ error: 'workerId required' });

        const cursor = applicationsCollection.aggregate([
          { $match: { workerId } },
          {
            $addFields: {
              _jobObjId: {
                $convert: { input: "$jobId", to: "objectId", onError: null, onNull: null }
              }
            }
          },
          {
            $lookup: {
              from: browseJobsCollection.collectionName, // e.g. "browseJobs"
              localField: "_jobObjId",
              foreignField: "_id",
              as: "bj"
            }
          },
          {
            $lookup: {
              from: jobsCollection.collectionName, // e.g. "jobs"
              localField: "_jobObjId",
              foreignField: "_id",
              as: "j"
            }
          },
          {
            $addFields: {
              jobDoc: { $ifNull: [{ $arrayElemAt: ["$bj", 0] }, { $arrayElemAt: ["$j", 0] }] }
            }
          },
          {
            $addFields: {
              title: { $ifNull: ["$jobDoc.title", "$title"] },
              location: { $ifNull: ["$jobDoc.location", "$location"] },
              budget: { $ifNull: ["$jobDoc.budget", "$budget"] },
              category: { $ifNull: ["$jobDoc.category", "$category"] },
              images: { $ifNull: ["$jobDoc.images", []] }
            }
          },
          { $project: { bj: 0, j: 0, jobDoc: 0, _jobObjId: 0 } },
          { $sort: { createdAt: -1 } }
        ]);

        const docs = await cursor.toArray();
        res.json(docs);
      } catch (err) {
        console.error('GET /api/my-applications/:workerId failed:', err);
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });



    // app.post('/api/applications', async (req, res) => {
    //   try {
    //     const result = await applicationsCollection.insertOne(req.body);
    //     res.status(201).json({ message: 'Application submitted', appId: result.insertedId });
    //   } catch (err) {
    //     res.status(500).json({ error: 'Failed to submit application' });
    //   }
    // });

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

    // ---------- Routes end ----------

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
