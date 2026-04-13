const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { collections } = require('../config/db');
const usersRouter = require('../routes/users');
const jobsRouter = require('../routes/jobs');

function matchesCondition(value, condition) {
  if (
    condition &&
    typeof condition === 'object' &&
    !Array.isArray(condition) &&
    !(condition instanceof ObjectId)
  ) {
    if (Object.prototype.hasOwnProperty.call(condition, '$exists')) {
      const exists = value !== undefined;
      return exists === Boolean(condition.$exists);
    }
    if (Array.isArray(condition.$in)) {
      return condition.$in.some((item) => String(item) === String(value));
    }
    if (Array.isArray(condition.$nin)) {
      return !condition.$nin.some((item) => String(item) === String(value));
    }
  }
  return String(value) === String(condition);
}

function matchesQuery(doc, query = {}) {
  if (query.$or) {
    return query.$or.some((branch) => matchesQuery(doc, branch));
  }

  return Object.entries(query).every(([key, condition]) => matchesCondition(doc[key], condition));
}

function createCursor(items) {
  let results = [...items];
  return {
    sort(sortSpec = {}) {
      const [field, direction] = Object.entries(sortSpec)[0] || [];
      if (field) {
        results.sort((a, b) => {
          const left = a[field];
          const right = b[field];
          const leftValue = left instanceof Date ? left.getTime() : new Date(left).getTime() || left;
          const rightValue = right instanceof Date ? right.getTime() : new Date(right).getTime() || right;
          if (leftValue < rightValue) return -1 * (direction < 0 ? -1 : 1);
          if (leftValue > rightValue) return 1 * (direction < 0 ? -1 : 1);
          return 0;
        });
      }
      return this;
    },
    skip(count = 0) {
      results = results.slice(count);
      return this;
    },
    limit(count = results.length) {
      results = results.slice(0, count);
      return this;
    },
    async toArray() {
      return results.map((item) => ({ ...item }));
    },
  };
}

function createMockCollection(seed = []) {
  const docs = seed.map((doc) => ({ ...doc }));

  return {
    async findOne(query = {}) {
      return docs.find((doc) => matchesQuery(doc, query)) || null;
    },
    find(query = {}) {
      return createCursor(docs.filter((doc) => matchesQuery(doc, query)));
    },
    async insertOne(doc) {
      const record = { ...doc };
      if (!record._id) record._id = new ObjectId();
      docs.push(record);
      return { insertedId: record._id };
    },
    async updateOne(query = {}, update = {}, options = {}) {
      let doc = docs.find((item) => matchesQuery(item, query));
      if (!doc && options.upsert) {
        doc = { ...query };
        if (!doc._id) doc._id = new ObjectId();
        docs.push(doc);
      }
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };

      if (update.$setOnInsert && !doc.__inserted) {
        Object.assign(doc, update.$setOnInsert);
      }
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete doc[key];
        }
      }
      doc.__inserted = true;
      return { matchedCount: 1, modifiedCount: 1, upsertedId: options.upsert ? doc._id : undefined };
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  app.use('/api', jobsRouter);
  return app;
}

async function run() {
  collections.users = createMockCollection();
  collections.browseJobs = createMockCollection();
  collections.workerJobRequests = createMockCollection();
  collections.applications = createMockCollection();
  collections.reviews = createMockCollection();

  let app = buildApp();

  let response = await request(app)
    .post('/api/users')
    .send({
      uid: 'user-1',
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'User',
      role: 'client',
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.uid, 'user-1');
  assert.equal(response.body.email, 'new@example.com');

  collections.browseJobs = createMockCollection([
    { _id: 'job-1', conversationId: 'conv-1', title: 'Fix wiring', isPrivate: true },
  ]);
  collections.workerJobRequests = createMockCollection([
    { _id: 'req-1', conversationId: 'conv-1', title: 'Request quote', status: 'pending' },
  ]);
  app = buildApp();
  response = await request(app).get('/api/conversations/conv-1/jobs');
  assert.equal(response.status, 200);
  assert.equal(response.body.jobs.length, 1);
  assert.equal(response.body.workerRequests.length, 1);
  assert.equal(response.body.all.length, 2);

  collections.workerJobRequests = createMockCollection([
    { _id: new ObjectId('66b8f2c0b7e1a40000000001'), conversationId: 'conv-1', status: 'pending' },
  ]);
  app = buildApp();
  response = await request(app)
    .patch('/api/worker-job-requests/66b8f2c0b7e1a40000000001/status')
    .send({ status: 'accepted' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'accepted');

  const applicationId = new ObjectId('66b8f2c0b7e1a40000000002');
  const jobId = new ObjectId('66b8f2c0b7e1a40000000003');
  collections.applications = createMockCollection([
    {
      _id: applicationId,
      jobId: jobId.toString(),
      workerId: 'worker-1',
      clientId: 'client-1',
      status: 'completed',
    },
  ]);
  collections.browseJobs = createMockCollection([
    {
      _id: jobId,
      clientId: 'client-1',
      title: 'Paint the living room',
    },
  ]);
  app = buildApp();
  response = await request(app)
    .post('/api/reviews')
    .send({
      jobId: jobId.toString(),
      applicationId: applicationId.toString(),
      workerId: 'worker-1',
      clientId: 'client-1',
      reviewerId: 'client-1',
      reviewerRole: 'client',
      revieweeId: 'worker-1',
      revieweeRole: 'worker',
      ratings: {
        qualityOfWork: 5,
        punctuality: 4,
        communication: 5,
      },
      reviewText: 'Great work.',
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.review.applicationId, applicationId.toString());

  response = await request(app)
    .get(`/api/reviews/application/${applicationId.toString()}`)
    .query({ reviewerId: 'client-1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.applicationId, applicationId.toString());
  assert.equal(response.body.reviewerId, 'client-1');

  console.log('Server smoke checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
