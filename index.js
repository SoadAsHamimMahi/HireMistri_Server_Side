const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');
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

// ✅ MongoDB URI from .env
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

    // ✅ Upload image endpoint
    app.post('/api/browse-jobs/upload', upload.single('image'), (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const imageUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;
      res.json({ imageUrl });
    });

    // ✅ Post job with image URLs
    app.post('/api/browse-jobs', async (req, res) => {
      try {
        const result = await browseJobsCollection.insertOne({
          ...req.body,
          status: 'active',
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

    // ✅ Get all browse jobs
    app.get('/api/browse-jobs', async (req, res) => {
      try {
        const jobs = await browseJobsCollection.find().toArray();
        res.json(jobs);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch browse jobs' });
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
