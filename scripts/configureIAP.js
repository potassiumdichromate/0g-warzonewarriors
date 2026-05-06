/* eslint-disable no-console */
/**
 * Script to configure Warzone IAP contract products and deposit address.
 *
 * Usage:
 *   IAP_OWNER_PRIVATE_KEY=0x... node scripts/configureIAP.js
 *
 * Environment variables:
 *   IAP_RPC_URL               - RPC endpoint (defaults to Somnia mainnet public RPC)
 *   IAP_CONTRACT_ADDRESS      - Deployed WarzoneInAppPurchase contract address (required)
 *   IAP_OWNER_PRIVATE_KEY     - Owner private key (required to send transactions)
 *   IAP_DEPOSIT_ADDRESS       - Optional deposit address to set before pricing
 *   IAP_CHAIN_ID              - Expected network chain id (default 5031 Somnia)
 */

const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function loadContractAbi() {
  const candidates = [
    path.resolve(__dirname, '../shared/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/abi/WarzoneInAppPurchase.json'),
  ];

  const abiPath = candidates.find((p) => fs.existsSync(p));
  if (!abiPath) {
    throw new Error(
      `WarzoneInAppPurchase ABI not found. Tried: ${candidates.join(', ')}`,
    );
  }
  return require(abiPath);
}

const contractAbi = loadContractAbi();

const DEFAULT_RPC = 'https://api.infra.mainnet.somnia.network';
const PRODUCTS = [
  // Coins
  { category: 'Coins', product: '100', priceEth: '0.5', enabled: true },
  { category: 'Coins', product: '500', priceEth: '2', enabled: true },
  { category: 'Coins', product: '1000', priceEth: '4', enabled: true },
  { category: 'Coins', product: '2000', priceEth: '7.5', enabled: true },
  // Gems
  { category: 'Gems', product: '100', priceEth: '0.5', enabled: true },
  { category: 'Gems', product: '300', priceEth: '1.5', enabled: true },
  { category: 'Gems', product: '500', priceEth: '2.5', enabled: true },
  { category: 'Gems', product: '1000', priceEth: '5', enabled: true },
  // Guns
  { category: 'Guns', product: 'Shotgun', priceEth: '0.8', enabled: true },
  { category: 'Guns', product: 'Bullpup', priceEth: '1.6', enabled: true },
  { category: 'Guns', product: 'ScarH', priceEth: '2', enabled: true },
  { category: 'Guns', product: 'Sniper Rifle', priceEth: '2.4', enabled: true },
  { category: 'Guns', product: 'Tesla Mini', priceEth: '3', enabled: true },
  { category: 'Guns', product: 'AWP', priceEth: '4', enabled: true },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const rpcUrl = process.env.IAP_RPC_URL || process.env.SOMNIA_RPC_URL || DEFAULT_RPC;
  const privateKey = process.env.IAP_OWNER_PRIVATE_KEY;
  const contractAddressRaw = process.env.IAP_CONTRACT_ADDRESS;
  const expectedChainId = Number(process.env.IAP_CHAIN_ID || 5031);
  const depositAddress = process.env.IAP_DEPOSIT_ADDRESS;

  if (!contractAddressRaw) {
    throw new Error('Missing IAP_CONTRACT_ADDRESS in environment variables.');
  }
  if (!privateKey) {
    throw new Error('Missing IAP_OWNER_PRIVATE_KEY in environment variables.');
  }

  const contractAddress = ethers.utils.getAddress(contractAddressRaw);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const { chainId } = await provider.getNetwork();
  if (expectedChainId && chainId !== expectedChainId) {
    throw new Error(
      `RPC chain id mismatch (got ${chainId}, expected ${expectedChainId}). Set IAP_CHAIN_ID accordingly.`,
    );
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, contractAbi, wallet);

  console.log('----------------------------------------------');
  console.log('Configuring Warzone IAP Contract');
  console.log('Contract:     ', contractAddress);
  console.log('Owner wallet: ', wallet.address);
  console.log('RPC:          ', rpcUrl);
  console.log('Chain Id:     ', chainId);
  console.log('----------------------------------------------');

  const contractOwner = await contract.owner();
  if (wallet.address.toLowerCase() !== contractOwner.toLowerCase()) {
    throw new Error(
      `Wallet ${wallet.address} is not the contract owner (${contractOwner}).`,
    );
  }

  if (depositAddress) {
    const normalizedDeposit = ethers.utils.getAddress(depositAddress);
    const currentDeposit = await contract.depositAddress();
    if (currentDeposit.toLowerCase() !== normalizedDeposit.toLowerCase()) {
      console.log(`Updating deposit address -> ${normalizedDeposit}`);
      const tx = await contract.setDepositAddress(normalizedDeposit);
      console.log('  tx sent:', tx.hash);
      await tx.wait(1);
      console.log('  deposit address updated.');
      await sleep(750);
    } else {
      console.log('Deposit address already configured, skipping.');
    }
  } else {
    console.log('IAP_DEPOSIT_ADDRESS not provided. Skipping deposit update.');
  }

  for (const { category, product, priceEth, enabled } of PRODUCTS) {
    const priceWei = ethers.utils.parseEther(priceEth);
    const [currentPriceWei, currentEnabled] = await contract.getProduct(category, product);

    const needsUpdate =
      !priceWei.eq(currentPriceWei) || Boolean(enabled) !== Boolean(currentEnabled);

    if (!needsUpdate) {
      console.log(
        `SKU ${category}:${product} already configured (${priceEth} ETH, enabled=${enabled}). Skipping.`,
      );
      continue;
    }

    console.log(
      `Setting ${category}:${product} -> ${priceEth} ETH, enabled=${enabled}`,
    );

    const tx = await contract.setProduct(category, product, priceWei, enabled);
    console.log('  tx sent:', tx.hash);
    await tx.wait(1);
    console.log('  confirmed.');
    await sleep(750);
  }

  console.log('All products processed ✅');
}

main().catch((err) => {
  console.error('Failed to configure IAP contract:', err);
  process.exit(1);
});
