const {
  grantWarzoneGunReward,
  verifyRewardSecret,
} = require("../services/crossGameGunRewardService");

async function grantGunReward(req, res) {
  try {
    if (!verifyRewardSecret(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized cross-game reward request",
      });
    }

    const reward = await grantWarzoneGunReward({
      walletAddress: req.body?.walletAddress || req.body?.wallet || req.body?.user,
      sourceGame: String(req.body?.sourceGame || "").trim(),
      difficulty: String(req.body?.difficulty || "").trim(),
      metric: String(req.body?.metric || "").trim(),
      value: req.body?.value,
    });

    return res.status(reward.created ? 201 : 200).json({
      success: true,
      granted: true,
      created: reward.created,
      reward,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || "Failed to grant cross-game reward",
    });
  }
}

module.exports = { grantGunReward };
