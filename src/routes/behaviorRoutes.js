const router = require("express").Router();
const ctrl   = require("../controllers/behaviorController");

// Unity uploads a batch of gameplay samples → stored on 0G Storage
router.post("/upload",          ctrl.uploadSamples);

// Check sample count, training status, and 0G model link
router.get("/status/:wallet",   ctrl.getStatus);

// Manually trigger re-training (e.g. after error or new batches)
router.post("/retrain/:wallet", ctrl.retrain);

module.exports = router;
