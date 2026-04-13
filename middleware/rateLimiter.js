// middleware/rateLimiter.js — In-memory rate limiting middleware factories

// ---- Job Offer Rate Limiter ----
const jobOfferRateLimitStore = new Map(); // key -> { count, resetAt }
const JOB_OFFER_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const JOB_OFFER_RATE_MAX = 10; // max requests per window

const jobOfferLimiter = (req, res, next) => {
  const key = (req.ip || req.connection?.remoteAddress || 'unknown') + ':job-offers';
  const now = Date.now();
  let entry = jobOfferRateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + JOB_OFFER_RATE_WINDOW_MS };
    jobOfferRateLimitStore.set(key, entry);
  }
  entry.count++;
  if (entry.count > JOB_OFFER_RATE_MAX) {
    return res.status(429).json({
      error: 'Too many job offer requests. Please try again later.',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
  }
  next();
};

// ---- Admin Rate Limiter (factory) ----
const adminRateLimitStore = new Map();
const ADMIN_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const ADMIN_BULK_MAX = 10;
const ADMIN_BACKUP_MAX = 2;

function adminRateLimiter(keyPrefix, maxPerWindow) {
  return (req, res, next) => {
    const uid = req.user?.uid || req.ip || 'unknown';
    const key = `${keyPrefix}:${uid}`;
    const now = Date.now();
    let entry = adminRateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + ADMIN_RATE_WINDOW_MS };
      adminRateLimitStore.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxPerWindow) {
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
    }
    next();
  };
}

module.exports = {
  jobOfferLimiter,
  adminRateLimiter,
  ADMIN_BULK_MAX,
  ADMIN_BACKUP_MAX,
};
