const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { authenticateAdmin, logAdminAction } = require('../../middleware/auth');
const { collections } = require('../../config/db');

const router = Router();

    router.get('/', authenticateAdmin, async (req, res) => {
      try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;
        const status = req.query.status;
        const q = {};
        if (status) q.status = String(status).toLowerCase();
        const [list, total] = await Promise.all([
          collections.applications.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          collections.applications.countDocuments(q),
        ]);
        
        const workerIds = Array.from(new Set(list.map((x) => String(x.workerId || '')).filter(Boolean)));
        const clientIds = Array.from(new Set(list.map((x) => String(x.clientId || '')).filter(Boolean)));
        const jobIdStrings = Array.from(new Set(list.map((x) => String(x.jobId || '')).filter(Boolean)));
        const jobObjectIds = jobIdStrings.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

        const WORKER_PROJECTION = {
          uid: 1, displayName: 1, firstName: 1, lastName: 1, email: 1,
          phone: 1, profileCover: 1, headline: 1, bio: 1,
          isVerified: 1, isSuspended: 1, city: 1, country: 1,
          role: 1, workerAccountStatus: 1,
          servicesOffered: 1, experienceYears: 1, workExperience: 1,
          createdAt: 1,
        };
        const CLIENT_PROJECTION = {
          uid: 1, displayName: 1, firstName: 1, lastName: 1, email: 1,
          phone: 1, profileCover: 1, city: 1, country: 1,
          isVerified: 1, isSuspended: 1, role: 1, createdAt: 1,
        };

        const [workers, clients, browseJobs, jobs] = await Promise.all([
          workerIds.length
            ? collections.users
                .find({ uid: { $in: workerIds } })
                .project(WORKER_PROJECTION)
                .toArray()
            : [],
          clientIds.length
            ? collections.users
                .find({ uid: { $in: clientIds } })
                .project(CLIENT_PROJECTION)
                .toArray()
            : [],
          jobObjectIds.length
            ? collections.browseJobs.find({ _id: { $in: jobObjectIds } }).project({ 
                title: 1, 
                description: 1,
                budget: 1, 
                location: 1, 
                floorHouseNo: 1, 
                landmark: 1,
                locationGeo: 1,
                categoryId: 1,
                serviceName: 1,
                scheduledDate: 1,
              }).toArray()
            : [],
          jobObjectIds.length
            ? collections.jobs.find({ _id: { $in: jobObjectIds } }).project({ 
                title: 1, 
                totalPrice: 1, 
                address: 1,
                locationGeo: 1,
                description: 1,
              }).toArray()
            : [],
        ]);

        const toName = (u) => {
          if (!u) return null;
          const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
          return (u.displayName || full || u.email || u.uid || '').trim();
        };

        const workerByUid = new Map(workers.map((u) => [String(u.uid), u]));
        const clientByUid = new Map(clients.map((u) => [String(u.uid), u]));
        const jobDataById = new Map();
        browseJobs.forEach((j) => jobDataById.set(String(j._id), j));
        jobs.forEach((j) => jobDataById.set(String(j._id), j));

        const enriched = list.map((app) => {
          const workerId = String(app.workerId || '');
          const clientId = String(app.clientId || '');
          const jobId = String(app.jobId || '');
          const workerDoc = workerByUid.get(workerId) || null;
          const clientDoc = clientByUid.get(clientId) || null;
          const jobDoc = jobDataById.get(jobId) || null;
          return {
            ...app,
            workerName: toName(workerDoc) || app.workerName || workerId || '',
            clientName: toName(clientDoc) || app.clientName || clientId || '',
            jobTitle: (jobDoc?.title) || app.jobTitle || app.jobName || '',
            workerProfile: workerDoc ? {
              uid: workerDoc.uid,
              name: toName(workerDoc),
              email: workerDoc.email || '',
              phone: workerDoc.phone || '',
              profileCover: workerDoc.profileCover || '',
              headline: workerDoc.headline || '',
              city: workerDoc.city || '',
              country: workerDoc.country || '',
              isVerified: !!workerDoc.isVerified,
              isSuspended: !!workerDoc.isSuspended,
              workerAccountStatus: workerDoc.workerAccountStatus || '',
              servicesOffered: workerDoc.servicesOffered || null,
              experienceYears: workerDoc.experienceYears || workerDoc.workExperience || 0,
              createdAt: workerDoc.createdAt || null,
            } : null,
            clientProfile: clientDoc ? {
              uid: clientDoc.uid,
              name: toName(clientDoc),
              email: clientDoc.email || '',
              phone: clientDoc.phone || '',
              profileCover: clientDoc.profileCover || '',
              city: clientDoc.city || '',
              country: clientDoc.country || '',
              isVerified: !!clientDoc.isVerified,
              isSuspended: !!clientDoc.isSuspended,
              createdAt: clientDoc.createdAt || null,
            } : null,
            jobDetails: jobDoc ? {
              title: jobDoc.title || '',
              description: jobDoc.description || '',
              budget: jobDoc.budget || jobDoc.totalPrice || null,
              location: jobDoc.location || jobDoc.address || '',
              floorHouseNo: jobDoc.floorHouseNo || '',
              landmark: jobDoc.landmark || '',
              locationGeo: jobDoc.locationGeo || null,
              serviceName: jobDoc.serviceName || '',
              scheduledDate: jobDoc.scheduledDate || null,
            } : null,
          };
        });

        res.json({ list: enriched, total, page, limit });
      } catch (err) {
        console.error('GET /api/admin/bookings failed:', err);
        res.status(500).json({ error: 'Failed to fetch bookings' });
      }
    });
    router.get('/:id', authenticateAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid booking id' });
        const booking = await collections.applications.findOne({ _id: new ObjectId(id) });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        const workerId = String(booking.workerId || '');
        const clientId = String(booking.clientId || '');
        const jobId = String(booking.jobId || '');
        const jobObjectId = ObjectId.isValid(jobId) ? new ObjectId(jobId) : null;

        const WORKER_PROJECTION = {
          uid: 1, displayName: 1, firstName: 1, lastName: 1, email: 1,
          phone: 1, profileCover: 1, headline: 1, bio: 1,
          isVerified: 1, isSuspended: 1, city: 1, country: 1,
          role: 1, workerAccountStatus: 1,
          servicesOffered: 1, experienceYears: 1, workExperience: 1,
          certifications: 1, skills: 1, createdAt: 1,
        };
        const CLIENT_PROJECTION = {
          uid: 1, displayName: 1, firstName: 1, lastName: 1, email: 1,
          phone: 1, profileCover: 1, city: 1, country: 1,
          isVerified: 1, isSuspended: 1, role: 1, createdAt: 1, bio: 1,
        };

        const [workerDoc, clientDoc, browseJob, legacyJob] = await Promise.all([
          workerId ? collections.users.findOne({ uid: workerId }, { projection: WORKER_PROJECTION }) : null,
          clientId ? collections.users.findOne({ uid: clientId }, { projection: CLIENT_PROJECTION }) : null,
          jobObjectId ? collections.browseJobs.findOne({ _id: jobObjectId }) : null,
          jobObjectId ? collections.jobs.findOne({ _id: jobObjectId }) : null,
        ]);

        const jobDoc = browseJob || legacyJob;

        const toName = (u) => {
          if (!u) return null;
          const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
          return (u.displayName || full || u.email || u.uid || '').trim();
        };

        res.json({
          ...booking,
          workerName: toName(workerDoc) || booking.workerName || workerId || '',
          clientName: toName(clientDoc) || booking.clientName || clientId || '',
          jobTitle: jobDoc?.title || booking.jobTitle || booking.jobName || '',
          workerProfile: workerDoc ? {
            uid: workerDoc.uid,
            name: toName(workerDoc),
            email: workerDoc.email || '',
            phone: workerDoc.phone || '',
            profileCover: workerDoc.profileCover || '',
            headline: workerDoc.headline || '',
            bio: workerDoc.bio || '',
            city: workerDoc.city || '',
            country: workerDoc.country || '',
            isVerified: !!workerDoc.isVerified,
            isSuspended: !!workerDoc.isSuspended,
            workerAccountStatus: workerDoc.workerAccountStatus || '',
            servicesOffered: workerDoc.servicesOffered || null,
            experienceYears: workerDoc.experienceYears || workerDoc.workExperience || 0,
            certifications: workerDoc.certifications || [],
            skills: workerDoc.skills || [],
            createdAt: workerDoc.createdAt || null,
          } : null,
          clientProfile: clientDoc ? {
            uid: clientDoc.uid,
            name: toName(clientDoc),
            email: clientDoc.email || '',
            phone: clientDoc.phone || '',
            profileCover: clientDoc.profileCover || '',
            bio: clientDoc.bio || '',
            city: clientDoc.city || '',
            country: clientDoc.country || '',
            isVerified: !!clientDoc.isVerified,
            isSuspended: !!clientDoc.isSuspended,
            createdAt: clientDoc.createdAt || null,
          } : null,
          jobDetails: jobDoc ? {
            title: jobDoc.title || '',
            description: jobDoc.description || '',
            budget: jobDoc.budget || jobDoc.totalPrice || null,
            location: jobDoc.location || jobDoc.address || '',
            floorHouseNo: jobDoc.floorHouseNo || '',
            landmark: jobDoc.landmark || '',
            locationGeo: jobDoc.locationGeo || null,
            serviceName: jobDoc.serviceName || '',
            scheduledDate: jobDoc.scheduledDate || null,
            categoryId: jobDoc.categoryId || null,
          } : null,
        });
      } catch (err) {
        console.error('GET /api/admin/bookings/:id failed:', err);
        res.status(500).json({ error: 'Failed to fetch booking detail' });
      }
    });
    router.patch('/:id/status', authenticateAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body || {};
        const statusIn = String(status || '').toLowerCase().trim();
        const allowed = new Set(['pending', 'accepted', 'rejected', 'completed']);
        if (!ObjectId.isValid(id) || !allowed.has(statusIn)) {
          return res.status(400).json({ error: 'Invalid id or status' });
        }
        const result = await collections.applications.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: statusIn, updatedAt: new Date() } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: 'Booking not found' });
        await logAdminAction(req, 'booking_status', 'bookings', { applicationId: id, status: statusIn });
        res.json({ ok: true, status: statusIn });
      } catch (err) {
        console.error('PATCH /api/admin/bookings/:id/status failed:', err);
        res.status(500).json({ error: 'Update failed' });
      }
    });

module.exports = router;
