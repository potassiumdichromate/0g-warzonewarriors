const express = require('express');
const router = express.Router();
const { getProfile, saveProfile, getLeaderboard, checkNameExistance, getDailyQuests,
  getDailyQuestByType, getAchieveQuestByType, saveName, getName, login } = require('../controllers/profileController');
const { getSpecificDBLeaderboard } = require('../controllers/newDBController');
const verifyUser = require('../routes/middleware/verifyUser');

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
} = require('../controllers/zgController');

// Raw binary body parser — applied only to the binary save route
const rawBinaryParser = express.raw({ type: 'application/octet-stream', limit: '5mb' });


// ── 0G Storage — binary save / load (Unity native path) ─────────────────────
// POST body: raw msgpack binary (Content-Type: application/octet-stream)
// Header:    X-Wallet-Address: 0x...
// Header:    X-Save-Index: <int>  (optional, for rollback protection)
router.post('/save/binary', rawBinaryParser, saveBinary);

// GET response: raw msgpack binary (Content-Type: application/octet-stream)
// Header:    X-Root-Hash, X-Save-Index, X-Da-Status
router.get('/load/binary', loadBinary);

// Metadata: rootHash, saveIndex, DA commitment, compute verdict
router.get('/save/metadata', getSaveMetadata);

// 4-layer integrity check: DB record + DA proof + file checksum + compute
router.get('/verify', verifySave);

// Leaderboard backed by 0G DA — scores have BLS signatures from DA nodes
router.get('/leaderboard/decentralized', getDecentralizedLeaderboard);

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
