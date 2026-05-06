const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const PlayerProfile = require('../models/PlayerProfile');
const IAPPurchase = require('../models/IAPPurchase');

// Re-persist updated profile to 0G Storage after IAP delivers items.
// Lazy-loaded so missing SDK never crashes the IAP flow.
let _persistTo0G = null;
function get0GPersist() {
  if (_persistTo0G) return _persistTo0G;
  try {
    _persistTo0G = require('./zgController').persistProfileTo0G;
  } catch {
    _persistTo0G = async () => null;
  }
  return _persistTo0G;
}

function loadContractAbi() {
  const candidates = [
    path.resolve(__dirname, '../shared/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../shared/WarzoneInAppPurchase.json'),
    path.resolve(process.cwd(), 'shared/WarzoneInAppPurchase.json'),
    path.resolve(process.cwd(), 'shared/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../warzonewarrior/src/abi/WarzoneInAppPurchase.json'),
    path.resolve(__dirname, '../../warzone-warriors-frontend/src/abi/WarzoneInAppPurchase.json'),
  ];

  const abiPath = candidates.find((p) => fs.existsSync(p));
  if (!abiPath) {
    throw new Error(
      `WarzoneInAppPurchase ABI not found. Tried: ${candidates.join(', ')}`
    );
  }
  return require(abiPath);
}

const CONTRACT_ABI = loadContractAbi();

const COIN_PACKS = new Map([
  ['100', 100],
  ['500', 500],
  ['1000', 1000],
  ['2000', 2000],
]);
const COIN_PRICES = new Map([
  ['100', '0.5'],
  ['500', '2'],
  ['1000', '4'],
  ['2000', '7.5'],
]);

const GEM_PACKS = new Map([
  ['100', 100],
  ['300', 300],
  ['500', 500],
  ['1000', 1000],
]);
const GEM_PRICES = new Map([
  ['100', '0.5'],
  ['300', '1.5'],
  ['500', '2.5'],
  ['1000', '5'],
]);

const GUN_IDS = new Map([
  ['Shotgun', 4],
  ['Bullpup', 6],
  ['ScarH', 2],
  ['Sniper Rifle', 7],
  ['Tesla Mini', 8],
  ['AWP', 3],
  ['Spread', 100],
  ['Chaser', 101],
  ['Famas', 102],
  ['Laser', 103],
  ['Split', 104],
  ['Fireball', 105],
  ['Tesla', 106],
  ['Kame Power', 107],
  ['Flame Thrower', 108],
]);
const GUN_PRICES = new Map([
  ['Shotgun', '0.8'],
  ['Bullpup', '1.6'],
  ['ScarH', '2'],
  ['Sniper Rifle', '2.4'],
  ['Tesla Mini', '3'],
  ['AWP', '4'],
  ['Spread', '5'],
  ['Chaser', '6'],
  ['Famas', '7'],
  ['Laser', '8'],
  ['Split', '9'],
  ['Fireball', '10'],
  ['Tesla', '12'],
  ['Kame Power', '13'],
  ['Flame Thrower', '15'],
]);

// IAP contract stays on Somnia — unchanged.
const DEFAULT_RPC = 'https://api.infra.mainnet.somnia.network';
const RPC_URL = process.env.IAP_RPC_URL || process.env.SOMNIA_RPC_URL || DEFAULT_RPC;
const CONTRACT_ADDRESS_RAW = process.env.IAP_CONTRACT_ADDRESS || '';
const CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase();
const EXPECTED_CHAIN_ID = Number(process.env.IAP_CHAIN_ID || 5031);

const provider =
  CONTRACT_ADDRESS && RPC_URL ? new ethers.providers.JsonRpcProvider(RPC_URL) : null;
const contractInterface = new ethers.utils.Interface(CONTRACT_ABI);
const PURCHASE_TOPIC = contractInterface.getEventTopic('Purchase');
const PURCHASE_STATUS = {
  PENDING: 'pending_verification',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};
const processingPurchases = new Set();

const normalizeAddress = (value) => (value ? value.toLowerCase() : '');

const toPlainMap = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === 'object') return { ...value };
  return {};
};

const ensurePlayerGunMap = (player) => {
  if (player.PlayerGuns instanceof Map) return player.PlayerGuns;
  const map = new Map(Object.entries(player.PlayerGuns || {}));
  player.PlayerGuns = map;
  return map;
};

const resolveProduct = (category, product) => {
  const key = String(product);
  if (category === 'Coins') {
    const amount = COIN_PACKS.get(key);
    if (!amount) {
      const err = new Error('Invalid coin pack');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = COIN_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for coin pack');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
    };
  }

  if (category === 'Gems') {
    const amount = GEM_PACKS.get(key);
    if (!amount) {
      const err = new Error('Invalid gem pack');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = GEM_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for gem pack');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
    };
  }

  if (category === 'Guns') {
    const gunId = GUN_IDS.get(key);
    if (gunId === undefined) {
      const err = new Error('Invalid gun product');
      err.statusCode = 400;
      throw err;
    }
    const priceEth = GUN_PRICES.get(key);
    if (!priceEth) {
      const err = new Error('Price not configured for gun');
      err.statusCode = 500;
      throw err;
    }
    return {
      category,
      product: key,
      amount: null,
      priceEth,
      price: parseFloat(priceEth),
      priceWei: ethers.utils.parseEther(priceEth),
      currency: 'ETH',
      gunId,
    };
  }

  const err = new Error('Unsupported category. Allowed: Coins, Gems, Guns');
  err.statusCode = 400;
  throw err;
};

const buildPurchasePayload = (record) => {
  if (!record) return null;
  const status = record.metadata?.status || (record.delivered ? PURCHASE_STATUS.COMPLETED : PURCHASE_STATUS.PENDING);
  return {
    category: record.category,
    product: record.product,
    amount: record.metadata?.amount ?? null,
    gunId: record.metadata?.gunId ?? null,
    priceEth: record.priceEth,
    priceWei: record.priceWei,
    price: record.price,
    currency: 'ETH',
    orderId: record.orderId,
    txHash: record.txHash,
    delivered: record.delivered,
    purchaseId: record._id?.toString?.(),
    chainId: record.chainId ?? null,
    blockNumber: record.metadata?.blockNumber ?? null,
    status,
    verificationError: record.metadata?.verificationError ?? null,
  };
};

async function markPurchaseFailed(purchase, message) {
  const metadata = { ...(purchase.metadata || {}) };
  metadata.status = PURCHASE_STATUS.FAILED;
  metadata.verificationError = message;
  metadata.failedAt = new Date();
  purchase.metadata = metadata;
  purchase.delivered = false;
  await purchase.save();
}

async function verifyAndDeliverPurchase(purchaseId) {
  if (!provider || !CONTRACT_ADDRESS) {
    throw new Error('IAP contract is not configured on the server');
  }

  const purchase = await IAPPurchase.findById(purchaseId);
  if (!purchase) return;

  const metadata = { ...(purchase.metadata || {}) };
  const currentStatus = metadata.status || PURCHASE_STATUS.PENDING;
  if (currentStatus === PURCHASE_STATUS.COMPLETED || currentStatus === PURCHASE_STATUS.FAILED) {
    return;
  }

  metadata.status = PURCHASE_STATUS.PROCESSING;
  purchase.metadata = metadata;
  await purchase.save();

  const wallet = normalizeAddress(purchase.walletAddress);
  const productInfo = resolveProduct(purchase.category, purchase.product);

  const receipt = await provider.getTransactionReceipt(purchase.txHash);
  if (!receipt) {
    return await markPurchaseFailed(purchase, 'Transaction receipt not found');
  }
  if (receipt.status !== 1) {
    return await markPurchaseFailed(purchase, 'Transaction failed on-chain');
  }
  if (normalizeAddress(receipt.to) !== CONTRACT_ADDRESS) {
    return await markPurchaseFailed(purchase, 'Transaction target contract mismatch');
  }
  if (normalizeAddress(receipt.from) !== wallet) {
    return await markPurchaseFailed(purchase, 'Transaction sender mismatch');
  }

  const tx = await provider.getTransaction(purchase.txHash);
  if (!tx) {
    return await markPurchaseFailed(purchase, 'Transaction not found');
  }
  if (tx.chainId != null && Number(tx.chainId) !== EXPECTED_CHAIN_ID) {
    return await markPurchaseFailed(
      purchase,
      `Unexpected chain id ${tx.chainId}; expected ${EXPECTED_CHAIN_ID}`,
    );
  }
  if (!tx.value.eq(productInfo.priceWei)) {
    return await markPurchaseFailed(purchase, 'Transaction value mismatch');
  }

  const purchaseLog = receipt.logs.find(
    (log) =>
      normalizeAddress(log.address) === CONTRACT_ADDRESS &&
      log.topics &&
      log.topics[0] === PURCHASE_TOPIC,
  );
  if (!purchaseLog) {
    return await markPurchaseFailed(purchase, 'Purchase event not found');
  }

  const parsedLog = contractInterface.parseLog(purchaseLog);
  if (normalizeAddress(parsedLog.args.buyer) !== wallet) {
    return await markPurchaseFailed(purchase, 'Purchase event buyer mismatch');
  }
  if (parsedLog.args.orderId !== purchase.orderHash) {
    return await markPurchaseFailed(purchase, 'Purchase event orderId mismatch');
  }
  if (
    parsedLog.args.category !== purchase.category ||
    parsedLog.args.product !== purchase.product
  ) {
    return await markPurchaseFailed(purchase, 'Purchase event category/product mismatch');
  }
  if (!parsedLog.args.priceWei.eq(productInfo.priceWei)) {
    return await markPurchaseFailed(purchase, 'Purchase event price mismatch');
  }

  const player = await PlayerProfile.findOne({
    walletAddress: { $regex: new RegExp(`^${wallet}$`, 'i') },
  });
  if (!player) {
    return await markPurchaseFailed(purchase, 'Player not found');
  }

  let message = '';
  let changed = false;
  let delivered = true;
  if (purchase.category === 'Coins') {
    player.PlayerResources = player.PlayerResources || {
      coin: 0,
      gem: 0,
      stamina: 0,
      medal: 0,
      tournamentTicket: 0,
    };
    player.PlayerResources.coin = (player.PlayerResources.coin ?? 0) + productInfo.amount;
    message = `Added +${productInfo.amount} coins`;
    changed = true;
  } else if (purchase.category === 'Gems') {
    player.PlayerResources = player.PlayerResources || {
      coin: 0,
      gem: 0,
      stamina: 0,
      medal: 0,
      tournamentTicket: 0,
    };
    player.PlayerResources.gem = (player.PlayerResources.gem ?? 0) + productInfo.amount;
    message = `Added +${productInfo.amount} gems`;
    changed = true;
  } else if (purchase.category === 'Guns') {
    const gunKey = String(productInfo.gunId);
    const gunsMap = ensurePlayerGunMap(player);
    const hasGun = gunsMap instanceof Map ? gunsMap.get(gunKey) : gunsMap[gunKey];

    if (hasGun) {
      message = `Gun already owned: ${purchase.product} (id=${productInfo.gunId})`;
      delivered = false;
    } else {
      const gunData = { id: productInfo.gunId, level: 1, ammo: 100000, isNew: true };
      if (gunsMap instanceof Map) {
        gunsMap.set(gunKey, gunData);
      } else {
        gunsMap[gunKey] = gunData;
        player.PlayerGuns = gunsMap;
        if (typeof player.markModified === 'function') player.markModified('PlayerGuns');
      }
      message = `Unlocked gun: ${purchase.product} (id=${productInfo.gunId})`;
      changed = true;
    }
  }

  if (changed) {
    await player.save();
    // Re-upload the updated profile to 0G Storage so IAP deliveries are reflected on-chain.
    setImmediate(() => {
      get0GPersist()(purchase.walletAddress, player.toObject(), 'iap_delivery').catch(
        err => console.error('[0G] IAP re-upload failed (non-fatal):', err.message),
      );
    });
  }

  const finalMeta = { ...(purchase.metadata || {}) };
  finalMeta.status = PURCHASE_STATUS.COMPLETED;
  finalMeta.blockNumber = receipt.blockNumber ?? null;
  finalMeta.transactionIndex = receipt.transactionIndex ?? null;
  finalMeta.logIndex = purchaseLog.logIndex ?? null;
  finalMeta.completedAt = new Date();
  finalMeta.message = message;
  delete finalMeta.verificationError;

  purchase.metadata = finalMeta;
  purchase.chainId = tx.chainId != null ? Number(tx.chainId) : undefined;
  purchase.delivered = delivered;
  await purchase.save();
}

function schedulePurchaseProcessing(purchaseId) {
  const key = String(purchaseId);
  if (processingPurchases.has(key)) return;
  processingPurchases.add(key);
  setImmediate(async () => {
    try {
      await verifyAndDeliverPurchase(purchaseId);
    } catch (err) {
      console.error('IAP background verification failed:', err);
      try {
        const purchase = await IAPPurchase.findById(purchaseId);
        if (purchase) {
          await markPurchaseFailed(
            purchase,
            err?.message || 'Background verification failed',
          );
        }
      } catch (markErr) {
        console.error('Failed to persist IAP verification error:', markErr);
      }
    } finally {
      processingPurchases.delete(key);
    }
  });
}

function buildPlayerSnapshot(player, purchasePayload) {
  return {
    walletAddress: player.walletAddress,
    PlayerResources: player.PlayerResources,
    PlayerGuns: toPlainMap(player.PlayerGuns),
    purchase: purchasePayload,
    priceEth: purchasePayload?.priceEth,
    price: purchasePayload?.price,
    currency: 'ETH',
  };
}

// POST /warzone/iap/purchase
exports.purchase = async (req, res) => {
  try {
    const wallet = normalizeAddress(
      req.walletAddress || req.user?.wallet || req.wallet || '',
    );
    if (!wallet) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const { category, product, orderId, txHash } = req.body || {};

    if (!category || !product) {
      return res
        .status(400)
        .json({ ok: false, message: 'category and product are required' });
    }

    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      return res.status(400).json({ ok: false, message: 'orderId is required' });
    }

    if (
      !txHash ||
      typeof txHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())
    ) {
      return res.status(400).json({
        ok: false,
        message: 'txHash must be a 0x-prefixed transaction hash',
      });
    }

    if (!provider || !CONTRACT_ADDRESS) {
      return res.status(500).json({
        ok: false,
        message: 'IAP contract is not configured on the server',
      });
    }

    const categoryNorm = String(category);
    const productNorm = String(product);
    const orderIdTrim = orderId.trim();
    const txHashNorm = txHash.trim().toLowerCase();
    const orderHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(orderIdTrim),
    );

    // Validate pack/product synchronously so client gets fast deterministic errors.
    const productInfo = resolveProduct(categoryNorm, productNorm);

    const player = await PlayerProfile.findOne({
      walletAddress: { $regex: new RegExp(`^${wallet}$`, 'i') },
    });
    if (!player) {
      return res.status(404).json({ ok: false, message: 'Player not found' });
    }

    let purchaseRecord = await IAPPurchase.findOne({ orderHash });
    if (purchaseRecord) {
      if (normalizeAddress(purchaseRecord.walletAddress) !== wallet) {
        return res.status(409).json({
          ok: false,
          message: 'Order already processed by another wallet',
        });
      }
      if (purchaseRecord.txHash !== txHashNorm) {
        return res.status(409).json({
          ok: false,
          message: 'Order already processed with a different transaction hash',
        });
      }
      if (
        purchaseRecord.category !== categoryNorm ||
        purchaseRecord.product !== productNorm
      ) {
        return res
          .status(409)
          .json({ ok: false, message: 'Order already processed for another item' });
      }

      const status = purchaseRecord.metadata?.status;
      if (status !== PURCHASE_STATUS.COMPLETED && status !== PURCHASE_STATUS.FAILED) {
        schedulePurchaseProcessing(purchaseRecord._id);
      }

      const purchasePayload = buildPurchasePayload(purchaseRecord);
      return res.json({
        ok: true,
        message:
          purchasePayload?.status === PURCHASE_STATUS.COMPLETED
            ? 'Order already processed'
            : 'Purchase is being verified in background',
        data: buildPlayerSnapshot(player, purchasePayload),
      });
    }

    try {
      purchaseRecord = await IAPPurchase.create({
        orderId: orderIdTrim,
        orderHash,
        walletAddress: wallet,
        txHash: txHashNorm,
        category: categoryNorm,
        product: productNorm,
        priceEth: productInfo.priceEth,
        price: productInfo.price,
        priceWei: productInfo.priceWei.toString(),
        delivered: false,
        metadata: {
          amount: productInfo.amount ?? null,
          gunId: productInfo.gunId ?? null,
          status: PURCHASE_STATUS.PENDING,
          acceptedAt: new Date(),
        },
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        purchaseRecord =
          (await IAPPurchase.findOne({ orderHash })) ||
          (await IAPPurchase.findOne({ txHash: txHashNorm }));
      } else {
        throw createErr;
      }
    }
    if (!purchaseRecord) {
      throw new Error('Unable to create or resolve purchase record');
    }
    if (normalizeAddress(purchaseRecord.walletAddress) !== wallet) {
      return res.status(409).json({
        ok: false,
        message: 'Order already processed by another wallet',
      });
    }
    if (
      purchaseRecord.category !== categoryNorm ||
      purchaseRecord.product !== productNorm
    ) {
      return res
        .status(409)
        .json({ ok: false, message: 'Order already processed for another item' });
    }

    schedulePurchaseProcessing(purchaseRecord._id);

    const purchasePayload = buildPurchasePayload(purchaseRecord);
    return res.status(202).json({
      ok: true,
      message: 'Purchase accepted for background verification',
      data: buildPlayerSnapshot(player, purchasePayload),
    });
  } catch (err) {
    console.error('IAP purchase error:', err);
    const status = err?.statusCode || 500;
    const message =
      err?.message ||
      'Unable to process purchase at the moment. Please try again later.';
    return res.status(status).json({ ok: false, message });
  }
};

// GET /warzone/iap/purchase-status?orderId=... OR ?txHash=...
exports.getPurchaseStatus = async (req, res) => {
  try {
    const wallet = normalizeAddress(
      req.walletAddress || req.user?.wallet || req.wallet || '',
    );
    if (!wallet) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const orderId = String(req.query?.orderId || '').trim();
    const txHash = String(req.query?.txHash || '').trim().toLowerCase();
    if (!orderId && !txHash) {
      return res.status(400).json({
        ok: false,
        message: 'orderId or txHash is required',
      });
    }

    const query = orderId ? { orderId } : { txHash };
    const purchase = await IAPPurchase.findOne(query);
    if (!purchase) {
      return res.status(404).json({ ok: false, message: 'Purchase not found' });
    }
    if (normalizeAddress(purchase.walletAddress) !== wallet) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const status = purchase.metadata?.status;
    if (status !== PURCHASE_STATUS.COMPLETED && status !== PURCHASE_STATUS.FAILED) {
      schedulePurchaseProcessing(purchase._id);
    }

    const player = await PlayerProfile.findOne({
      walletAddress: { $regex: new RegExp(`^${wallet}$`, 'i') },
    });
    if (!player) {
      return res.status(404).json({ ok: false, message: 'Player not found' });
    }

    const purchasePayload = buildPurchasePayload(purchase);
    return res.json({
      ok: true,
      message: 'Purchase status fetched',
      data: buildPlayerSnapshot(player, purchasePayload),
    });
  } catch (err) {
    console.error('IAP purchase status error:', err);
    return res.status(500).json({ ok: false, message: 'Unable to fetch purchase status' });
  }
};
