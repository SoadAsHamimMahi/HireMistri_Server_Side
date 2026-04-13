// utils/helpers.js — Shared utility functions used across multiple route files
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');

// Remove empty strings, undefined values, and empty objects recursively
function pruneEmpty(obj) {
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) pruneEmpty(v);
    const isEmptyObj = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
    if (v === '' || v === undefined || isEmptyObj) delete obj[k];
  });
  return obj;
}

// Build a $set from only allowed user profile keys present on req.body
function buildUserSet(body = {}) {
  const allowed = [
    'firstName', 'lastName', 'phone', 'headline', 'bio',
    'skills', 'isAvailable', 'profileCover', 'address1', 'address2',
    'city', 'country', 'zip', 'workExperience', 'role', 'email',
    'district', 'fullLegalName', 'nidNumber',
    'nidFrontImageUrl', 'nidBackImageUrl',
    'emergencyContactName', 'emergencyContactPhone',
    'payoutWalletProvider', 'payoutWalletNumber',
    'termsAcceptedAt', 'privacyAcceptedAt',
    'termsVersion', 'privacyVersion',
    'ageConfirmedAt', 'workerAccountStatus',
    'servicesOffered', 'serviceArea', 'certifications', 'portfolio',
    'experienceYears', 'locationGeo', 'emailVerified',
  ];

  const set = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      set[k] = body[k];
    }
  }

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
  if (typeof set.email === 'string') set.email = set.email.toLowerCase().trim();
  if (typeof set.fullLegalName === 'string') set.fullLegalName = set.fullLegalName.trim();
  if (typeof set.district === 'string') set.district = set.district.trim();
  if (typeof set.nidNumber === 'string') set.nidNumber = set.nidNumber.trim();
  if (typeof set.emergencyContactPhone === 'string') set.emergencyContactPhone = set.emergencyContactPhone.trim();
  if (typeof set.payoutWalletNumber === 'string') set.payoutWalletNumber = set.payoutWalletNumber.trim();
  if (set.workerAccountStatus && !['draft', 'pending_review', 'approved', 'rejected'].includes(set.workerAccountStatus)) {
    delete set.workerAccountStatus;
  }

  return pruneEmpty(set);
}

// Map job/application status to a display emoji
function getStatusEmoji(status) {
  const statusLower = String(status || '').toLowerCase();
  const emojiMap = {
    'completed': '✅',
    'cancelled': '❌',
    'on-hold': '⏸️',
    'active': '📋',
    'pending': '⏳',
    'accepted': '✅',
    'rejected': '❌',
    'expired': '⏰',
  };
  return emojiMap[statusLower] || '📋';
}

// Fetch worker name/email/phone from usersCollection or Firebase Admin
async function getWorkerIdentity(workerId, admin) {
  const out = { email: '', name: '', phone: '' };

  if (collections.users) {
    const u = await collections.users.findOne({ uid: workerId });
    if (u) {
      out.email = (u.email || out.email).toLowerCase().trim();
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || '';
      out.name = (name || out.name).trim();
      out.phone = (u.phone || out.phone).trim();
      if (out.email && out.name && out.phone) return out;
    }
  }

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

// Compute aggregated stats for a user (worker or client)
async function computeUserStats(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return null;

  const userDoc = await collections.users.findOne({ uid: safeUid }).catch(() => null);
  const userRole = userDoc?.role || 'worker';

  const [
    jobsPostedBrowse,
    jobsPostedLegacy,
    appsAsWorker,
    appsAsClient,
    jobsAsClient,
  ] = await Promise.all([
    collections.browseJobs.countDocuments({ clientId: safeUid }),
    collections.jobs.countDocuments({ clientId: safeUid }).catch(() => 0),
    collections.applications
      .find({ workerId: safeUid })
      .project({ status: 1, createdAt: 1, updatedAt: 1, acceptedAt: 1, completedAt: 1, proposedPrice: 1, negotiationStatus: 1, finalPrice: 1 })
      .toArray(),
    collections.applications
      .find({ clientId: safeUid })
      .project({ status: 1, createdAt: 1, updatedAt: 1, jobId: 1 })
      .toArray(),
    collections.browseJobs
      .find({ clientId: safeUid })
      .project({ status: 1, createdAt: 1, updatedAt: 1, _id: 1 })
      .toArray(),
  ]);

  const normStatus = (s) => String(s || '').toLowerCase();

  const workerStatusCounts = (appsAsWorker || []).reduce((acc, a) => {
    const st = normStatus(a.status || 'pending') || 'pending';
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});

  const workerApplicationsTotal = (appsAsWorker || []).length;
  const workerAccepted = (appsAsWorker || []).filter((a) => {
    if (normStatus(a.status) !== 'accepted') return false;
    const hasProposedPrice = a.proposedPrice != null && a.proposedPrice !== '';
    const priceAgreed = a.negotiationStatus === 'accepted' || (a.finalPrice != null && a.finalPrice !== '');
    if (hasProposedPrice && !priceAgreed) return false;
    return true;
  }).length;
  const workerCompleted = workerStatusCounts.completed || 0;

  const acceptedApps = (appsAsWorker || []).filter((a) => normStatus(a.status) === 'accepted');
  let workerResponseTimeHours = null;
  if (acceptedApps.length > 0) {
    const responseTimes = acceptedApps
      .map((a) => {
        const created = a.createdAt ? new Date(a.createdAt) : null;
        const accepted = a.acceptedAt ? new Date(a.acceptedAt) : (a.updatedAt ? new Date(a.updatedAt) : null);
        if (created && accepted && accepted > created) {
          return (accepted - created) / (1000 * 60 * 60);
        }
        return null;
      })
      .filter((t) => t !== null);
    if (responseTimes.length > 0) {
      const avg = responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length;
      workerResponseTimeHours = Math.round(avg * 10) / 10;
    }
  }

  const totalJobsPosted = Number(jobsPostedBrowse || 0) + Number(jobsPostedLegacy || 0);
  const jobsStatusCounts = (jobsAsClient || []).reduce((acc, j) => {
    const st = normStatus(j.status || 'active') || 'active';
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});

  const jobsCompleted = jobsStatusCounts.completed || 0;
  const jobsCancelled = jobsStatusCounts.cancelled || 0;
  const clientHireRate = (appsAsClient || []).length > 0
    ? Math.min(100, Math.round(((appsAsClient || []).filter((a) => normStatus(a.status) === 'accepted').length / (appsAsClient || []).length) * 100))
    : 0;
  const clientCancellationRate = totalJobsPosted > 0
    ? Math.min(100, Math.round((jobsCancelled / totalJobsPosted) * 100))
    : 0;

  // Ratings (workers only)
  let averageRating = 0;
  let categoryRatings = { qualityOfWork: 0, punctuality: 0, communication: 0, professionalism: 0, valueForMoney: 0, cleanliness: 0 };

  if (userRole === 'worker') {
    const reviews = await collections.reviews.find({
      $or: [
        { revieweeId: safeUid, revieweeRole: 'worker' },
        { workerId: safeUid, revieweeRole: { $exists: false } },
      ],
    }).toArray();

    if (reviews.length > 0) {
      const totalRating = reviews.reduce((sum, r) => sum + (r.overallRating || 0), 0);
      averageRating = Math.round((totalRating / reviews.length) * 10) / 10;

      const categoryTotals = { qualityOfWork: 0, punctuality: 0, communication: 0, professionalism: 0, valueForMoney: 0, cleanliness: 0 };
      reviews.forEach((review) => {
        if (review.ratings) {
          Object.keys(categoryTotals).forEach((cat) => {
            if (review.ratings[cat]) categoryTotals[cat] += review.ratings[cat];
          });
        }
      });
      Object.keys(categoryTotals).forEach((cat) => {
        categoryRatings[cat] = Math.round((categoryTotals[cat] / reviews.length) * 10) / 10;
      });
    }
  }

  const baseStats = {
    totalJobsPosted,
    averageRating,
    categoryRatings: userRole === 'worker' ? categoryRatings : null,
    totalReviews: userRole === 'worker'
      ? await collections.reviews.countDocuments({
          $or: [
            { revieweeId: safeUid, revieweeRole: 'worker' },
            { workerId: safeUid, revieweeRole: { $exists: false } },
          ],
        })
      : 0,
  };

  const clientStatsWhenPosted = totalJobsPosted > 0
    ? { applicationsAsClient: (appsAsClient || []).length, clientJobsCompleted: jobsCompleted, clientHireRate, clientCancellationRate, clientNoShowRate: 0 }
    : {};

  if (userRole === 'worker') {
    return {
      ...baseStats,
      ...clientStatsWhenPosted,
      applicationsAsWorker: workerApplicationsTotal,
      workerStatusCounts,
      workerActiveOrders: workerAccepted,
      workerCompletedJobs: workerCompleted,
      workerResponseRate: workerApplicationsTotal > 0
        ? Math.min(100, Math.round((workerAccepted / workerApplicationsTotal) * 100))
        : 0,
      workerResponseTimeHours,
      workerOnTimeRate: null,
    };
  }

  return {
    ...baseStats,
    applicationsAsClient: (appsAsClient || []).length,
    clientJobsCompleted: jobsCompleted,
    clientHireRate,
    clientCancellationRate,
    clientNoShowRate: 0,
  };
}

// Helper: generate conversationId string (pure function, no DB)
function getConversationId(senderId, recipientId, jobId) {
  const sorted = [String(senderId), String(recipientId)].sort();
  return jobId ? `${jobId}_${sorted.join('_')}` : sorted.join('_');
}

module.exports = {
  pruneEmpty,
  buildUserSet,
  getStatusEmoji,
  getWorkerIdentity,
  computeUserStats,
  getConversationId,
};
