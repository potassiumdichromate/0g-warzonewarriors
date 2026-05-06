const mongoose = require('mongoose');
const { Schema } = mongoose;

// Stores 0G Storage metadata per player save. The actual game data lives on 0G Storage
// as a msgpack binary — this document is just the index/pointer.
const DaCommitmentSchema = new Schema({
  requestId:           { type: String },
  batchId:             { type: Number },
  blobIndex:           { type: Number },
  batchHeaderHash:     { type: String },
  referenceBlockNumber:{ type: Number },
  finalizedAt:         { type: Date },
}, { _id: false });

const ComputeValidationSchema = new Schema({
  valid:                     { type: Boolean },
  confidence:                { type: Number },
  flags:                     { type: [String], default: [] },
  verdict:                   { type: String, enum: ['CLEAN', 'SUSPICIOUS', 'REJECTED'] },
  rootHash:                  { type: String },
  teeVerified:               { type: Boolean, default: false },
  teeVerifiedIndependently:  { type: Boolean, default: false },
  providerAddress:           { type: String },
  chatId:                    { type: String },
  requestId:                 { type: String },
  billingCost:               { type: String },
  validatedAt:               { type: Date },
}, { _id: false });

const PlayerSaveRecordSchema = new Schema({
  walletAddress: {
    type: String,
    required: true,
    index: true,
    lowercase: true,
    trim: true,
  },

  // 0G Storage
  rootHash:  { type: String, required: true, unique: true },
  txHash:    { type: String },   // 0G Storage chain tx
  fileSize:  { type: Number },
  checksum:  { type: String },   // SHA-256 hex of raw binary

  // 0G chain anchor — PlayerSaveAnchor contract tx (chainscan.0g.ai)
  anchorTxHash: { type: String, default: null },
  anchorBlock:  { type: Number, default: null },

  // Monotonically increasing counter — prevents rollback attacks
  saveIndex: { type: Number, required: true, default: 0 },

  // Coin snapshot for decentralized leaderboard (no DB query needed)
  coinSnapshot: { type: Number, default: 0 },

  // 0G DA
  daStatus: {
    type: String,
    enum: ['pending', 'finalized', 'failed', 'skipped'],
    default: 'pending',
  },
  daCommitment: { type: DaCommitmentSchema, default: null },

  // 0G Compute anti-cheat
  computeStatus: {
    type: String,
    enum: ['skipped', 'pending', 'validated', 'rejected'],
    default: 'skipped',
  },
  computeValidation: { type: ComputeValidationSchema, default: null },

  // Source of this save record
  source: {
    type: String,
    enum: ['game_save', 'iap_delivery', 'migration'],
    default: 'game_save',
  },
}, {
  timestamps: true,
  versionKey: false,
});

// Latest save per wallet (leaderboard + load queries)
PlayerSaveRecordSchema.index({ walletAddress: 1, saveIndex: -1 });
// Leaderboard
PlayerSaveRecordSchema.index({ coinSnapshot: -1 });

module.exports = mongoose.models.PlayerSaveRecord
  || mongoose.model('PlayerSaveRecord', PlayerSaveRecordSchema);
