/**
 * player.controller — Warzone player profile REST endpoints.
 *
 * GET    /player/profile          — returns full WarzonePlayerProfile (auth)
 * PATCH  /player/profile          — partial update (auth)
 * GET    /player/profile/:wallet  — public profile (no wallet key)
 * GET    /player/leaderboard      — top players by coin (public)
 */

const PlayerProfile    = require("../models/PlayerProfile");
const PlayerSaveRecord = require("../models/PlayerSaveRecord");
const sessionService     = require("../blockchain/sessionService");
const leaderboardService = require("../blockchain/leaderboardService");

exports.getProfile = async (req, res) => {
  try {
    let profile = await PlayerProfile.findOne({ walletAddress: req.walletAddress });

    if (!profile) {
      profile = await PlayerProfile.create({ walletAddress: req.walletAddress });
    }

    return res.json(profile.toObject({ getters: true }));
  } catch (err) {
    console.error("getProfile error:", err);
    return res.status(500).json({ error: "Failed to load player profile" });
  }
};

exports.patchProfile = async (req, res) => {
  try {
    // Allow updating any top-level field except walletAddress
    const body = req.body || {};
    delete body.walletAddress;

    // Build a flat $set from the body to allow partial nested updates
    const $set = {};
    for (const [key, val] of Object.entries(body)) {
      $set[key] = val;
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const profile = await PlayerProfile.findOneAndUpdate(
      { walletAddress: req.walletAddress },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json(profile.toObject({ getters: true }));
  } catch (err) {
    console.error("patchProfile error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

exports.getPublicProfile = async (req, res) => {
  try {
    const wallet  = req.params.wallet?.toLowerCase();
    if (!wallet) return res.status(400).json({ error: "wallet param required" });

    const profile = await PlayerProfile.findOne({ walletAddress: wallet }).lean();
    if (!profile) return res.status(404).json({ error: "Player not found" });

    // Strip wallet key from public response
    const { walletAddress: _w, ...publicData } = profile;

    return res.json(publicData);
  } catch (err) {
    console.error("getPublicProfile error:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit) || 100, 200);
    const userWallet = req.walletAddress || req.query.wallet;

    const players = await PlayerProfile.find(
      {},
      {
        walletAddress:    1,
        PlayerResources:  1,
        PlayerProfile:    1,
        _id:              0
      }
    )
      .sort({ "PlayerResources.coin": -1 })
      .limit(limit)
      .lean();

    const result = players.map((p, i) => ({
      rank:            i + 1,
      walletAddress:   p.walletAddress,
      displayName:     `Warrior_${p.walletAddress.slice(2, 8)}`,
      PlayerResources: p.PlayerResources,
      PlayerProfile:   p.PlayerProfile
    }));

    // Record leaderboard snapshot on-chain (non-critical)
    if (userWallet && result.length > 0) {
      const userEntry = result.find(p => p.walletAddress.toLowerCase() === userWallet.toLowerCase());
      if (userEntry) {
        leaderboardService.saveLeaderboardOnChain(
          userWallet, userWallet,
          {
            userScore:    userEntry.PlayerResources?.coin ?? 0,
            userStanding: userEntry.rank,
            topPlayers:   result.slice(0, 10).map(p => ({
              walletAddress: p.walletAddress,
              highScore:     p.PlayerResources?.coin ?? 0
            }))
          }
        ).catch(err => console.error("Leaderboard on-chain failed (non-critical):", err.message));
      }
    }

    return res.json({ leaderboard: result, total: result.length });
  } catch (err) {
    console.error("getLeaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

// Session-related pass-through endpoints
exports.getOnChainSessions = async (req, res) => {
  try {
    const sessions     = await sessionService.getPlayerSessions(req.walletAddress);
    const sessionCount = await sessionService.getSessionCount(req.walletAddress);
    res.json({
      success: true,
      sessions,
      count: sessionCount,
      contractAddress: process.env.SESSION_CONTRACT_ADDRESS,
      explorerUrl: `https://chainscan.0g.ai/address/${process.env.SESSION_CONTRACT_ADDRESS}`
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

exports.getBlockchainStats = async (req, res) => {
  try {
    const sessionCount    = await sessionService.getSessionCount(req.walletAddress);
    const totalSessions   = await sessionService.getTotalSessions();
    const owner           = await sessionService.getOwner();
    const contractInfo    = sessionService.getContractInfo();
    const totalSnapshots  = await leaderboardService.getTotalSnapshots();
    res.json({
      success: true,
      stats: {
        sessions:    { yourSessions: sessionCount, totalSessions, contractOwner: owner, ...contractInfo },
        leaderboard: { totalSnapshots, ...leaderboardService.getContractInfo() }
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch blockchain stats" });
  }
};
