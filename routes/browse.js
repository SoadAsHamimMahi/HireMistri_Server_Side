// routes/browse.js — /api/browse-workers, /api/browse-clients
const { Router } = require('express');
const { collections } = require('../config/db');
const { computeUserStats } = require('../utils/helpers');

const router = Router();

// Popularity score helper
function calculatePopularityScore(worker) {
  const stats = worker.stats || {};
  const completedJobs = stats.workerCompletedJobs || 0;
  const rating = stats.averageRating || 0;
  const responseRate = stats.workerResponseRate || 0;
  const jobsScore = completedJobs * 10;
  const ratingScore = rating * 20;
  const responseRateScore = responseRate * 0.5;
  let bonusPoints = 0;
  if (worker.emailVerified) bonusPoints += 5;
  if (worker.isAvailable) bonusPoints += 10;
  return { ...worker, popularityScore: jobsScore + ratingScore + responseRateScore + bonusPoints };
}

router.get('/browse-workers', async (req, res) => {
  try {
    const { limit = 9, sortBy = 'popular' } = req.query;
    const limitNum = Math.min(parseInt(limit) || 9, 50);
    const workers = await collections.users.find({ role: 'worker' }).toArray();
    const workersWithStats = await Promise.all(
      workers.map(async (worker) => {
        const stats = await computeUserStats(worker.uid);
        return {
          uid: worker.uid,
          displayName: worker.displayName || [worker.firstName, worker.lastName].filter(Boolean).join(' ') || 'Worker',
          profileCover: worker.profileCover || '',
          city: worker.city || '', country: worker.country || '',
          servicesOffered: worker.servicesOffered || { categories: [], tags: [] },
          portfolio: Array.isArray(worker.portfolio) ? worker.portfolio : [],
          pricing: worker.pricing || null, stats: stats || {},
          emailVerified: !!worker.emailVerified, isAvailable: !!worker.isAvailable,
        };
      })
    );
    const workersWithScores = workersWithStats.map(calculatePopularityScore);
    if (sortBy === 'popular') {
      workersWithScores.sort((a, b) => {
        if (b.popularityScore !== a.popularityScore) return b.popularityScore - a.popularityScore;
        const aJobs = a.stats?.workerCompletedJobs || 0;
        const bJobs = b.stats?.workerCompletedJobs || 0;
        if (bJobs !== aJobs) return bJobs - aJobs;
        return (b.stats?.averageRating || 0) - (a.stats?.averageRating || 0);
      });
    }
    const limited = workersWithScores.slice(0, limitNum).map(({ popularityScore, ...w }) => w);
    res.json(limited);
  } catch (err) {
    console.error('GET /api/browse-workers failed:', err);
    res.status(500).json({ error: 'Failed to fetch workers' });
  }
});

router.get('/browse-clients', async (req, res) => {
  try {
    const { limit = 9, sortBy = 'recent' } = req.query;
    const limitNum = Math.min(parseInt(limit) || 9, 50);
    const clients = await collections.users.find({ role: 'client' }).toArray();
    const clientsWithStats = await Promise.all(
      clients.map(async (client) => {
        const stats = await computeUserStats(client.uid);
        return {
          uid: client.uid,
          displayName: client.displayName || [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Client',
          profileCover: client.profileCover || '',
          city: client.city || '', country: client.country || '',
          stats: stats || {},
          emailVerified: !!client.emailVerified, phoneVerified: !!client.phoneVerified,
          createdAt: client.createdAt || new Date(),
        };
      })
    );
    if (sortBy === 'recent') {
      clientsWithStats.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    } else if (sortBy === 'jobs') {
      clientsWithStats.sort((a, b) => (b.stats?.totalJobsPosted || 0) - (a.stats?.totalJobsPosted || 0));
    }
    res.json(clientsWithStats.slice(0, limitNum));
  } catch (err) {
    console.error('GET /api/browse-clients failed:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

module.exports = router;
