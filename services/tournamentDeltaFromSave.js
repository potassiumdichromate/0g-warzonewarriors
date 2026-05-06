/**
 * Tournament sync on saveProfile: baselineCoin is the last saved coin snapshot per round.
 * Each save sends (coins - baselineCoin) to medals + Intraverse, then sets baselineCoin = coins.
 * Repeating the same save yields delta 0. baselineCoin is not exposed in profile API responses.
 */
const https = require('https');
const PlayerProfile = require('../models/PlayerProfile');
const PlayerRoundParticipation = require('../models/PlayerRoundParticipation');

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api-stage.intraverse.io';
const DEFAULT_GAME_SLUG = process.env.INTRAVERSE_GAME_SLUG || 'warzone-warriors';

function shortWallet(w) {
  const s = String(w || '').trim();
  if (s.length < 14) return s || '(empty)';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function snippet(value, max = 480) {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value).slice(0, max);
  }
}

function isRoundIntervalActive(round) {
  if (!round || !Array.isArray(round.intervals) || round.intervals.length === 0) return false;
  const now = Date.now();
  return round.intervals.some((iv) => now >= iv.startDate && now <= iv.endDate);
}

/**
 * GET /api/v2/tournament/game/:slug — same source as intraverseTestRoutes sync-tournaments.
 * Returns the first round id whose interval contains now (RUNNING tournaments first).
 */
async function resolveActiveRoundIdFromIntraverse(slug = DEFAULT_GAME_SLUG) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }
  const url = `${BASE_URL}/api/v2/tournament/game/${encodeURIComponent(slug)}?size=30`;
  let status;
  let body;
  try {
    const r = await fetchJSON(url, { method: 'GET', headers });
    status = r.status;
    body = r.body;
  } catch (err) {
    // Optional: log tournament-list failures when debugging round resolution
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_fetch_error', slug, message: err.message || String(err) });
    return {
      roundId: null,
      reason: 'FETCH_ERROR',
      fetchStatus: 0,
      detail: err.message || String(err),
    };
  }
  if (status !== 200) {
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_http_error', slug, httpStatus: status, body: snippet(body) });
    return { roundId: null, reason: 'FETCH_FAILED', fetchStatus: status, detail: body };
  }
  const tournaments = body?.data;
  if (!Array.isArray(tournaments)) {
    // console.warn('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'resolve_active_round_invalid_body', slug, httpStatus: status });
    return { roundId: null, reason: 'INVALID_RESPONSE', fetchStatus: status };
  }
  const running = tournaments.filter((t) => String(t?.status || '').toUpperCase() === 'RUNNING');
  const rest = tournaments.filter((t) => String(t?.status || '').toUpperCase() !== 'RUNNING');
  for (const t of [...running, ...rest]) {
    for (const r of t.rounds || []) {
      if (isRoundIntervalActive(r)) {
        // console.log('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'active_round_resolved', slug, roundId: String(r.id), tournamentId: t.id != null ? String(t.id) : undefined });
        return {
          roundId: String(r.id),
          tournamentId: t.id != null ? String(t.id) : undefined,
          fetchStatus: status,
        };
      }
    }
  }
  // console.log('[tournament-intraverse]', { ts: new Date().toISOString(), event: 'no_active_round', slug, tournamentCount: tournaments.length });
  return { roundId: null, reason: 'NO_ACTIVE_ROUND', fetchStatus: status };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressRegexQuery(walletAddress) {
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(String(walletAddress).trim())}$`, 'i') },
  };
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

async function postIntraverseGamePoint({ roundId, walletAddress, roomId, score }) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }
  const body = {
    roundId,
    roomId: String(roomId || `warzone-${Date.now()}`).slice(0, 64),
    score: Number(score),
    walletAddress,
  };
  return fetchJSON(`${BASE_URL}/api/v2/game-point/`, {
    method: 'POST',
    headers,
    body,
  });
}

/**
 * After profile save: delta = max(0, coins - baselineCoin), then baselineCoin := coins.
 * Medals += delta; Intraverse game-point gets `score: delta` (increment since last save).
 * cumulativeDelta in the return value is roundPoints total (sum of deltas) for API compatibility.
 */
async function applyTournamentDeltaOnProfileSave(walletAddress, roundId, roomId) {
  const profile = await PlayerProfile.findOne(walletAddressRegexQuery(walletAddress));
  if (!profile) {
    return { ok: false, reason: 'NO_PROFILE' };
  }

  const coins = Number(profile.PlayerResources?.coin) || 0;
  const w = String(walletAddress).trim();

  let participation = await PlayerRoundParticipation.findOne({
    ...walletAddressRegexQuery(walletAddress),
    roundId: String(roundId),
  });

  let delta = 0;
  let baselineBefore = coins;
  let roundPointsTotal = 0;

  if (!participation) {

    const firstTimeDelta = coins < 500
      ? Math.max(0, Math.floor(coins))
      : Math.floor(Math.random() * (500 - 300 + 1)) + 300; 

    participation = new PlayerRoundParticipation({
      walletAddress: w,
      roundId: String(roundId),
      baselineCoin: coins,
      roundPoints: 0,
      lastUpdated: new Date(),
    });
    await participation.save();
    delta = firstTimeDelta;
    roundPointsTotal = firstTimeDelta;
  } else {
    baselineBefore = Number(participation.baselineCoin) || 0;
    delta = Math.max(0, coins - baselineBefore);
    participation.baselineCoin = coins;
    participation.roundPoints = (Number(participation.roundPoints) || 0) + delta;
    participation.lastUpdated = new Date();
    await participation.save();
    roundPointsTotal = Number(participation.roundPoints) || 0;
  }

  if (delta > 0) {
    if (!profile.PlayerResources) {
      profile.PlayerResources = {
        coin: 1000,
        gem: 0,
        stamina: 0,
        medal: 0,
        tournamentTicket: 0,
      };
    }
    profile.PlayerResources.medal = (Number(profile.PlayerResources.medal) || 0) + delta;
    await profile.save();
  }

  if(delta > 50000){ 
    console.log("STEP 14.1.10: delta > 50000, send to admin",walletAddress,delta);
  }

  let intrabaseStatus;
  let intrabaseBody;
  try {
    /** Intraverse `score` is incremental this save; confirm their API sums increments if they expose a cumulative leaderboard. */
    const iv = await postIntraverseGamePoint({
      roundId: String(roundId),
      walletAddress: w,
      roomId,
      score: delta,
    });
    intrabaseStatus = iv.status;
    intrabaseBody = iv.body;
    const okHttp = intrabaseStatus >= 200 && intrabaseStatus < 300;
    const ivPayloadBase = {
      ts: new Date().toISOString(),
      event: okHttp ? 'game_point_ok' : 'game_point_http_error',
      what: 'intraverse_tournament_score_sync',
      wallet: shortWallet(w),
      roundId: String(roundId),
      profileCoin: coins,
      baselineBeforeSnapshot: baselineBefore,
      deltaSent: delta,
      roundPointsTotal,
      medalAdded: delta,
      httpStatus: intrabaseStatus,
      response: snippet(intrabaseBody),
    };
    if (okHttp) {
      console.log('[tournament-intraverse]', ivPayloadBase);
    } else {
      console.warn('[tournament-intraverse]', ivPayloadBase);
    }
  } catch (err) {
    intrabaseStatus = 0;
    intrabaseBody = { error: err.message || String(err) };
    console.warn('[tournament-intraverse]', {
      ts: new Date().toISOString(),
      event: 'game_point_request_failed',
      what: 'intraverse_tournament_score_sync',
      wallet: shortWallet(w),
      roundId: String(roundId),
      profileCoin: coins,
      baselineBeforeSnapshot: baselineBefore,
      deltaSent: delta,
      roundPointsTotal,
      medalAdded: delta,
      message: err.message || String(err),
    });
  }

  return {
    ok: true,
    roundId: String(roundId),
    delta,
    medalAdded: delta,
    cumulativeDelta: roundPointsTotal,
    intrabaseStatus,
    intrabaseBody,
  };
}

module.exports = {
  applyTournamentDeltaOnProfileSave,
  postIntraverseGamePoint,
  resolveActiveRoundIdFromIntraverse,
};
