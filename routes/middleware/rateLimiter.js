/**
 * rateLimiter — Redis-backed rate limiter with in-memory fallback.
 *
 * When REDIS_URL is set, rate limits are shared across all server instances
 * (required for multi-instance / load-balanced deployments).
 *
 * When REDIS_URL is not set (or Redis fails), falls back to the original
 * in-memory Map — suitable for single-instance deployments and local dev.
 *
 * Redis key format: `rl:<endpoint-key>:<client-ip>`  (TTL = windowMs / 1000)
 *
 * Standard headers added to every response:
 *   X-RateLimit-Limit     — max requests per window
 *   X-RateLimit-Remaining — remaining in current window
 *   X-RateLimit-Reset     — UNIX seconds when window resets
 *   Retry-After           — seconds to wait (only on 429 responses)
 *
 * Usage:
 *   const rateLimiter = require('./rateLimiter');
 *   router.post('/save/binary', rateLimiter({ windowMs: 60_000, max: 10 }), handler);
 */

let _redisClient = null;
let _redisReady  = false;

function getRedis() {
  if (_redisClient) return _redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const Redis = require('ioredis');
    _redisClient = new Redis(url, {
      lazyConnect:        true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout:     2000,
    });

    _redisClient.on('connect', () => {
      _redisReady = true;
      console.log('[rateLimiter] Redis connected — rate limits shared across instances');
    });

    _redisClient.on('error', (err) => {
      // Downgrade silently — fallback to in-memory
      if (_redisReady) console.warn('[rateLimiter] Redis error — falling back to in-memory:', err.message);
      _redisReady = false;
    });

    _redisClient.connect().catch(() => {});
    return _redisClient;
  } catch {
    console.warn('[rateLimiter] ioredis not installed — using in-memory rate limits (install: npm i ioredis)');
    return null;
  }
}

// In-memory fallback (single instance only)
const buckets = new Map();

function getClientIp(req) {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  const xRealIp       = req?.headers?.['x-real-ip'];
  const forwarded     = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const realIp        = Array.isArray(xRealIp)       ? xRealIp[0]       : xRealIp;
  const firstForwarded = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return firstForwarded || realIp || req?.ip || req?.socket?.remoteAddress || 'global';
}

/**
 * Redis-based check using atomic INCR + EXPIRE.
 * Returns { count, resetAt } where count is the request count after this one.
 */
async function redisCheck(redis, key, windowMs) {
  const ttlSec = Math.ceil(windowMs / 1000);
  // INCR atomically increments. If key doesn't exist, it's created with value 0 first.
  const count = await redis.incr(key);
  if (count === 1) {
    // First request in this window — set the expiry
    await redis.expire(key, ttlSec);
  }
  // Get remaining TTL for the reset timestamp
  const ttlRemaining = await redis.ttl(key);
  const resetAt = Date.now() + (ttlRemaining > 0 ? ttlRemaining * 1000 : windowMs);
  return { count, resetAt };
}

/**
 * In-memory fallback check.
 * Returns { count, resetAt }.
 */
function memoryCheck(key, windowMs) {
  const now   = Date.now();
  let entry   = buckets.get(key);
  if (!entry || now >= entry.expiresAt) {
    entry = { count: 0, expiresAt: now + windowMs };
    buckets.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, resetAt: entry.expiresAt };
}

function rateLimiter(options = {}) {
  const windowMs     = Number(options.windowMs ?? 60_000);
  const max          = Number(options.max      ?? 60);
  const keyPrefix    = options.keyPrefix || 'rl';
  const keyGenerator = options.keyGenerator || ((req) => getClientIp(req));
  const message      = options.message || 'Too many requests, please try again later.';

  // Eagerly connect Redis when the limiter is first created
  const redis = getRedis();

  return async (req, res, next) => {
    try {
      const clientKey = keyGenerator(req);
      const key       = `${keyPrefix}:${clientKey}`;

      let count, resetAt;

      // Try Redis first; fall back to memory if not ready or errors
      if (redis && _redisReady) {
        try {
          ({ count, resetAt } = await redisCheck(redis, key, windowMs));
        } catch {
          ({ count, resetAt } = memoryCheck(key, windowMs));
        }
      } else {
        ({ count, resetAt } = memoryCheck(key, windowMs));
      }

      const remaining   = Math.max(0, max - count);
      const resetSeconds = Math.ceil(resetAt / 1000);

      res.setHeader('X-RateLimit-Limit',     String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset',     String(resetSeconds));

      if (count > max) {
        const retryAfterMs  = Math.max(0, resetAt - Date.now());
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          ok:               false,
          error:            message,
          status:           429,
          retryAfterMs,
          retryAfterSeconds: retryAfterSec,
          resetAt:          new Date(resetAt).toISOString(),
        });
      }

      return next();
    } catch (err) {
      // Never block requests on rate-limiter failure
      console.error('[rateLimiter] unexpected error — passing through:', err.message);
      return next();
    }
  };
}

module.exports = rateLimiter;
