/**
 * ZeroGStorage — upload / download player save files on 0G Storage.
 *
 * SDK v1.2.9 has a proper CommonJS build — require() works directly.
 * Uses retry + indexer rotation so a single flaky node doesn't kill a save.
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const { ethers }          = require('ethers-v6');
const { Indexer, ZgFile } = require('@0gfoundation/0g-storage-ts-sdk');

const ZG_RPC_URL  = process.env.ZG_RPC_URL  || 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID || 16661); // 16661 = 0G Mainnet

// Try multiple indexer endpoints — rotate on failure
const INDEXER_URLS = [
  process.env.ZG_INDEXER_RPC,
  'https://indexer-storage-turbo.0g.ai',
  'https://indexer-storage-turbo-standard.0g.ai',
].filter(Boolean);

let _indexer    = null;
let _indexerIdx = 0;
let _signer     = null;

function getSigner() {
  if (_signer) return _signer;
  const key = process.env.ZG_PRIVATE_KEY
    || process.env.GAME_OWNER_PRIVATE_KEY
    || process.env.OWNER_PRIVATE_KEY
    || '';
  if (!key) throw new Error('ZG_PRIVATE_KEY is not set');
  const pk       = key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`;
  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, { chainId: ZG_CHAIN_ID, name: '0g-mainnet' });
  _signer = new ethers.Wallet(pk, provider);
  return _signer;
}

function getIndexer() {
  if (!_indexer) {
    const url = INDEXER_URLS[_indexerIdx % INDEXER_URLS.length];
    _indexer = new Indexer(url);
    console.log('[0G Storage] indexer:', url);
  }
  return _indexer;
}

function rotateIndexer() {
  _indexerIdx = (_indexerIdx + 1) % INDEXER_URLS.length;
  _indexer = null;
  console.warn('[0G Storage] rotating indexer →', INDEXER_URLS[_indexerIdx % INDEXER_URLS.length]);
}

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(8).toString('hex')}.bin`);
}

async function withRetry(fn, label, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = 4000 * Math.pow(2, attempt - 1);
        console.warn(`[0G Storage] ${label}: attempt ${attempt}/${maxAttempts} failed — ${err.message}. Retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Upload a binary buffer to 0G Storage.
 * Pre-computes rootHash from merkle tree so it's available even if the file
 * was already uploaded (SDK returns no rootHash on duplicate uploads).
 * Returns { rootHash, txHash, size, checksum }
 */
async function uploadBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  return withRetry(async () => {
    const tmp = tmpPath('wz_save');
    let file  = null;
    try {
      fs.writeFileSync(tmp, buffer);
      file = await ZgFile.fromFilePath(tmp);

      // Pre-compute rootHash from Merkle tree — reliable even if upload is a no-op
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);
      const merkleRootHash = tree.rootHash();

      const indexer = getIndexer();
      const signer  = getSigner();
      const [uploadResult, uploadErr] = await indexer.upload(file, ZG_RPC_URL, signer);
      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      // v1.2.9 upload result can be: { txHash, rootHash, txSeq } or { txHashes[], rootHashes[] }
      // Fall back to pre-computed merkleRootHash when upload returns no rootHash (already uploaded)
      const rootHash = uploadResult?.rootHash ?? uploadResult?.rootHashes?.[0] ?? merkleRootHash;

      let txHash;
      if (typeof uploadResult?.txHash === 'string') {
        txHash = uploadResult.txHash;
      } else if (uploadResult?.txHashes?.[0]) {
        txHash = uploadResult.txHashes[0];
      } else if (uploadResult?.txSeq !== undefined) {
        txHash = `seq-${uploadResult.txSeq}`;
      } else {
        txHash = `uploaded-${Date.now()}`;
      }

      console.log('[0G Storage] uploaded', { rootHash, txHash, size: buffer.length });
      return { rootHash, txHash, size: buffer.length, checksum };
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      if (file) { try { await file.close(); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, 'uploadBuffer');
}

/**
 * Download a file from 0G Storage by its rootHash.
 * withProof=true verifies every Merkle segment — tampered data throws.
 * Returns the raw Buffer.
 */
async function downloadToBuffer(rootHash) {
  if (!rootHash) throw new Error('rootHash is required');

  return withRetry(async () => {
    const tmp = tmpPath('wz_dl');
    try {
      const indexer = getIndexer();
      const err = await indexer.download(rootHash, tmp, true /* withProof */);
      if (err) throw new Error(`Download error: ${err}`);
      return fs.readFileSync(tmp);
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, 'downloadToBuffer');
}

/**
 * Re-verify a saved file by downloading and checksumming it.
 * Used by the 4-layer verification endpoint.
 */
async function verifyChecksum(rootHash, expectedChecksum) {
  const buf    = await downloadToBuffer(rootHash);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  return actual === expectedChecksum;
}

module.exports = { uploadBuffer, downloadToBuffer, verifyChecksum };
