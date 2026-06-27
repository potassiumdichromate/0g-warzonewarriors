const HIGHWAY_HUSTLE_REWARD_ID = "lamborghini";
const DEFAULT_COIN_THRESHOLD = 3000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_REWARD_GRANT_SECRET = "warzone-highway-lamborghini-cross-game-v1";

function normalizeWalletAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function getConfig() {
  const baseUrl = String(
    process.env.HIGHWAY_HUSTLE_API_URL || "https://highway-hustle-backend.onrender.com/api",
  ).replace(/\/+$/, "");

  return {
    baseUrl,
    grantSecret: String(
      process.env.HIGHWAY_HUSTLE_REWARD_GRANT_SECRET || DEFAULT_REWARD_GRANT_SECRET,
    ).trim(),
    threshold: Number(process.env.HIGHWAY_HUSTLE_LAMBORGHINI_COIN_THRESHOLD || DEFAULT_COIN_THRESHOLD),
    timeoutMs: Number(process.env.HIGHWAY_HUSTLE_REWARD_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

async function grantLamborghiniIfEligible(player) {
  const walletAddress = normalizeWalletAddress(player?.walletAddress);
  const coinBalance = Number(player?.PlayerResources?.coin || 0);
  const config = getConfig();

  if (!walletAddress || !Number.isFinite(coinBalance) || coinBalance < config.threshold) {
    return { eligible: false, granted: false, walletAddress, coinBalance };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/player/rewards/grant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-contest-grant-secret": config.grantSecret,
      },
      body: JSON.stringify({
        walletAddress,
        rewardId: HIGHWAY_HUSTLE_REWARD_ID,
        rewardType: "vehicle",
        note: `Unlocked by reaching ${config.threshold} coins in Warzone Warriors`,
      }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success !== true) {
      throw new Error(
        `Highway Hustle reward grant failed (${response.status}): ${body?.error || "unknown error"}`,
      );
    }

    return {
      eligible: true,
      granted: true,
      created: body.created === true,
      walletAddress,
      coinBalance,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function queueLamborghiniRewardCheck(player, source = "unknown") {
  setImmediate(async () => {
    try {
      const result = await grantLamborghiniIfEligible(player);
      if (result.eligible) {
        console.log("[cross-game-reward] Highway Hustle Lamborghini synchronized", {
          source,
          walletAddress: result.walletAddress,
          coinBalance: result.coinBalance,
          created: result.created,
        });
      }
    } catch (error) {
      console.error("[cross-game-reward] Highway Hustle Lamborghini synchronization failed", {
        source,
        walletAddress: normalizeWalletAddress(player?.walletAddress),
        message: error?.message || String(error),
      });
    }
  });
}

module.exports = {
  grantLamborghiniIfEligible,
  queueLamborghiniRewardCheck,
};
