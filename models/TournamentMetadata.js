const mongoose = require('mongoose');
const { Schema } = mongoose;

const IntervalSchema = new Schema({
  startDate: { type: Number, required: true },
  endDate: { type: Number, required: true }
}, { _id: false });

const RoundSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String },
  title: { type: String },
  intervals: [IntervalSchema],
  createdAt: { type: Number },
  updatedAt: { type: Number }
}, { _id: false });

const TournamentMetadataSchema = new Schema({
  tournamentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  gameId: { type: String },
  organizationId: { type: String },
  startDate: { type: Number },
  endDate: { type: Number },
  rounds: [RoundSchema],
  rules: { type: String, default: "" },
  lastSynced: { type: Date, default: Date.now }
}, {
  timestamps: true
});

module.exports = mongoose.model('TournamentMetadata', TournamentMetadataSchema);
