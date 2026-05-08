/**
 * Deploy PlayerSaveAnchor to 0G EVM chain.
 *
 * Usage:
 *   ANCHOR_BYTECODE=0x<bytecode> node scripts/deployAnchor.js
 *
 * Required env vars:
 *   ZG_RPC_URL              — 0G chain RPC  (default: https://evmrpc.0g.ai)
 *   ZG_CHAIN_ID             — 0G chain ID   (default: 16661 = 0G Mainnet)
 *   ZG_CHAIN_PRIVATE_KEY    — deployer wallet private key (fund with 0G tokens first)
 *   (or ZG_PRIVATE_KEY as fallback if using a single key)
 *
 * After deployment, add the printed address to your .env:
 *   ZG_ANCHOR_CONTRACT_ADDRESS=0x...
 *
 * Explorer: https://chainscan.0g.ai
 */

require('dotenv').config();
const { ethers } = require('ethers-v6');

const ZG_RPC_URL  = process.env.ZG_RPC_URL  || 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID || 16661); // 16661 = 0G Mainnet

function getPrivateKey() {
  // Prefer ZG_CHAIN_PRIVATE_KEY (dedicated chain key). Falls back to ZG_PRIVATE_KEY.
  // The deployer wallet becomes the immutable backendOperator in PlayerSaveAnchor.sol.
  const k = process.env.ZG_CHAIN_PRIVATE_KEY
    || process.env.ZG_PRIVATE_KEY
    || process.env.GAME_OWNER_PRIVATE_KEY
    || process.env.OWNER_PRIVATE_KEY
    || '';
  if (!k) {
    console.error('ERROR: ZG_CHAIN_PRIVATE_KEY (or ZG_PRIVATE_KEY) not set');
    process.exit(1);
  }
  return k.startsWith('0x') ? k : `0x${k}`;
}

// Compiled bytecode for PlayerSaveAnchor.sol
// Recompile with: npx hardhat compile  OR  solc --bin contracts/PlayerSaveAnchor.sol
// Replace the bytecode below after recompiling if the contract changes.
const ANCHOR_ABI = [
  'constructor(address backendOperator)',
  'function anchorSave(address wallet, string calldata rootHash, uint64 saveIndex) external',
  'function getLatestSave(address wallet) external view returns (string rootHash, uint64 saveIndex, uint64 timestamp)',
  'function hasSave(address wallet) external view returns (bool)',
  'function backendOperator() external view returns (address)',
  'event SaveAnchored(address indexed wallet, string rootHash, uint64 saveIndex, uint64 timestamp)',
];

// To compile the bytecode:
//   1. Install hardhat: npm install --save-dev hardhat @nomicfoundation/hardhat-ethers
//   2. npx hardhat compile
//   3. Copy bytecode from artifacts/contracts/PlayerSaveAnchor.sol/PlayerSaveAnchor.json
// OR use Remix IDE (remix.ethereum.org) — paste the .sol, compile, copy bytecode.
const ANCHOR_BYTECODE = process.env.ANCHOR_BYTECODE || '';

async function main() {
  if (!ANCHOR_BYTECODE) {
    console.error([
      '',
      'ERROR: ANCHOR_BYTECODE is not set.',
      '',
      'To get the bytecode:',
      '  Option A — Remix IDE (easiest):',
      '    1. Go to https://remix.ethereum.org',
      '    2. Paste contracts/PlayerSaveAnchor.sol',
      '    3. Compile with Solidity 0.8.20',
      '    4. Copy "Bytecode" from the Compilation Details panel',
      '    5. Run: ANCHOR_BYTECODE=0x<paste> node scripts/deployAnchor.js',
      '',
      '  Option B — Hardhat:',
      '    npm install --save-dev hardhat @nomicfoundation/hardhat-ethers',
      '    npx hardhat compile',
      '    node -e "console.log(require(\'./artifacts/contracts/PlayerSaveAnchor.sol/PlayerSaveAnchor.json\').bytecode)"',
      '',
    ].join('\n'));
    process.exit(1);
  }

  console.log('Deploying PlayerSaveAnchor to 0G chain...');
  console.log('  RPC:    ', ZG_RPC_URL);
  console.log('  ChainId:', ZG_CHAIN_ID);

  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, { chainId: ZG_CHAIN_ID, name: '0g-mainnet' });
  const signer   = new ethers.Wallet(getPrivateKey(), provider);

  const balance = await provider.getBalance(signer.address);
  console.log('  Deployer:', signer.address);
  console.log('  Balance: ', ethers.formatEther(balance), '0G');

  if (balance === 0n) {
    console.error('ERROR: Deployer wallet has zero balance. Fund it with 0G tokens first.');
    process.exit(1);
  }

  // The backend operator address (ZG_PRIVATE_KEY wallet) is baked in at deploy time.
  // Only this address + each player's own wallet can call anchorSave.
  const backendOperator = signer.address;
  console.log('  Backend operator:', backendOperator);

  const factory  = new ethers.ContractFactory(ANCHOR_ABI, ANCHOR_BYTECODE, signer);
  const contract = await factory.deploy(backendOperator);
  console.log('  Tx hash:', contract.deploymentTransaction().hash);

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log('');
  console.log('PlayerSaveAnchor deployed successfully!');
  console.log('  Contract address:', address);
  console.log('  Explorer:        ', `https://chainscan.0g.ai/address/${address}`);
  console.log('');
  console.log('Add this to your .env:');
  console.log(`  ZG_ANCHOR_CONTRACT_ADDRESS=${address}`);
}

main().catch(err => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
