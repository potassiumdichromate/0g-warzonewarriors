const { ethers } = require("ethers-v6");

const ZG_RPC_URL  = process.env.OG_MAINNET_RPC      || "https://evmrpc.0g.ai";
const ZG_CHAIN_ID = parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661");

const ANCHOR_ABI = [
  "function anchorSave(address wallet, string rootHash, uint64 saveIndex) external",
  "function getLatestSave(address wallet) external view returns (string rootHash, uint64 saveIndex, uint256 timestamp, bool exists)",
  "function hasSave(address wallet) external view returns (bool)"
];

let _provider = null;
let _signer   = null;
let _contract = null;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
      chainId: ZG_CHAIN_ID,
      name: "0g-mainnet"
    });
  }
  return _provider;
}

function getSigner() {
  if (!_signer) {
    _signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, getProvider());
  }
  return _signer;
}

function getContract() {
  if (!_contract) {
    const addr = process.env.ZG_ANCHOR_CONTRACT_ADDRESS;
    if (!addr) throw new Error("ZG_ANCHOR_CONTRACT_ADDRESS not set");
    _contract = new ethers.Contract(addr, ANCHOR_ABI, getSigner());
  }
  return _contract;
}

async function anchorSaveHash(wallet, rootHash, saveIndex) {
  const contract = getContract();
  const tx = await contract.anchorSave(wallet, rootHash, BigInt(saveIndex));
  const receipt = await tx.wait();
  return receipt.hash;
}

async function getOnChainSave(wallet) {
  const contract = getContract();
  const result = await contract.getLatestSave(wallet);
  return {
    rootHash:  result.rootHash,
    saveIndex: Number(result.saveIndex),
    timestamp: Number(result.timestamp),
    exists:    result.exists
  };
}

module.exports = { anchorSaveHash, getOnChainSave };
