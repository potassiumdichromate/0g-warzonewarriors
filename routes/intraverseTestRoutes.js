const express = require('express');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PlayerProfile = require('../models/PlayerProfile');
const TournamentMetadata = require('../models/TournamentMetadata');
const PlayerRoundParticipation = require('../models/PlayerRoundParticipation');

const router = express.Router();

const BASE_URL = process.env.INTRAVERSE_BASE_URL || 'https://api-stage.intraverse.io';
const DEFAULT_GAME_SLUG = process.env.INTRAVERSE_GAME_SLUG || 'warzone-warriors';

function getPlayBaseUrl() {
  if (process.env.INTRAVERSE_PLAY_BASE_URL) {
    return process.env.INTRAVERSE_PLAY_BASE_URL;
  }

  if (BASE_URL.includes('api-stage.intraverse.io')) {
    return 'https://play-stage.intraverse.io';
  }

  if (BASE_URL.includes('api.intraverse.io')) {
    return 'https://play.intraverse.io';
  }

  return 'https://play-stage.intraverse.io';
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

function buildQueryString(source, allowedKeys) {
  const params = new URLSearchParams();

  allowedKeys.forEach((key) => {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value));
    }
  });

  const query = params.toString();
  return query ? `?${query}` : '';
}

function getUserJwt(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const forwardedJwt = String(req.headers['x-user-jwt'] || '').trim();
  if (forwardedJwt.toLowerCase().startsWith('bearer ')) {
    return forwardedJwt.slice(7).trim();
  }

  return forwardedJwt;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const json = Buffer.from(payloadBase64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function pickPrimaryWalletAddress(payload) {
  const wallets = Array.isArray(payload?.wallets) ? payload.wallets : [];
  if (wallets.length === 0) return '';

  const ethereumWallet = wallets.find((item) => String(item?.chain || '').toLowerCase() === 'ethereum');
  if (ethereumWallet?.walletAddress) return String(ethereumWallet.walletAddress).trim().toLowerCase();

  const first = wallets[0];
  return String(first?.walletAddress || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  const normalized = String(walletAddress || '').trim().toLowerCase();
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') },
  };
}

function buildAuthHeaders(req, { includeClientKey = false, includeServerKey = false, includeUserJwt = false } = {}) {
  const headers = {};

  if (includeClientKey && process.env.INTRAVERSE_CLIENT_KEY) {
    headers['x-game-key'] = process.env.INTRAVERSE_CLIENT_KEY;
  }

  if (includeServerKey && process.env.INTRAVERSE_SERVER_KEY) {
    headers['x-game-server-key'] = process.env.INTRAVERSE_SERVER_KEY;
  }

  if (includeUserJwt) {
    const userJwt = getUserJwt(req);
    if (userJwt) {
      headers.Authorization = `Bearer ${userJwt}`;
    }
  }

  return headers;
}

async function proxyToIntraverse(req, res, path, options = {}) {
  try {
    const headers = {
      ...buildAuthHeaders(req, options.auth),
      ...(options.headers || {}),
    };

    const method = String(options.method || 'GET').toUpperCase();
    const response = await fetchJSON(`${BASE_URL}${path}`, {
      method,
      headers,
      body: options.body,
    });

    // Verbose proxy logging (enable when debugging Intraverse / other routes):
    // const isGamePointPost = path === '/api/v2/game-point/' && method === 'POST';
    // if (isGamePointPost) {
    //   const ok = response.status >= 200 && response.status < 300;
    //   const bodyStr =
    //     typeof response.body === 'object'
    //       ? JSON.stringify(response.body)
    //       : String(response.body || '').slice(0, 800);
    //   console.log(
    //     `[intraverse][game-point] Intraverse ${ok ? 'OK' : 'FAILED'} → ${BASE_URL}${path} status=${response.status} body=${bodyStr}`,
    //   );
    // } else {
    //   console.log(`[intraverse] ${method} ${path}`, response.status, JSON.stringify(response.body, null, 2));
    // }
    res.status(response.status).json({ status: response.status, body: response.body });
  } catch (error) {
    console.error(`[intraverse] ${options.method || 'GET'} ${path} failed`, error);
    res.status(500).json({ error: error.message });
  }
}

router.get('/auth/magic-link', (req, res) => {
  const clientKey = String(process.env.INTRAVERSE_CLIENT_KEY || '').trim();
  if (!clientKey) {
    return res.status(500).json({
      success: false,
      message: 'INTRAVERSE_CLIENT_KEY is not configured on the server.',
    });
  }

  const authHash = crypto.randomUUID();
  const playBaseUrl = getPlayBaseUrl();
  const magicLoginUrl = `${playBaseUrl}/magic-login?hash=${encodeURIComponent(authHash)}&game=${encodeURIComponent(clientKey)}`;

  return res.json({
    success: true,
    authHash,
    clientKey,
    playBaseUrl,
    magicLoginUrl,
  });
});

router.post('/auth/user-login', async (req, res) => {
  const authHeader = String(req.headers.authorization || '').trim();
  const bodyToken = String(req.body?.idToken || req.body?.token || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : bodyToken;
  const bodyUserId = String(req.body?.userId || req.body?.user || '').trim();

  if (!token && !bodyUserId) {
    return res.status(400).json({
      success: false,
      message: 'Missing user identity. Provide { userId } or { idToken }.',
    });
  }

  const decoded = token ? decodeJwtPayload(token) : null;
  const intraverseUserId = bodyUserId
    || String(decoded?.user_id || decoded?.sub || '').trim();

  if (!intraverseUserId) {
    return res.status(400).json({
      success: false,
      message: 'Unable to extract userId from payload/token.',
    });
  }

  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'idToken is required to fetch wallet details from Intraverse.',
    });
  }

  const serverKey = String(process.env.INTRAVERSE_SERVER_KEY || '').trim();
  if (!serverKey) {
    return res.status(500).json({
      success: false,
      message: 'INTRAVERSE_SERVER_KEY is not configured on the server.',
    });
  }

  let userGameProfile = null;
  try {
    const response = await fetchJSON(`${BASE_URL}/api/v2/user/${encodeURIComponent(intraverseUserId)}/game`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-game-server-key': serverKey,
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json({
        success: false,
        message: 'Intraverse user lookup failed.',
        intraverseStatus: response.status,
        intraverseBody: response.body,
      });
    }

    userGameProfile = response.body;
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to call Intraverse user lookup API.',
      error: error.message,
    });
  }

  const walletAddress = pickPrimaryWalletAddress(userGameProfile);
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      message: 'No walletAddress found in Intraverse user profile.',
      intraverseUserId,
      intraverseProfile: userGameProfile,
    });
  }

  const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
  const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
  const backendToken = jwt.sign(
    { walletAddress, intraverseUserId },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );

  const now = Math.floor(Date.now() / 1000);
  const userName = String(decoded?.name || userGameProfile?.username || '').trim();

  try {
    const profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(walletAddress));
    if (profile) {
      profile.Intraverse = {
        userId: intraverseUserId,
        userName,
      };
      await profile.save();
    } else {
      await PlayerProfile.create({
        walletAddress,
        Intraverse: {
          userId: intraverseUserId,
          userName,
        },
      });
    }
  } catch (dbError) {
    console.error('[intraverse] failed to persist intraverse profile:', dbError);
  }

  const user = {
    userId: intraverseUserId,
    name: userName,
    roles: Array.isArray(decoded?.roles) ? decoded.roles : [],
    scope: decoded?.scope || '',
    issuer: decoded?.iss || '',
    audience: decoded?.aud || '',
    authTime: decoded?.auth_time || null,
    issuedAt: decoded?.iat || null,
    expiresAt: decoded?.exp || null,
    isExpired: decoded?.exp ? Number(decoded.exp) <= now : null,
    provider: decoded?.firebase?.sign_in_provider || '',
    walletAddress,
  };

  return res.json({
    success: true,
    userLogin: true,
    intraverseUserId,
    walletAddress,
    token: backendToken,
    Intraverse: {
      userId: intraverseUserId,
      userName,
    },
    user,
    intraverseProfile: userGameProfile,
  });
});

router.get('/games', async (req, res) => {
  const query = buildQueryString(req.query, ['size', 'orderBy', 'order', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/public/games${query}`);
});

router.get('/games/:slug', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/public/games/${req.params.slug}`);
});

router.get('/games/:slug/versions', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/public/games/${req.params.slug}/versions`);
});

router.get('/tournaments', async (req, res) => {
  const slug = req.query.slug || DEFAULT_GAME_SLUG;
  const query = buildQueryString(req.query, ['size', 'status', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/tournament/game/${encodeURIComponent(slug)}${query}`);
});

// ── Guild tournament CRUD (requires Intraverse user JWT via Authorization header) ──

router.post('/guild-tournaments', async (req, res) => {
  await proxyToIntraverse(req, res, '/api/v2/guild-tournaments', {
    method: 'POST',
    auth: { includeUserJwt: true },
    body: req.body,
  });
});

router.get('/guild-tournaments/my', async (req, res) => {
  const query = buildQueryString(req.query, ['size', 'status', 'guildId', 'requestedBy', 'key', 'direction']);
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/my${query}`, {
    auth: { includeUserJwt: true },
  });
});

router.get('/guild-tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}`, {
    auth: { includeUserJwt: true },
  });
});

router.patch('/guild-tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}`, {
    method: 'PATCH',
    auth: { includeUserJwt: true },
    body: req.body,
  });
});

router.post('/guild-tournaments/:id/launch', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}/launch`, {
    method: 'POST',
    auth: { includeUserJwt: true },
  });
});

router.get('/guild-tournaments/:id/treasury', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/guild-tournaments/${req.params.id}/treasury`, {
    auth: { includeUserJwt: true },
  });
});

// Must be before /tournaments/:id to avoid Express treating 'slug' as an id
router.get('/tournaments/slug/:slug/active-round', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/slug/${encodeURIComponent(req.params.slug)}/activeRound`);
});

router.get('/tournaments/:id', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}`);
});

router.get('/tournaments/:id/drops', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}/drops/`);
});

router.get('/tournaments/:id/stakes', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}/stakes/`);
});

router.get('/tournaments/:id/projects', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}/projects/`);
});

router.get('/tournaments/:id/wallet-level', async (req, res) => {
  const query = buildQueryString(req.query, ['walletAddress', 'projectId']);
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}/walletLevel${query}`, {
    auth: { includeClientKey: true },
  });
});

router.post('/tournaments/:id/calculate-score', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/tournament/${req.params.id}/calculateScore`, {
    method: 'POST',
    auth: { includeServerKey: true },
    body: req.body,
  });
});

// --- Tournament helpers ---

function isRoundIntervalActive(round) {
  if (!round || !Array.isArray(round.intervals) || round.intervals.length === 0) return false;
  const now = Date.now();
  return round.intervals.some((iv) => now >= iv.startDate && now <= iv.endDate);
}

async function findRoundMetaByRoundId(roundId) {
  const meta = await TournamentMetadata.findOne({ 'rounds.id': roundId }).lean();
  if (!meta || !Array.isArray(meta.rounds)) return { meta: null, round: null };
  const round = meta.rounds.find((r) => r.id === roundId);
  return { meta, round: round || null };
}

// No explicit join: first game-point while the round interval is live creates baseline (delta 0); later points use coin delta vs baseline.
async function computeDifferentialScore(walletAddress, roundId, { kills, deaths, metadata } = {}) {
  const profile = await PlayerProfile.findOne({
    walletAddress: { $regex: new RegExp(`^${walletAddress.trim()}$`, 'i') },
  });
  if (!profile) return { ok: false, reason: 'NO_PROFILE' };

  const { meta, round } = await findRoundMetaByRoundId(roundId);
  if (!round || !isRoundIntervalActive(round)) {
    // console.log(`[intraverse] game-point rejected: round not active or unknown roundId=${roundId}`);
    return { ok: false, reason: 'ROUND_NOT_ACTIVE' };
  }

  const currentCoins = Number(profile.PlayerResources?.coin) || 0;
  let participation = await PlayerRoundParticipation.findOne({
    walletAddress: { $regex: new RegExp(`^${walletAddress.trim()}$`, 'i') },
    roundId,
  });

  if (!participation) {
    participation = new PlayerRoundParticipation({
      walletAddress,
      roundId,
      tournamentId: meta.tournamentId,
      baselineCoin: currentCoins,
      roundPoints: 0,
    });
    await participation.save();
    // console.log(`[intraverse] auto-baseline round=${roundId} wallet=${walletAddress} baseline=${currentCoins}`);
  }

  const previousRoundPoints = Number(participation.roundPoints) || 0;
  const delta = Math.max(0, currentCoins - Number(participation.baselineCoin));
  const expGain = Math.max(0, delta - previousRoundPoints);

  participation.roundPoints = delta;
  if (kills !== undefined) participation.kills = kills;
  if (deaths !== undefined) participation.deaths = deaths;
  if (metadata) participation.metadata = { ...participation.metadata, ...metadata };
  participation.lastUpdated = new Date();
  await participation.save();

  if (expGain > 0) {
    // if (!profile.PlayerProfile) {
    //   profile.PlayerProfile = { level: 1, exp: 0 };
    // }
    profile.PlayerProfile.exp = (Number(profile.PlayerProfile.exp) || 0) + expGain;

    if (!profile.PlayerResources) {
      profile.PlayerResources = {
        coin: 1000,
        gem: 0,
        stamina: 0,
        medal: 0,
        tournamentTicket: 0,
      };
    }
    profile.PlayerResources.medal = (Number(profile.PlayerResources.medal) || 0) + expGain;

    await profile.save();
  }

  // console.log(
  //   `[intraverse] Differential scoring: Total=${currentCoins}, Baseline=${participation.baselineCoin}, Delta=${delta}, expGain=${expGain}`,
  // );
  return { ok: true, delta };
}

async function upsertTournamentFromIntraverse(t) {
  const doc = {
    tournamentId: t.id, name: t.name, slug: t.slug,
    gameId: t.gameId, organizationId: t.organizationId,
    startDate: t.startDate, endDate: t.endDate,
    rounds: (t.rounds || []).map(r => ({
      id: r.id, name: r.name, title: r.title,
      intervals: r.intervals || [], createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
    rules: t.rules || '', lastSynced: new Date(),
  };
  await TournamentMetadata.findOneAndUpdate({ tournamentId: t.id }, doc, { upsert: true, new: true });
  return { id: t.id, name: t.name };
}

// --- Routes ---

// Current saved coin-delta for this wallet + round (for tournament cards)
router.get('/rounds/:roundId/participation', async (req, res) => {
  const walletAddress = req.query.walletAddress;
  if (!walletAddress || !String(walletAddress).trim()) {
    return res.status(400).json({ error: 'walletAddress query is required' });
  }
  try {
    const p = await PlayerRoundParticipation.findOne({
      walletAddress: { $regex: new RegExp(`^${String(walletAddress).trim()}$`, 'i') },
      roundId: req.params.roundId,
    }).lean();
    if (!p) {
      return res.json({ success: true, roundPoints: 0, baselineCoin: null, hasParticipation: false });
    }
    res.json({
      success: true,
      roundPoints: Number(p.roundPoints) || 0,
      baselineCoin: p.baselineCoin,
      hasParticipation: true,
      lastUpdated: p.lastUpdated,
    });
  } catch (err) {
    console.error('[intraverse] participation lookup error:', err);
    res.status(500).json({ error: 'Failed to load participation' });
  }
});

router.post('/game-point', async (req, res) => {
  const { roundId, walletAddress, roomId, kills, deaths, metadata } = req.body;
  if (!roundId || !walletAddress) {
    // console.warn('[intraverse][game-point] rejected: missing roundId or walletAddress');
    return res.status(400).json({ error: 'roundId and walletAddress are required' });
  }
  try {
    const result = await computeDifferentialScore(walletAddress, roundId, { kills, deaths, metadata });
    if (!result.ok) {
      // console.warn('[intraverse][game-point] no Intraverse call:', result.reason, { roundId, walletAddress: String(walletAddress).slice(0, 12) + '…' });
      if (result.reason === 'NO_PROFILE') {
        return res.status(404).json({ error: 'Player profile not found' });
      }
      if (result.reason === 'ROUND_NOT_ACTIVE') {
        return res.status(400).json({
          error: 'This round is not in an active play window, or schedule is not synced yet. Scores are only recorded during the live window.',
        });
      }
      return res.status(500).json({ error: 'Failed to compute score' });
    }

    const intraBody = {
      roundId,
      roomId: String(roomId || `warzone-${Date.now()}`).slice(0, 64),
      score: Number(result.delta),
      walletAddress,
    };
    // const w = String(walletAddress);
    // const walletLog = w.length > 14 ? `${w.slice(0, 10)}…${w.slice(-4)}` : w;
    // console.log(
    //   '[intraverse][game-point] local DB updated; sending to Intraverse',
    //   JSON.stringify({
    //     roundId,
    //     roomId: intraBody.roomId,
    //     score: intraBody.score,
    //     wallet: walletLog,
    //     intraverseBaseUrl: BASE_URL,
    //   }),
    // );

    await proxyToIntraverse(req, res, '/api/v2/game-point/', {
      method: 'POST',
      auth: { includeServerKey: true },
      body: intraBody,
    });
  } catch (err) {
    console.error('[intraverse] game-point error:', err);
    res.status(500).json({ error: 'Failed to process game point' });
  }
});

router.post('/sync-tournaments', async (req, res) => {
  try {
    const slug = req.query.slug || DEFAULT_GAME_SLUG;
    const query = buildQueryString({ ...req.query, size: req.query.size || 10 }, ['size', 'status', 'key', 'direction']);
    const response = await fetchJSON(`${BASE_URL}/api/v2/tournament/game/${encodeURIComponent(slug)}${query}`, {
      method: 'GET',
      headers: buildAuthHeaders(req, { includeServerKey: true }),
    });
    if (response.status !== 200) {
      return res.status(response.status).json({ message: 'Failed to fetch tournaments from Intraverse', body: response.body });
    }
    const synced = await Promise.all((response.body?.data || []).map(upsertTournamentFromIntraverse));
    res.json({ success: true, synced });
  } catch (err) {
    console.error('[intraverse] sync-tournaments error:', err);
    res.status(500).json({ error: 'Failed to sync tournaments' });
  }
});

router.get('/tournaments/:id/rounds/:roundId/players', async (req, res) => {
  try {
    const players = await PlayerRoundParticipation.find({ roundId: req.params.roundId }).sort({ roundPoints: -1 });
    res.json({ success: true, roundId: req.params.roundId, players });
  } catch (err) {
    console.error('[intraverse] get round players error:', err);
    res.status(500).json({ error: 'Failed to fetch round players' });
  }
});

router.get('/game-point/:roundId', async (req, res) => {
  await proxyToIntraverse(req, res, `/api/v2/game-point/game-client/${req.params.roundId}`, {
    auth: { includeClientKey: true, includeUserJwt: true },
  });
});

module.exports = router;
