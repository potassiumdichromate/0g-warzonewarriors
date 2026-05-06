const mongoose = require('mongoose');
const { Schema } = mongoose;

const PlayerRoundParticipationSchema = new Schema({
  walletAddress: { type: String, required: true, index: true },
  roundId: { type: String, required: true, index: true },
  tournamentId: { type: String },

  // Last saved profile coin snapshot for this round (advanced on each saveProfile tournament sync)
  baselineCoin: { type: Number, default: 0 },

  // Sum of positive coin deltas since first touch of this round (for local leaderboard)
  roundPoints: { type: Number, default: 0 },

  // Extra stats per round
  kills: { type: Number, default: 0 },
  deaths: { type: Number, default: 0 },

  // For metadata or other information
  metadata: { type: Schema.Types.Mixed, default: {} },

  lastUpdated: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Ensure a player can have only one record per round
PlayerRoundParticipationSchema.index({ walletAddress: 1, roundId: 1 }, { unique: true });

module.exports = mongoose.model('PlayerRoundParticipation', PlayerRoundParticipationSchema);
