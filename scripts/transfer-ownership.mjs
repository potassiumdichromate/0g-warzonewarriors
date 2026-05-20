import 'dotenv/config';
import { ethers } from 'ethers';

const EXPLORER          = 'https://chainscan.0g.ai';
const RPC_URL           = process.env.OG_MAINNET_RPC || 'https://evmrpc.0g.ai';
const EXPECTED_CHAIN_ID = 16661;

const OWNABLE_ABI = [
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
];

function fatal(msg) { console.error(`\n[FATAL] ${msg}\n`); process.exit(1); }
function ok(msg)    { console.log(`  ✔  ${msg}`); }
function info(label, value) { console.log(`  ${label.padEnd(18)} ${value}`); }

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.startsWith('0x_') || v.startsWith('0xyour') || v.trim() === '') {
    fatal(`${name} is not set or is still a placeholder.`);
  }
  return v.trim();
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║    Ownership Transfer Script — 0G Mainnet (16661)   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const privateKey      = requireEnv('OLD_PRIVATE_KEY');
  const newOwnerRaw     = requireEnv('NEW_OWNER');
  const contractAddrRaw = requireEnv('CONTRACT_ADDRESS');

  if (!ethers.isAddress(newOwnerRaw))     fatal(`NEW_OWNER="${newOwnerRaw}" is not valid.`);
  if (!ethers.isAddress(contractAddrRaw)) fatal(`CONTRACT_ADDRESS="${contractAddrRaw}" is not valid.`);

  const newOwner     = ethers.getAddress(newOwnerRaw);
  const contractAddr = ethers.getAddress(contractAddrRaw);

  if (newOwner === ethers.ZeroAddress) fatal('NEW_OWNER cannot be the zero address.');

  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: EXPECTED_CHAIN_ID, name: '0g-mainnet' });
  const signer   = new ethers.Wallet(privateKey, provider);

  info('RPC:', RPC_URL);
  info('Signer:', signer.address);
  info('Contract:', contractAddr);
  info('New owner:', newOwner);
  console.log('');

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
    fatal(`Wrong chain ID ${network.chainId} — expected ${EXPECTED_CHAIN_ID}.`);
  }
  ok(`Chain ID: ${network.chainId} (0G Mainnet)`);

  const contract = new ethers.Contract(contractAddr, OWNABLE_ABI, signer);
  let currentOwner;
  try {
    currentOwner = await contract.owner();
  } catch {
    fatal('owner() reverted — this contract (PlayerSaveAnchor) uses an immutable backendOperator. Redeploy with npm run deploy:anchor instead.');
  }

  currentOwner = ethers.getAddress(currentOwner);
  if (signer.address.toLowerCase() !== currentOwner.toLowerCase()) {
    fatal(`Signer mismatch. OLD_PRIVATE_KEY must be the current owner (${currentOwner}).`);
  }
  if (newOwner.toLowerCase() === currentOwner.toLowerCase()) {
    fatal('NEW_OWNER is already the current owner.');
  }

  const gasEstimate = await contract.transferOwnership.estimateGas(newOwner);
  const gasLimit = (gasEstimate * 130n) / 100n;
  ok(`Gas estimate: ${gasEstimate.toLocaleString()} (limit: ${gasLimit.toLocaleString()})`);

  const tx = await contract.transferOwnership(newOwner, { gasLimit });
  info('Tx hash:', tx.hash);
  const receipt = await tx.wait(2);
  ok(`Confirmed — block ${receipt.blockNumber}`);

  const verifiedOwner = ethers.getAddress(await contract.owner());
  if (verifiedOwner.toLowerCase() !== newOwner.toLowerCase()) {
    fatal('Post-transfer verification FAILED.');
  }
  ok(`On-chain owner is now: ${verifiedOwner}`);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        ✅  Ownership transferred successfully!       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  info('Contract:', contractAddr);
  info('Old owner:', signer.address);
  info('New owner:', verifiedOwner);
  info('Explorer:', `${EXPLORER}/tx/${tx.hash}`);
}

main().catch(err => { console.error(`\n[FATAL] ${err.message}`); process.exit(1); });
