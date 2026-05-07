const { MongoClient } = require('mongodb');

async function run() {
  const uri = "mongodb://HireMistri:HMProjectServ@ac-yozcwku-shard-00-00.3zws6aa.mongodb.net:27017,ac-yozcwku-shard-00-01.3zws6aa.mongodb.net:27017,ac-yozcwku-shard-00-02.3zws6aa.mongodb.net:27017/?ssl=true&authSource=admin&retryWrites=true&w=majority&appName=Cluster0";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("Connected correctly to server");
    const db = client.db('hiremistriDB');

    let usersCollection = db.collection('users');
    let users = await usersCollection.find({}).toArray();
    let updatedUsers = 0;
    
    for (let user of users) {
      let needsUpdate = false;
      let updateDoc = { $set: {} };

      if (user.profileCover && user.profileCover.includes('http://localhost:5000')) {
        updateDoc.$set.profileCover = user.profileCover.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com');
        needsUpdate = true;
      }
      
      if (user.avatar && user.avatar.includes('http://localhost:5000')) {
        updateDoc.$set.avatar = user.avatar.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com');
        needsUpdate = true;
      }

      if (Array.isArray(user.portfolio)) {
        let newPortfolio = user.portfolio.map(p => {
          if (typeof p === 'string' && p.includes('http://localhost:5000')) {
            return p.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com');
          } else if (p && p.url && p.url.includes('http://localhost:5000')) {
            return { ...p, url: p.url.replace(/http:\/\/localhost:5000/g, 'https://hiremistri-server-side.onrender.com') };
          }
          return p;
        });
        
        if (JSON.stringify(newPortfolio) !== JSON.stringify(user.portfolio)) {
          updateDoc.$set.portfolio = newPortfolio;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        await usersCollection.updateOne({ _id: user._id }, updateDoc);
        updatedUsers++;
      }
    }
    console.log(`Updated ${updatedUsers} users.`);

  } catch (err) {
    console.log(err.stack);
  } finally {
    await client.close();
  }
}

run();
