const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const { ethers }              = require("ethers-v6");
const { Indexer, ZgFile }     = require("@0gfoundation/0g-storage-ts-sdk");
const { withRetry }           = require("../utils/retry");

const ZG_RPC_URL  = process.env.OG_MAINNET_RPC       || "https://evmrpc.0g.ai";
const ZG_CHAIN_ID = parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661");

const ZG_INDEXER_URLS = [
  process.env.ZG_INDEXER_RPC,
  "https://indexer-storage-turbo.0g.ai",
  "https://indexer-storage-turbo-standard.0g.ai",
  "https://storage-indexer-v2.0g.ai",
].filter(Boolean);

let _indexer     = null;
let _indexerUrl  = null;
let _signer      = null;

function getSigner() {
  const key = process.env.ZG_PRIVATE_KEY;
  if (!key || key.startsWith("0xyour") || key === "your_private_key_here") {
    throw new Error("ZG_PRIVATE_KEY is not configured. Set it in environment variables.");
  }
  if (!_signer) {
    const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
      chainId: ZG_CHAIN_ID,
      name:    "0g-mainnet"
    });
    _signer = new ethers.Wallet(key, provider);
  }
  return _signer;
}

function getIndexer() {
  if (!_indexer) {
    const url = _indexerUrl || ZG_INDEXER_URLS[0];
    _indexer    = new Indexer(url);
    _indexerUrl = url;
    console.log(`[0G] Using indexer: ${url}`);
  }
  return _indexer;
}

function rotateIndexer() {
  const current = _indexerUrl || ZG_INDEXER_URLS[0];
  const idx     = ZG_INDEXER_URLS.indexOf(current);
  const next    = ZG_INDEXER_URLS[idx + 1];
  if (next) {
    console.warn(`[0G] Indexer ${current} failed — trying ${next}`);
    _indexerUrl = next;
  }
  _indexer = null;
  _signer  = null;
}

function tmpPath() {
  return path.join(
    os.tmpdir(),
    `wz-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`
  );
}

async function uploadBuffer(buffer) {
  return withRetry(async () => {
    const tmp = tmpPath();
    let zgFile = null;
    try {
      fs.writeFileSync(tmp, buffer);

      zgFile = await ZgFile.fromFilePath(tmp);
      const [tree, treeErr] = await zgFile.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const rootHash = tree.rootHash();
      const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

      const indexer = getIndexer();
      const signer  = getSigner();

      const [uploadResult, uploadErr] = await indexer.upload(zgFile, ZG_RPC_URL, signer);
      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      let txHash;
      if (typeof uploadResult === "string") {
        txHash = uploadResult;
      } else if (uploadResult?.txHash && typeof uploadResult.txHash === "string") {
        txHash = uploadResult.txHash;
      } else if (uploadResult?.txSeq !== undefined) {
        txHash = `seq-${uploadResult.txSeq}`;
      } else {
        txHash = `uploaded-${Date.now()}`;
      }
      const finalRoot = uploadResult?.rootHash || rootHash;

      return { rootHash: finalRoot, txHash, size: buffer.length, checksum };
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      if (zgFile) { try { await zgFile.close(); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.upload" });
}

async function downloadToBuffer(rootHash) {
  return withRetry(async () => {
    const tmp = tmpPath();
    try {
      const indexer = getIndexer();
      const err = await indexer.download(rootHash, tmp, true);
      if (err) throw new Error(`Download error: ${err}`);
      return fs.readFileSync(tmp);
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.download" });
}

module.exports = { uploadBuffer, downloadToBuffer };
