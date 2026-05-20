const router    = require("express").Router();
const rateLimit = require("express-rate-limit");
const auth      = require("../middleware/auth");
const ux        = require("../controllers/zgUXController");

const limiter = (max, windowMs = 60_000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

// ── Auth-required ─────────────────────────────────────────────────────────────
router.get("/dashboard",      limiter(30), auth, ux.getDashboard);
router.get("/activity",       limiter(30), auth, ux.getActivity);
router.get("/badge",          limiter(30), auth, ux.getBadge);
router.get("/player/history", limiter(30), auth, ux.getSaveHistory);

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/network",                   limiter(20), ux.getNetworkStatus);
router.get("/stats",                     limiter(30), ux.getGlobalStats);
router.get("/saves/recent",              limiter(30), ux.getRecentSaves);
router.get("/compute/stats",             limiter(20), ux.getComputeStats);
router.get("/player/overview/:wallet",   limiter(30), ux.getPlayerOverview);
router.get("/leaderboard/verified",      limiter(30), ux.getVerifiedLeaderboard);
router.get("/proof/:wallet/:saveIndex",  limiter(20), ux.getProof);
router.get("/explorer/:wallet",          limiter(30), ux.getWalletExplorer);

module.exports = router;
