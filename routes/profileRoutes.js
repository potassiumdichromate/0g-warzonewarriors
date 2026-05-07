const express = require('express');
const router = express.Router();
const { getProfile, saveProfile, getLeaderboard, checkNameExistance, getDailyQuests,
  getDailyQuestByType, getAchieveQuestByType, saveName, getName, login } = require('../controllers/profileController');
const { getSpecificDBLeaderboard } = require('../controllers/newDBController');
const verifyUser = require('../routes/middleware/verifyUser');
const rateLimiter = require('../routes/middleware/rateLimiter');

const iapController = require('../controllers/iap.controller');
const trashTalkController = require('../controllers/trashTalkController');
const internalMarketplaceController = require('../controllers/internalMarketplaceController');

// ── 0G decentralised endpoints ────────────────────────────────────────────────
const {
  saveBinary,
  loadBinary,
  getSaveMetadata,
  verifySave,
  getDecentralizedLeaderboard,
  getDashboard,
  getSaveHistory,
  getSavePipeline,
  getProof,
  getNetworkStatus,
} = require('../controllers/zgController');

// Raw binary body parser — applied only to the binary save route
const rawBinaryParser = express.raw({ type: 'application/octet-stream', limit: '5mb' });

// Rate limiters tuned per endpoint cost
const saveBinaryLimiter   = rateLimiter({ windowMs: 60_000, max: 10,  message: 'Save rate limit exceeded — max 10 saves/min' });
const loadBinaryLimiter   = rateLimiter({ windowMs: 60_000, max: 30,  message: 'Load rate limit exceeded — max 30 loads/min' });
const metadataLimiter     = rateLimiter({ windowMs: 60_000, max: 60,  message: 'Metadata rate limit exceeded' });
const verifyLimiter       = rateLimiter({ windowMs: 60_000, max: 20,  message: 'Verify rate limit exceeded — max 20 verifications/min' });
const leaderboardLimiter  = rateLimiter({ windowMs: 60_000, max: 30,  message: 'Leaderboard rate limit exceeded' });
const dashboardLimiter    = rateLimiter({ windowMs: 60_000, max: 60,  message: 'Dashboard rate limit exceeded' });
const historyLimiter      = rateLimiter({ windowMs: 60_000, max: 30,  message: 'History rate limit exceeded' });
const pipelineLimiter     = rateLimiter({ windowMs: 60_000, max: 60,  message: 'Pipeline rate limit exceeded' });
const proofLimiter        = rateLimiter({ windowMs: 60_000, max: 30,  message: 'Proof rate limit exceeded' });
const networkLimiter      = rateLimiter({ windowMs: 60_000, max: 20,  message: 'Network status rate limit exceeded' });


// ── 0G Storage — binary save / load ──────────────────────────────────────────
//
// POST /save/binary
//   Body:    raw msgpack binary (Content-Type: application/octet-stream)
//   Headers: Authorization: Bearer <jwt>, X-Save-Index (optional)
//
// Wallet comes from the JWT — issued at login, passed through the React Native
// iframe session. No wallet popup or signing prompt required in-game.
router.post('/save/binary',
  saveBinaryLimiter,
  verifyUser,
  rawBinaryParser,
  saveBinary,
);

// GET /load/binary
//   Response: raw msgpack binary
//   Headers:  X-Root-Hash, X-Save-Index, X-Da-Status, X-Checksum-Sha256
//
// JWT wallet is used as the lookup key — player always loads their own save.
router.get('/load/binary',
  loadBinaryLimiter,
  verifyUser,
  loadBinary,
);

// GET /save/metadata?wallet=0x...
//   Public metadata (rootHash, saveIndex, DA status, compute verdict).
//   No auth — metadata is not sensitive game data.
router.get('/save/metadata', metadataLimiter, getSaveMetadata);

// GET /verify?wallet=0x...
//   4-layer integrity check: DB record + DA proof + file checksum + compute.
//   Public — anyone can verify the integrity of a save.
router.get('/verify', verifyLimiter, verifySave);

// GET /leaderboard/decentralized
//   Backed by coinSnapshot stored in MongoDB, sourced from 0G DA.
//   Public — leaderboards are always public.
router.get('/leaderboard/decentralized', leaderboardLimiter, getDecentralizedLeaderboard);

// ── 0G UX endpoints — makes the decentralized layer visible to users ──────────

// GET /dashboard
//   All-in-one player profile card. One call for the entire 0G profile screen.
//   Returns: trust score, rank, save stats, latest pipeline status, on-chain record.
router.get('/dashboard', dashboardLimiter, verifyUser, getDashboard);

// GET /save/history?page=1&limit=10
//   Paginated save timeline — every save with its pipeline status badges.
router.get('/save/history', historyLimiter, verifyUser, getSaveHistory);

// GET /save/pipeline/:rootHash
//   Live step-by-step pipeline progress for one save (poll after POST /save/binary).
//   Public — rootHash is already a public content address.
router.get('/save/pipeline/:rootHash', pipelineLimiter, getSavePipeline);

// GET /proof/:rootHash
//   Shareable public proof card — anyone can verify this save is real.
router.get('/proof/:rootHash', proofLimiter, getProof);

// GET /network/status
//   Live health of all 0G services (Storage, Chain, DA, Compute).
//   Frontend shows a status banner so users understand delays.
router.get('/network/status', networkLimiter, getNetworkStatus);

// ── Legacy JSON API (unchanged — backward compat for existing Unity builds) ──
router.get('/', getProfile);
router.post('/', saveProfile);
router.get('/dailyQuests', getDailyQuests);
router.get('/dailyQuests/type/:type', getDailyQuestByType);
router.get('/achieveQuests/type/:type', getAchieveQuestByType);
router.get('/leaderboard', getLeaderboard);
router.get('/leaderboard/allTime',getSpecificDBLeaderboard)
router.post('/name', checkNameExistance);
router.post('/saveName', verifyUser, saveName);
router.get('/name', verifyUser, getName);
router.post('/login', login);

router.post('/trash-talk/generate', trashTalkController.generateTrashTalk);
router.get('/trash-talk/line', trashTalkController.getTrashLine);

router.get("/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

router.post('/iap/purchase', verifyUser, iapController.purchase);
router.get('/iap/purchase-status', verifyUser, iapController.getPurchaseStatus);
// Legacy alias for FE compatibility
router.post('/api/v1/player/iap/purchase', verifyUser, iapController.purchase);
router.get('/api/v1/player/iap/purchase-status', verifyUser, iapController.getPurchaseStatus);

// Internal marketplace sync endpoint (server-to-server; token protected)
router.post('/internal/marketplace-sync', internalMarketplaceController.syncMarketplacePurchase);

// Optional: expose pricing for Coins/Gems so FE can render store
router.get('/iap/pricing', (req, res) => {
  // Keep in sync with controllers/iap.controller.js
  const currency = 'ETH';
  const coinPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '500', amount: 500, priceEth: '2', price: 2, currency },
    { product: '1000', amount: 1000, priceEth: '4', price: 4, currency },
    { product: '2000', amount: 2000, priceEth: '7.5', price: 7.5, currency },
  ];
  const gemPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '300', amount: 300, priceEth: '1.5', price: 1.5, currency },
    { product: '500', amount: 500, priceEth: '2.5', price: 2.5, currency },
    { product: '1000', amount: 1000, priceEth: '5', price: 5, currency },
  ];

  res.json({ ok: true, data: { coins: coinPacks, gems: gemPacks, currency } });
});
// Legacy alias for FE compatibility
router.get('/api/v1/player/iap/pricing', (req, res) => {
  const currency = 'STT';
  const coinPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '500', amount: 500, priceEth: '2', price: 2, currency },
    { product: '1000', amount: 1000, priceEth: '4', price: 4, currency },
    { product: '2000', amount: 2000, priceEth: '7.5', price: 7.5, currency },
  ];
  const gemPacks = [
    { product: '100', amount: 100, priceEth: '0.5', price: 0.5, currency },
    { product: '300', amount: 300, priceEth: '1.5', price: 1.5, currency },
    { product: '500', amount: 500, priceEth: '2.5', price: 2.5, currency },
    { product: '1000', amount: 1000, priceEth: '5', price: 5, currency },
  ];

  res.json({ ok: true, data: { coins: coinPacks, gems: gemPacks, currency } });
});

module.exports = router;
