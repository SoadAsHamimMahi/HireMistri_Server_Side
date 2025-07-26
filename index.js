const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// MongoDB URI from .env
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

    // ✅ Get all jobs
    app.get('/api/jobs', async (req, res) => {
      try {
        const jobs = await jobsCollection.find().toArray();
        res.json(jobs);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch jobs' });
      }
    });

    // ✅ Get a job by jobId
    app.get('/api/jobs/:jobId', async (req, res) => {
      const { jobId } = req.params;
      try {
        let job = await jobsCollection.findOne({ _id: jobId });
        if (!job) {
          job = await jobsCollection.findOne({ jobId }); // fallback if jobId stored separately
        }
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch job' });
      }
    });

    // ✅ Create new job
    app.post('/api/jobs', async (req, res) => {
      try {
        const result = await jobsCollection.insertOne(req.body);
        res.status(201).json({ message: 'Job posted', jobId: result.insertedId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to post job' });
      }
    });

    // ✅ Get all applications
    app.get('/api/applications', async (req, res) => {
      try {
        const apps = await applicationsCollection.find().toArray();
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch all applications' });
      }
    });

    // ✅ Get applications by workerId
    app.get('/api/applications/:workerId', async (req, res) => {
      const { workerId } = req.params;
      try {
        const cleanedId = workerId.trim();
        const apps = await applicationsCollection.find({ workerId: cleanedId }).toArray();
        console.log(`📨 Found ${apps.length} applications for workerId: "${cleanedId}"`);
        res.json(apps);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch applications' });
      }
    });

    // ✅ Create application
    app.post('/api/applications', async (req, res) => {
      try {
        const result = await applicationsCollection.insertOne(req.body);
        res.status(201).json({ message: 'Application submitted', appId: result.insertedId });
      } catch (err) {
        res.status(500).json({ error: 'Failed to submit application' });
      }
    });

    // ✅ Get all browseJobs
    app.get('/api/browse-jobs', async (req, res) => {
      try {
        const jobs = await browseJobsCollection.find().toArray();
        res.json(jobs);
      } catch (err) {
        console.error('❌ Failed to fetch browseJobs:', err);
        res.status(500).json({ error: 'Failed to fetch browse jobs' });
      }
    });

    // ✅ Start the server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

startServer();
