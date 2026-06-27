const HIGHWAY_HUSTLE_REWARD_ID = "lamborghini";
const DEFAULT_COIN_THRESHOLD = 3000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_REWARD_GRANT_SECRET = "warzone-highway-lamborghini-cross-game-v1";

const PlayerProfile = require("../models/PlayerProfile");
const PlayerSaveRecord = require("../models/PlayerSaveRecord");

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

function readCoinBalance(value) {
  return Number(
    value?.PlayerResources?.coin ??
    value?.coinSnapshot ??
    value?.coin ??
    0
  );
}

async function resolveRewardSubject(value) {
  const walletAddress = normalizeWalletAddress(value?.walletAddress || value);
  const directCoinBalance = readCoinBalance(value);

  if (walletAddress && directCoinBalance > 0) {
    return { walletAddress, coinBalance: directCoinBalance, coinSource: "input" };
  }

  if (!walletAddress) {
    return { walletAddress: "", coinBalance: 0, coinSource: "missing-wallet" };
  }

  const [profile, latestSave] = await Promise.all([
    PlayerProfile.findOne({ walletAddress }).lean(),
    PlayerSaveRecord.findOne({ walletAddress }).sort({ saveIndex: -1 }).lean(),
  ]);

  const profileCoins = readCoinBalance(profile);
  const saveCoins = readCoinBalance(latestSave);

  return {
    walletAddress,
    coinBalance: Math.max(profileCoins, saveCoins),
    coinSource: saveCoins > profileCoins ? "latest-save" : "profile",
  };
}

async function grantLamborghiniIfEligible(player) {
  const { walletAddress, coinBalance, coinSource } = await resolveRewardSubject(player);
  const config = getConfig();

  if (!walletAddress || !Number.isFinite(coinBalance) || coinBalance < config.threshold) {
    return { eligible: false, granted: false, walletAddress, coinBalance, coinSource };
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
      coinSource,
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
          coinSource: result.coinSource,
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
