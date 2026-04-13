// config/db.js — MongoDB client, all collection references, indexes, and migrations
const { MongoClient, ServerApiVersion } = require('mongodb');

const uri =
  process.env.MONGODB_URI?.trim() ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3zws6aa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// All collections — populated after connection
const collections = {};

async function connectDB() {
  await client.connect();
  console.log('✅ Connected to MongoDB');

  const db = client.db('hiremistriDB');

  collections.db                    = db;
  collections.users                  = db.collection('users');
  collections.jobs                   = db.collection('jobs');
  collections.applications           = db.collection('applications');
  collections.browseJobs             = db.collection('browseJobs');
  collections.messages               = db.collection('messages');
  collections.notifications          = db.collection('notifications');
  collections.savedJobs              = db.collection('savedJobs');
  collections.reviews                = db.collection('reviews');
  collections.workerJobRequests      = db.collection('workerJobRequests');
  collections.jobOfferHistory        = db.collection('jobOfferHistory');
  collections.jobOfferReminders      = db.collection('jobOfferReminders');
  collections.adminUsers             = db.collection('adminUsers');
  collections.paymentRequests        = db.collection('paymentRequests');
  collections.settlements            = db.collection('settlements');
  collections.cashCollections        = db.collection('cashCollections');
  collections.services               = db.collection('services');
  collections.categories             = db.collection('categories');
  collections.transactions           = db.collection('transactions');
  collections.userQueries            = db.collection('userQueries');
  collections.reportingReasons       = db.collection('reportingReasons');
  collections.blockedUsers           = db.collection('blockedUsers');
  collections.promoCodes             = db.collection('promoCodes');
  collections.sliders                = db.collection('sliders');
  collections.featuredSection        = db.collection('featuredSection');
  collections.subscriptionPlans      = db.collection('subscriptionPlans');
  collections.userSubscriptions      = db.collection('userSubscriptions');
  collections.gallery                = db.collection('gallery');
  collections.faqs                   = db.collection('faqs');
  collections.adminAuditLog          = db.collection('adminAuditLog');
  collections.supportTickets         = db.collection('supportTickets');
  collections.supportMessages        = db.collection('supportMessages');
  collections.ledgers                = db.collection('ledgers');
  collections.additionalCharges      = db.collection('additionalCharges');

  await createIndexes(collections);
  await runMigrations(collections);

  return collections;
}

async function createIndexes(col) {
  await col.users.createIndex({ uid: 1 }, { unique: true, sparse: true });
  await col.users.createIndex({ email: 1 }, { unique: true, sparse: true });
  await col.adminUsers.createIndex({ uid: 1 }, { unique: true });
  await col.adminAuditLog.createIndex({ createdAt: -1 });
  await col.adminAuditLog.createIndex({ adminUid: 1, createdAt: -1 });

  await col.applications.createIndex({ jobId: 1 });
  await col.applications.createIndex({ workerId: 1 });
  await col.applications.createIndex({ clientId: 1 });
  await col.applications.createIndex({ workerEmail: 1 });
  await col.applications.createIndex({ clientEmail: 1 });
  await col.applications.createIndex({ jobId: 1, workerId: 1 }, { unique: true, sparse: true });

  await col.jobOfferHistory.createIndex({ jobId: 1, createdAt: -1 });
  await col.jobOfferReminders.createIndex({ jobId: 1, workerId: 1 });
  await col.jobOfferReminders.createIndex({ reminderAt: 1 });

  await col.messages.createIndex({ conversationId: 1, createdAt: 1 });
  await col.messages.createIndex({ senderId: 1 });
  await col.messages.createIndex({ recipientId: 1 });
  await col.messages.createIndex({ jobId: 1 });

  await col.supportTickets.createIndex({ userId: 1, updatedAt: -1 });
  await col.supportTickets.createIndex({ userRole: 1, status: 1, updatedAt: -1 });
  await col.supportMessages.createIndex({ ticketId: 1, createdAt: 1 });

  await col.notifications.createIndex({ userId: 1, read: 1, createdAt: -1 });
  await col.notifications.createIndex({ userId: 1, createdAt: -1 });

  await col.savedJobs.createIndex({ userId: 1, jobId: 1 }, { unique: true });
  await col.savedJobs.createIndex({ userId: 1, savedAt: -1 });

  await col.reviews.createIndex({ workerId: 1, createdAt: -1 });
  await col.reviews.createIndex({ jobId: 1 });
  try { await col.reviews.dropIndex('applicationId_1'); } catch (e) { /* ignore if not present */ }
  await col.reviews.createIndex({ applicationId: 1, reviewerId: 1 }, { unique: true, sparse: true });
  await col.reviews.createIndex({ clientId: 1, workerId: 1 });

  await col.browseJobs.createIndex({ conversationId: 1 });
  await col.browseJobs.createIndex({ targetWorkerId: 1, isPrivate: 1 });

  await col.workerJobRequests.createIndex({ conversationId: 1 });
  await col.workerJobRequests.createIndex({ workerId: 1, status: 1 });
  await col.workerJobRequests.createIndex({ clientId: 1, status: 1 });

  await col.users.createIndex({ workerAccountStatus: 1, role: 1, registrationSubmittedAt: -1 });
}

async function runMigrations(col) {
  try {
    const migrationResult = await col.users.updateMany(
      { role: 'worker', workerAccountStatus: { $exists: false } },
      { $set: { workerAccountStatus: 'approved' } }
    );
    if (migrationResult.modifiedCount > 0) {
      console.log(`✅ Migration: set workerAccountStatus=approved for ${migrationResult.modifiedCount} existing workers`);
    }
  } catch (migrationErr) {
    console.warn('⚠️ Worker migration failed (non-blocking):', migrationErr.message);
  }
}

module.exports = { connectDB, collections, client };
