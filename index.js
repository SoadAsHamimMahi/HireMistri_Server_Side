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

// ✅ Ensure uploads folder exists automatically
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
  console.log('📂 Created uploads folder automatically');
}

// ✅ Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// ✅ Serve static files for uploaded images
app.use('/uploads', express.static(uploadsDir));

// ✅ MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3zws6aa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('hiremistriDB');
    const usersCollection = db.collection('users');
    const jobsCollection = db.collection('jobs');
    const applicationsCollection = db.collection('applications');
    const browseJobsCollection = db.collection('browseJobs');

    // ✅ Root route
    app.get('/', (req, res) => {
      res.send('🚀 HireMistri API is running...');
    });

    // ================= JOBS =================
    app.get('/api/jobs', async (req, res) => {
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

    // ================= APPLICATIONS =================
    app.get('/api/applications', async (req, res) => {
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
        const apps = await applicationsCollection.find({ workerId: workerId.trim() }).toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });

    app.post('/api/applications', async (req, res) => {
      try {
        const result = await applicationsCollection.insertOne(req.body);
        res.status(201).json({ message: 'Application submitted', appId: result.insertedId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to submit application' });
      }
    });

    // ================= BROWSE JOBS =================
    app.get('/api/browse-jobs', async (req, res) => {
      try {
        const jobs = await browseJobsCollection.find().toArray();
        res.json(jobs);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch browse jobs' });
      }
    });

 
    // ✅ Handle multiple image uploads (up to 10 files)
    app.post('/api/browse-jobs/upload', upload.array('images', 10), (req, res) => {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const imageUrls = req.files.map(file =>
        `http://localhost:${PORT}/uploads/${file.filename}`
      );

      res.json({ imageUrls });
    });


    // ✅ Post browse job (with or without images)
    app.post('/api/browse-jobs', async (req, res) => {
      try {
        const result = await browseJobsCollection.insertOne({
          ...req.body,
          status: 'active',
          date: new Date().toISOString().split('T')[0],
          createdAt: new Date(),
        });

        res.status(201).json({
          message: '✅ Job posted successfully',
          jobId: result.insertedId,
        });
      } catch (err) {
        console.error('❌ Failed to post job:', err);
        res.status(500).json({ error: 'Failed to post job' });
      }
    });

    // ✅ Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
