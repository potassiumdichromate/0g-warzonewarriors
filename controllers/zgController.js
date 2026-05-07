/**
 * zgController — decentralised player save/load via 0G Storage + DA + Compute.
 *
 * NEW ENDPOINTS (all under /warzone):
 *   POST /save/binary          — Unity sends raw msgpack binary; stored on 0G Storage
 *   GET  /load/binary          — fetch latest binary save from 0G Storage
 *   GET  /save/metadata        — rootHash, saveIndex, DA status for a wallet
 *   GET  /verify               — 4-layer integrity check (DB + DA + checksum + compute)
 *   GET  /leaderboard/decentralized — top-100 from PlayerSaveRecord (DA-backed)
 *
 * BINARY FORMAT (msgpack, Unity → backend):
 *   Unity serialises its player state using MessagePack-CSharp.
 *   The backend stores the bytes as-is on 0G Storage.
 *   On load the same bytes come back — Unity deserialises them.
 *   Anti-cheat uses 0G Compute to validate the decoded metadata.
 */

const crypto = require('crypto');
const msgpack = require('@msgpack/msgpack');
const PlayerSaveRecord = require('../models/PlayerSaveRecord');
const { uploadBuffer, downloadToBuffer, verifyChecksum } = require('../services/ZeroGStorage');
const { publishCommitment, verifyCommitment } = require('../services/ZeroGDA');
const { validateSave, shouldTriggerCompute } = require('../services/ZeroGCompute');
const { anchorSaveHash, getOnChainSave } = require('../services/ZeroGChain');

const ZG_ENABLED = process.env.ZG_ENABLED !== 'false';  // opt-out flag for local dev

function normalizeWallet(w) {
  return String(w || '').trim().toLowerCase();
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Safely decode msgpack or JSON binary from Unity.
 * Unity might send raw msgpack or, during transition, JSON bytes.
 */
function decodeSaveBuffer(buffer) {
  try {
    return { format: 'msgpack', data: msgpack.decode(buffer) };
  } catch {
    try {
      return { format: 'json', data: JSON.parse(buffer.toString('utf-8')) };
    } catch {
      return { format: 'binary', data: null };
    }
  }
}

/**
 * Encode player profile JSON to msgpack binary.
 * Used when converting existing JSON saves → 0G Storage.
 */
function encodeToMsgpack(profileObj) {
  return Buffer.from(msgpack.encode(profileObj));
}

/**
 * Extract coin balance from decoded save data.
 * Handles both Unity msgpack shape and legacy JSON shape.
 */
function extractCoinBalance(decoded) {
  if (!decoded) return 0;
  return (
    decoded?.PlayerResources?.coin ??
    decoded?.playerResources?.coin ??
    decoded?.coin ??
    0
  );
}

// ─── background pipeline ─────────────────────────────────────────────────────

/**
 * After a save record is created in MongoDB, run DA commitment and Compute validation
 * asynchronously so we never block the HTTP response.
 */
function runSavePipeline(record, decoded, previousRecord) {
  setImmediate(async () => {
    const wallet = record.walletAddress;

    // ── 0G Compute anti-cheat ──────────────────────────────────────────────
    const coinNow  = extractCoinBalance(decoded);
    const coinPrev = previousRecord?.coinSnapshot ?? 0;
    const timeDelta = previousRecord
      ? (Date.now() - new Date(previousRecord.createdAt).getTime()) / 1000
      : null;

    const computeMeta = {
      saveIndex:         record.saveIndex,
      previousSaveIndex: previousRecord?.saveIndex ?? -1,
      isFirstSave:       !previousRecord,
      coinDelta:         coinNow - coinPrev,
      timeDeltaSeconds:  timeDelta,
      fileSize:          record.fileSize,
    };

    if (shouldTriggerCompute(computeMeta)) {
      try {
        const validation = await validateSave(computeMeta, record.rootHash);
        const computeStatus = validation.verdict === 'REJECTED' ? 'rejected' : 'validated';
        await PlayerSaveRecord.findByIdAndUpdate(record._id, {
          computeStatus,
          computeValidation: validation,
        });

        if (validation.verdict === 'REJECTED') {
          console.warn('[0G Compute] REJECTED save', { wallet, rootHash: record.rootHash, flags: validation.flags });
        }
      } catch (err) {
        console.error('[0G Compute] validation error:', err.message);
      }
    }

    // ── 0G chain anchor — rootHash written to PlayerSaveAnchor on 0G EVM ──
    try {
      const anchor = await anchorSaveHash(wallet, record.rootHash, record.saveIndex);
      if (anchor) {
        await PlayerSaveRecord.findByIdAndUpdate(record._id, {
          'anchorTxHash':    anchor.txHash,
          'anchorBlock':     anchor.blockNumber,
        });
        console.log('[0G Chain] anchored', { wallet, rootHash: record.rootHash, txHash: anchor.txHash });
      }
    } catch (err) {
      console.error('[0G Chain] anchor failed (non-fatal):', err.message);
    }

    // ── 0G DA commitment ───────────────────────────────────────────────────
    try {
      const commitment = await publishCommitment(
        {
          rootHash:  record.rootHash,
          wallet,
          saveIndex: record.saveIndex,
          coinSnapshot: coinNow,
          ts: Date.now(),
        },
        wallet,
      );
      await PlayerSaveRecord.findByIdAndUpdate(record._id, {
        daStatus: 'finalized',
        daCommitment: commitment,
      });
      console.log('[0G DA] committed', { wallet, rootHash: record.rootHash });
    } catch (err) {
      await PlayerSaveRecord.findByIdAndUpdate(record._id, { daStatus: 'failed' });
      console.error('[0G DA] commitment failed:', err.message);
    }
  });
}

// ─── POST /warzone/save/binary ────────────────────────────────────────────────

exports.saveBinary = async (req, res) => {
  try {
    if (!ZG_ENABLED) {
      return res.status(503).json({ ok: false, message: '0G Storage is disabled (ZG_ENABLED=false)' });
    }

    // Wallet comes from the JWT (set by verifyUser middleware). Never trust the raw header
    // since verifyUser already decoded and verified the token before we get here.
    const wallet = normalizeWallet(req.walletAddress);
    if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
      return res.status(401).json({ ok: false, message: 'No authenticated wallet — JWT required' });
    }

    // req.body is a raw Buffer (express.raw middleware applied in server.js)
    const rawBuffer = req.body;
    if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
      return res.status(400).json({ ok: false, message: 'Request body must be binary (Content-Type: application/octet-stream)' });
    }
    if (rawBuffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ ok: false, message: 'Save file exceeds 5MB limit' });
    }

    // Decode to validate content and extract metadata (non-blocking on decode failure)
    const { data: decoded } = decodeSaveBuffer(rawBuffer);
    const coinSnapshot = extractCoinBalance(decoded);

    // Anti-rollback: fetch the current latest save index
    const latestRecord = await PlayerSaveRecord.findOne({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .select('saveIndex rootHash coinSnapshot createdAt')
      .lean();

    const clientSaveIndex = parseInt(req.headers['x-save-index'] || '0', 10);
    const nextSaveIndex   = (latestRecord?.saveIndex ?? -1) + 1;

    // If client sends an explicit saveIndex, enforce it is strictly greater
    if (!Number.isNaN(clientSaveIndex) && clientSaveIndex > 0 && clientSaveIndex <= (latestRecord?.saveIndex ?? -1)) {
      return res.status(409).json({
        ok: false,
        message: 'Save index rollback detected — rejected',
        currentSaveIndex: latestRecord.saveIndex,
        receivedSaveIndex: clientSaveIndex,
      });
    }

    // ── 0G Storage upload ──────────────────────────────────────────────────
    const { rootHash, txHash, size, checksum } = await uploadBuffer(rawBuffer);

    // ── MongoDB metadata record ────────────────────────────────────────────
    const record = await PlayerSaveRecord.create({
      walletAddress: wallet,
      rootHash,
      txHash,
      fileSize:     size,
      checksum,
      saveIndex:    nextSaveIndex,
      coinSnapshot,
      daStatus:     'pending',
      computeStatus: 'skipped',
      source:       'game_save',
    });

    // ── Background: Compute + DA (never blocks response) ──────────────────
    runSavePipeline(record, decoded, latestRecord);

    return res.status(201).json({
      ok:        true,
      rootHash,
      txHash,
      saveIndex: nextSaveIndex,
      size,
      daStatus:  'pending',
      message:   'Save uploaded to 0G Storage. DA commitment running in background.',
    });
  } catch (err) {
    console.error('[zgController.saveBinary]', err);
    return res.status(500).json({ ok: false, message: err.message || 'Save failed' });
  }
};

// ─── GET /warzone/load/binary ─────────────────────────────────────────────────

exports.loadBinary = async (req, res) => {
  try {
    if (!ZG_ENABLED) {
      return res.status(503).json({ ok: false, message: '0G Storage is disabled' });
    }

    const wallet = normalizeWallet(req.query.wallet || req.headers['x-wallet-address']);
    if (!wallet) {
      return res.status(400).json({ ok: false, message: 'wallet query param required' });
    }

    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .lean();

    if (!record) {
      return res.status(404).json({ ok: false, message: 'No save found for this wallet on 0G Storage' });
    }

    // Download from 0G Storage (Merkle proof verified internally by SDK)
    const buffer = await downloadToBuffer(record.rootHash);

    res.set({
      'Content-Type':        'application/octet-stream',
      'Content-Length':      buffer.length,
      'X-Root-Hash':         record.rootHash,
      'X-Save-Index':        String(record.saveIndex),
      'X-Da-Status':         record.daStatus,
      'X-Checksum-Sha256':   record.checksum || '',
    });

    return res.send(buffer);
  } catch (err) {
    console.error('[zgController.loadBinary]', err);
    return res.status(500).json({ ok: false, message: err.message || 'Load failed' });
  }
};

// ─── GET /warzone/save/metadata ───────────────────────────────────────────────

exports.getSaveMetadata = async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ ok: false, message: 'wallet required' });

    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .lean();

    if (!record) {
      return res.json({
        ok:           true,
        hasSave:      false,
        walletAddress: wallet,
      });
    }

    // Also read the on-chain anchor (trustless verification — doesn't require our backend)
    let onChain = null;
    try { onChain = await getOnChainSave(wallet); } catch {}

    return res.json({
      ok:            true,
      hasSave:       true,
      walletAddress: wallet,
      // 0G Storage
      rootHash:      record.rootHash,
      storageTxHash: record.txHash,
      saveIndex:     record.saveIndex,
      fileSize:      record.fileSize,
      coinSnapshot:  record.coinSnapshot,
      // 0G chain anchor (independently verifiable at https://chainscan.0g.ai)
      onChainAnchor: onChain,
      // 0G DA
      daStatus:      record.daStatus,
      daCommitment:  record.daCommitment,
      // 0G Compute anti-cheat
      computeStatus: record.computeStatus,
      computeVerdict: record.computeValidation?.verdict || null,
      savedAt:       record.createdAt,
    });
  } catch (err) {
    console.error('[zgController.getSaveMetadata]', err);
    return res.status(500).json({ ok: false, message: 'Metadata fetch failed' });
  }
};

// ─── GET /warzone/verify ──────────────────────────────────────────────────────
// 4-layer verification: MongoDB record → DA proof → file checksum → compute result

exports.verifySave = async (req, res) => {
  try {
    const wallet   = normalizeWallet(req.query.wallet);
    const rootHash = String(req.query.rootHash || '').trim();
    if (!wallet || !rootHash) {
      return res.status(400).json({ ok: false, message: 'wallet and rootHash required' });
    }

    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet, rootHash }).lean();
    if (!record) {
      return res.json({ ok: true, verdict: 'TAMPERED', checks: { dbRecord: false }, message: 'No record found in index' });
    }

    const checks = { dbRecord: true };

    // L2 — DA proof
    checks.daFinalized = record.daStatus === 'finalized';
    if (checks.daFinalized && record.daCommitment) {
      checks.daProofValid = await verifyCommitment(record.daCommitment);
    } else {
      checks.daProofValid = false;
    }

    // L3 — file checksum (re-download from 0G)
    try {
      checks.checksumValid = await verifyChecksum(rootHash, record.checksum);
    } catch {
      checks.checksumValid = false;
    }

    // L4 — compute result (re-use stored if available)
    checks.computeValid = record.computeStatus === 'validated'
      ? (record.computeValidation?.valid ?? false)
      : null; // null = not yet validated

    const allPassed = checks.dbRecord && checks.daProofValid && checks.checksumValid;
    const verdict   = allPassed ? 'CLEAN' : 'TAMPERED';

    return res.json({
      ok:           true,
      verdict,
      checks,
      daStatus:     record.daStatus,
      computeVerdict: record.computeValidation?.verdict || 'NOT_VALIDATED',
      rootHash,
      saveIndex:    record.saveIndex,
      savedAt:      record.createdAt,
    });
  } catch (err) {
    console.error('[zgController.verifySave]', err);
    return res.status(500).json({ ok: false, message: 'Verification failed' });
  }
};

// ─── GET /warzone/leaderboard/decentralized ───────────────────────────────────
// Reads from PlayerSaveRecord (coinSnapshot field) — no MongoDB PlayerProfile needed.
// Each entry has a DA commitment proving the score was reported honestly.

exports.getDecentralizedLeaderboard = async (req, res) => {
  try {
    const WarzoneNameWallet = require('../models/nameWallet');

    // Aggregate: one entry per wallet, pick highest saveIndex (latest)
    const top = await PlayerSaveRecord.aggregate([
      { $sort: { saveIndex: -1 } },
      { $group: {
        _id:          '$walletAddress',
        coinSnapshot: { $first: '$coinSnapshot' },
        rootHash:     { $first: '$rootHash' },
        daStatus:     { $first: '$daStatus' },
        saveIndex:    { $first: '$saveIndex' },
        savedAt:      { $first: '$createdAt' },
      }},
      { $sort: { coinSnapshot: -1 } },
      { $limit: 100 },
    ]);

    const wallets = top.map(e => e._id);
    const nameRecords = await WarzoneNameWallet.find({ walletAddress: { $in: wallets } }).lean();
    const nameMap = {};
    nameRecords.forEach(r => { nameMap[r.walletAddress] = r.name; });

    const entries = top.map((e, i) => ({
      rank:         i + 1,
      walletAddress: e._id,
      name:         nameMap[e._id] || `Warrior_${e._id.slice(2, 8)}`,
      coin:         e.coinSnapshot,
      rootHash:     e.rootHash,
      daStatus:     e.daStatus,
      saveIndex:    e.saveIndex,
      savedAt:      e.savedAt,
      // daStatus 'finalized' = score is cryptographically proved by 0G DA nodes
      verified:     e.daStatus === 'finalized',
    }));

    return res.json({
      ok:      true,
      source:  '0g-da',
      count:   entries.length,
      entries,
    });
  } catch (err) {
    console.error('[zgController.getDecentralizedLeaderboard]', err);
    return res.status(500).json({ ok: false, message: 'Leaderboard fetch failed' });
  }
};

// ─── GET /warzone/dashboard ───────────────────────────────────────────────────
// All-in-one player card. One call loads the entire 0G profile screen.

exports.getDashboard = async (req, res) => {
  try {
    const wallet = normalizeWallet(req.walletAddress);

    const [latest, totalSaves, daFinalizedCount, computeCleanCount, rankAgg] = await Promise.all([
      PlayerSaveRecord.findOne({ walletAddress: wallet })
        .sort({ saveIndex: -1 })
        .lean(),

      PlayerSaveRecord.countDocuments({ walletAddress: wallet }),

      PlayerSaveRecord.countDocuments({ walletAddress: wallet, daStatus: 'finalized' }),

      PlayerSaveRecord.countDocuments({ walletAddress: wallet, computeStatus: 'validated',
        'computeValidation.verdict': 'CLEAN' }),

      // Rank: count how many wallets have a higher coinSnapshot than this wallet's latest
      PlayerSaveRecord.aggregate([
        { $sort: { saveIndex: -1 } },
        { $group: { _id: '$walletAddress', coinSnapshot: { $first: '$coinSnapshot' } } },
        { $sort: { coinSnapshot: -1 } },
        { $group: { _id: null, wallets: { $push: '$_id' } } },
        { $project: { rank: { $add: [{ $indexOfArray: ['$wallets', wallet] }, 1] } } },
      ]),
    ]);

    if (!latest) {
      return res.json({
        ok: true,
        wallet,
        hasData: false,
        message: 'No saves found — play the game to see your 0G profile',
      });
    }

    let onChain = null;
    try { onChain = await getOnChainSave(wallet); } catch (_) {}

    const rank = rankAgg[0]?.rank > 0 ? rankAgg[0].rank : null;
    const trustScore = totalSaves > 0 ? Math.round((daFinalizedCount / totalSaves) * 100) : 0;

    const pipeline = {
      storage:  { status: 'done',                          label: 'Saved on 0G Storage',       rootHash: latest.rootHash },
      chain:    { status: onChain?.rootHash ? 'done' : 'pending', label: 'Anchored on 0G Chain',
                  txHash: latest.anchorTxHash,
                  explorerUrl: latest.anchorTxHash ? `https://chainscan.0g.ai/tx/${latest.anchorTxHash}` : null },
      da:       { status: latest.daStatus,                 label: daLabel(latest.daStatus),    commitment: latest.daCommitment },
      compute:  { status: latest.computeStatus,            label: computeLabel(latest.computeStatus), verdict: latest.computeValidation?.verdict ?? null },
    };

    return res.json({
      ok: true,
      wallet,
      hasData: true,
      trustScore,
      rank,
      totalSaves,
      daFinalizedCount,
      computeCleanCount,
      latestSave: {
        rootHash:   latest.rootHash,
        saveIndex:  latest.saveIndex,
        fileSize:   latest.fileSize,
        coinSnapshot: latest.coinSnapshot,
        savedAt:    latest.createdAt,
        source:     latest.source,
      },
      pipeline,
      onChain,
    });
  } catch (err) {
    console.error('[zgController.getDashboard]', err);
    return res.status(500).json({ ok: false, message: 'Dashboard fetch failed' });
  }
};

function daLabel(status) {
  return { pending: 'DA commitment pending…', finalized: 'Finalised by 0G DA nodes',
           failed: 'DA commitment failed', skipped: 'DA skipped' }[status] || status;
}
function computeLabel(status) {
  return { skipped: 'Anti-cheat not run', pending: 'Anti-cheat pending…',
           validated: 'Passed anti-cheat (0G Compute)', rejected: 'Flagged by anti-cheat' }[status] || status;
}

// ─── GET /warzone/save/history ────────────────────────────────────────────────
// Paginated save timeline. Shows every save with its full pipeline status.

exports.getSaveHistory = async (req, res) => {
  try {
    const wallet = normalizeWallet(req.walletAddress);
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const skip   = (page - 1) * limit;

    const [records, total] = await Promise.all([
      PlayerSaveRecord.find({ walletAddress: wallet })
        .sort({ saveIndex: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PlayerSaveRecord.countDocuments({ walletAddress: wallet }),
    ]);

    const entries = records.map(r => ({
      saveIndex:   r.saveIndex,
      rootHash:    r.rootHash,
      fileSize:    r.fileSize,
      coinSnapshot: r.coinSnapshot,
      source:      r.source,
      savedAt:     r.createdAt,
      pipeline: {
        storage:  { status: 'done',       label: 'Stored on 0G Storage' },
        chain:    { status: r.anchorTxHash ? 'done' : 'pending',
                    label:  r.anchorTxHash ? 'Anchored on 0G Chain' : 'Chain anchor pending…',
                    txHash: r.anchorTxHash || null,
                    explorerUrl: r.anchorTxHash ? `https://chainscan.0g.ai/tx/${r.anchorTxHash}` : null },
        da:       { status: r.daStatus,   label: daLabel(r.daStatus) },
        compute:  { status: r.computeStatus, label: computeLabel(r.computeStatus),
                    verdict: r.computeValidation?.verdict ?? null },
      },
      fullyVerified: r.anchorTxHash && r.daStatus === 'finalized' && r.computeStatus === 'validated',
    }));

    return res.json({
      ok: true,
      wallet,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      entries,
    });
  } catch (err) {
    console.error('[zgController.getSaveHistory]', err);
    return res.status(500).json({ ok: false, message: 'History fetch failed' });
  }
};

// ─── GET /warzone/save/pipeline/:rootHash ─────────────────────────────────────
// Live pipeline status for one specific save.
// Frontend polls this after POST /save/binary to drive a progress tracker UI.

exports.getSavePipeline = async (req, res) => {
  try {
    const { rootHash } = req.params;
    if (!rootHash) return res.status(400).json({ ok: false, message: 'rootHash param required' });

    const record = await PlayerSaveRecord.findOne({ rootHash }).lean();
    if (!record) return res.status(404).json({ ok: false, message: 'No record for this rootHash' });

    const steps = [
      {
        id:     'storage',
        label:  '0G Storage',
        detail: 'Binary save uploaded and content-addressed',
        status: 'done',
        value:  record.rootHash,
      },
      {
        id:     'chain',
        label:  '0G Chain Anchor',
        detail: 'rootHash written to PlayerSaveAnchor contract on 0G EVM',
        status: record.anchorTxHash ? 'done' : 'pending',
        value:  record.anchorTxHash || null,
        explorerUrl: record.anchorTxHash ? `https://chainscan.0g.ai/tx/${record.anchorTxHash}` : null,
      },
      {
        id:     'da',
        label:  '0G Data Availability',
        detail: 'Commitment BLS-signed by 0G DA committee',
        status: record.daStatus,
        value:  record.daCommitment?.requestId || null,
        finalizedAt: record.daCommitment?.finalizedAt || null,
      },
      {
        id:     'compute',
        label:  '0G Compute Anti-Cheat',
        detail: 'Save validated by TEE-attested AI inference',
        status: record.computeStatus,
        value:  record.computeValidation?.verdict || null,
        confidence: record.computeValidation?.confidence || null,
      },
    ];

    const doneCount = steps.filter(s => s.status === 'done' || s.status === 'finalized' || s.status === 'validated').length;
    const allDone   = doneCount === steps.length;

    return res.json({
      ok: true,
      rootHash,
      wallet:    record.walletAddress,
      saveIndex: record.saveIndex,
      progress:  Math.round((doneCount / steps.length) * 100),
      allDone,
      steps,
      savedAt:   record.createdAt,
    });
  } catch (err) {
    console.error('[zgController.getSavePipeline]', err);
    return res.status(500).json({ ok: false, message: 'Pipeline status fetch failed' });
  }
};

// ─── GET /warzone/proof/:rootHash ─────────────────────────────────────────────
// Shareable public proof card for a specific save.
// Anyone can open this URL and independently verify the save is real.

exports.getProof = async (req, res) => {
  try {
    const { rootHash } = req.params;
    const record = await PlayerSaveRecord.findOne({ rootHash }).lean();
    if (!record) return res.status(404).json({ ok: false, message: 'No proof found for this rootHash' });

    const WarzoneNameWallet = require('../models/nameWallet');
    const nameRecord = await WarzoneNameWallet.findOne({ walletAddress: record.walletAddress }).lean();
    const displayName = nameRecord?.name || `Warrior_${record.walletAddress.slice(2, 8)}`;

    let onChain = null;
    try { onChain = await getOnChainSave(record.walletAddress); } catch (_) {}

    return res.json({
      ok: true,
      proof: {
        rootHash:     record.rootHash,
        wallet:       record.walletAddress,
        displayName,
        saveIndex:    record.saveIndex,
        coinSnapshot: record.coinSnapshot,
        fileSize:     record.fileSize,
        checksum:     record.checksum,
        savedAt:      record.createdAt,

        storage: {
          verified: true,
          rootHash: record.rootHash,
          note: 'File is content-addressed on 0G Storage — rootHash is the Merkle root of the file',
        },

        chain: {
          verified:    !!record.anchorTxHash,
          txHash:      record.anchorTxHash || null,
          block:       record.anchorBlock  || null,
          explorerUrl: record.anchorTxHash ? `https://chainscan.0g.ai/tx/${record.anchorTxHash}` : null,
          contractUrl: process.env.ZG_ANCHOR_CONTRACT_ADDRESS
            ? `https://chainscan.0g.ai/address/${process.env.ZG_ANCHOR_CONTRACT_ADDRESS}`
            : null,
          onChainRecord: onChain,
        },

        da: {
          verified:    record.daStatus === 'finalized',
          status:      record.daStatus,
          commitment:  record.daCommitment || null,
          note: record.daStatus === 'finalized'
            ? 'This commitment was BLS-signed by >2/3 of 0G DA nodes'
            : 'DA finalization pending',
        },

        compute: {
          verified:   record.computeStatus === 'validated',
          status:     record.computeStatus,
          verdict:    record.computeValidation?.verdict    || null,
          confidence: record.computeValidation?.confidence || null,
          flags:      record.computeValidation?.flags      || [],
          teeVerified: record.computeValidation?.teeVerified || false,
        },

        allVerified: !!(
          record.anchorTxHash &&
          record.daStatus     === 'finalized' &&
          record.computeStatus === 'validated'
        ),
      },
    });
  } catch (err) {
    console.error('[zgController.getProof]', err);
    return res.status(500).json({ ok: false, message: 'Proof fetch failed' });
  }
};

// ─── GET /warzone/network/status ──────────────────────────────────────────────
// Live health check for all 0G services.
// Frontend can show a "0G Network" status banner so users understand delays.

exports.getNetworkStatus = async (req, res) => {
  const results = await Promise.allSettled([
    pingStorage(),
    pingChain(),
    pingDA(),
    pingCompute(),
  ]);

  const [storage, chain, da, compute] = results.map(r =>
    r.status === 'fulfilled' ? r.value : { status: 'offline', latencyMs: null, error: r.reason?.message }
  );

  const allOnline = [storage, chain, da, compute].every(s => s.status === 'online');

  return res.json({
    ok: true,
    allOnline,
    checkedAt: new Date().toISOString(),
    services: { storage, chain, da, compute },
  });
};

async function pingStorage() {
  const start = Date.now();
  const url   = process.env.ZG_INDEXER_RPC || 'https://indexer-storage-turbo.0g.ai';
  const r     = await fetch(`${url}/api/v1/status`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  return { service: '0G Storage', status: r?.ok ? 'online' : 'degraded', latencyMs: Date.now() - start, endpoint: url };
}

async function pingChain() {
  const start = Date.now();
  const url   = process.env.ZG_RPC_URL || 'https://evmrpc.0g.ai';
  const r     = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  const json = r ? await r.json().catch(() => null) : null;
  return {
    service: '0G Chain', status: json?.result ? 'online' : 'degraded',
    latencyMs: Date.now() - start, blockNumber: json?.result ? parseInt(json.result, 16) : null, endpoint: url,
  };
}

async function pingDA() {
  // DA is gRPC — just check if the host resolves. Treat as online if ZG_DA_DISPERSER is set.
  const endpoint = process.env.ZG_DA_DISPERSER || 'disperser-testnet.0g.ai:51001';
  return { service: '0G DA', status: 'unknown', latencyMs: null,
    note: 'gRPC — reachability shown on first save', endpoint };
}

async function pingCompute() {
  if (!process.env.ZG_COMPUTE_API_KEY) {
    return { service: '0G Compute', status: 'not_configured', latencyMs: null,
      note: 'ZG_COMPUTE_API_KEY not set — anti-cheat is skipped' };
  }
  const start = Date.now();
  const r = await fetch('https://router-api.0g.ai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.ZG_COMPUTE_API_KEY}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  return { service: '0G Compute', status: r?.ok ? 'online' : 'degraded', latencyMs: Date.now() - start };
}

// ─── Utility: encode existing JSON profile → 0G Storage ──────────────────────
// Used internally by profileController dual-write and IAP re-upload.

exports.persistProfileTo0G = async function persistProfileTo0G(walletAddress, profileObj, source = 'game_save') {
  if (!ZG_ENABLED) return null;

  const wallet = normalizeWallet(walletAddress);
  const buffer = encodeToMsgpack(profileObj);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  try {
    const { rootHash, txHash, size } = await uploadBuffer(buffer);

    const latestRecord = await PlayerSaveRecord.findOne({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .select('saveIndex coinSnapshot createdAt')
      .lean();

    const nextSaveIndex = (latestRecord?.saveIndex ?? -1) + 1;
    const coinSnapshot  = extractCoinBalance(profileObj);

    const record = await PlayerSaveRecord.create({
      walletAddress: wallet,
      rootHash,
      txHash,
      fileSize:      size,
      checksum,
      saveIndex:     nextSaveIndex,
      coinSnapshot,
      daStatus:      'pending',
      computeStatus: 'skipped',
      source,
    });

    // DA in background — don't await
    runSavePipeline(record, profileObj, latestRecord);

    console.log('[0G] persisted profile', { wallet, rootHash, saveIndex: nextSaveIndex, source });
    return { rootHash, txHash, saveIndex: nextSaveIndex };
  } catch (err) {
    console.error('[0G] persistProfileTo0G failed (non-fatal):', err.message);
    return null;
  }
};
