const mongoose = require("mongoose");

// Each sample batch uploaded to 0G Storage is tracked here.
// MongoDB never stores the actual sample data — only the rootHash pointer.
const SampleBatchSchema = new mongoose.Schema(
  {
    rootHash:    { type: String, required: true },
    sampleCount: { type: Number, required: true },
    uploadedAt:  { type: Date,   default: Date.now }
  },
  { _id: false }
);

const AIRecordSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, unique: true, lowercase: true, trim: true },

    // 0G rootHashes for every sample batch uploaded
    sampleBatches: { type: [SampleBatchSchema], default: [] },
    totalSamples:  { type: Number, default: 0 },

    // 0G rootHash of the trained TF.js model weights
    modelRootHash: { type: String, default: null },

    status:    { type: String, enum: ["none", "training", "ready", "error"], default: "none" },
    trainedAt: { type: Date,   default: null },
    errorMsg:  { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("AIRecord", AIRecordSchema);
