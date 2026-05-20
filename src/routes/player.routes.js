const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const auth   = require("../middleware/auth");
const ctrl   = require("../controllers/player.controller");

const limiter = (max, windowMs = 60_000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

// Profile endpoints
router.get("/profile",          limiter(60), auth, ctrl.getProfile);
router.patch("/profile",        limiter(30), auth, ctrl.patchProfile);
router.get("/profile/:wallet",  limiter(60),       ctrl.getPublicProfile);

// Leaderboard
router.get("/leaderboard",      limiter(30),       ctrl.getLeaderboard);

// Blockchain stats
router.get("/sessions",         limiter(30), auth, ctrl.getOnChainSessions);
router.get("/blockchain-stats", limiter(30), auth, ctrl.getBlockchainStats);

module.exports = router;
