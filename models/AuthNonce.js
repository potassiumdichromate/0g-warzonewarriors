const mongoose = require('mongoose');

// Single-use nonces for wallet signature auth (SIWE).
// TTL index auto-deletes documents 5 minutes after creation.
// One nonce per wallet at a time — any existing nonce is deleted before issuing a new one.
const AuthNonceSchema = new mongoose.Schema({
  wallet:    { type: String, required: true, index: true },
  nonce:     { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }  // TTL: 5 min
});

module.exports = mongoose.model('AuthNonce', AuthNonceSchema);
