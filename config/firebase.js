// config/firebase.js — Firebase Admin SDK initialization
const fs = require('fs');

let admin = null;

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
  try {
    admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    console.log('🔥 Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase init failed:', e);
    admin = null;
  }
} else if (process.env.FIREBASE_CONFIG) {
  try {
    admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      admin.initializeApp();
    }
    console.log('🔥 Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase init failed:', e);
    admin = null;
  }
}

module.exports = admin;
