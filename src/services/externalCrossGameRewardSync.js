const { grantWarzoneGunReward } = require("./crossGameGunRewardService");

const EXTERNAL_ENDPOINTS = Object.freeze({
  zeroDashLeaderboard: "https://zerog-zerodash.onrender.com/player/leaderboard",
  zeroGpoolLocal: "https://zerogpoolgame.onrender.com/api/cross-game/local",
  highwayHustleLocal: "https://highway-hustle-backend.onrender.com/api/cross-game/local",
});

function normalizeWalletAddress(value) {
  return String(value || "").trim().toLowerCase();
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    return body?.data || body;
  } finally {
    clearTimeout(timeout);
  }
}

function isMediumOrHard(difficulty) {
  return difficulty === "medium" || difficulty === "hard";
}

async function syncZeroDash(walletAddress) {
  const url = `${EXTERNAL_ENDPOINTS.zeroDashLeaderboard}?wallet=${encodeURIComponent(walletAddress)}`;
  const payload = await fetchJsonWithTimeout(url);
  const best = Number(payload?.userScore || 0);
  if (best < 8) return { sourceGame: "zeroDash", eligible: false, value: best };

  return grantWarzoneGunReward({
    walletAddress,
    sourceGame: "zeroDash",
    difficulty: best >= 10 ? "hard" : "medium",
    metric: "best",
    value: best,
  });
}

async function syncZeroGpool(walletAddress) {
  const url = `${EXTERNAL_ENDPOINTS.zeroGpoolLocal}?walletAddress=${encodeURIComponent(walletAddress)}`;
  const payload = await fetchJsonWithTimeout(url);
  const crossGame = payload?.crossGame;
  if (!isMediumOrHard(crossGame?.difficulty)) {
    return { sourceGame: "zerogool", eligible: false, value: crossGame?.value || 0 };
  }

  return grantWarzoneGunReward({
    walletAddress,
    sourceGame: "zerogool",
    difficulty: crossGame.difficulty,
    metric: crossGame.metric,
    value: crossGame.value,
  });
}

async function syncHighwayHustle(walletAddress) {
  const url = `${EXTERNAL_ENDPOINTS.highwayHustleLocal}?walletAddress=${encodeURIComponent(walletAddress)}`;
  const payload = await fetchJsonWithTimeout(url);
  const crossGame = payload?.crossGame;
  if (!isMediumOrHard(crossGame?.difficulty)) {
    return { sourceGame: "highwayHustle", eligible: false, value: crossGame?.value || 0 };
  }

  return grantWarzoneGunReward({
    walletAddress,
    sourceGame: "highwayHustle",
    difficulty: crossGame.difficulty,
    metric: crossGame.metric,
    value: crossGame.value,
  });
}

async function syncExternalCrossGameRewards(walletAddress) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) return [];

  const tasks = [
    ["zeroDash", () => syncZeroDash(wallet)],
    ["zerogool", () => syncZeroGpool(wallet)],
    ["highwayHustle", () => syncHighwayHustle(wallet)],
  ];

  return Promise.all(tasks.map(async ([sourceGame, task]) => {
    try {
      return { sourceGame, ok: true, result: await task() };
    } catch (error) {
      return {
        sourceGame,
        ok: false,
        error: error?.message || "External cross-game sync failed",
      };
    }
  }));
}

function queueExternalCrossGameRewards(walletAddress, source = "unknown") {
  setImmediate(async () => {
    try {
      const results = await syncExternalCrossGameRewards(walletAddress);
      console.log("[cross-game-warzone-pull-sync] complete", {
        source,
        walletAddress: normalizeWalletAddress(walletAddress),
        results,
      });
    } catch (error) {
      console.error("[cross-game-warzone-pull-sync] failed", {
        source,
        walletAddress: normalizeWalletAddress(walletAddress),
        message: error?.message || String(error),
      });
    }
  });
}

module.exports = {
  EXTERNAL_ENDPOINTS,
  queueExternalCrossGameRewards,
  syncExternalCrossGameRewards,
};
