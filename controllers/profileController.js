const { ethers } = require('ethers');
const crypto = require('crypto');

// controllers/warzoneController.js
const jwt = require('jsonwebtoken');
const PlayerProfile = require('../models/PlayerProfile');
const {
  applyTournamentDeltaOnProfileSave,
  resolveActiveRoundIdFromIntraverse,
} = require('../services/tournamentDeltaFromSave');
const WarzoneNameWallet = require('../models/nameWallet');
const NameCounter = require('../models/nameCounter');
const NonceState = require('../models/NonceState');
const { request } = require('http');

// 0G dual-write: every JSON save is also persisted to 0G Storage as msgpack binary.
// Loaded lazily so missing SDK doesn't crash startup.
let _persistTo0G = null;
function get0GPersist() {
  if (_persistTo0G) return _persistTo0G;
  try {
    _persistTo0G = require('./zgController').persistProfileTo0G;
  } catch {
    _persistTo0G = async () => null;  // no-op if 0G not installed
  }
  return _persistTo0G;
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const PERF_LOGS_ENABLED =
  String(process.env.API_PERF_LOGS ?? 'true').trim().toLowerCase() !== 'false';
const PERF_SLOW_STEP_MS = Number(process.env.API_SLOW_STEP_MS || 500);

function createPerfLogger(scope, meta = {}) {
  const start = process.hrtime.bigint();
  let last = start;

  const emit = (level, phase, durationMs, extra = {}) => {
    if (!PERF_LOGS_ENABLED) return;
    const payload = {
      scope,
      phase,
      durationMs: Number(durationMs.toFixed(2)),
      ...meta,
      ...extra,
    };
    if (level === 'warn') console.warn('[perf][slow]', payload);
    else console.log('[perf]', payload);
  };

  return {
    step(phase, extra = {}) {
      const now = process.hrtime.bigint();
      const durationMs = Number(now - last) / 1e6;
      last = now;
      emit(durationMs >= PERF_SLOW_STEP_MS ? 'warn' : 'info', phase, durationMs, extra);
    },
    done(extra = {}) {
      const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
      emit(totalMs >= PERF_SLOW_STEP_MS ? 'warn' : 'info', 'total', totalMs, extra);
    },
  };
}

function runInBackground(task, label, meta = {}) {
  setImmediate(async () => {
    const perf = createPerfLogger(label, meta);
    try {
      await task();
      perf.done({ status: 'ok' });
    } catch (error) {
      perf.step('error', { message: error?.message || String(error) });
      perf.done({ status: 'error' });
      console.error(`[${label}] background task failed:`, error);
    }
  });
}

const SUPPORTED_WALLET_PROVIDER_TYPES = new Set([
  'metamask',
  'coinbase_wallet',
  'base_account',
  'rainbow',
  'phantom',
  'zerion',
  'cryptocom',
  'uniswap',
  'okx_wallet',
  'bitget_wallet',
  'universal_profile',
]);

function normalizeWalletProviderType(rawType) {
  if (!rawType) return null;
  const normalized = String(rawType).trim().toLowerCase();
  if (!normalized) return null;

  // Backward-compatible aliases seen in wallet SDKs.
  if (normalized === 'bitget') return 'bitget_wallet';
  if (normalized === 'okx') return 'okx_wallet';

  return SUPPORTED_WALLET_PROVIDER_TYPES.has(normalized) ? normalized : normalized;
}

function extractLoginWalletAddress(payload) {
  return (
    payload?.walletAddress ||
    payload?.wallet?.address ||
    payload?.privyMetaData?.walletAddress ||
    payload?.privyMetaData?.address ||
    null
  );
}

function normalizeWalletAddress(walletAddress) {
  return String(walletAddress || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walletAddressCaseInsensitiveQuery(walletAddress) {
  const normalized = normalizeWalletAddress(walletAddress);
  return {
    walletAddress: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') }
  };
}

function getClientIp(req) {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  const xRealIp = req?.headers?.['x-real-ip'];
  const forwarded = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const realIp = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
  const firstForwardedIp = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return firstForwardedIp || realIp || req?.ip || req?.socket?.remoteAddress || '';
}

// Somnia chain settings — game contract (registerUser, startGameFor, endGameFor) stays on Somnia.
// Root hash anchoring uses a separate 0G chain contract (see services/ZeroGChain.js).
function readEnv(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const trimmed = String(v).trim();
  return trimmed === '' ? fallback : trimmed;
}

function getChainConfig() {
  const rpcUrl = readEnv('SOMNIA_RPC_URL', 'https://api.infra.mainnet.somnia.network');
  const rpcUrlsRaw = readEnv('SOMNIA_RPC_URLS', '');
  const rpcUrls = (rpcUrlsRaw ? rpcUrlsRaw.split(',') : [rpcUrl])
    .map(s => String(s).trim())
    .filter(Boolean);
  const contractAddress = readEnv('GAME_CONTRACT_ADDRESS', '0xEA4450c195ECFd63A6d7e35768fF351e748317cB');
  const ownerPkRaw = readEnv('GAME_OWNER_PRIVATE_KEY', readEnv('OWNER_PRIVATE_KEY', ''));
  const waitConfirmations = Number(readEnv('WAIT_FOR_CONFIRMATIONS', '1'));
  const gasPriceGwei = readEnv('GAS_PRICE_GWEI', '');
  const rpcTimeoutMs = Number(readEnv('SOMNIA_RPC_TIMEOUT_MS', '15000'));
  const rpcRetries = Number(readEnv('SOMNIA_RPC_RETRIES', '3'));
  const nonceFloorTtlMs = Number(readEnv('SOMNIA_NONCE_FLOOR_TTL_MS', '2000'));
  const nonceFloorStrategy = readEnv('SOMNIA_NONCE_FLOOR_STRATEGY', 'pending');
  const maxNonceGap = 5;
  const chainId = Number(readEnv('SOMNIA_CHAIN_ID', '5031'));
  const networkName = readEnv('SOMNIA_NETWORK_NAME', 'somnia');
  return {
    rpcUrl, rpcUrls, contractAddress, ownerPkRaw, waitConfirmations, gasPriceGwei,
    rpcTimeoutMs, rpcRetries, nonceFloorTtlMs, nonceFloorStrategy, maxNonceGap, chainId, networkName,
  };
}

const GAME_ABI = [
  'function registerUser(address user, string name) external',
  'function startGameFor(address user) external returns (uint256)',
  'function endGameFor(address user) external returns (uint256)',
  'function isRegistered(address user) external view returns (bool)',
  'function activeSessionOf(address user) external view returns (uint256)',
];

let _gameContract;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRpcError(err) {
  const code =
    err?.code ||
    err?.error?.code ||
    err?.serverError?.code ||
    err?.serverError?.errno ||
    err?.errno;

  const text = [
    err?.reason,
    err?.message,
    err?.error?.message,
    err?.serverError?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    text.includes('missing response') ||
    text.includes('socket hang up') ||
    text.includes('disconnected') ||
    text.includes('timeout')
  );
}

class RetryingJsonRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  constructor(url, network, opts = {}) {
    const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000;
    super({ url, timeout }, network);
    this._rpcRetries = Number.isFinite(opts.retries) ? Math.max(0, opts.retries) : 3;
    this._rpcRetryBaseMs = Number.isFinite(opts.retryBaseMs) ? Math.max(0, opts.retryBaseMs) : 250;
    this._rpcRetryMaxMs = Number.isFinite(opts.retryMaxMs) ? Math.max(0, opts.retryMaxMs) : 4000;
  }

  async send(method, params) {
    // For raw tx broadcast, prefer fast failover over retrying the same host.
    const retriesForMethod = method === 'eth_sendRawTransaction' ? 0 : this._rpcRetries;
    const maxAttempts = retriesForMethod + 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await super.send(method, params);
      } catch (err) {
        lastErr = err;
        if (!isTransientRpcError(err) || attempt === maxAttempts) throw err;

        const exp = Math.min(this._rpcRetryMaxMs, this._rpcRetryBaseMs * (2 ** (attempt - 1)));
        const jitter = Math.floor(Math.random() * 100);
        const delayMs = exp + jitter;
        console.warn('[rpc retry]', { method, attempt, maxAttempts, delayMs, code: err?.code || err?.serverError?.code });
        await sleep(delayMs);
      }
    }
    throw lastErr;
  }
}

function getGameContract() {
  if (_gameContract) return _gameContract;

  const { rpcUrls, contractAddress, ownerPkRaw, rpcTimeoutMs, rpcRetries, chainId, networkName } = getChainConfig();
  if (!rpcUrls?.length) throw new Error('Missing SOMNIA_RPC_URL(S)');
  if (!contractAddress) throw new Error('Missing GAME_CONTRACT_ADDRESS');
  if (!ownerPkRaw) throw new Error('Missing GAME_OWNER_PRIVATE_KEY');
  if (!Number.isFinite(chainId)) throw new Error('Missing/invalid SOMNIA_CHAIN_ID');

  const network = { chainId, name: networkName || 'somnia' };
  const providers = rpcUrls.map((url) => new RetryingJsonRpcProvider(url, network, { timeoutMs: rpcTimeoutMs, retries: rpcRetries }));
  const provider =
    providers.length === 1
      ? providers[0]
      : new ethers.providers.FallbackProvider(
          providers.map((p, i) => ({
            provider: p,
            priority: i + 1,
            weight: 1,
            stallTimeout: rpcTimeoutMs,
          })),
          1
        );
  const pkTrim = ownerPkRaw.trim();
  const pk = pkTrim.startsWith('0x') ? pkTrim : `0x${pkTrim}`;
  const wallet = new ethers.Wallet(pk, provider);
  _gameContract = new ethers.Contract(contractAddress, GAME_ABI, wallet);
  return _gameContract;
}

let _nonceLock = Promise.resolve();
let _nextNonce = null;

async function withNonceLock(task) {
  const previous = _nonceLock;
  let release;
  _nonceLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function isNonceConflictError(err) {
  const text = [
    err?.code,
    err?.reason,
    err?.message,
    err?.error?.message,
    err?.error?.body,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    err?.code === 'NONCE_EXPIRED' ||
    text.includes('nonce too low') ||
    text.includes('nonce has already been used') ||
    text.includes('nonce not close enough') ||
    text.includes('nonce too high') ||
    text.includes('already known') ||
    text.includes('replacement transaction underpriced')
  );
}

function useDbNonceManager() {
  const raw = readEnv('USE_DB_NONCE_MANAGER', 'true');
  return raw !== 'false' && raw !== '0';
}

const _nonceFloorCache = new Map();

function nonceFloorCacheKey({ chainId, address }) {
  return `${chainId}:${String(address || '').trim().toLowerCase()}`;
}

function clearNonceFloorCache({ chainId, address }) {
  _nonceFloorCache.delete(nonceFloorCacheKey({ chainId, address }));
}

async function getChainNonceFloor({ provider, address }) {
  const { chainId, nonceFloorTtlMs, nonceFloorStrategy } = getChainConfig();
  const key = nonceFloorCacheKey({ chainId, address });
  const now = Date.now();
  const cached = _nonceFloorCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  // Most RPCs guarantee pending >= latest; calling both doubles load.
  const pending = await provider.getTransactionCount(address, 'pending');
  let floor = Number(pending);
  if (nonceFloorStrategy === 'pending_latest') {
    const latest = await provider.getTransactionCount(address, 'latest');
    floor = Math.max(floor, Number(latest));
  }
  if (!Number.isSafeInteger(floor)) {
    throw new Error(`Unsafe nonce value returned from RPC: pending=${pending}`);
  }

  const ttl = Number.isFinite(nonceFloorTtlMs) ? Math.max(0, nonceFloorTtlMs) : 0;
  _nonceFloorCache.set(key, { value: floor, expiresAt: now + ttl });
  return floor;
}

async function sendContractTx(method, args = [], overrides = {}) {
  const contract = getGameContract();
  const signer = contract.signer;
  const provider = contract.provider || signer.provider;
  const from = (await signer.getAddress()).toLowerCase();
  const { chainId, maxNonceGap } = getChainConfig();
  const dbNonce = useDbNonceManager();

  return withNonceLock(async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const chainNonceFloor = await getChainNonceFloor({ provider, address: from });

        let nonce;
        if (dbNonce) {
          nonce = await NonceState.allocateNonce({ address: from, chainId, chainNonceFloor, maxNonceGap });
        } else {
          if (_nextNonce == null) _nextNonce = chainNonceFloor;
          if (_nextNonce < chainNonceFloor) _nextNonce = chainNonceFloor;
          nonce = _nextNonce;
        }

        const tx = await contract[method](...args, { ...overrides, nonce });
        if (!dbNonce) _nextNonce = nonce + 1;
        return tx;
      } catch (err) {
        if (isNonceConflictError(err) && attempt < 3) {
          try {
            clearNonceFloorCache({ chainId, address: from });
            const chainNonceFloor = await getChainNonceFloor({ provider, address: from });
            if (dbNonce) {
              await NonceState.bumpFloor({ address: from, chainId, chainNonceFloor });
            } else {
              _nextNonce = chainNonceFloor;
            }
          } catch (bumpErr) {
            console.warn('[sendContractTx] nonce bump failed:', bumpErr?.message || bumpErr);
            _nextNonce = null;
          }
          continue;
        }
        throw err;
      }
    }
  });
}

function gasOverrides() {
  const { gasPriceGwei } = getChainConfig();
  if (gasPriceGwei && !Number.isNaN(Number(gasPriceGwei))) {
    return { gasPrice: ethers.utils.parseUnits(String(gasPriceGwei), 'gwei') };
  }
  return {};
}

function toSafeInt(value, fallback = 0) {
  if (value == null) return fallback;
  if (ethers.BigNumber.isBigNumber(value)) {
    try {
      return value.toNumber();
    } catch {
      const n = Number(value.toString());
      return Number.isFinite(n) ? n : fallback;
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safely extract values from PlayerAchievementData regardless of whether
 * Mongoose returns it as a Map, a plain object, or a Mongoose document.
 * This is the core fix — Mongoose Map cannot be iterated with Object.values().
 */
function extractAchievementValues(achievementData) {
  if (!achievementData) return [];

  // Mongoose Map (most common case with Map schema type)
  if (achievementData instanceof Map) {
    return Array.from(achievementData.values());
  }

  // After .toObject() — plain JS object
  if (typeof achievementData === 'object' && !Array.isArray(achievementData)) {
    return Object.values(achievementData).filter(
      v => v !== null && typeof v === 'object' && 'type' in v
    );
  }

  return [];
}

async function registerAndStartOnChain(walletAddress, displayName = '') {
  const perf = createPerfLogger('registerAndStartOnChain', { walletAddress });
  const overrides = gasOverrides();

  const result = {
    attemptedRegister: false,
    registerTxHash: null,
    attemptedStart: false,
    startTxHash: null,
    notes: [],
  };
  try {
    const contract = getGameContract();
    perf.step('getGameContract');
    let registered = false;
    try {
      registered = await contract.isRegistered(walletAddress);
      perf.step('isRegistered', { registered });
    } catch {
      result.notes.push('isRegistered check failed — continuing.');
      perf.step('isRegistered_failed');
    }

    if (!registered) {
      result.attemptedRegister = true;
      const tx = await sendContractTx('registerUser', [walletAddress, displayName], overrides);
      result.registerTxHash = tx.hash;
      perf.step('registerUser_sent', { txHash: tx.hash });
      const { waitConfirmations } = getChainConfig();
      if (waitConfirmations >= 0) await tx.wait(waitConfirmations);
      perf.step('registerUser_confirmed', { waitConfirmations });
    } else {
      result.notes.push('Already registered on-chain.');
    }

    let activeId = 0;
    let activeCheckFailed = false;
    try {
      activeId = toSafeInt(await contract.activeSessionOf(walletAddress), 0);
      perf.step('activeSessionOf', { activeId });
    } catch {
      activeCheckFailed = true;
      result.notes.push('activeSessionOf check failed — skipping start to avoid revert.');
      perf.step('activeSessionOf_failed');
    }

    if (!activeId && !activeCheckFailed) {
      result.attemptedStart = true;
      const tx2 = await sendContractTx('startGameFor', [walletAddress], overrides);
      result.startTxHash = tx2.hash;
      perf.step('startGameFor_sent', { txHash: tx2.hash });
      const { waitConfirmations: wait2 } = getChainConfig();
      if (wait2 >= 0) await tx2.wait(wait2);
      perf.step('startGameFor_confirmed', { waitConfirmations: wait2 });
    } else if (activeCheckFailed) {
      result.notes.push('Start skipped because active session status is unknown.');
    } else {
      result.notes.push(`Game already active (sessionId=${activeId}).`);
    }
  } catch (err) {
    console.error('On-chain error:', err);
    result.notes.push(`On-chain error: ${err.message || String(err)}`);
    perf.step('onchain_error', { message: err?.message });
  }

  console.log('registerAndStartOnChain result:', result);
  perf.done({ attemptedRegister: result.attemptedRegister, attemptedStart: result.attemptedStart });
  return result;
}

async function endGameIfActive(walletAddress) {
  const perf = createPerfLogger('endGameIfActive', { walletAddress });
  const overrides = gasOverrides();

  const result = {
    attemptedEnd: false,
    endTxHash: null,
    notes: [],
  };

  try {
    const contract = getGameContract();
    perf.step('getGameContract');
    let activeId = 0;
    try {
      activeId = toSafeInt(await contract.activeSessionOf(walletAddress), 0);
      perf.step('activeSessionOf', { activeId });
    } catch {
      result.notes.push('activeSessionOf check failed — skipping end to avoid revert.');
      perf.step('activeSessionOf_failed');
      return result;
    }

    if (!activeId) {
      result.notes.push('No active game to end.');
      return result;
    }

    result.attemptedEnd = true;
    const tx = await sendContractTx('endGameFor', [walletAddress], overrides);
    result.endTxHash = tx.hash;
    perf.step('endGameFor_sent', { txHash: tx.hash });
    const { waitConfirmations } = getChainConfig();
    if (waitConfirmations >= 0) await tx.wait(waitConfirmations);
    perf.step('endGameFor_confirmed', { waitConfirmations });
  } catch (err) {
    console.error('endGameIfActive error:', err);
    result.notes.push(`On-chain error: ${err.message || String(err)}`);
    perf.step('onchain_error', { message: err?.message });
  }

  perf.done({ attemptedEnd: result.attemptedEnd });
  return result;
}

/* ---------------- defaults & utils ---------------- */
const defaultData = {
  PlayerProfile: { level: 1, exp: 0 },
  PlayerResources: { coin: 1000, gem: 0, stamina: 0, medal: 0, tournamentTicket: 0 },
  PlayerRambos: { "0": { id: 0, level: 1 } },
  PlayerRamboSkills: { "0": Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i.toString(), 0])) },
  PlayerGuns: { "0": { id: 0, level: 1, ammo: 0, isNew: false } },
  PlayerGrenades: { "500": { id: 500, level: 1, quantity: 10, isNew: false } },
  PlayerMeleeWeapons: { "600": { id: 600, level: 1, isNew: false } },
  PlayerCampaignProgress: {},
  PlayerCampaignStageProgress: {},
  PlayerCampaignRewardProgress: {},
  PlayerBoosters: { Hp: 0, Grenade: 0, Damage: 0, CoinMagnet: 0, Speed: 0, Critical: 0 },
  PlayerSelectingBooster: [],
  PlayerDailyQuestData: [],
  PlayerAchievementData: {},
  PlayerTutorialData: {}
};

const generateDefaultName = async () => {
  const counter = await NameCounter.findByIdAndUpdate(
    'default',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `JohnDigger${counter.seq}`;
};

function normalizeProfile(obj) {
  if (!obj) return obj;
  const ensure = (key, defVal) => {
    if (obj[key] === undefined || obj[key] === null) {
      obj[key] = Array.isArray(defVal) ? [] : (typeof defVal === 'object' ? {} : defVal);
    }
  };
  for (const [k, v] of Object.entries(defaultData)) ensure(k, v);


  if (obj.PlayerCampaignProgress == null) obj.PlayerCampaignProgress = {};
  if (obj.PlayerCampaignStageProgress == null) obj.PlayerCampaignStageProgress = {};
  if (obj.PlayerCampaignRewardProgress == null) obj.PlayerCampaignRewardProgress = {};
  if (obj.PlayerSelectingBooster == null) obj.PlayerSelectingBooster = [];
  if (obj.PlayerDailyQuestData == null) obj.PlayerDailyQuestData = [];
  if (obj.PlayerAchievementData == null) obj.PlayerAchievementData = {};
  if (obj.PlayerTutorialData == null) obj.PlayerTutorialData = {};

  return obj;
}

const getWalletProfile = async (walletAddress) => {
  const perf = createPerfLogger('getWalletProfile', { walletAddress });
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  if (!normalizedWalletAddress) throw new Error('walletAddress required');

  let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
  perf.step('findOne');

  if (!profile) {
    profile = new PlayerProfile({ walletAddress, ...defaultData });
    normalizeProfile(profile);
    await profile.save();
    perf.step('create_and_save');
  } else {
    if (profile.PlayerCampaignProgress == null) profile.PlayerCampaignProgress = {};
    if (profile.PlayerCampaignStageProgress == null) profile.PlayerCampaignStageProgress = {};
    normalizeProfile(profile);
    if (profile.isModified()) {
      await profile.save();
      perf.step('normalize_and_save');
    } else {
      perf.step('normalize_only');
    }
  }
  perf.done();
  return profile;
};

/* ---------------- controllers ---------------- */
exports.saveProfile = async (req, res) => {
  const perf = createPerfLogger('saveProfile', { walletAddress: req.body?.walletAddress });
  try {
    const { data: shouldUpdate, walletAddress, roundId, roomId, ...data } = req.body;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    if (shouldUpdate) {
      const profile = await getWalletProfile(walletAddress);
      perf.step('getWalletProfile_only');
      perf.done({ shouldUpdate: true });
      return res.json(profile);
    }

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
    perf.step('findOne');
    if (!profile) profile = new PlayerProfile({ walletAddress, ...defaultData });

    data.PlayerCampaignProgress = {};

    if (data.PlayerCampaignStageProgress == null) {
      data.PlayerCampaignStageProgress = {};
    }

    Object.assign(profile, data);
    normalizeProfile(profile);

    await profile.save();
    perf.step('profile_save');

    /** Tournament: snapshot baseline per round; medal += (coins − baseline); Intraverse gets that delta; baseline := coins. Never expose baselineCoin in JSON. */
    // let tournamentDelta;
    // const clientRoundId =
    //   roundId != null && String(roundId).trim() !== '' ? String(roundId).trim() : null;
    // let effectiveRoundId = clientRoundId;
    // let roundResolve;
    // if (!effectiveRoundId) {
    //   roundResolve = await resolveActiveRoundIdFromIntraverse();
    //   effectiveRoundId = roundResolve.roundId || null;
    //   perf.step('tournament_resolve_active_round');
    // }
    // if (effectiveRoundId) {
    //   // Intraverse points update happens here: compute this save's tournament delta and push it to Intraverse for the active round.
    //   tournamentDelta = await applyTournamentDeltaOnProfileSave(
    //     walletAddress,
    //     effectiveRoundId,
    //     roomId,
    //   );
    //   if (tournamentDelta.ok && !clientRoundId && roundResolve) {
    //     tournamentDelta.resolvedFromIntraverse = true;
    //     if (roundResolve.tournamentId) tournamentDelta.tournamentId = roundResolve.tournamentId;
    //   }
    //   profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
    //   perf.step('tournament_delta_save');
    // } else if (!clientRoundId && roundResolve) {
    //   tournamentDelta = {
    //     ok: false,
    //     reason: roundResolve.reason || 'NO_ACTIVE_ROUND',
    //     roundId: null,
    //     resolvedFromIntraverse: true,
    //     fetchStatus: roundResolve.fetchStatus,
    //     detail: roundResolve.detail,
    //   };
    // }

    // runInBackground(
    //   () => endGameIfActive(walletAddress),
    //   'saveProfile.endGameIfActive',
    //   { walletAddress },
    // );
    // perf.step('endGameIfActive_scheduled_async');

    // const responseProfile = profile.toObject();
    // if (tournamentDelta !== undefined) {
    //   responseProfile.tournamentDelta = {
    //     ok: tournamentDelta.ok,
    //     reason: tournamentDelta.reason,
    //     roundId: tournamentDelta.roundId,
    //     tournamentId: tournamentDelta.tournamentId,
    //     resolvedFromIntraverse: tournamentDelta.resolvedFromIntraverse,
    //     fetchStatus: tournamentDelta.fetchStatus,
    //     detail: tournamentDelta.detail,
    //     delta: tournamentDelta.delta,
    //     cumulativeDelta: tournamentDelta.cumulativeDelta,
    //     medalAdded: tournamentDelta.medalAdded,
    //     intrabaseStatus: tournamentDelta.intrabaseStatus,
    //     intrabaseBody: tournamentDelta.intrabaseBody,
    //   };
    // }
    const responseProfile = profile.toObject();
    perf.step('prepare_response');

    // 0G Storage dual-write: persist the profile as msgpack binary to 0G Storage.
    // Runs fully in background — never delays the game response.
    runInBackground(
      () => get0GPersist()(walletAddress, responseProfile, 'game_save'),
      'saveProfile.0gPersist',
      { walletAddress: normalizedWalletAddress },
    );

    perf.done({ shouldUpdate: false });
    return res.json(responseProfile);
  } catch (error) {
    console.error('Error in saveProfile:', error);
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({ error: error.message, details: error.errors });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getDailyQuests = async (req, res) => {
  const perf = createPerfLogger('getDailyQuests', { walletAddress: req.query?.walletAddress });
  try {
    const { walletAddress } = req.query;
    if (!walletAddress) {
      return res.status(400).json({ success: false, error: "walletAddress is required" });
    }

    const profile = await getWalletProfile(walletAddress);
    perf.step('getWalletProfile');
    if (!profile) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    perf.done();
    return res.json({
      wallet: walletAddress,
      PlayerDailyQuestData: profile.PlayerDailyQuestData || []
    });
  } catch (error) {
    console.error("Error in getDailyQuests:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

exports.getProfile = async (req, res) => {
  const perf = createPerfLogger('getProfile', { walletAddress: req.query?.walletAddress });
  try {
    const walletAddress = req.query.walletAddress;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    const profile = await getWalletProfile(walletAddress);
    perf.step('getWalletProfile');
    perf.done();
    return res.json(profile);
  } catch (error) {
    console.error('Error in getProfile:', error);
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({ error: error.message, details: error.errors });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /dailyQuests/type/:type?walletAddress=0x...
exports.getDailyQuestByType = async (req, res) => {
  const requestId = crypto.randomBytes(16).toString('hex');
  try {
    const { walletAddress } = req.query;
    const type = Number(req.params.type);
    const clientIp = getClientIp(req);

    res.set('X-Request-Id', requestId);
    console.log('[getDailyQuestByType] start', { requestId, walletAddress, type, ip: clientIp, reqIp: req?.ip });

    if (!walletAddress) {
      console.warn('[getDailyQuestByType] missing walletAddress', { requestId, ip: clientIp, reqIp: req.ip });
      return res.status(400).json({ success: false, error: "walletAddress is required", requestId });
    }
    if (!Number.isFinite(type)) {
      console.warn('[getDailyQuestByType] invalid type', { requestId, type: req.params.type });
      return res.status(400).json({ success: false, error: "type must be a number", requestId });
    }

    const profile = await getWalletProfile(walletAddress);
    const all = Array.isArray(profile.PlayerDailyQuestData) ? profile.PlayerDailyQuestData : [];
    const matches = all.filter(q => Number(q.type) === type);

    let completed = false;
    let reward = '';

    console.log("requestID: ", requestId, " :: Matched ", matches);

    if (type == 11) {
      reward = 'Stage Runner';
      if (matches.length > 0 && matches[0].progress > 2) completed = true;
    } else if (type == 1) {
      reward = 'Mass Annihilation';
      if (matches.length > 0 && matches[0].progress >= 200) completed = true;
    } else if (type == 9) {
      reward = 'Tank Buster';
      if (matches.length > 0 && matches[0].progress >= 20) completed = true;
    } else if (type == 10) {
      reward = 'Hardcore Victor';
      if (matches.length > 0 && matches[0].progress > 5) completed = true;
    } else if (type == 0) {
      reward = 'Boss Slayer';
      if (matches.length > 0 && matches[0].progress >= 3) completed = true;
    }

    const newResponse = {
      success: true,
      status: 200,
      wallet: walletAddress,
      completed: completed ?? false,
      score: matches[0]?.progress ?? 0,
      isClaimed: matches[0]?.isClaimed ?? false,
      reward: reward,
    };

    console.log('[getDailyQuestByType] success', { requestId, walletAddress, type, completed: newResponse.completed, score: newResponse.score });
    return res.json({ ...newResponse });
  } catch (error) {
    console.error("[getDailyQuestByType] error", { requestId, message: error?.message, stack: error?.stack });
    res.set('X-Request-Id', requestId);
    return res.status(500).json({
      ok: false,
      status: 500,
      error: "Server Error, Please Retry",
      requestId
    });
  }
};

exports.getLeaderboard = async (req, res) => {
  const perf = createPerfLogger('getLeaderboard');
  try {
    const leaderboard = await PlayerProfile.find()
      .sort({ 'PlayerResources.coin': -1 })
      .limit(100);
    perf.step('find_profiles');

    const walletAddresses = leaderboard.map(p => p.walletAddress);
    const nameRecords = await WarzoneNameWallet.find({ walletAddress: { $in: walletAddresses } });
    perf.step('find_names', { walletCount: walletAddresses.length });
    const nameMap = {};
    nameRecords.forEach(r => { nameMap[r.walletAddress] = r.name; });

    const leaderboardWithNames = leaderboard.map(doc => {
      const profile = doc.toObject();
      const normalized = normalizeProfile(profile);
      return {
        ...normalized,
        name: nameMap[profile.walletAddress] || `JohnDigger${Math.floor(Math.random() * 1000)}`
      };
    });

    perf.step('map_response');
    perf.done({ count: leaderboardWithNames.length });
    res.json(leaderboardWithNames);
  } catch (error) {
    console.error('Error in getLeaderboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching leaderboard' });
  }
};

exports.checkNameExistance = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const profile = await WarzoneNameWallet.findOne({ name });
    if (profile) return res.json({ success: false, message: 'Name already exists' });
    return res.json({ success: true, message: 'Name is available' });
  } catch (error) {
    console.error('Error in checkNameExistance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.saveName = async (req, res) => {
  try {
    const { name, walletAddress } = req.body;
    if (!walletAddress || !name) {
      return res.status(400).json({ success: false, error: 'Wallet address and name are required' });
    }

    const existingName = await WarzoneNameWallet.findOne({ name });
    if (existingName && existingName.walletAddress !== walletAddress) {
      return res.status(400).json({ success: false, error: 'Name is already taken' });
    }

    const profile = await WarzoneNameWallet.findOneAndUpdate(
      { walletAddress },
      { name, isDefaultName: false },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, message: 'Name saved successfully', data: profile });
  } catch (error) {
    console.error('Error saving name:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.getName = async (req, res) => {
  try {
    const walletAddress = req.walletAddress;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    let nameRecord = await WarzoneNameWallet.findOne({ walletAddress });
    if (!nameRecord) {
      const defaultName = await generateDefaultName();
      nameRecord = new WarzoneNameWallet({ walletAddress, name: defaultName, isDefaultName: true });
      await nameRecord.save();
    }

    res.json({ success: true, name: nameRecord.name, isDefault: nameRecord.isDefaultName || false });
  } catch (error) {
    console.error('Error in getName:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.login = async (req, res) => {
  const perf = createPerfLogger('login');
  try {
    const walletAddress = extractLoginWalletAddress(req.body);
    const providerType = normalizeWalletProviderType(
      req.body?.walletProviderType ||
      req.body?.walletType ||
      req.body?.privyMetaData?.type ||
      req.body?.wallet?.walletClientType
    );
    const providerName = req.body?.providerName || req.body?.privyMetaData?.providerName || null;
    const privyUserId = req.body?.privyUserId || req.body?.privyMetaData?.privyUserId || null;

    if (!walletAddress) {
      return res.status(400).json({ success: false, message: 'Wallet address is required' });
    }

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    perf.step('input_validated', { walletAddress: normalizedWalletAddress });
    let profile = await PlayerProfile.findOne(walletAddressCaseInsensitiveQuery(normalizedWalletAddress));
    perf.step('find_profile');
    const isNewUser = !profile;

    if (isNewUser) {
      profile = new PlayerProfile({ walletAddress, ...defaultData });
      normalizeProfile(profile);
      profile.walletProviderType = providerType;
      profile.walletProviderName = providerName;
      profile.privyUserId = privyUserId;
      profile.lastLoginAt = new Date();
      await profile.save();
      perf.step('create_profile');
    } else {
      normalizeProfile(profile);
      profile.walletProviderType = providerType || profile.walletProviderType || null;
      profile.walletProviderName = providerName || profile.walletProviderName || null;
      profile.privyUserId = privyUserId || profile.privyUserId || null;
      profile.lastLoginAt = new Date();
      await profile.save();
      perf.step('update_profile');
    }

    runInBackground(
      () => registerAndStartOnChain(walletAddress, ''),
      'login.registerAndStartOnChain',
      { walletAddress: normalizedWalletAddress },
    );
    perf.step('registerAndStartOnChain_scheduled_async');

    const token = jwt.sign({ walletAddress }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    perf.step('jwt_sign');

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      ...(process.env.NODE_ENV === 'production' ? { domain: '.warzonewarriors.xyz' } : {})
    });

    perf.done({ isNewUser });
    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'User registered successfully' : 'Login successful',
      token,
      user: {
        walletAddress: profile.walletAddress,
        walletProviderType: profile.walletProviderType,
        walletProviderName: profile.walletProviderName,
        isNewUser,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during authentication' });
  }
};

// GET /achieveQuests/type/:type?walletAddress=0x...
exports.getAchieveQuestByType = async (req, res) => {
  const requestId = crypto.randomBytes(16).toString('hex');
  console.log("get achieveeQuestBy Type get called");
  try {
    const { walletAddress } = req.query;
    const type = Number(req.params.type);
    const clientIp = getClientIp(req);

    res.set('X-Request-Id', requestId);
    // console.log('[getAchieveQuestByType] start', { requestId, walletAddress, type, ip: clientIp, reqIp: req?.ip });

    if (!walletAddress) {
      console.warn('[getAchieveQuestByType] missing walletAddress', { requestId, ip: clientIp, reqIp: req.ip });
      return res.status(400).json({ success: false, error: "walletAddress is required", requestId });
    }
    if (!Number.isFinite(type)) {
      console.warn('[getAchieveQuestByType] invalid type', { requestId, type: req.params.type });
      return res.status(400).json({ success: false, error: "type must be a number", requestId });
    }

    const profile = await getWalletProfile(walletAddress);

    // FIX: PlayerAchievementData is a Mongoose Map (schema type: Map).
    // Object.values() does NOT work on Mongoose Maps — must use extractAchievementValues()
    // which handles both Map instances and plain objects (post-.toObject()) correctly.
    const all = extractAchievementValues(profile.PlayerAchievementData);

    const matches = all.filter(q => q && Number(q.type) === type);

    // console.log('[getAchieveQuestByType] all count:', all.length, '| matches:', JSON.stringify(matches));

    let completed = false;
    let reward = '';

    if (type == 4) {
      reward = 'Tank Buster';
      if (matches.length > 0 && matches[0].progress >= 20) completed = true;
    } else if (type == 23) {
      reward = 'Hardcore Victor';
      if (matches.length > 0 && matches[0].progress > 5) completed = true;
    } else if (type == 39) {
      reward = 'Boss Slayer';
      if (matches.length > 0 && matches[0].progress >= 3) completed = true;
    } else if (type == 0) {
      reward = 'Mass Annihilation';
      if (matches.length > 0 && matches[0].progress >= 200) completed = true;
    }

    const newResponse = {
      success: true,
      status: 200,
      wallet: walletAddress,
      completed: completed ?? false,
      score: matches[0]?.progress ?? 0,
      isClaimed: matches[0]?.isReady ?? false,
      reward: reward,
    };

    // console.log('[getAchieveQuestByType] success', { requestId, walletAddress, type, completed: newResponse.completed, score: newResponse.score });
    return res.json({ ...newResponse });
  } catch (error) {
    // console.error("[getAchieveQuestByType] error", { requestId, message: error?.message, stack: error?.stack });
    res.set('X-Request-Id', requestId);
    return res.status(500).json({
      ok: false,
      status: 500,
      error: "Server Error, Please Retry",
      requestId
    });
  }
};
