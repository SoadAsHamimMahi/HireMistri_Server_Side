const { MongoClient } = require('mongodb');

async function run() {
  const uri = "mongodb://HireMistri:HMProjectServ@ac-yozcwku-shard-00-00.3zws6aa.mongodb.net:27017,ac-yozcwku-shard-00-01.3zws6aa.mongodb.net:27017,ac-yozcwku-shard-00-02.3zws6aa.mongodb.net:27017/?ssl=true&authSource=admin&retryWrites=true&w=majority&appName=Cluster0";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('hiremistriDB');

    // Fix Jobs
    let jobsCollection = db.collection('jobs');
    let jobs = await jobsCollection.find({}).toArray();
    let updatedJobs = 0;
    
    for (let job of jobs) {
      let needsUpdate = false;
      let updateDoc = { $set: {} };

      if (Array.isArray(job.images)) {
        let newImages = job.images.map(img => {
          if (typeof img === 'string' && img.includes('http://localhost:5000')) {
            return img.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com');
          }
          return img;
        });
        
        if (JSON.stringify(newImages) !== JSON.stringify(job.images)) {
          updateDoc.$set.images = newImages;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        await jobsCollection.updateOne({ _id: job._id }, updateDoc);
        updatedJobs++;
      }
    }
    console.log(`Updated ${updatedJobs} jobs.`);

    // Fix Categories
    let categoriesCollection = db.collection('categories');
    let categories = await categoriesCollection.find({}).toArray();
    let updatedCategories = 0;

    for (let category of categories) {
      if (category.image && category.image.includes('http://localhost:5000')) {
        await categoriesCollection.updateOne(
          { _id: category._id },
          { $set: { image: category.image.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com') } }
        );
        updatedCategories++;
      }
    }
    console.log(`Updated ${updatedCategories} categories.`);

  } catch (err) {
    console.log(err.stack);
  } finally {
    await client.close();
  }
}

run();
