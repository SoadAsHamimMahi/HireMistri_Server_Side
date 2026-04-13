// routes/applications.js — /api/applications/*, /api/job-applications/*, /api/client-applications/*, /api/my-applications/*
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');
const { getWorkerIdentity } = require('../utils/helpers');
const { findOrCreateConversationId, sendSystemMessage } = require('../utils/messaging');
const { createNotification } = require('../utils/notifications');
const { sendApplicationReceivedEmail, sendApplicationStatusEmail } = require('../utils/emailService');
const { processJobSettlement } = require('./payments');

const router = Router();

// Middleware-like check for approved workers
async function requireApprovedWorker(req, res, next) {
  try {
    const workerId = req.body?.workerId || req.params?.uid;
    if (!workerId) return next();
    const userDoc = await collections.users.findOne({ uid: String(workerId) });
    if (userDoc && userDoc.role === 'worker' && userDoc.workerAccountStatus !== 'approved') {
      return res.status(403).json({ code: 'WORKER_NOT_APPROVED', status: userDoc.workerAccountStatus || 'draft', error: 'Your account is pending review. You cannot perform this action until approved by admin.' });
    }
    next();
  } catch (e) {
    console.warn('requireApprovedWorker check failed (non-blocking):', e.message);
    next();
  }
}

// Create/update application (one per worker per job)
router.post('/', requireApprovedWorker, async (req, res) => {
  try {
    const b = req.body || {};
    const str = (v) => (v == null ? '' : String(v));
    const s = (v) => str(v).trim();
    const mail = (v) => s(v).toLowerCase();

    const jobId = s(b.jobId);
    const workerId = s(b.workerId);
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });

    let workerEmailIn = mail(b.workerEmail || b.postedByEmail);
    let workerNameIn = s(b.workerName);
    let workerPhoneIn = s(b.workerPhone);
    let clientIdIn = s(b.clientId);
    let clientEmailIn = mail(b.clientEmail);

    const existing = await collections.applications.findOne({ jobId, workerId });
    const isNew = !existing;

    if (!isNew && existing) {
      const currentStatus = (existing.status || 'pending').toLowerCase();
      const isPriceUpdateOnly = [b.finalPrice, b.counterPrice, b.negotiationStatus].some(v => v !== undefined && v !== null) && !b.status && !b.proposalText && !('text' in b) && !('proposalText' in b);
      const allowed = currentStatus === 'pending' || (currentStatus === 'accepted' && isPriceUpdateOnly);
      if (!allowed) return res.status(400).json({ error: 'Cannot edit application. Only pending applications can be edited, or you can update price negotiation on an accepted application.' });
      if (existing.workerId !== workerId) return res.status(403).json({ error: 'You do not have permission to edit this application' });
    }

    if (ObjectId.isValid(jobId) && (!clientIdIn || !clientEmailIn)) {
      const _id = new ObjectId(jobId);
      const jobDoc = (await collections.browseJobs.findOne({ _id })) || (await collections.jobs.findOne({ _id }));
      if (jobDoc) {
        if (!clientIdIn) clientIdIn = s(jobDoc.clientId || jobDoc.postedByUid);
        if (!clientEmailIn) clientEmailIn = mail(jobDoc.postedByEmail || jobDoc.email);
      }
    }

    const needsWorkerBackfill = (!workerEmailIn || !workerNameIn || !workerPhoneIn) && (!existing || !existing.workerEmail || !existing.workerName || !existing.workerPhone);
    if (needsWorkerBackfill) {
      const backfill = await getWorkerIdentity(workerId);
      workerEmailIn = workerEmailIn || backfill.email;
      workerNameIn = workerNameIn || backfill.name;
      workerPhoneIn = workerPhoneIn || backfill.phone;
    }

    const now = new Date();
    const $set = { updatedAt: now };
    const $setOnInsert = { jobId, workerId, createdAt: now, status: 'pending' };
    const setIf = (k, v) => { if (v || v === 0 || v === false) (isNew ? $setOnInsert : $set)[k] = v; };

    if ('status' in b) (isNew ? $setOnInsert : $set).status = s(b.status);
    if ('proposalText' in b || 'text' in b) (isNew ? $setOnInsert : $set).proposalText = s(b.proposalText || b.text);

    if ('proposedPrice' in b) {
      const price = parseFloat(b.proposedPrice);
      if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'proposedPrice must be a positive number' });
      setIf('proposedPrice', price);
      if (!existing?.negotiationStatus || existing.negotiationStatus === 'none') setIf('negotiationStatus', 'pending');
    }
    if ('counterPrice' in b) { const price = parseFloat(b.counterPrice); if (!isNaN(price) && price > 0) { setIf('counterPrice', price); setIf('negotiationStatus', 'countered'); } }
    if ('finalPrice' in b) { const price = parseFloat(b.finalPrice); if (!isNaN(price) && price > 0) { setIf('finalPrice', price); setIf('negotiationStatus', 'accepted'); } }
    if ('negotiationStatus' in b) { const status = s(b.negotiationStatus); if (['none', 'pending', 'countered', 'accepted', 'cancelled'].includes(status)) setIf('negotiationStatus', status); }

    if (!isNew && existing) {
      const nextNeg = $set.negotiationStatus ?? existing.negotiationStatus;
      const prevNeg = String(existing.negotiationStatus || '').toLowerCase();
      const finalValid = $set.finalPrice != null && Number($set.finalPrice) > 0;
      if (String(nextNeg || '').toLowerCase() === 'accepted' && !finalValid && prevNeg === 'countered' && Number.isFinite(Number(existing.counterPrice)) && Number(existing.counterPrice) > 0) {
        $set.finalPrice = Number(existing.counterPrice);
      }
    }

    const requestedStatus = s(b.status) || 'pending';
    if (isNew && requestedStatus === 'pending') {
      const proposalTextIn = s(b.proposalText || b.text);
      const proposedPriceIn = parseFloat(b.proposedPrice);
      if (!proposalTextIn) return res.status(400).json({ error: 'proposalText is required for application' });
      if (isNaN(proposedPriceIn) || proposedPriceIn <= 0) return res.status(400).json({ error: 'proposedPrice is required for application' });
    }

    setIf('clientId', clientIdIn);
    setIf('clientEmail', clientEmailIn);
    if (workerEmailIn) { setIf('workerEmail', workerEmailIn); setIf('postedByEmail', workerEmailIn); }
    setIf('workerName', workerNameIn);
    setIf('workerPhone', workerPhoneIn);

    const result = await collections.applications.updateOne({ jobId, workerId }, { $set, $setOnInsert }, { upsert: true });
    const doc = await collections.applications.findOne({ jobId, workerId });

    if (result.upsertedId && doc) {
      try {
        let jobTitle = 'Your Job';
        let clientEmail = doc.clientEmail;
        let clientName = 'Client';
        let jobDoc = null;
        if (ObjectId.isValid(jobId)) {
          jobDoc = await collections.browseJobs.findOne({ _id: new ObjectId(jobId) });
          if (jobDoc) {
            jobTitle = jobDoc.title || jobTitle;
            clientEmail = clientEmail || jobDoc.postedByEmail || jobDoc.email;
            if (doc.clientId) {
              const clientUser = await collections.users.findOne({ uid: doc.clientId });
              if (clientUser) { clientName = clientUser.displayName || [clientUser.firstName, clientUser.lastName].filter(Boolean).join(' ') || clientName; clientEmail = clientEmail || clientUser.email; }
            }
          }
        }
        const workerName = doc.workerName || 'A worker';
        if (clientEmail) sendApplicationReceivedEmail(clientEmail, clientName, jobTitle, workerName).catch(() => {});
      } catch (e) { /* non-fatal */ }
    }

    return res.status(result.upsertedId ? 201 : 200).json({ ok: true, application: doc });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: 'You already applied to this job.' });
    console.error('POST /api/applications failed:', err);
    return res.status(500).json({ error: err?.message || 'Failed to submit proposal' });
  }
});

// Get by MongoDB _id
router.get('/by-id/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application ID' });
    const application = await collections.applications.findOne({ _id: new ObjectId(id) });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    let workerInfo = null;
    if (application.workerId) {
      const worker = await collections.users.findOne({ uid: application.workerId }).catch(() => null);
      if (worker) workerInfo = { name: worker.displayName || [worker.firstName, worker.lastName].filter(Boolean).join(' ') || 'Unknown', profileCover: worker.profileCover || null, specialty: worker.specialty || worker.headline || null, averageRating: worker.stats?.averageRating || null };
    }
    let jobInfo = null;
    if (application.jobId && ObjectId.isValid(application.jobId)) {
      const job = await collections.browseJobs.findOne({ _id: new ObjectId(application.jobId) }).catch(() => null);
      if (job) jobInfo = { title: job.title || 'Untitled Job', description: job.description || '', budget: job.budget || null, category: job.category || null, location: job.location || null, deadline: job.deadline || null, status: job.status || 'active' };
    }
    res.json({ ...application, workerInfo, jobInfo });
  } catch (err) {
    console.error('GET /api/applications/by-id/:id failed:', err);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// Get by jobId + workerId
router.get('/:jobId/:workerId', async (req, res) => {
  try {
    const { jobId, workerId } = req.params;
    const application = await collections.applications.findOne({ jobId: String(jobId), workerId: String(workerId) });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    res.json(application);
  } catch (err) {
    console.error('GET /api/applications/:jobId/:workerId failed:', err);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// Update status (PATCH /:id/status)
async function handleStatusUpdate(req, res) {
  try {
    const { id } = req.params;
    const statusIn = String(req.body?.status || '').toLowerCase().trim();
    const actorRole = String(req.body?.actorRole || '').toLowerCase().trim();
    const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
    if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });

    const _id = new ObjectId(id);
    const oldDoc = await collections.applications.findOne({ _id });
    if (!oldDoc) return res.status(404).json({ error: 'Application not found' });

    if (statusIn === 'accepted') {
      const hasProposedPrice = oldDoc.proposedPrice != null;
      const hasFinalPrice = oldDoc.finalPrice != null && Number(oldDoc.finalPrice) > 0;
      const negotiationAccepted = String(oldDoc.negotiationStatus || '').toLowerCase() === 'accepted';
      if (hasProposedPrice && !hasFinalPrice && !negotiationAccepted) {
        return res.status(400).json({ error: 'Finalize price negotiation before accepting this application' });
      }
    }

    const oldStatus = (oldDoc.status || 'pending').toLowerCase();
    const now = new Date();
    const updateFields = { updatedAt: now };
    let resolvedStatus = statusIn;

    if (statusIn === 'completed') {
      if (!['accepted', 'completed'].includes(oldStatus)) return res.status(400).json({ error: 'Only accepted applications can be marked complete' });
      if (!['client', 'worker'].includes(actorRole)) return res.status(400).json({ error: 'actorRole must be either client or worker for completion' });
      if (actorRole === 'client' && !oldDoc.completedByClientAt) updateFields.completedByClientAt = now;
      if (actorRole === 'worker' && !oldDoc.completedByWorkerAt) updateFields.completedByWorkerAt = now;
      const clientCompleted = !!(oldDoc.completedByClientAt || updateFields.completedByClientAt);
      const workerCompleted = !!(oldDoc.completedByWorkerAt || updateFields.completedByWorkerAt);
      resolvedStatus = clientCompleted && workerCompleted ? 'completed' : 'accepted';
      updateFields.status = resolvedStatus;
      if (resolvedStatus === 'completed') {
        updateFields.completedAt = now;
        if (oldStatus !== 'completed') updateFields.settlementStatus = 'PENDING';
      }
    } else {
      updateFields.status = statusIn;
    }

    const upd = await collections.applications.updateOne({ _id }, { $set: updateFields });
    if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });
    if (resolvedStatus === 'completed' && updateFields.settlementStatus === 'PENDING') await processJobSettlement(id);

    const doc = await collections.applications.findOne({ _id });
    const statusChanged = oldStatus !== resolvedStatus;

    // Notifications: accepted / rejected
    if (statusChanged && (resolvedStatus === 'accepted' || resolvedStatus === 'rejected')) {
      try {
        let jobTitle = 'the job';
        if (ObjectId.isValid(doc.jobId)) { const jd = await collections.browseJobs.findOne({ _id: new ObjectId(doc.jobId) }); if (jd) jobTitle = jd.title || jobTitle; }
        let workerEmail = doc.workerEmail;
        let workerName = doc.workerName || 'Worker';
        if (doc.workerId) { const wu = await collections.users.findOne({ uid: doc.workerId }); if (wu) { workerName = wu.displayName || [wu.firstName, wu.lastName].filter(Boolean).join(' ') || workerName; workerEmail = workerEmail || wu.email; } }
        if (doc.workerId) {
          await createNotification(doc.workerId, `Application ${resolvedStatus === 'accepted' ? 'Accepted' : 'Rejected'}`, `Your application for "${jobTitle}" has been ${resolvedStatus}.`, resolvedStatus === 'accepted' ? 'success' : 'info', doc.jobId, `/jobs/${doc.jobId}`);
        }
        if (workerEmail) sendApplicationStatusEmail(workerEmail, workerName, jobTitle, resolvedStatus).catch(() => {});
        if (doc.jobId && doc.clientId && doc.workerId) {
          const conversationId = await findOrCreateConversationId(doc.jobId, doc.clientId, doc.workerId);
          const reason = req.body.reason || req.body.message || null;
          const msg = resolvedStatus === 'accepted'
            ? `✅ Congratulations! Your application has been accepted!\n\n📋 Job: ${jobTitle}\n\n🎉 You can now start working on this job.`
            : `❌ Application rejected: ${jobTitle}${reason ? `\n\nReason: ${reason}` : ''}`;
          await sendSystemMessage(conversationId, doc.clientId, doc.workerId, doc.jobId, msg);
        }
      } catch (e) { /* non-fatal */ }
    }

    // Notifications: completed
    if (statusChanged && resolvedStatus === 'completed' && doc.jobId && doc.clientId && doc.workerId) {
      try {
        let jobTitle = 'the job';
        if (ObjectId.isValid(doc.jobId)) { const jd = await collections.browseJobs.findOne({ _id: new ObjectId(doc.jobId) }); if (jd) jobTitle = jd.title || jobTitle; }
        const conversationId = await findOrCreateConversationId(doc.jobId, doc.clientId, doc.workerId);
        const msgText = `🎉 Job completed: ${jobTitle}`;
        await sendSystemMessage(conversationId, doc.clientId, doc.workerId, doc.jobId, msgText);
        await sendSystemMessage(conversationId, doc.workerId, doc.clientId, doc.jobId, msgText);
      } catch (e) { /* non-fatal */ }
    }

    res.json(doc);
  } catch (err) {
    console.error('handleStatusUpdate failed:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
}

router.patch('/:id/status', handleStatusUpdate);
router.patch('/:id', handleStatusUpdate);
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const statusIn = String(req.body?.status || '').toLowerCase().trim();
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
    if (!['pending', 'accepted', 'rejected', 'completed'].includes(statusIn)) return res.status(400).json({ error: 'Invalid status' });
    const _id = new ObjectId(id);
    const upd = await collections.applications.updateOne({ _id }, { $set: { status: statusIn, updatedAt: new Date() } });
    if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });
    res.json(await collections.applications.findOne({ _id }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Legacy update-status endpoint
router.post('/update-status', async (req, res) => {
  try {
    const { applicationId, status: statusIn } = req.body;
    const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);
    if (!ObjectId.isValid(applicationId)) return res.status(400).json({ error: 'Invalid application id' });
    if (!allowed.has(statusIn)) return res.status(400).json({ error: 'Invalid status' });
    const _id = new ObjectId(applicationId);
    const upd = await collections.applications.updateOne({ _id }, { $set: { status: statusIn, updatedAt: new Date() } });
    if (!upd.matchedCount) return res.status(404).json({ error: 'Application not found' });
    res.json(await collections.applications.findOne({ _id }));
  } catch (err) {
    console.error('POST /api/applications/update-status failed:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Notes CRUD
router.post('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName, note } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
    if (!userId || !note?.trim()) return res.status(400).json({ error: 'userId and note are required' });
    const _id = new ObjectId(id);
    const application = await collections.applications.findOne({ _id });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    if (application.clientId !== userId && application.workerId !== userId) return res.status(403).json({ error: 'Permission denied' });
    const newNote = { _id: new ObjectId(), userId, userName: userName || 'User', note: String(note).trim(), createdAt: new Date() };
    await collections.applications.updateOne({ _id }, { $set: { notes: [...(application.notes || []), newNote], updatedAt: new Date() } });
    res.status(201).json({ message: 'Note added successfully', note: newNote });
  } catch (err) { res.status(500).json({ error: 'Failed to add note' }); }
});
router.get('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid application id' });
    const application = await collections.applications.findOne({ _id: new ObjectId(id) });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    res.json({ notes: application.notes || [] });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch notes' }); }
});
router.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const { id, noteId } = req.params;
    const { userId } = req.body;
    if (!ObjectId.isValid(id) || !ObjectId.isValid(noteId)) return res.status(400).json({ error: 'Invalid id' });
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const _id = new ObjectId(id);
    const application = await collections.applications.findOne({ _id });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    const notes = application.notes || [];
    const noteIndex = notes.findIndex(n => String(n._id) === noteId);
    if (noteIndex === -1) return res.status(404).json({ error: 'Note not found' });
    if (notes[noteIndex].userId !== userId) return res.status(403).json({ error: 'Permission denied' });
    notes.splice(noteIndex, 1);
    await collections.applications.updateOne({ _id }, { $set: { notes, updatedAt: new Date() } });
    res.json({ message: 'Note deleted successfully' });
  } catch (err) { res.status(500).json({ error: 'Failed to delete note' }); }
});

module.exports = router;
