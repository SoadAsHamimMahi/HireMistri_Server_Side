// utils/cache.js — In-memory response cache for conversation jobs
const conversationJobsCache = new Map(); // key -> { data, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedConversationJobs(conversationId) {
  const key = `conversation_jobs:${conversationId}`;
  const entry = conversationJobsCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    conversationJobsCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedConversationJobs(conversationId, data) {
  conversationJobsCache.set(`conversation_jobs:${conversationId}`, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function invalidateConversationJobsCache(conversationId) {
  if (conversationId) conversationJobsCache.delete(`conversation_jobs:${conversationId}`);
}

module.exports = {
  getCachedConversationJobs,
  setCachedConversationJobs,
  invalidateConversationJobsCache,
};
