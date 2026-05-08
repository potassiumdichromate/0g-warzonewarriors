/**
 * metrics.js — Prometheus metrics middleware for Warzone Warriors backend.
 *
 * Exposes GET /metrics (Prometheus text format).
 * Mount BEFORE routes so all requests are measured.
 *
 * Metrics exposed:
 *   http_requests_total              — counter by method, path (normalized), status
 *   http_request_duration_seconds    — histogram by method, path, status
 *   zg_storage_uploads_total         — 0G Storage upload counter (success/failure)
 *   zg_storage_upload_duration_ms    — histogram of upload times
 *   zg_da_dispersals_total           — 0G DA dispersal counter by status
 *   zg_da_finality_duration_ms       — histogram of DA finality wait times
 *   zg_anchor_txs_total              — 0G chain anchor tx counter
 *   zg_compute_validations_total     — 0G Compute validation counter by verdict
 *
 * Usage:
 *   const { metricsMiddleware, metricsHandler, zgMetrics } = require('./middleware/metrics');
 *   app.use(metricsMiddleware);
 *   app.get('/metrics', metricsHandler);
 *   // In ZeroGStorage.js: zgMetrics.recordUpload(durationMs, 'success')
 *
 * Install prom-client: npm install prom-client
 * If not installed, all exports are no-ops — metrics are optional.
 */

let client;
try {
  client = require('prom-client');
} catch {
  console.warn('[metrics] prom-client not installed — metrics disabled. Install: npm i prom-client');
}

if (!client) {
  // No-op exports — metrics are completely optional
  module.exports = {
    metricsMiddleware: (req, res, next) => next(),
    metricsHandler:    (req, res) => res.status(503).json({ error: 'prom-client not installed' }),
    zgMetrics: {
      recordUpload:     () => {},
      recordDA:         () => {},
      recordAnchor:     () => {},
      recordCompute:    () => {},
    },
  };
  return;
}

// ── Prometheus registry ───────────────────────────────────────────────────────

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// ── HTTP metrics ──────────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name:       'http_requests_total',
  help:       'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers:  [registry],
});

const httpDuration = new client.Histogram({
  name:       'http_request_duration_seconds',
  help:       'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets:    [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers:  [registry],
});

/**
 * Normalize dynamic path segments so /save/pipeline/0xabc123 doesn't
 * create unbounded cardinality. Maps :rootHash → ':rootHash', etc.
 */
function normalizePath(path) {
  if (!path) return 'unknown';
  return path
    .replace(/\/0x[0-9a-fA-F]{40,}/g, '/:address')   // wallet or rootHash hex
    .replace(/\/[0-9a-fA-F]{64,}/g,   '/:hash')       // plain hashes
    .replace(/\/\d+/g,                '/:id')          // numeric IDs
    .split('?')[0];                                    // strip query string
}

const metricsMiddleware = (req, res, next) => {
  const end   = httpDuration.startTimer();
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const normalizedPath = normalizePath(req.originalUrl || req.url);
    const labels = {
      method: req.method,
      path:   normalizedPath,
      status: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });

  next();
};

// ── 0G-specific metrics ───────────────────────────────────────────────────────

const zgStorageUploadsTotal = new client.Counter({
  name:       'zg_storage_uploads_total',
  help:       '0G Storage upload attempts',
  labelNames: ['result'],  // success | failure
  registers:  [registry],
});

const zgStorageUploadDuration = new client.Histogram({
  name:       'zg_storage_upload_duration_ms',
  help:       '0G Storage upload duration in milliseconds',
  buckets:    [100, 500, 1000, 2000, 5000, 10000, 30000],
  registers:  [registry],
});

const zgDaDispersalsTotal = new client.Counter({
  name:       'zg_da_dispersals_total',
  help:       '0G DA dispersal attempts by final status',
  labelNames: ['status'],  // finalized | failed | timeout
  registers:  [registry],
});

const zgDaFinalityDuration = new client.Histogram({
  name:       'zg_da_finality_duration_ms',
  help:       'Time from DA dispersal to FINALIZED status in milliseconds',
  buckets:    [5000, 15000, 30000, 60000, 120000, 180000, 240000],
  registers:  [registry],
});

const zgAnchorTxsTotal = new client.Counter({
  name:       'zg_anchor_txs_total',
  help:       '0G chain anchor transactions',
  labelNames: ['result'],  // success | failure
  registers:  [registry],
});

const zgComputeValidationsTotal = new client.Counter({
  name:       'zg_compute_validations_total',
  help:       '0G Compute anti-cheat validation results',
  labelNames: ['verdict'],  // CLEAN | FLAGGED | error | skipped
  registers:  [registry],
});

// ── Metrics handler ───────────────────────────────────────────────────────────

const metricsHandler = async (req, res) => {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
};

// ── Helper methods for 0G services to call ───────────────────────────────────

const zgMetrics = {
  recordUpload(durationMs, result = 'success') {
    zgStorageUploadsTotal.inc({ result });
    if (typeof durationMs === 'number') zgStorageUploadDuration.observe(durationMs);
  },

  recordDA(status = 'finalized', durationMs) {
    zgDaDispersalsTotal.inc({ status });
    if (status === 'finalized' && typeof durationMs === 'number') {
      zgDaFinalityDuration.observe(durationMs);
    }
  },

  recordAnchor(result = 'success') {
    zgAnchorTxsTotal.inc({ result });
  },

  recordCompute(verdict = 'CLEAN') {
    zgComputeValidationsTotal.inc({ verdict });
  },
};

module.exports = { metricsMiddleware, metricsHandler, zgMetrics };
