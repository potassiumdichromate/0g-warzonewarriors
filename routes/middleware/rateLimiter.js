// Simple in-memory rate limiter middleware
// Usage: router.get(path, rateLimiter({ windowMs: 60000, max: 20 }), handler)
// Adds standard headers so clients can determine when to retry:
// - X-RateLimit-Limit: max requests per window
// - X-RateLimit-Remaining: remaining requests in current window
// - X-RateLimit-Reset: UNIX seconds when the window resets
// - Retry-After (on 429): seconds to wait before retrying

const buckets = new Map();

function getClientIp(req) {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  const xRealIp = req?.headers?.['x-real-ip'];
  const forwarded = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const realIp = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
  const firstForwardedIp = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return firstForwardedIp || realIp || req?.ip || req?.socket?.remoteAddress || 'global';
}

function rateLimiter(options = {}) {
  const windowMs = Number(options.windowMs ?? 60_000); // default 1 minute
  const max = Number(options.max ?? 60); // default 60 requests per window
  const keyGenerator = options.keyGenerator || ((req) => getClientIp(req));
  const message = options.message || 'Too many requests, please try again later.';

  return (req, res, next) => {
    try {
      const now = Date.now();
      const key = keyGenerator(req);

      let entry = buckets.get(key);
      if (!entry || now >= entry.expiresAt) {
        entry = { count: 0, expiresAt: now + windowMs };
        buckets.set(key, entry);
      }

      const remainingBefore = Math.max(0, max - entry.count);
      const resetSeconds = Math.ceil(entry.expiresAt / 1000);

      if (entry.count >= max) {
        const retryAfterMs = Math.max(0, entry.expiresAt - now);
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(resetSeconds));
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          ok: false,
          error: message,
          status:429,
          retryAfterMs,
          retryAfterSeconds: retryAfterSec,
          resetAt: new Date(entry.expiresAt).toISOString(),
        });
        return;
      }

      // Update counters and expose headers
      entry.count += 1;
      const remainingAfter = Math.max(0, max - entry.count);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remainingAfter));
      res.setHeader('X-RateLimit-Reset', String(resetSeconds));
      next();
    } catch (err) {
      // On failure, do not block the request
      next();
    }
  };
}

module.exports = rateLimiter;
