const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const crossGameRewardController = require("../controllers/crossGameRewardController");

const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/internal/cross-game/gun-reward", limiter, crossGameRewardController.grantGunReward);

module.exports = router;
