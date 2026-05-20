const router    = require("express").Router();
const rateLimit = require("express-rate-limit");
const auth      = require("../controllers/authController");

const limiter = (max, windowMs = 60_000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

router.get("/nonce", limiter(10), auth.getNonce);
router.post("/login", limiter(5), auth.login);

module.exports = router;
