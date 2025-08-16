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

    // Indexes (safe to call multiple times)
    await usersCollection.createIndex({ uid: 1 }, { unique: true, sparse: true });
    await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true });
    await usersCollection.createIndex({ roles: 1 }, { sparse: true });

    // helper to sanitize/whitelist incoming fields
    function sanitizeWorkerPayload(body = {}) {
      const w = (body.profiles && body.profiles.worker) ? body.profiles.worker : body;

      const str = (v, d = "") => (typeof v === "string" ? v.trim() : d);
      const num = (v, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
      };

      const worker = {
        firstName: str(w.firstName),
        lastName: str(w.lastName),
        displayName: str(w.displayName),
        phone: str(w.phone),
        workExperience: num(w.workExperience),
        headline: str(w.headline),
        bio: str(w.bio),
        skills: Array.isArray(w.skills) ? w.skills.map((s) => String(s).trim()).filter(Boolean) : [],
        isAvailable: Boolean(w.isAvailable ?? true),
        avatar: str(w.avatar || w.profileCover || ""),
        address1: str(w.address1),
        address2: str(w.address2),
        location: {
          city: str(w.location?.city || body.city),
          country: str(w.location?.country || body.country || "Bangladesh"),
          zip: str(w.location?.zip || body.zip),
        },
      };

      // prune empty strings/empty objects
      (function prune(obj) {
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (v && typeof v === "object" && !Array.isArray(v)) prune(v);
          const isEmptyObj = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
          if (v === "" || isEmptyObj) delete obj[k];
        });
      })(worker);

      return worker;
    }

    // PUT upsert worker profile under profiles.worker
    app.put('/api/users/:uid', async (req, res) => {
      try {
        console.log('PUT /api/users/:uid (flat) → uid:', req.params.uid);
        const uid = String(req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Missing uid in URL' });

        const b = req.body || {};
        const now = new Date();

        const email = String(b.email || '').toLowerCase().trim();

        // Normalize inputs from your EditProfile.jsx
        const setDoc = {
          uid,
          // core
          displayName: (b.displayName || '').trim(),
          firstName: (b.firstName || '').trim(),
          lastName: (b.lastName || '').trim(),
          phone: (b.phone || '').trim(),
          role: (b.role || 'worker').toLowerCase(),

          // profile extras
          headline: (b.headline || '').trim(),
          bio: (b.bio || '').trim(),
          workExperience: Number(b.workExperience) || 0,
          isAvailable: !!b.isAvailable,
          skills: Array.isArray(b.skills) ? b.skills.map(s => String(s).trim()).filter(Boolean) : [],
          profileCover: b.profileCover || null,

          // address (your UI uses flat keys)
          address1: (b.address1 || '').trim(),
          address2: (b.address2 || '').trim(),
          city: (b.city || '').trim(),
          country: (b.country || 'Bangladesh').trim(),
          zip: (b.zip || '').trim(),

          updatedAt: now,
        };

        // only set email if non-empty; otherwise unset to avoid unique "" collisions
        const update = {
          $set: setDoc,
          $setOnInsert: { createdAt: now },
        };
        if (email) update.$set.email = email; else update.$unset = { email: "" };

        const result = await usersCollection.updateOne({ uid }, update, { upsert: true });
        console.log('Mongo result:', { matched: result.matchedCount, modified: result.modifiedCount, upsertedId: result.upsertedId });

        const doc = await usersCollection.findOne({ uid });
        return res.json({ ok: true, user: doc });
      } catch (err) {
        console.error('PUT /api/users/:uid failed:', err);
        if (err && err.code === 11000) {
          return res.status(409).json({ error: 'Duplicate key (likely email). Use a unique email.' });
        }
        return res.status(500).json({ error: 'Failed to upsert user' });
      }
    });

    // Upload avatar and persist directly to profiles.worker.avatar
    app.post('/api/users/:uid/avatar', upload.single('avatar'), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const uid = String(req.params.uid);
        const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        const now = new Date();

        await usersCollection.updateOne(
          { uid },
          { $set: { profileCover: publicUrl, updatedAt: now }, $setOnInsert: { uid, createdAt: now } },
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

// Create/update a proposal (one per worker per job)
// Create/update a proposal (one per worker per job)
app.post('/api/applications', async (req, res) => {
  try {
    const b = req.body || {};

    const jobId    = String(b.jobId || '').trim();
    const workerId = String(b.workerId || '').trim();

    if (!jobId || !workerId) {
      return res.status(400).json({ error: 'jobId and workerId are required' });
    }

    // Worker info (sent from frontend WorkerJobDetails.jsx)
    let workerEmail = b.workerEmail
      ? String(b.workerEmail).toLowerCase().trim()
      : (b.postedByEmail ? String(b.postedByEmail).toLowerCase().trim() : '');
    let workerName  = b.workerName ? String(b.workerName).trim() : '';
    let workerPhone = b.workerPhone ? String(b.workerPhone).trim() : '';

    // Client (job owner) info
    let clientId    = b.clientId ? String(b.clientId).trim() : '';
    let clientEmail = b.clientEmail ? String(b.clientEmail).toLowerCase().trim() : '';

    // Fill missing client info from job doc
    if (ObjectId.isValid(jobId) && (!clientId || !clientEmail)) {
      const _id = new ObjectId(jobId);
      const j =
        (await browseJobsCollection.findOne({ _id })) ||
        (await jobsCollection.findOne({ _id }));
      if (j) {
        if (!clientId) clientId = String(j.clientId || j.postedByUid || '');
        if (!clientEmail) {
          const derived = j.postedByEmail || j.email || '';
          clientEmail = derived ? String(derived).toLowerCase().trim() : '';
        }
      }
    }

    const now = new Date();
    const proposalText = String(b.proposalText || b.text || '').trim();

    const update = {
      $set: {
        jobId,
        workerId,

        // job owner
        clientId: clientId || null,
        clientEmail: clientEmail || null,

        // worker info
        workerEmail: workerEmail || null,
        workerName: workerName || null,
        workerPhone: workerPhone || null,

        // keep for backward compatibility
        postedByEmail: workerEmail || null,

        proposalText,
        status: b.status ? String(b.status) : 'pending',
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    };

    const result = await applicationsCollection.updateOne(
      { jobId, workerId }, // unique pair
      update,
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
