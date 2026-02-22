/**
 * Seed a single admin user into the adminUsers collection.
 * Usage: node scripts/seed-admin-user.js
 * Requires: MONGODB_URI, ADMIN_SEED_UID, ADMIN_SEED_EMAIL in env (or .env via dotenv).
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = (process.env.MONGODB_URI || '').trim();
const uid = process.env.ADMIN_SEED_UID?.trim();
const email = process.env.ADMIN_SEED_EMAIL?.trim();

if (!uri) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}
if (!uid || !email) {
  console.error('Missing ADMIN_SEED_UID or ADMIN_SEED_EMAIL');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('hiremistriDB');
    const coll = db.collection('adminUsers');
    const result = await coll.updateOne(
      { uid },
      {
        $set: {
          uid,
          email: email.toLowerCase(),
          permissions: ['*'],
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log(result.upsertedCount ? 'Admin user created.' : 'Admin user already exists (updated).');
    console.log('UID:', uid, 'Email:', email);
  } finally {
    await client.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
