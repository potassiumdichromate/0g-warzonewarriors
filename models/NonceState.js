const mongoose = require('mongoose');

const nonceStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    address: { type: String, required: true, index: true },
    chainId: { type: Number, required: true, index: true },
    nextNonce: { type: Number, required: true, default: 0 },
    lastAllocatedNonce: { type: Number, required: false },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false }
);

nonceStateSchema.index({ address: 1, chainId: 1 }, { unique: true });

function makeId({ address, chainId }) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!normalized) throw new Error('NonceState requires address');
  if (!Number.isFinite(chainId)) throw new Error('NonceState requires chainId');
  return `${chainId}:${normalized}`;
}

nonceStateSchema.statics.allocateNonce = async function allocateNonce({
  address,
  chainId,
  chainNonceFloor,
  maxNonceGap = 5,
}) {
  if (!Number.isFinite(chainNonceFloor)) throw new Error('allocateNonce requires chainNonceFloor');

  const _id = makeId({ address, chainId });
  const addr = String(address).trim().toLowerCase();
  const gap = Number.isFinite(maxNonceGap) ? Math.max(0, Math.floor(maxNonceGap)) : 0;
  const ceiling = chainNonceFloor + gap;

  // Pipeline update so "max then increment" happens deterministically.
  const update = [
    {
      $set: {
        _id,
        address: addr,
        chainId,
        updatedAt: '$$NOW',
        nextNonce: { $ifNull: ['$nextNonce', chainNonceFloor] },
      },
    },
    {
      $set: {
        // Some RPCs reject txs whose nonce is too far from the current pending nonce.
        // Clamp any stored "nextNonce" that drifted too far ahead back toward chainNonceFloor.
        _boundedNext: { $min: ['$nextNonce', ceiling] },
      },
    },
    {
      $set: {
        _effective: { $max: ['$_boundedNext', chainNonceFloor] },
      },
    },
    {
      $set: {
        lastAllocatedNonce: '$_effective',
        nextNonce: { $add: ['$_effective', 1] },
      },
    },
    { $unset: ['_effective', '_boundedNext'] },
  ];

  const doc = await this.findOneAndUpdate({ _id }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  return doc.lastAllocatedNonce;
};

nonceStateSchema.statics.bumpFloor = async function bumpFloor({ address, chainId, chainNonceFloor }) {
  const _id = makeId({ address, chainId });
  const addr = String(address).trim().toLowerCase();

  const update = [
    {
      $set: {
        _id,
        address: addr,
        chainId,
        updatedAt: '$$NOW',
        nextNonce: { $ifNull: ['$nextNonce', chainNonceFloor] },
      },
    },
    {
      $set: {
        nextNonce: { $max: ['$nextNonce', chainNonceFloor] },
      },
    },
  ];

  await this.findOneAndUpdate({ _id }, update, {
    upsert: true,
    new: false,
    setDefaultsOnInsert: true,
  });
};

module.exports = mongoose.model('NonceState', nonceStateSchema);
