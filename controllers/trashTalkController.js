/**
 * Trash talk controllers.
 *
 * POST /warzone/trash-talk/generate  — raw proxy to worker (admin/debug use)
 * GET  /warzone/trash-talk/line      — instant line from pre-generated pool
 *
 * Env:
 *   TRASH_TALK_WORKER_URL — full URL (default: https://trash-talk-worker.ronit-sde.workers.dev/generate)
 */

const { popLine } = require('../utils/trashTalkPool');

const DEFAULT_WORKER_URL = 'https://trash-talk-worker.ronit-sde.workers.dev/generate';

exports.generateTrashTalk = async (req, res) => {
  const url = String(process.env.TRASH_TALK_WORKER_URL || DEFAULT_WORKER_URL).trim() || DEFAULT_WORKER_URL;

  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        upstream: data,
      });
    }

    if (data !== null && typeof data === 'object') {
      return res.json(data);
    }
    return res.type('application/json').send(text || '{}');
  } catch (err) {
    console.error('[trash-talk] proxy error:', err?.message || err);
    return res.status(502).json({
      ok: false,
      message: 'Trash talk worker unreachable',
      error: process.env.NODE_ENV === 'development' ? String(err?.message || err) : undefined,
    });
  }
};

/**
 * GET /warzone/trash-talk/line?won=true|false
 *
 * Returns one pre-generated line instantly from the pool.
 * Falls back to a static line if the pool is empty (e.g. cold start).
 */
exports.getTrashLine = (req, res) => {
  const won = req.query.won === 'true';
  const text = popLine(won);
  res.json({ success: true, won, text });
};
