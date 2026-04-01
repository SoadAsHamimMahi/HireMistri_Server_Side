const { MongoClient, ServerApiVersion } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const uri =
  process.env.MONGODB_URI?.trim() ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.3zws6aa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function runDueMonitor() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB for Due Monitor');
    
    const db = client.db('hiremistriDB');
    const usersCollection = db.collection('users');
    
    // Find workers with due balance >= 200 BDT
    const overDueWorkers = await usersCollection.find({
        role: 'worker',
        dueBalance: { $gte: 200 }
    }).toArray();

    const now = new Date();
    
    for (const worker of overDueWorkers) {
        if (!worker.dueWarningNotifiedAt) {
            // First time crossing 200, start 48h grace period
            await usersCollection.updateOne(
                { _id: worker._id },
                { $set: { dueWarningNotifiedAt: now } }
            );
            console.log(`⚠️ Worker ${worker.uid} crossed due limit. Starting 48h grace period.`);
            // TODO: In the future, emit an email or SMS notification here.
        } else {
            // Check if 48h passed
            const gracePeriodEnd = new Date(worker.dueWarningNotifiedAt);
            gracePeriodEnd.setHours(gracePeriodEnd.getHours() + 48);
            
            if (now > gracePeriodEnd && !worker.isApplyBlocked) {
                // Time's up
                await usersCollection.updateOne(
                    { _id: worker._id },
                    { $set: { isApplyBlocked: true, blockReason: 'DUE_LIMIT_EXCEEDED' } }
                );
                console.log(`🚫 Worker ${worker.uid} blocked. Grace period expired.`);
            }
        }
    }
  } catch (err) {
    console.error('❌ Due Monitor failed:', err);
  } finally {
    await client.close();
    console.log('✅ Due Monitor finished.');
    process.exit(0);
  }
}

runDueMonitor();
