/**
 * Token Bucket Rate Limiter (per-project, in-memory).
 * Each project gets 200 events/sec sustained, burst up to 500.
 */
const rateLimits = new Map();
const BUCKET_CAPACITY = 500;
const REFILL_RATE = 200;

export function checkRateLimit(projectId) {
  const now = Date.now();
  if (!rateLimits.has(projectId)) {
    rateLimits.set(projectId, { tokens: BUCKET_CAPACITY, lastRefill: now });
    return true;
  }

  const bucket = rateLimits.get(projectId);
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsed * REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
