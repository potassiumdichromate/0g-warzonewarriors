/**
 * ZeroGChain — anchor player save rootHashes on the 0G EVM chain.
 *
 * Every time a player save is uploaded to 0G Storage, we call
 * PlayerSaveAnchor.anchorSave(wallet, rootHash, saveIndex) on the 0G chain.
 * This creates an immutable, publicly verifiable on-chain record:
 *   "wallet 0xABC had save file <rootHash> at index N"
 *
 * Anyone — including the player — can verify their save is legitimate by:
 *   1. Reading the on-chain rootHash for their wallet
 *   2. Fetching that file from 0G Storage
 *   3. Confirming the file is authentic (Merkle proof verified by SDK)
 *
 * 0G EVM chain:
 *   RPC:     https://evmrpc.0g.ai   (ZG_RPC_URL)
 *   ChainId: 16661                   (0G Mainnet)
 *   Explorer:https://chainscan.0g.ai
 *
 * Contract to deploy: contracts/PlayerSaveAnchor.sol
 * Deploy script:      scripts/deployAnchor.js
 */

const { ethers } = require('ethers-v6');

const ZG_RPC_URL    = process.env.ZG_RPC_URL    || 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID   = Number(process.env.ZG_CHAIN_ID || 16661); // 16661 = 0G Mainnet
const ANCHOR_ADDR   = process.env.ZG_ANCHOR_CONTRACT_ADDRESS || '';

// Minimal ABI — only what the backend calls
const ANCHOR_ABI = [
  'function anchorSave(address wallet, string calldata rootHash, uint64 saveIndex) external',
  'function getLatestSave(address wallet) external view returns (string rootHash, uint64 saveIndex, uint64 timestamp)',
  'event SaveAnchored(address indexed wallet, string rootHash, uint64 saveIndex, uint64 timestamp)',
];

function getPrivateKey() {
  // Prefer ZG_CHAIN_PRIVATE_KEY (dedicated chain anchoring key).
  // Falls back to ZG_PRIVATE_KEY for backward compat with single-key deployments.
  // Best practice: set both ZG_STORAGE_PRIVATE_KEY and ZG_CHAIN_PRIVATE_KEY to separate wallets.
  const k = process.env.ZG_CHAIN_PRIVATE_KEY
    || process.env.ZG_PRIVATE_KEY
    || process.env.GAME_OWNER_PRIVATE_KEY
    || process.env.OWNER_PRIVATE_KEY
    || '';
  if (!k) throw new Error('ZG_CHAIN_PRIVATE_KEY (or ZG_PRIVATE_KEY) not set — needed for 0G chain anchoring');
  return k.trim().startsWith('0x') ? k.trim() : `0x${k.trim()}`;
}

let _contract = null;

function getContract() {
  if (_contract) return _contract;
  if (!ANCHOR_ADDR) throw new Error('ZG_ANCHOR_CONTRACT_ADDRESS not set — deploy contracts/PlayerSaveAnchor.sol on 0G chain first');

  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
    chainId: ZG_CHAIN_ID,
    name: '0g-mainnet',
  });
  const signer = new ethers.Wallet(getPrivateKey(), provider);
  _contract = new ethers.Contract(ANCHOR_ADDR, ANCHOR_ABI, signer);
  console.log('[0G Chain] PlayerSaveAnchor ready —', ANCHOR_ADDR, '(chainId', ZG_CHAIN_ID, ')');
  return _contract;
}

/**
 * Write wallet → rootHash → saveIndex to the PlayerSaveAnchor contract on 0G chain.
 * Call this inside setImmediate — never block a request handler on it.
 *
 * @returns {{ txHash, blockNumber }} or null if contract not configured
 */
async function anchorSaveHash(walletAddress, rootHash, saveIndex) {
  if (!ANCHOR_ADDR) {
    console.warn('[0G Chain] ZG_ANCHOR_CONTRACT_ADDRESS not set — anchor skipped');
    return null;
  }

  const contract = getContract();
  const tx = await contract.anchorSave(walletAddress, rootHash, BigInt(saveIndex));
  console.log('[0G Chain] anchorSave tx sent', { txHash: tx.hash, wallet: walletAddress, rootHash, saveIndex });

  const receipt = await tx.wait(1);
  console.log('[0G Chain] anchorSave confirmed', { txHash: tx.hash, block: receipt.blockNumber });
  return { txHash: tx.hash, blockNumber: Number(receipt.blockNumber) };
}

/**
 * Read the latest anchored save for a wallet from 0G chain.
 * Useful for trustless load: client can verify rootHash without trusting our backend.
 *
 * @returns {{ rootHash, saveIndex, timestamp }} or null
 */
async function getOnChainSave(walletAddress) {
  if (!ANCHOR_ADDR) return null;

  const contract = getContract();
  const [rootHash, saveIndex, timestamp] = await contract.getLatestSave(walletAddress);
  if (!rootHash) return null;
  return {
    rootHash,
    saveIndex: Number(saveIndex),
    timestamp: Number(timestamp),
  };
}

module.exports = { anchorSaveHash, getOnChainSave };
