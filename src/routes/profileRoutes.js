const router    = require("express").Router();
const rateLimit = require("express-rate-limit");
const express   = require("express");
const auth      = require("../middleware/auth");
const zg        = require("../controllers/zgController");

const limiter = (max, windowMs = 60_000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

// Binary save/load — mounted BEFORE legacy player routes
router.post(
  "/save/binary",
  limiter(10),
  auth,
  express.raw({ type: "application/octet-stream", limit: "5mb" }),
  zg.saveBinary
);

router.get("/load/binary",               limiter(30), auth, zg.loadBinary);
router.get("/save/metadata",             limiter(60),       zg.getSaveMetadata);
router.get("/verify",                    limiter(20),       zg.verifySave);
router.get("/leaderboard/decentralized", limiter(30),       zg.getDecentralizedLeaderboard);

module.exports = router;
