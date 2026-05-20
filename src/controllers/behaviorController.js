const AIRecord       = require("../models/AIRecord");
const { uploadBuffer }                     = require("../services/ZeroGStorage");
const { trainForWallet, MIN_SAMPLES }      = require("../services/BehaviorTrainer");

// POST /behavior/upload
// Body: { wallet, sessionId?, samples: [...] }
// Uploads the sample batch to 0G Storage, stores the rootHash in AIRecord,
// and fires training automatically once MIN_SAMPLES is reached.
exports.uploadSamples = async (req, res) => {
  try {
    const { wallet, samples } = req.body;

    if (!wallet || !Array.isArray(samples) || samples.length === 0) {
      return res.status(400).json({ error: "wallet and a non-empty samples array are required" });
    }

    // Serialize batch → Buffer → 0G Storage
    const batchBuf        = Buffer.from(JSON.stringify(samples), "utf8");
    const { rootHash }    = await uploadBuffer(batchBuf);

    // Update record — push new batch, increment total
    const record = await AIRecord.findOneAndUpdate(
      { walletAddress: wallet.toLowerCase() },
      {
        $push: { sampleBatches: { rootHash, sampleCount: samples.length, uploadedAt: new Date() } },
        $inc:  { totalSamples: samples.length }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Auto-trigger training once threshold is reached and we're not already training
    let trainingFired = false;
    if (record.totalSamples >= MIN_SAMPLES && record.status === "none") {
      trainingFired = true;
      setImmediate(() =>
        trainForWallet(wallet).catch(e =>
          console.error("[behavior] auto-train error:", e.message)
        )
      );
    }

    res.json({
      success: true,
      batchRootHash: rootHash,
      received:      samples.length,
      totalSamples:  record.totalSamples,
      trainingFired
    });
  } catch (err) {
    console.error("[behavior] uploadSamples:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /behavior/status/:wallet
exports.getStatus = async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const record = await AIRecord.findOne({ walletAddress: wallet });

    if (!record) {
      return res.json({
        wallet,
        totalSamples:  0,
        samplesNeeded: MIN_SAMPLES,
        readyToTrain:  false,
        status:        "none"
      });
    }

    res.json({
      wallet,
      totalSamples:  record.totalSamples,
      samplesNeeded: Math.max(0, MIN_SAMPLES - record.totalSamples),
      readyToTrain:  record.totalSamples >= MIN_SAMPLES,
      status:        record.status,
      batchCount:    record.sampleBatches.length,
      modelRootHash: record.modelRootHash,
      trainedAt:     record.trainedAt,
      errorMsg:      record.errorMsg,
      explorerUrl:   record.modelRootHash
        ? `https://explorer.0g.ai/storage/${record.modelRootHash}`
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /behavior/retrain/:wallet
// Force re-training (e.g. after an error, or when new batches have been added).
exports.retrain = async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const record = await AIRecord.findOne({ walletAddress: wallet });

    if (!record || record.totalSamples < 10) {
      return res.status(400).json({ error: "Not enough samples (need at least 10)" });
    }
    if (record.status === "training") {
      return res.status(400).json({ error: "Training is already in progress" });
    }

    await AIRecord.updateOne({ walletAddress: wallet }, { status: "none", errorMsg: null });
    setImmediate(() =>
      trainForWallet(wallet).catch(e =>
        console.error("[behavior] retrain error:", e.message)
      )
    );

    res.json({ success: true, message: "Training started" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
