/**
 * ZeroGStorage — upload / download player save files on 0G Storage (mainnet).
 *
 * 0G Storage is a decentralized storage network where each file is addressed by its
 * Merkle root hash. Same bytes always produce the same rootHash — it is a permanent,
 * content-addressed pointer that lives on the 0G chain.
 *
 * Chain: 0G mainnet  (chainId 16661)
 * RPC:   https://evmrpc.0g.ai
 * Indexer: https://indexer-storage-turbo.0g.ai
 * Flow contract: 0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');

// Uses ethers-v6 alias because the 0G Storage SDK targets ethers v6 API.
// Existing controllers keep ethers v5 — no conflict.
const { ethers } = require('ethers-v6');

const ZG_RPC_URL    = process.env.ZG_RPC_URL    || 'https://evmrpc.0g.ai';
const ZG_INDEXER_RPC = process.env.ZG_INDEXER_RPC || 'https://indexer-storage-turbo.0g.ai';

function getPrivateKey() {
  const key = process.env.ZG_PRIVATE_KEY
    || process.env.GAME_OWNER_PRIVATE_KEY
    || process.env.OWNER_PRIVATE_KEY
    || '';
  if (!key) throw new Error('ZG_PRIVATE_KEY is not set');
  return key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`;
}

// Lazily initialised — avoids blocking startup when SDK is optional
let _storageInstance = null;

async function getStorageInstance() {
  if (_storageInstance) return _storageInstance;

  const pk = getPrivateKey();
  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
  const signer   = new ethers.Wallet(pk, provider);

  // Dynamic import handles both ESM-only and CJS SDK builds
  const sdk = await import('@0gfoundation/0g-storage-ts-sdk');
  const Indexer = sdk.Indexer || sdk.default?.Indexer;
  if (!Indexer) throw new Error('0G Storage SDK missing Indexer export');

  const indexer = new Indexer(ZG_INDEXER_RPC);
  _storageInstance = { indexer, signer, sdk };
  console.log('[0G Storage] initialised — indexer:', ZG_INDEXER_RPC);
  return _storageInstance;
}

/**
 * Upload a binary buffer to 0G Storage.
 * Writes to a temp file (SDK requires file path), uploads, cleans up.
 * Returns { rootHash, txHash, size, checksum }
 */
async function uploadBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');

  const { indexer, signer, sdk } = await getStorageInstance();
  const ZgFile = sdk.ZgFile || sdk.default?.ZgFile;
  if (!ZgFile) throw new Error('0G Storage SDK missing ZgFile export');

  const tmpFile = path.join(
    os.tmpdir(),
    `wz_save_${crypto.randomBytes(8).toString('hex')}.bin`,
  );

  try {
    fs.writeFileSync(tmpFile, buffer);

    const file = await ZgFile.fromFilePath(tmpFile);
    try {
      const [, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`0G Merkle tree error: ${treeErr}`);

      const [tx, uploadErr] = await indexer.upload(file, ZG_RPC_URL, signer);
      if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`);

      // SDK returns either single or multi-chunk tx shape
      const rootHash = tx.rootHash  ?? tx.rootHashes?.[0];
      const txHash   = tx.txHash    ?? tx.txHashes?.[0];
      if (!rootHash) throw new Error('0G upload returned no rootHash');

      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      console.log('[0G Storage] uploaded', { rootHash, txHash, size: buffer.length });
      return { rootHash, txHash, size: buffer.length, checksum };
    } finally {
      await file.close();
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Download a file from 0G Storage by its rootHash.
 * withProof=true: SDK verifies every Merkle segment before writing — tampered data throws.
 * Returns the raw Buffer.
 */
async function downloadToBuffer(rootHash) {
  if (!rootHash) throw new Error('rootHash is required');

  const { indexer } = await getStorageInstance();

  const tmpFile = path.join(
    os.tmpdir(),
    `wz_dl_${crypto.randomBytes(8).toString('hex')}.bin`,
  );

  try {
    const dlErr = await indexer.download(rootHash, tmpFile, true /* withProof */);
    if (dlErr) throw new Error(`0G download error: ${dlErr}`);
    return fs.readFileSync(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Re-verify a saved file by downloading and checksumming it.
 * Used by the 4-layer verification endpoint.
 */
async function verifyChecksum(rootHash, expectedChecksum) {
  const buf = await downloadToBuffer(rootHash);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  return actual === expectedChecksum;
}

module.exports = { uploadBuffer, downloadToBuffer, verifyChecksum };
