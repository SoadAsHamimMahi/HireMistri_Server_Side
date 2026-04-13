// routes/jobs.js — /api/jobs (legacy) and /api/browse-jobs
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');
const { upload } = require('../middleware/upload');
const { getStatusEmoji } = require('../utils/helpers');
const { findOrCreateConversationId, sendSystemMessage } = require('../utils/messaging');
const { createNotification } = require('../utils/notifications');
const { sendJobStatusEmail, sendJobOfferEmail } = require('../utils/emailService');
const { getCachedConversationJobs, setCachedConversationJobs, invalidateConversationJobsCache } = require('../utils/cache');

const router = Router();

// ---- Legacy Jobs (/api/jobs) ----
router.get('/jobs', async (_req, res) => {
  try { res.json(await collections.jobs.find().toArray()); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch jobs' }); }
});
router.get('/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.jobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch job' }); }
});
router.post('/jobs', async (req, res) => {
  try {
    const body = req.body || {};
    const locationText = body.locationText != null ? String(body.locationText).trim() : (body.location != null ? String(body.location).trim() : null);
    let locationGeo = null;
    if (body.locationGeo && typeof body.locationGeo === 'object') {
      const lat = parseFloat(body.locationGeo.lat);
      const lng = parseFloat(body.locationGeo.lng);
      if (!isNaN(lat) && !isNaN(lng)) locationGeo = { lat, lng };
    }
    const placeId = body.placeId != null ? String(body.placeId).trim() : null;
    const jobDoc = { ...body, location: locationText || body.location || null, locationText: locationText || null, locationGeo: locationGeo || null, placeId: placeId || null };
    const result = await collections.jobs.insertOne(jobDoc);
    res.status(201).json({ message: 'Job posted', jobId: result.insertedId });
  } catch (err) { res.status(500).json({ error: 'Failed to post job' }); }
});

// ---- Browse Jobs (/api/browse-jobs) ----
router.get('/browse-jobs', async (req, res) => {
  try {
    const { status, clientId, targetWorkerId, conversationId, isPrivate, offerStatus, limit = 20, skip = 0 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (clientId) filter.clientId = String(clientId);
    if (targetWorkerId) filter.targetWorkerId = String(targetWorkerId);
    if (conversationId) filter.conversationId = String(conversationId);
    if (isPrivate !== undefined) filter.isPrivate = isPrivate === 'true';
    if (offerStatus) filter.offerStatus = String(offerStatus);
    const jobs = await collections.browseJobs.find(filter).sort({ createdAt: -1 }).skip(parseInt(skip) || 0).limit(Math.min(parseInt(limit) || 20, 100)).toArray();
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch jobs' }); }
});

router.get('/browse-jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid job ID format' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (e) { console.error('GET /api/browse-jobs/:id failed:', e); res.status(500).json({ error: 'Failed to fetch job' }); }
});

router.post('/browse-jobs', async (req, res) => {
  try {
    const { expiresAt, ...jobData } = req.body;
    if (expiresAt) {
      const expirationDate = new Date(expiresAt);
      if (isNaN(expirationDate.getTime())) return res.status(400).json({ error: 'Invalid expiration date format' });
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(expiresAt))) expirationDate.setHours(23, 59, 59, 999);
      if (expirationDate <= new Date()) return res.status(400).json({ error: 'Expiration date must be in the future' });
    }
    const isPrivate = jobData.isPrivate || false;
    if (isPrivate) {
      const isProfileInitiated = jobData.conversationId && String(jobData.conversationId).startsWith('profile_');
      if (!isProfileInitiated && !jobData.conversationId) return res.status(400).json({ error: 'conversationId is required for private jobs' });
      if (!jobData.targetWorkerId) return res.status(400).json({ error: 'targetWorkerId is required for private jobs' });
      if (!jobData.clientId) return res.status(400).json({ error: 'clientId is required for private jobs' });
      const targetWorker = await collections.users.findOne({ uid: String(jobData.targetWorkerId) });
      if (!targetWorker) return res.status(404).json({ error: 'Target worker not found' });
      if (targetWorker.role !== 'worker') return res.status(400).json({ error: 'Target user is not a worker' });
      const pendingOffer = await collections.browseJobs.findOne({ clientId: String(jobData.clientId), targetWorkerId: String(jobData.targetWorkerId), isPrivate: true, offerStatus: 'pending', status: { $nin: ['cancelled', 'completed'] } });
      if (pendingOffer) return res.status(409).json({ error: 'You already have a pending offer to this worker' });
      if (!isProfileInitiated) {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const duplicateJob = await collections.browseJobs.findOne({ conversationId: String(jobData.conversationId), clientId: String(jobData.clientId), title: String(jobData.title).trim(), createdAt: { $gte: oneDayAgo }, status: { $ne: 'completed' } });
        if (duplicateJob) return res.status(409).json({ error: 'A similar job was already posted in this conversation recently.', duplicateJobId: duplicateJob._id });
      }
    }
    let finalExpiresAt = expiresAt ? new Date(expiresAt) : null;
    if (isPrivate && !finalExpiresAt) finalExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const locationText = jobData.locationText != null ? String(jobData.locationText).trim() : (jobData.location != null ? String(jobData.location).trim() : null);
    let locationGeo = null;
    if (jobData.locationGeo && typeof jobData.locationGeo === 'object') {
      const lat = parseFloat(jobData.locationGeo.lat);
      const lng = parseFloat(jobData.locationGeo.lng);
      if (!isNaN(lat) && !isNaN(lng)) locationGeo = { lat, lng };
    }
    const placeId = jobData.placeId != null ? String(jobData.placeId).trim() : null;
    const jobDoc = { ...jobData, location: locationText || jobData.location || null, locationText: locationText || null, locationGeo: locationGeo || null, placeId: placeId || null, status: 'active', date: new Date().toISOString().split('T')[0], createdAt: new Date(), expiresAt: finalExpiresAt, autoCloseEnabled: !!finalExpiresAt, isPrivate, conversationId: !isPrivate ? (jobData.conversationId || null) : null, targetWorkerId: jobData.targetWorkerId || null, createdFromChat: !!isPrivate, offerStatus: isPrivate ? 'pending' : null };
    const result = await collections.browseJobs.insertOne(jobDoc);
    const jobId = result.insertedId.toString();
    let canonicalConversationId = null;
    if (isPrivate && jobData.clientId && jobData.targetWorkerId) {
      const sortedIds = [String(jobData.clientId), String(jobData.targetWorkerId)].sort();
      canonicalConversationId = `${jobId}_${sortedIds.join('_')}`;
      await collections.browseJobs.updateOne({ _id: result.insertedId }, { $set: { conversationId: canonicalConversationId } });
    }
    if (isPrivate && (canonicalConversationId || jobData.conversationId) && jobData.targetWorkerId) {
      const conversationIdForMessage = canonicalConversationId || String(jobData.conversationId);
      try {
        const client = await collections.users.findOne({ uid: String(jobData.clientId) });
        const clientName = client?.displayName || client?.email || 'Client';
        const systemMessage = { conversationId: conversationIdForMessage, senderId: String(jobData.clientId), recipientId: String(jobData.targetWorkerId), jobId, message: `📋 New job posted: ${jobData.title}${jobData.budget ? `\n💰 Budget: ${jobData.budget} ${jobData.currency || 'BDT'}` : ''}${jobData.location ? `\n📍 Location: ${jobData.location}` : ''}`, senderName: 'System', recipientName: '', read: false, createdAt: new Date(), isSystemMessage: true };
        await collections.messages.insertOne(systemMessage);
        try {
          const targetWorkerDoc = await collections.users.findOne({ uid: String(jobData.targetWorkerId) });
          if (targetWorkerDoc?.email) sendJobOfferEmail(targetWorkerDoc.email, targetWorkerDoc.displayName || targetWorkerDoc.email || 'Worker', jobData.title, clientName, jobData.budget, jobData.currency, finalExpiresAt).catch(() => {});
        } catch { /* non-fatal */ }
        await createNotification(String(jobData.targetWorkerId), 'New Job Offer', `${clientName} sent you a job offer: ${jobData.title}${jobData.budget ? ` (${jobData.budget} ${jobData.currency || 'BDT'})` : ''}`, 'info', jobId, '/job-offers').catch(() => {});
      } catch (msgErr) { console.error('Failed to create system message for private job:', msgErr); }
    }
    if (canonicalConversationId || jobData.conversationId) {
      invalidateConversationJobsCache(canonicalConversationId || String(jobData.conversationId));
    }
    res.status(201).json({ message: '✅ Job posted successfully', jobId });
  } catch (err) { console.error('❌ Failed to post job:', err); res.status(500).json({ error: 'Failed to post job' }); }
});

router.post('/browse-jobs/upload', upload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ imageUrls: req.files.map((file) => `${base}/uploads/${file.filename}`) });
});

router.patch('/browse-jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { clientId, status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (clientId && job.clientId && job.clientId !== clientId) return res.status(403).json({ error: 'Permission denied' });
    let newStatus = status ? String(status).toLowerCase() : null;
    if (newStatus) {
      const currentStatus = (job.status || 'active').toLowerCase();
      const allowedStatuses = ['active', 'on-hold', 'cancelled', 'completed'];
      if (!allowedStatuses.includes(newStatus)) return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` });
      if (['cancelled', 'completed'].includes(currentStatus)) return res.status(400).json({ error: `Cannot change status from ${currentStatus}.` });
    }
    if (req.body.expiresAt !== undefined) {
      if (req.body.expiresAt === null || req.body.expiresAt === '') { req.body.expiresAt = null; req.body.autoCloseEnabled = false; }
      else {
        const d = new Date(req.body.expiresAt);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expiration date format' });
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expiresAt))) d.setHours(23, 59, 59, 999);
        if (d <= new Date()) return res.status(400).json({ error: 'Expiration date must be in the future' });
        req.body.expiresAt = d; req.body.autoCloseEnabled = true;
      }
    }
    const updateData = { ...req.body };
    delete updateData._id; delete updateData.createdAt; delete updateData.clientId;
    updateData.updatedAt = new Date();
    await collections.browseJobs.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    const updatedJob = await collections.browseJobs.findOne({ _id: new ObjectId(id) });
    if (newStatus && job.status !== newStatus) {
      try {
        const jobTitle = updatedJob.title || 'Your Job';
        if (updatedJob.clientId) { await createNotification(updatedJob.clientId, 'Job Status Updated', `Your job "${jobTitle}" status updated to ${newStatus}.`, 'info', id, `/My-Posted-Job-Details/${id}`).catch(() => {}); }
        if (updatedJob.postedByEmail || updatedJob.clientId) {
          let clientEmail = null;
          if (updatedJob.clientId) { const cu = await collections.users.findOne({ uid: updatedJob.clientId }); if (cu) clientEmail = cu.email; }
          if (clientEmail) sendJobStatusEmail(clientEmail, 'Client', jobTitle, newStatus).catch(() => {});
        }
        const apps = await collections.applications.find({ jobId: String(id), status: { $in: ['pending', 'accepted'] } }).toArray();
        for (const appDoc of apps) {
          if (appDoc.workerId && updatedJob.clientId) {
            const cid = await findOrCreateConversationId(id, updatedJob.clientId, appDoc.workerId);
            if (cid) await sendSystemMessage(cid, updatedJob.clientId, appDoc.workerId, id, `📊 Job status updated: ${jobTitle}\n🔄 New status: ${getStatusEmoji(newStatus)} ${newStatus}`);
          }
        }
      } catch { /* non-fatal */ }
    }
    res.json({ message: '✅ Job updated successfully', job: updatedJob });
  } catch (err) { console.error('❌ Failed to update job:', err); res.status(500).json({ error: 'Failed to update job' }); }
});

router.put('/browse-jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const updateData = { ...req.body };
    delete updateData._id;
    if (job.createdAt) updateData.createdAt = job.createdAt;
    updateData.updatedAt = new Date();
    await collections.browseJobs.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    res.json({ message: '✅ Job updated successfully', job: await collections.browseJobs.findOne({ _id: new ObjectId(id) }) });
  } catch (err) { res.status(500).json({ error: 'Failed to update job' }); }
});

router.delete('/browse-jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const hasAccepted = await collections.applications.findOne({ jobId: String(id), status: 'accepted' });
    if (hasAccepted) return res.status(400).json({ error: 'Cannot delete job with accepted applications.' });
    await collections.browseJobs.deleteOne({ _id: new ObjectId(id) });
    await collections.applications.deleteMany({ jobId: String(id) });
    res.json({ message: '✅ Job deleted successfully' });
  } catch (err) { res.status(500).json({ error: 'Failed to delete job' }); }
});

// Job recommendations
router.get('/jobs/recommendations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'User ID is required' });
    const user = await collections.users.findOne({ uid: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const userSkills = user.skills || [];
    const userLocation = user.location || null;
    const userApplications = await collections.applications.find({ workerId: userId }).toArray();
    const appliedJobIds = userApplications.map(a => a.jobId);
    const allJobs = await collections.browseJobs.find({ status: 'active', ...appliedJobIds.length ? { _id: { $nin: appliedJobIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) } } : {} }).toArray();
    const scoredJobs = allJobs.map(job => {
      let score = 0; const reasons = [];
      if (userSkills.length > 0 && Array.isArray(job.skills)) {
        const matchingSkills = job.skills.filter(skill => userSkills.some(us => String(us).toLowerCase() === String(skill).toLowerCase()));
        if (matchingSkills.length > 0) { score += matchingSkills.length * 10; reasons.push(`Matches ${matchingSkills.length} skill${matchingSkills.length > 1 ? 's' : ''}`); }
      }
      if (userLocation && userLocation.lat && userLocation.lng && job.location) {
        const jobLat = job.lat || job.latitude || job.locationLat;
        const jobLng = job.lng || job.longitude || job.locationLng;
        if (jobLat && jobLng) {
          const R = 6371, dLat = (jobLat - userLocation.lat) * Math.PI / 180, dLng = (jobLng - userLocation.lng) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(userLocation.lat * Math.PI / 180) * Math.cos(jobLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
          const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          if (distance <= 10) { score += 20; reasons.push(`Very close (${distance.toFixed(1)} km)`); }
          else if (distance <= 25) { score += 10; reasons.push(`Nearby (${distance.toFixed(1)} km)`); }
          else if (distance <= 50) { score += 5; reasons.push(`Within range (${distance.toFixed(1)} km)`); }
        }
      }
      if (job.createdAt && (new Date() - new Date(job.createdAt)) / 86400000 <= 7) { score += 5; reasons.push('Recently posted'); }
      return { ...job, recommendationScore: score, recommendationReasons: reasons };
    });
    const recommendations = scoredJobs.filter(j => j.recommendationScore > 0).sort((a, b) => b.recommendationScore - a.recommendationScore).slice(0, 10);
    res.json(recommendations);
  } catch (err) { console.error('❌ Failed to get job recommendations:', err); res.status(500).json({ error: 'Failed to get job recommendations' }); }
});

// Job offer specific routes
router.get('/job-offers', async (req, res) => {
  try {
    const { workerId } = req.query;
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    const offers = await collections.browseJobs.find({ targetWorkerId: String(workerId), isPrivate: true }).sort({ createdAt: -1 }).toArray();
    res.json(offers);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch job offers' }); }
});

router.get('/job-offers/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job offer not found' });
    res.json(job);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch job offer' }); }
});

router.post('/job-offers/:jobId/respond', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { workerId, action, reason } = req.body;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be accept or reject' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (String(job.targetWorkerId) !== String(workerId)) return res.status(403).json({ error: 'Not authorized' });
    if (job.offerStatus !== 'pending') return res.status(400).json({ error: `Job offer is already ${job.offerStatus}` });
    const now = new Date();
    const newOfferStatus = action === 'accept' ? 'accepted' : 'rejected';
    await collections.browseJobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { offerStatus: newOfferStatus, offerRespondedAt: now, ...(action === 'reject' && reason ? { offerRejectionReason: String(reason) } : {}), updatedAt: now } });
    // If accepted, create an application record
    if (action === 'accept' && job.clientId) {
      await collections.applications.updateOne(
        { jobId: String(jobId), workerId: String(workerId) },
        { $setOnInsert: { jobId: String(jobId), workerId: String(workerId), clientId: String(job.clientId), status: 'accepted', createdAt: now, updatedAt: now } },
        { upsert: true }
      );
    }
    await createNotification(String(job.clientId), `Job offer ${newOfferStatus}`, `Your job offer "${job.title}" has been ${newOfferStatus} by the worker.`, action === 'accept' ? 'success' : 'info', jobId, `/My-Posted-Job-Details/${jobId}`).catch(() => {});
    res.json({ success: true, offerStatus: newOfferStatus });
  } catch (err) { console.error('POST /api/job-offers/:jobId/respond failed:', err); res.status(500).json({ error: 'Failed to respond to job offer' }); }
});

router.post('/job-offers/:jobId/withdraw', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { clientId } = req.body;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (String(job.clientId) !== String(clientId)) return res.status(403).json({ error: 'Not authorized' });
    if (job.offerStatus !== 'pending') return res.status(400).json({ error: `Job offer is already ${job.offerStatus}` });
    await collections.browseJobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { offerStatus: 'withdrawn', status: 'cancelled', updatedAt: new Date() } });
    await createNotification(String(job.targetWorkerId), 'Job offer withdrawn', `The client has withdrawn the job offer: ${job.title || 'Job offer'}.`, 'info', String(jobId), '/job-offers').catch(() => {});
    res.json({ success: true, message: 'Job offer withdrawn successfully' });
  } catch (err) { console.error('POST /api/job-offers/:jobId/withdraw failed:', err); res.status(500).json({ error: 'Failed to withdraw job offer' }); }
});

router.get('/job-offers/analytics/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const history = await collections.jobOfferHistory.find({ jobId: String(jobId) }).sort({ createdAt: -1 }).toArray();
    const accepted = history.filter(h => h.action === 'accepted').length;
    const rejected = history.filter(h => h.action === 'rejected').length;
    const totalActions = history.length;
    let timeToAccept = null;
    const acceptanceRecord = history.find(h => h.action === 'accepted');
    if (acceptanceRecord && job.createdAt) timeToAccept = new Date(acceptanceRecord.createdAt) - new Date(job.createdAt);
    res.json({ jobId: String(jobId), metrics: { totalActions, accepted, rejected, acceptanceRate: totalActions > 0 ? (accepted / totalActions) * 100 : 0, timeToAccept: timeToAccept ? Math.floor(timeToAccept / 3600000) : null }, history: history.map(h => ({ action: h.action, workerId: h.workerId, createdAt: h.createdAt, reason: h.reason, proposal: h.proposal })) });
  } catch (err) { console.error('GET /api/job-offers/analytics/:jobId failed:', err); res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

router.post('/job-offers/:jobId/remind-later', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { workerId, reminderAt } = req.body;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    if (!reminderAt) return res.status(400).json({ error: 'reminderAt is required' });
    const reminderDate = new Date(reminderAt);
    if (isNaN(reminderDate.getTime()) || reminderDate <= new Date()) return res.status(400).json({ error: 'Reminder date must be in the future' });
    const job = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (String(job.targetWorkerId) !== String(workerId)) return res.status(403).json({ error: 'Not authorized' });
    const existing = await collections.jobOfferReminders.findOne({ jobId: String(jobId), workerId: String(workerId) });
    if (existing) await collections.jobOfferReminders.updateOne({ _id: existing._id }, { $set: { reminderAt: reminderDate, updatedAt: new Date() } });
    else await collections.jobOfferReminders.insertOne({ jobId: String(jobId), workerId: String(workerId), reminderAt: reminderDate, createdAt: new Date(), updatedAt: new Date() });
    res.json({ success: true, message: 'Reminder set successfully', reminderAt: reminderDate });
  } catch (err) { console.error('POST /api/job-offers/:jobId/remind-later failed:', err); res.status(500).json({ error: 'Failed to set reminder' }); }
});

// Job offer history
router.get('/job-offer-history/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const history = await collections.jobOfferHistory.find({ jobId: String(jobId) }).sort({ createdAt: -1 }).toArray();
    res.json(history);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch job offer history' }); }
});

// all proposals by jobId (client view)
router.get('/job-applications/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const apps = await collections.applications.find({ jobId: String(jobId) }).sort({ createdAt: -1 }).toArray();
    const enrichedApps = await Promise.all(apps.map(async (a) => {
      const isAccepted = (a.status || '').toLowerCase() === 'accepted';
      let workerName = a.workerName || 'Unknown Worker';
      let workerEmail = isAccepted ? (a.workerEmail || 'No email') : '';
      let workerPhone = isAccepted ? (a.workerPhone || 'No phone') : '';
      if (a.workerId) {
        const worker = await collections.users.findOne({ uid: a.workerId }).catch(() => null);
        if (worker) {
          workerName = worker.displayName || [worker.firstName, worker.lastName].filter(Boolean).join(' ') || workerName;
          if (isAccepted) { workerEmail = worker.email || workerEmail; workerPhone = worker.phone || workerPhone; }
        }
      }
      return { ...a, workerName, workerEmail: isAccepted ? workerEmail : '', workerPhone: isAccepted ? workerPhone : '' };
    }));
    res.json(enrichedApps);
  } catch (err) { console.error('GET /api/job-applications/:jobId failed:', err); res.status(500).json({ error: 'Failed to fetch proposals' }); }
});

// All applications for a client
router.get('/client-applications/:clientId', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
    const clientJobs = await collections.browseJobs.find({ clientId }).project({ _id: 1 }).toArray();
    const clientJobIds = clientJobs.map(j => String(j._id));
    if (clientJobIds.length === 0) return res.json([]);
    const pipeline = [
      { $match: { jobId: { $in: clientJobIds } } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $addFields: { jobIdObj: { $convert: { input: '$jobId', to: 'objectId', onError: null, onNull: null } } } },
      { $lookup: { from: 'browseJobs', let: { jIdObj: '$jobIdObj' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } }, { $project: { title: 1, location: 1, budget: 1, category: 1 } }], as: 'bj' } },
      { $lookup: { from: 'jobs', let: { jIdObj: '$jobIdObj' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } }, { $project: { title: 1, location: 1, budget: 1, category: 1 } }], as: 'j' } },
      { $addFields: { jobDoc: { $cond: [{ $gt: [{ $size: '$bj' }, 0] }, { $first: '$bj' }, { $first: '$j' }] } } },
      { $project: { _id: 1, jobId: 1, workerId: 1, clientId: 1, status: 1, proposalText: 1, createdAt: 1, updatedAt: 1, proposedPrice: 1, negotiationStatus: 1, counterPrice: 1, finalPrice: 1, completedByClientAt: 1, completedByWorkerAt: 1, completedAt: 1, currency: 1, title: '$jobDoc.title', location: '$jobDoc.location', budget: '$jobDoc.budget', category: '$jobDoc.category' } }
    ];
    const rows = await collections.applications.aggregate(pipeline).toArray();
    res.json(rows.map(a => ({ ...a, title: a.title ?? 'Untitled Job', location: a.location ?? 'N/A', budget: a.budget ?? null, category: a.category ?? '', createdAt: a.createdAt || a.updatedAt || null, status: (a.status || 'pending').toLowerCase() })));
  } catch (err) { console.error('GET /api/client-applications error:', err); res.status(500).json({ error: 'Failed to load applications' }); }
});

// Worker's own applications
router.get('/my-applications/:uid', async (req, res) => {
  try {
    const workerId = req.params.uid;
    if (!workerId) return res.status(400).json({ error: 'Missing workerId' });
    const pipeline = [
      { $match: { workerId } }, { $sort: { createdAt: -1, _id: -1 } },
      { $addFields: { jobIdObj: { $convert: { input: '$jobId', to: 'objectId', onError: null, onNull: null } } } },
      { $lookup: { from: 'browseJobs', let: { jIdObj: '$jobIdObj' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } }, { $project: { title: 1, location: 1, budget: 1, category: 1 } }], as: 'bj' } },
      { $lookup: { from: 'jobs', let: { jIdObj: '$jobIdObj' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$jIdObj'] } } }, { $project: { title: 1, location: 1, budget: 1, category: 1 } }], as: 'j' } },
      { $addFields: { jobDoc: { $cond: [{ $gt: [{ $size: '$bj' }, 0] }, { $first: '$bj' }, { $first: '$j' }] } } },
      { $project: { _id: 1, jobId: 1, workerId: 1, clientId: 1, status: 1, proposalText: 1, createdAt: 1, updatedAt: 1, proposedPrice: 1, negotiationStatus: 1, counterPrice: 1, finalPrice: 1, completedByClientAt: 1, completedByWorkerAt: 1, completedAt: 1, currency: 1, workerName: 1, workerEmail: 1, workerPhone: 1, title: '$jobDoc.title', location: '$jobDoc.location', budget: '$jobDoc.budget', category: '$jobDoc.category' } }
    ];
    const rows = await collections.applications.aggregate(pipeline).toArray();
    res.json(rows.map(a => ({ ...a, title: a.title ?? 'Untitled Job', location: a.location ?? 'N/A', budget: a.budget ?? null, category: a.category ?? '', createdAt: a.createdAt || a.updatedAt || null, status: (a.status || 'pending').toLowerCase(), workerName: a.workerName || 'Unknown Worker', workerEmail: a.workerEmail || 'No email', workerPhone: a.workerPhone || 'No phone' })));
  } catch (err) { console.error('GET /api/my-applications error:', err); res.status(500).json({ error: 'Failed to load applications' }); }
});

// Conversation jobs
router.get('/conversations/:conversationId/jobs', async (req, res) => {
  try {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

    const cached = getCachedConversationJobs(conversationId);
    if (cached) return res.json(cached);

    const jobs = await collections.browseJobs.find({ conversationId }).toArray();
    const workerRequestsRaw = await collections.workerJobRequests.find({ conversationId }).toArray();
    const workerRequests = workerRequestsRaw.map((request) => ({ ...request, type: 'workerRequest' }));
    const payload = { jobs, workerRequests, all: [...jobs, ...workerRequests] };

    setCachedConversationJobs(conversationId, payload);
    res.json(payload);
  } catch (err) {
    console.error('GET /api/conversations/:conversationId/jobs failed:', err);
    res.status(500).json({ error: 'Failed to fetch conversation jobs' });
  }
});

// Worker job requests
router.get('/worker-job-requests', async (req, res) => {
  try {
    const { conversationId, workerId, clientId, status } = req.query;
    const q = {};
    if (conversationId) q.conversationId = String(conversationId);
    if (workerId) q.workerId = String(workerId);
    if (clientId) q.clientId = String(clientId);
    if (status) q.status = String(status);
    const list = await collections.workerJobRequests.find(q).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch' }); }
});
router.post('/worker-job-requests', async (req, res) => {
  try {
    const b = req.body || {};
    const doc = {
      workerId: String(b.workerId || ''),
      clientId: String(b.clientId || ''),
      conversationId: String(b.conversationId || ''),
      jobId: String(b.jobId || ''),
      title: String(b.title || '').trim(),
      description: String(b.description || '').trim(),
      category: String(b.category || '').trim(),
      proposedPrice: b.proposedPrice != null && b.proposedPrice !== '' ? parseFloat(b.proposedPrice) : null,
      currency: String(b.currency || 'BDT').trim() || 'BDT',
      location: String(b.location || '').trim(),
      message: String(b.message || '').trim(),
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!doc.workerId || !doc.clientId || !doc.conversationId || !doc.title || !doc.description || !doc.category) {
      return res.status(400).json({ error: 'workerId, clientId, conversationId, title, description, and category are required' });
    }
    const result = await collections.workerJobRequests.insertOne(doc);
    invalidateConversationJobsCache(doc.conversationId);
    res.status(201).json({ success: true, requestId: result.insertedId, request: { _id: result.insertedId, ...doc } });
  } catch (err) { res.status(500).json({ error: 'Failed to create' }); }
});
router.patch('/worker-job-requests/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || '').toLowerCase().trim();
    const allowedStatuses = new Set(['pending', 'accepted', 'rejected', 'expired']);

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid request ID' });
    if (!allowedStatuses.has(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${Array.from(allowedStatuses).join(', ')}` });

    const _id = new ObjectId(id);
    await collections.workerJobRequests.updateOne({ _id }, { $set: { status, updatedAt: new Date() } });
    const updatedRequest = await collections.workerJobRequests.findOne({ _id });
    if (!updatedRequest) return res.status(404).json({ error: 'Worker job request not found' });

    invalidateConversationJobsCache(updatedRequest.conversationId);
    res.json(updatedRequest);
  } catch (err) {
    console.error('PATCH /api/worker-job-requests/:id/status failed:', err);
    res.status(500).json({ error: 'Failed to update worker job request status' });
  }
});

// Services
router.get('/services', async (_req, res) => {
  try { res.json(await collections.services.find({ isActive: true }).sort({ order: 1 }).toArray()); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch services' }); }
});

// Reviews
router.post('/reviews', async (req, res) => {
  try {
    const {
      jobId,
      applicationId,
      workerId,
      clientId,
      reviewerId: reviewerIdIn,
      reviewerRole: reviewerRoleIn,
      revieweeId: revieweeIdIn,
      revieweeRole: revieweeRoleIn,
      ratings,
      overallRating,
      reviewText,
    } = req.body || {};

    const reviewerRole = String(reviewerRoleIn || 'client').toLowerCase();
    const reviewerId = String(reviewerIdIn || (reviewerRole === 'worker' ? workerId : clientId) || '').trim();
    const revieweeRole = String(revieweeRoleIn || (reviewerRole === 'worker' ? 'client' : 'worker')).toLowerCase();
    const revieweeId = String(revieweeIdIn || (revieweeRole === 'worker' ? workerId : clientId) || '').trim();

    if (!jobId || !applicationId || !workerId || !clientId) return res.status(400).json({ error: 'Missing required fields: jobId, applicationId, workerId, clientId' });
    if (!['client', 'worker'].includes(reviewerRole)) return res.status(400).json({ error: 'reviewerRole must be client or worker' });
    if (!['client', 'worker'].includes(revieweeRole)) return res.status(400).json({ error: 'revieweeRole must be client or worker' });
    if (!reviewerId || !revieweeId) return res.status(400).json({ error: 'reviewerId and revieweeId are required' });
    if (!ratings || typeof ratings !== 'object') return res.status(400).json({ error: 'Ratings object is required' });

    const validCategories = ['qualityOfWork', 'punctuality', 'communication', 'professionalism', 'valueForMoney', 'cleanliness'];
    for (const category of validCategories) {
      if (ratings[category] !== undefined) {
        const rating = Number(ratings[category]);
        if (rating > 0 && (Number.isNaN(rating) || rating > 5)) {
          return res.status(400).json({ error: `Rating for ${category} must be between 1 and 5` });
        }
      }
    }

    let calculatedOverallRating = overallRating;
    if (!calculatedOverallRating) {
      const ratingValues = Object.values(ratings).filter((value) => typeof value === 'number' && value >= 1 && value <= 5);
      if (ratingValues.length === 0) return res.status(400).json({ error: 'At least one category rating is required' });
      calculatedOverallRating = Math.round((ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length) * 10) / 10;
    }

    const existingReview = await collections.reviews.findOne({
      $or: [
        { applicationId: String(applicationId), reviewerId: String(reviewerId) },
        {
          applicationId: String(applicationId),
          reviewerId: { $exists: false },
          ...(reviewerRole === 'client' ? { clientId: String(reviewerId) } : { workerId: String(reviewerId) }),
        },
      ],
    });
    if (existingReview) return res.status(409).json({ error: 'You already reviewed this application' });

    const application = ObjectId.isValid(applicationId)
      ? await collections.applications.findOne({ _id: new ObjectId(applicationId) })
      : await collections.applications.findOne({ _id: applicationId });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    if (String(application.status || '').toLowerCase() !== 'completed') return res.status(400).json({ error: 'Can only review completed applications' });

    const job = ObjectId.isValid(jobId)
      ? await collections.browseJobs.findOne({ _id: new ObjectId(jobId) })
      : await collections.browseJobs.findOne({ _id: jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const normalizedClientId = String(clientId);
    const normalizedWorkerId = String(workerId);
    const normalizedReviewerId = String(reviewerId);
    const normalizedRevieweeId = String(revieweeId);

    if (reviewerRole === 'client') {
      if (String(job.clientId) !== normalizedReviewerId) return res.status(403).json({ error: 'You can only review workers for your own jobs' });
      if (normalizedRevieweeId !== normalizedWorkerId) return res.status(400).json({ error: 'Client review target must be the application worker' });
    } else {
      if (String(application.workerId || '') !== normalizedReviewerId) return res.status(403).json({ error: 'You can only review jobs you worked on' });
      if (normalizedRevieweeId !== normalizedClientId) return res.status(400).json({ error: 'Worker review target must be the job client' });
    }

    if (normalizedClientId !== String(job.clientId || normalizedClientId)) return res.status(400).json({ error: 'clientId does not match the job owner' });
    if (String(application.workerId || '') !== normalizedWorkerId) return res.status(400).json({ error: 'workerId does not match the application worker' });

    const review = {
      jobId: String(jobId),
      applicationId: String(applicationId),
      workerId: normalizedWorkerId,
      clientId: normalizedClientId,
      reviewerId: normalizedReviewerId,
      reviewerRole,
      revieweeId: normalizedRevieweeId,
      revieweeRole,
      ratings: {
        qualityOfWork: Number(ratings.qualityOfWork) || 0,
        punctuality: Number(ratings.punctuality) || 0,
        communication: Number(ratings.communication) || 0,
        professionalism: Number(ratings.professionalism) || 0,
        valueForMoney: Number(ratings.valueForMoney) || 0,
        cleanliness: Number(ratings.cleanliness) || 0,
      },
      overallRating: calculatedOverallRating,
      reviewText: String(reviewText || '').trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collections.reviews.insertOne(review);
    res.status(201).json({ success: true, review: { _id: result.insertedId, ...review } });
  } catch (err) {
    console.error('POST /api/reviews failed:', err);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

router.get('/reviews/worker/:workerId', async (req, res) => {
  try {
    const workerId = String(req.params.workerId || '').trim();
    const limit = Math.min(parseInt(req.query?.limit, 10) || 10, 100);
    const skip = Math.max(parseInt(req.query?.skip, 10) || 0, 0);

    const reviews = await collections.reviews
      .find({
        $or: [
          { revieweeId: workerId, revieweeRole: 'worker' },
          { workerId, revieweeRole: { $exists: false } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .toArray();

    const reviewsWithClientNames = await Promise.all(
      reviews.map(async (review) => {
        const client = await collections.users.findOne({ uid: review.clientId });
        return {
          ...review,
          clientName: client?.displayName || [client?.firstName, client?.lastName].filter(Boolean).join(' ') || 'Anonymous',
          clientAvatar: client?.profileCover || null,
        };
      })
    );

    res.json(reviewsWithClientNames);
  } catch (err) {
    console.error('GET /api/reviews/worker/:workerId failed:', err);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

router.get('/reviews/application/:applicationId', async (req, res) => {
  try {
    const applicationId = String(req.params.applicationId || '').trim();
    const reviewerId = String(req.query?.reviewerId || '').trim();
    const query = { applicationId };
    if (reviewerId) query.reviewerId = reviewerId;
    const review = await collections.reviews.findOne(query);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  } catch (err) {
    console.error('GET /api/reviews/application/:applicationId failed:', err);
    res.status(500).json({ error: 'Failed to fetch review' });
  }
});

// Reviews (GET public)
router.get('/reviews/:workerId', async (req, res) => {
  try {
    const uid = String(req.params.workerId);
    const reviews = await collections.reviews.find({
      $or: [{ revieweeId: uid, revieweeRole: 'worker' }, { workerId: uid, revieweeRole: { $exists: false } }],
    }).sort({ createdAt: -1 }).toArray();
    res.json(reviews);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch reviews' }); }
});

// Health
router.get('/health', (_req, res) => res.json({ ok: true }));

module.exports = router;
