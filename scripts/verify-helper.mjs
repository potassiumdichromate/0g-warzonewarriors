import 'dotenv/config';
import { ethers } from 'ethers';

const [,, argDeployer, argContract] = process.argv;

let deployerAddress = argDeployer;
if (!deployerAddress) {
  const key = process.env.ZG_PRIVATE_KEY;
  if (!key || key.startsWith('0x_')) {
    console.error('[ERROR] Provide deployer address as first arg, or set ZG_PRIVATE_KEY in .env');
    process.exit(1);
  }
  try {
    deployerAddress = new ethers.Wallet(key).address;
  } catch {
    console.error('[ERROR] ZG_PRIVATE_KEY is not a valid private key');
    process.exit(1);
  }
}

if (!ethers.isAddress(deployerAddress)) {
  console.error(`[ERROR] "${deployerAddress}" is not a valid address`);
  process.exit(1);
}

const deployer     = ethers.getAddress(deployerAddress);
const contractAddr = argContract || process.env.ZG_ANCHOR_CONTRACT_ADDRESS || '(not set)';

const encodedArg = ethers.AbiCoder.defaultAbiCoder()
  .encode(['address'], [deployer])
  .slice(2);

console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║    PlayerSaveAnchor (WarzoneWarrior) — Verification for chainscan    ║
╚═══════════════════════════════════════════════════════════════════════╝

  Contract address : ${contractAddr}
  Explorer URL     : https://chainscan.0g.ai/address/${contractAddr}

─── Compiler settings ──────────────────────────────────────────────────
  Compiler version : v0.8.20
  Optimization     : YES
  Optimization runs: 200
  EVM version      : default (paris)
  License          : MIT

─── Constructor argument (ABI-encoded) ─────────────────────────────────
  backendOperator  : ${deployer}
  Encoded (hex)    : ${encodedArg}

  ⚠  Paste ONLY the hex above (no 0x prefix) into
     "Constructor Arguments ABI-encoded" on the explorer.

─── Source code ────────────────────────────────────────────────────────
  File  : contracts/PlayerSaveAnchor.sol
  Action: Copy full file contents → paste into "Solidity Contract Code"

─── Steps on chainscan.0g.ai ───────────────────────────────────────────
  1. Open: https://chainscan.0g.ai/address/${contractAddr}
  2. Click "Contract" tab → "Verify & Publish"
  3. Compiler Type: Solidity (Single file)
     Compiler Version: v0.8.20+...  |  License: MIT
  4. Paste PlayerSaveAnchor.sol source
  5. Optimization: Yes  |  Runs: 200
  6. Constructor Arguments: paste the hex above
  7. Click "Verify and Publish"
`);
