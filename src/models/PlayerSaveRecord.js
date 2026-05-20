const mongoose = require("mongoose");

const DaCommitmentSchema = new mongoose.Schema({
  requestId: String,
  batchId: String,
  blobIndex: Number,
  batchHeaderHash: String,
  referenceBlockNumber: Number,
  finalizedAt: Date
}, { _id: false });

const ComputeValidationSchema = new mongoose.Schema({
  valid: Boolean,
  confidence: Number,
  flags: [String],
  verdict: String,
  rootHash: String,
  teeVerified: Boolean,
  providerAddress: String,
  chatId: String,
  requestId: String,
  billingCost: Number,
  validatedAt: Date
}, { _id: false });

const PlayerSaveRecordSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, index: true },

  rootHash:  { type: String, required: true },
  txHash:    String,
  fileSize:  Number,
  checksum:  String,

  saveIndex:    { type: Number, required: true },
  // Primary resource snapshot used for leaderboard queries
  // For Warzone: PlayerResources.coin
  coinSnapshot: { type: Number, default: 0 },

  anchorTxHash: String,
  anchorBlock:  Number,

  daStatus: {
    type: String,
    enum: ["pending", "finalized", "failed", "skipped"],
    default: "pending"
  },
  daCommitment: DaCommitmentSchema,

  computeStatus: {
    type: String,
    enum: ["skipped", "pending", "validated", "rejected"],
    default: "skipped"
  },
  computeValidation: ComputeValidationSchema,

  source: {
    type: String,
    enum: ["game_save", "iap_delivery", "migration"],
    default: "game_save"
  }
}, { timestamps: true });

PlayerSaveRecordSchema.index({ walletAddress: 1, saveIndex: -1 });
PlayerSaveRecordSchema.index({ coinSnapshot: -1 });

module.exports = mongoose.model("PlayerSaveRecord", PlayerSaveRecordSchema);
