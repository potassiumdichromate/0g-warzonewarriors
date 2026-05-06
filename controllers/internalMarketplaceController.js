const PlayerProfile = require('../models/PlayerProfile');

function normalizeWalletAddress(walletAddress) {
  return String(walletAddress || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  const normalized = normalizeWalletAddress(walletAddress);
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') },
  };
}

function readInternalToken(req) {
  const bearer = req.header('Authorization') || '';
  if (bearer.startsWith('Bearer ')) return bearer.replace('Bearer ', '').trim();
  return String(req.header('x-internal-token') || '').trim();
}

/**
 * POST /warzone/internal/marketplace-sync
 *
 * Body:
 * {
 *   "walletAddress": "0x...",
 *   "coinsDelta": 100,   // optional (can be negative)
 *   "gemsDelta": 10,     // optional (can be negative)
 *   "orderId": "ord_...",// optional
 *   "reason": "..."      // optional
 * }
 */
exports.syncMarketplacePurchase = async (req, res) => {
  try {
    const configuredToken = String(process.env.INTERNAL_MARKETPLACE_SYNC_TOKEN || '').trim();
    if (!configuredToken) {
      return res.status(503).json({
        ok: false,
        message: 'Internal sync token is not configured',
      });
    }

    const incomingToken = readInternalToken(req);
    if (!incomingToken || incomingToken !== configuredToken) {
      return res.status(401).json({ ok: false, message: 'Unauthorized internal sync request' });
    }

    const walletAddress = normalizeWalletAddress(req.body?.walletAddress);
    const coinsDeltaRaw = req.body?.coinsDelta;
    const gemsDeltaRaw = req.body?.gemsDelta;
    const orderId = req.body?.orderId ? String(req.body.orderId).trim() : null;
    const reason = req.body?.reason ? String(req.body.reason).trim() : 'marketplace_sync';

    if (!walletAddress) {
      return res.status(400).json({ ok: false, message: 'walletAddress is required' });
    }

    const coinsDelta = Number(coinsDeltaRaw || 0);
    const gemsDelta = Number(gemsDeltaRaw || 0);
    if (!Number.isFinite(coinsDelta) || !Number.isFinite(gemsDelta)) {
      return res.status(400).json({ ok: false, message: 'coinsDelta/gemsDelta must be numbers' });
    }
    if (coinsDelta === 0 && gemsDelta === 0) {
      return res.status(400).json({ ok: false, message: 'At least one of coinsDelta or gemsDelta is required' });
    }

    let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(walletAddress));
    if (!profile) {
      return res.status(404).json({ ok: false, message: 'Player not found' });
    }

    profile.PlayerResources = profile.PlayerResources || {
      coin: 0,
      gem: 0,
      stamina: 0,
      medal: 0,
      tournamentTicket: 0,
    };

    const prevCoin = Number(profile.PlayerResources.coin || 0);
    const prevGem = Number(profile.PlayerResources.gem || 0);
    const nextCoin = Math.max(0, prevCoin + coinsDelta);
    const nextGem = Math.max(0, prevGem + gemsDelta);

    profile.PlayerResources.coin = nextCoin;
    profile.PlayerResources.gem = nextGem;

    if (!profile.PlayerAchievementData) profile.PlayerAchievementData = {};
    profile.PlayerAchievementData.MARKETPLACE_LAST_SYNC = {
      type: 999,
      claimTimes: 0,
      progress: 0,
      isReady: false,
      orderId,
      reason,
      coinsDelta,
      gemsDelta,
      syncedAt: new Date().toISOString(),
    };

    await profile.save();

    return res.json({
      ok: true,
      message: 'Marketplace resource sync applied',
      data: {
        walletAddress: profile.walletAddress,
        orderId,
        reason,
        before: { coin: prevCoin, gem: prevGem },
        delta: { coin: coinsDelta, gem: gemsDelta },
        after: { coin: nextCoin, gem: nextGem },
      },
    });
  } catch (err) {
    console.error('internal marketplace sync error:', err);
    return res.status(500).json({ ok: false, message: 'Internal sync failed' });
  }
};
