const router = require("express").Router();
const ctrl   = require("../controllers/aiController");

// Hybrid inference: TF.js → 0G Compute fallback → neutral safe action
// "source" field in response tells Unity which layer answered
router.post("/predict",  ctrl.predictAction);

// 0G Compute only, always TEE-verified — for Arena fairness proofs
// ~200ms latency; cache on Unity side for 1-2 seconds
router.post("/strategy", ctrl.strategyAction);

module.exports = router;
