// routes/savedJobs.js — /api/saved-jobs/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');

const router = Router();

// Save a job
router.post('/', async (req, res) => {
  try {
    const { userId, jobId } = req.body;
    if (!userId || !jobId) return res.status(400).json({ error: 'userId and jobId are required' });

    if (ObjectId.isValid(jobId)) {
      const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
      if (!job) return res.status(404).json({ error: 'Job not found' });
    }

    const existing = await collections.savedJobs.findOne({ userId, jobId });
    if (existing) return res.status(409).json({ error: 'Job is already saved' });

    const result = await collections.savedJobs.insertOne({ userId, jobId, savedAt: new Date() });
    res.status(201).json({ message: 'Job saved successfully', savedJob: { _id: result.insertedId, userId, jobId, savedAt: new Date() } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Job is already saved' });
    console.error('❌ Failed to save job:', err);
    res.status(500).json({ error: 'Failed to save job' });
  }
});

// Get all saved jobs for a user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const savedJobs = await collections.savedJobs.find({ userId }).sort({ savedAt: -1 }).toArray();

    const jobsWithDetails = await Promise.all(
      savedJobs.map(async (saved) => {
        if (ObjectId.isValid(saved.jobId)) {
          const job = await collections.browseJobs.findOne({ _id: new ObjectId(saved.jobId) });
          return job ? { ...job, savedAt: saved.savedAt, savedJobId: saved._id } : null;
        }
        return null;
      })
    );

    res.json(jobsWithDetails.filter((j) => j !== null));
  } catch (err) {
    console.error('❌ Failed to fetch saved jobs:', err);
    res.status(500).json({ error: 'Failed to fetch saved jobs' });
  }
});

// Check if a job is saved
router.get('/check/:userId/:jobId', async (req, res) => {
  try {
    const { userId, jobId } = req.params;
    if (!userId || !jobId) return res.status(400).json({ error: 'userId and jobId are required' });
    const savedJob = await collections.savedJobs.findOne({ userId, jobId });
    res.json({ saved: !!savedJob, savedJobId: savedJob ? String(savedJob._id) : null });
  } catch (err) {
    console.error('❌ Failed to check saved job:', err);
    res.status(500).json({ error: 'Failed to check saved job' });
  }
});

// Unsave a job
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid saved job id' });
    const query = { _id: new ObjectId(id) };
    if (userId) query.userId = userId;
    const result = await collections.savedJobs.deleteOne(query);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Saved job not found' });
    res.json({ message: 'Job unsaved successfully', deleted: true });
  } catch (err) {
    console.error('❌ Failed to unsave job:', err);
    res.status(500).json({ error: 'Failed to unsave job' });
  }
});

module.exports = router;
