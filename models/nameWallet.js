const mongoose = require('mongoose');

const warriorNames = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  isDefaultName: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('WarzoneNameWallet', warriorNames); 