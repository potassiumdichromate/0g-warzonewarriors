const { predict, strategyPredict } = require("../services/BehaviorTrainer");

const FALLBACK_ACTION = { horizontal: 0, vertical: 0, jump: false, shoot: false, grenade: false };

// POST /ai/predict
// Hybrid: TF.js if trained → 0G Compute LLM fallback → neutral safe action.
// Unity should call this per frame (TF.js path) or every ~2s (0G Compute path).
// The response includes a "source" field so Unity knows which layer responded.
exports.predictAction = async (req, res) => {
  try {
    const { wallet, state } = req.body;
    if (!wallet || !state) {
      return res.status(400).json({ error: "wallet and state are required" });
    }
    const result = await predict(wallet, state);
    res.json(result);
  } catch (err) {
    console.error("[ai] predict error:", err.message);
    res.json({ action: FALLBACK_ACTION, confidence: 0, source: "fallback" });
  }
};

// POST /ai/strategy
// Always routes through 0G Compute with verify_tee: true.
// Returns a TEE-signed action decision — use this for Arena matches where
// you need a cryptographic proof that the AI decision was not tampered with.
//
// Response includes teeVerified, providerAddress, chatId for on-chain audit trail.
// NOTE: ~200ms latency. Cache result on the Unity side for 1–2 seconds.
exports.strategyAction = async (req, res) => {
  try {
    const { wallet, state } = req.body;
    if (!wallet || !state) {
      return res.status(400).json({ error: "wallet and state are required" });
    }

    if (!process.env.ZG_COMPUTE_API_KEY) {
      return res.status(503).json({
        error: "0G Compute not configured",
        hint:  "Set ZG_COMPUTE_API_KEY and ZG_AI_MODEL in .env"
      });
    }

    const result = await strategyPredict(wallet, state);
    res.json(result);
  } catch (err) {
    console.error("[ai] strategy error:", err.message);
    res.json({ action: FALLBACK_ACTION, confidence: 0, source: "fallback" });
  }
};
