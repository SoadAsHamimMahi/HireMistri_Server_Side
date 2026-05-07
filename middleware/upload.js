// middleware/upload.js — Cloudinary-based file storage (replaces local disk storage)
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// ── Configure Cloudinary SDK from environment variables ───────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── General storage: profile photos, job images, payment receipts ─────────────
// resource_type: 'auto' means Cloudinary auto-detects image vs video
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:           'hiremistri/uploads',
    allowed_formats:  ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'avi'],
    resource_type:    'auto',
    transformation:   [{ quality: 'auto', fetch_format: 'auto' }],
  },
});

// ── NID / Identity-document storage: images only, 5 MB cap ───────────────────
const nidStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          'hiremistri/nids',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    resource_type:   'image',
    transformation:  [{ quality: 80 }],
  },
});

// ── Multer instances ──────────────────────────────────────────────────────────
const upload = multer({ storage });

// nidUploadMiddleware — same name exported as before, so routes/users.js needs no import change
const nidUploadMiddleware = multer({
  storage: nidStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, or WebP images are allowed for NID documents'));
    }
  },
}).single('file');

module.exports = { upload, nidUploadMiddleware };
