const PlayerSaveRecord = require("../models/PlayerSaveRecord");
const PlayerProfile    = require("../models/PlayerProfile");
const AIRecord         = require("../models/AIRecord");
const ZeroGChain       = require("../services/ZeroGChain");

const EXPLORER = "https://chainscan.0g.ai";

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  const mb = kb / 1024;
  if (mb < 1) return `${kb.toFixed(1)} KB`;
  return `${mb.toFixed(1)} MB`;
}

function explorerTx(hash)    { return hash    ? `${EXPLORER}/tx/${hash}`      : null; }
function explorerAddr(address) { return address ? `${EXPLORER}/address/${address}` : null; }

function buildPipeline(record) {
  return {
    stored: {
      done:        !!record.rootHash,
      label:       "Uploaded to 0G Storage",
      description: "Your save is stored on the 0G decentralized storage network.",
      rootHash:    record.rootHash || null,
      txHash:      record.txHash || null,
      fileSize:    formatBytes(record.fileSize),
      explorerUrl: explorerTx(record.txHash)
    },
    anchored: {
      done:        !!record.anchorTxHash,
      label:       "Root hash anchored on-chain",
      description: "A permanent on-chain record links your wallet to this save.",
      txHash:      record.anchorTxHash || null,
      block:       record.anchorBlock || null,
      explorerUrl: explorerTx(record.anchorTxHash),
      contractUrl: explorerAddr(process.env.ZG_ANCHOR_CONTRACT_ADDRESS)
    },
    finalized: {
      done:        record.daStatus === "finalized",
      label:       "BLS-signed by 0G DA network",
      description: "A quorum of DA nodes signed off on this save's availability.",
      status:      record.daStatus,
      batchId:     record.daCommitment?.batchId || null,
      blobIndex:   record.daCommitment?.blobIndex ?? null,
      batchHeaderHash: record.daCommitment?.batchHeaderHash || null,
      referenceBlock:  record.daCommitment?.referenceBlockNumber || null,
      finalizedAt: record.daCommitment?.finalizedAt || null
    },
    validated: {
      done:        record.computeStatus === "validated",
      label:       "TEE anti-cheat verified",
      description: "A Trusted Execution Environment confirmed this save is legitimate.",
      status:      record.computeStatus,
      verdict:     record.computeValidation?.verdict || null,
      confidence:  record.computeValidation?.confidence || null,
      teeVerified: record.computeValidation?.teeVerified || false,
      flags:       record.computeValidation?.flags || []
    }
  };
}

function computeTrustScore(saves) {
  if (!saves || saves.length === 0) {
    return { score: 0, label: "UNVERIFIED", description: "No saves found on 0G yet." };
  }

  const total     = saves.length;
  const finalized = saves.filter(s => s.daStatus === "finalized").length;
  const anchored  = saves.filter(s => s.anchorTxHash).length;
  const validated = saves.filter(s => s.computeStatus === "validated").length;

  let score = 10;
  score += Math.round((finalized / total) * 40);
  score += Math.round((anchored  / total) * 25);
  if (validated > 0) score += 15;
  if (total >= 10)   score += 10;
  else if (total >= 5) score += 5;

  score = Math.min(100, score);

  let label, description;
  if (score <= 30) {
    label = "BRONZE";
    description = "Saves are being uploaded. Waiting for on-chain anchoring and DA finality.";
  } else if (score <= 55) {
    label = "SILVER";
    description = "Most saves are anchored on-chain. DA finalization is in progress.";
  } else if (score <= 80) {
    label = "GOLD";
    description = "Strong verification coverage. Saves are anchored and DA-finalized.";
  } else {
    label = "PLATINUM";
    description = "Maximum trust. Saves are anchored, DA-finalized, and TEE-validated.";
  }

  return {
    score,
    label,
    description,
    breakdown: {
      totalSaves:       total,
      finalizedSaves:   finalized,
      anchoredSaves:    anchored,
      computeValidated: validated,
      finalizedPercent: Math.round((finalized / total) * 100),
      anchoredPercent:  Math.round((anchored  / total) * 100)
    }
  };
}

function buildActivityEvents(saves) {
  const events = [];

  for (const save of saves) {
    if (save.rootHash) {
      events.push({
        id:          `${save.saveIndex}-stored`,
        type:        "SAVE_STORED",
        saveIndex:   save.saveIndex,
        timestamp:   save.createdAt,
        title:       `Save #${save.saveIndex} stored on 0G`,
        description: `${formatBytes(save.fileSize)} uploaded to the 0G decentralized storage network.`,
        status:      "success",
        data:        { rootHash: save.rootHash, fileSize: formatBytes(save.fileSize) },
        explorerUrl: explorerTx(save.txHash)
      });
    }

    if (save.anchorTxHash) {
      events.push({
        id:          `${save.saveIndex}-anchored`,
        type:        "SAVE_ANCHORED",
        saveIndex:   save.saveIndex,
        timestamp:   save.updatedAt,
        title:       `Save #${save.saveIndex} anchored on-chain`,
        description: `Root hash recorded permanently on the 0G EVM blockchain at block ${save.anchorBlock || "unknown"}.`,
        status:      "success",
        data:        { txHash: save.anchorTxHash, block: save.anchorBlock },
        explorerUrl: explorerTx(save.anchorTxHash)
      });
    }

    if (save.daStatus === "finalized" && save.daCommitment) {
      events.push({
        id:          `${save.saveIndex}-da`,
        type:        "DA_FINALIZED",
        saveIndex:   save.saveIndex,
        timestamp:   save.daCommitment.finalizedAt || save.updatedAt,
        title:       `Save #${save.saveIndex} finalized by 0G DA`,
        description: `BLS-signed finality proof generated. Batch #${save.daCommitment.batchId}, blob #${save.daCommitment.blobIndex}.`,
        status:      "success",
        data: {
          batchId:         save.daCommitment.batchId,
          blobIndex:       save.daCommitment.blobIndex,
          batchHeaderHash: save.daCommitment.batchHeaderHash
        },
        explorerUrl: null
      });
    }

    if (save.daStatus === "failed") {
      events.push({
        id:          `${save.saveIndex}-da-failed`,
        type:        "DA_FAILED",
        saveIndex:   save.saveIndex,
        timestamp:   save.updatedAt,
        title:       `Save #${save.saveIndex} DA finalization timed out`,
        description: "The save is still stored on 0G Storage, but the DA disperser did not finalize within 120 seconds.",
        status:      "error",
        data:        {},
        explorerUrl: null
      });
    }

    if (save.computeStatus === "validated" && save.computeValidation) {
      events.push({
        id:          `${save.saveIndex}-compute`,
        type:        "COMPUTE_VALIDATED",
        saveIndex:   save.saveIndex,
        timestamp:   save.computeValidation.validatedAt || save.updatedAt,
        title:       `Save #${save.saveIndex} cleared anti-cheat`,
        description: `TEE-verified AI returned ${save.computeValidation.verdict} with ${Math.round((save.computeValidation.confidence || 0) * 100)}% confidence.`,
        status:      "success",
        data: {
          verdict:     save.computeValidation.verdict,
          confidence:  save.computeValidation.confidence,
          teeVerified: save.computeValidation.teeVerified
        },
        explorerUrl: null
      });
    }

    if (save.computeStatus === "rejected" && save.computeValidation) {
      events.push({
        id:          `${save.saveIndex}-compute-reject`,
        type:        "COMPUTE_REJECTED",
        saveIndex:   save.saveIndex,
        timestamp:   save.computeValidation.validatedAt || save.updatedAt,
        title:       `Save #${save.saveIndex} flagged by anti-cheat`,
        description: `TEE validator returned ${save.computeValidation.verdict}. Flags: ${(save.computeValidation.flags || []).join(", ") || "none"}.`,
        status:      "warning",
        data: {
          verdict: save.computeValidation.verdict,
          flags:   save.computeValidation.flags || []
        },
        explorerUrl: null
      });
    }
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events;
}

function verificationBadge(record) {
  if (record.daStatus === "finalized" && record.computeStatus === "validated") return "FULLY_VERIFIED";
  if (record.daStatus === "finalized") return "DA_VERIFIED";
  if (record.anchorTxHash)            return "ANCHORED";
  if (record.rootHash)                return "STORED";
  return "UNVERIFIED";
}

// ── GET /0g/dashboard ─────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
  const wallet = req.walletAddress;

  try {
    const saves = await PlayerSaveRecord.find({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .limit(50)
      .lean();

    const latest = saves[0] || null;
    const trust  = computeTrustScore(saves);

    const totalBytes = saves.reduce((sum, s) => sum + (s.fileSize || 0), 0);
    const summary = {
      totalSaves:          saves.length,
      finalizedSaves:      saves.filter(s => s.daStatus === "finalized").length,
      pendingSaves:        saves.filter(s => s.daStatus === "pending").length,
      failedSaves:         saves.filter(s => s.daStatus === "failed").length,
      anchoredSaves:       saves.filter(s => s.anchorTxHash).length,
      totalDataStored:     formatBytes(totalBytes),
      totalDataStoredBytes: totalBytes
    };

    let latestSaveView = null;
    if (latest) {
      latestSaveView = {
        saveIndex:    latest.saveIndex,
        rootHash:     latest.rootHash,
        // coinSnapshot = PlayerResources.coin at save time
        coinSnapshot: latest.coinSnapshot,
        fileSize:     formatBytes(latest.fileSize),
        checksum:     latest.checksum,
        source:       latest.source,
        createdAt:    latest.createdAt,
        pipeline:     buildPipeline(latest)
      };
    }

    const recentActivity = buildActivityEvents(saves.slice(0, 5));

    return res.json({
      wallet,
      summary,
      trustScore:     trust,
      latestSave:     latestSaveView,
      recentActivity,
      contracts: {
        playerSaveAnchor: {
          address:     process.env.ZG_ANCHOR_CONTRACT_ADDRESS || null,
          explorerUrl: explorerAddr(process.env.ZG_ANCHOR_CONTRACT_ADDRESS)
        }
      }
    });
  } catch (err) {
    console.error("[0G UX] dashboard error:", err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
};

// ── GET /0g/activity ─────────────────────────────────────────────────────────

exports.getActivity = async (req, res) => {
  const wallet = req.walletAddress;
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(50, parseInt(req.query.limit) || 20);

  try {
    const saves = await PlayerSaveRecord.find({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .limit(100)
      .lean();

    const allEvents   = buildActivityEvents(saves);
    const totalEvents = allEvents.length;
    const totalPages  = Math.ceil(totalEvents / limit) || 1;
    const offset      = (page - 1) * limit;
    const pageEvents  = allEvents.slice(offset, offset + limit);

    return res.json({
      wallet,
      page,
      totalPages,
      totalEvents,
      hasMore: page < totalPages,
      events:  pageEvents
    });
  } catch (err) {
    console.error("[0G UX] activity error:", err);
    return res.status(500).json({ error: "Failed to load activity" });
  }
};

// ── GET /0g/proof/:wallet/:saveIndex ─────────────────────────────────────────

exports.getProof = async (req, res) => {
  const wallet    = req.params.wallet?.toLowerCase();
  const saveIndex = parseInt(req.params.saveIndex, 10);

  if (!wallet || isNaN(saveIndex)) {
    return res.status(400).json({ error: "wallet and saveIndex are required" });
  }

  try {
    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet, saveIndex }).lean();

    if (!record) {
      return res.status(404).json({
        error: `No save #${saveIndex} found for wallet ${wallet}`
      });
    }

    const isFullyVerified = record.daStatus === "finalized" && !!record.anchorTxHash;

    const certificate = {
      wallet,
      saveIndex,
      rootHash:  record.rootHash,
      issuedAt:  record.createdAt,
      verified:  isFullyVerified,
      badge:     verificationBadge(record)
    };

    const storage = {
      rootHash:      record.rootHash,
      txHash:        record.txHash || null,
      explorerUrl:   explorerTx(record.txHash),
      fileSize:      formatBytes(record.fileSize),
      fileSizeBytes: record.fileSize || 0,
      checksum:      record.checksum || null,
      network:       "0G Storage",
      indexerUrl:    process.env.ZG_INDEXER_RPC || "https://indexer-storage-turbo.0g.ai"
    };

    const onChain = record.anchorTxHash ? {
      contractAddress: process.env.ZG_ANCHOR_CONTRACT_ADDRESS || null,
      contractUrl:     explorerAddr(process.env.ZG_ANCHOR_CONTRACT_ADDRESS),
      txHash:          record.anchorTxHash,
      txUrl:           explorerTx(record.anchorTxHash),
      block:           record.anchorBlock || null,
      chainId:         parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661"),
      network:         "0G Mainnet"
    } : null;

    const da = {
      status:    record.daStatus,
      finalized: record.daStatus === "finalized",
      commitment: record.daCommitment ? {
        batchId:              record.daCommitment.batchId,
        blobIndex:            record.daCommitment.blobIndex,
        batchHeaderHash:      record.daCommitment.batchHeaderHash,
        referenceBlockNumber: record.daCommitment.referenceBlockNumber,
        finalizedAt:          record.daCommitment.finalizedAt
      } : null,
      network:  "0G DA Testnet",
      endpoint: process.env.ZG_DA_DISPERSER || "disperser-testnet.0g.ai:51001"
    };

    const compute = {
      status:  record.computeStatus,
      verdict: record.computeValidation?.verdict || null,
      details: record.computeValidation ? {
        valid:           record.computeValidation.valid,
        confidence:      record.computeValidation.confidence,
        flags:           record.computeValidation.flags || [],
        teeVerified:     record.computeValidation.teeVerified,
        providerAddress: record.computeValidation.providerAddress,
        validatedAt:     record.computeValidation.validatedAt
      } : null
    };

    return res.json({ certificate, storage, onChain, da, compute });
  } catch (err) {
    console.error("[0G UX] proof error:", err);
    return res.status(500).json({ error: "Failed to fetch proof" });
  }
};

// ── GET /0g/badge ─────────────────────────────────────────────────────────────

exports.getBadge = async (req, res) => {
  const wallet = req.walletAddress;

  try {
    const saves = await PlayerSaveRecord.find({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .limit(100)
      .lean();

    const trust = computeTrustScore(saves);

    return res.json({
      wallet,
      badge:       trust.label,
      score:       trust.score,
      description: trust.description,
      breakdown:   trust.breakdown,
      nextLevel: trust.label === "PLATINUM" ? null : {
        BRONZE:     { label: "SILVER",   hint: "Get more saves DA-finalized and anchored on-chain." },
        SILVER:     { label: "GOLD",     hint: "Reach 75%+ DA finalization rate across your saves." },
        GOLD:       { label: "PLATINUM", hint: "Accumulate TEE-validated saves and reach 10+ total saves." },
        UNVERIFIED: { label: "BRONZE",   hint: "Upload your first save via POST /player/save/binary." }
      }[trust.label] || null
    });
  } catch (err) {
    console.error("[0G UX] badge error:", err);
    return res.status(500).json({ error: "Failed to compute badge" });
  }
};

// ── GET /0g/network ───────────────────────────────────────────────────────────

exports.getNetworkStatus = async (req, res) => {
  const services = {};

  const storageUrl   = process.env.ZG_INDEXER_RPC || "https://indexer-storage-turbo.0g.ai";
  const storageStart = Date.now();
  try {
    await fetch(storageUrl, { signal: AbortSignal.timeout(5000) });
    services.storage = { status: "online", latencyMs: Date.now() - storageStart, endpoint: storageUrl, label: "0G Storage Indexer" };
  } catch {
    services.storage = { status: "connecting", latencyMs: Date.now() - storageStart, endpoint: storageUrl, label: "0G Storage Indexer" };
  }

  const chainUrl   = process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai";
  const chainStart = Date.now();
  try {
    const rpcRes = await fetch(chainUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal:  AbortSignal.timeout(5000)
    });
    const data        = await rpcRes.json();
    const blockNumber = parseInt(data.result, 16);
    services.chain = {
      status: "online", latencyMs: Date.now() - chainStart, blockNumber,
      chainId: parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661"),
      endpoint: chainUrl, explorerUrl: EXPLORER, label: "0G Mainnet EVM"
    };
  } catch {
    services.chain = {
      status: "unreachable", latencyMs: Date.now() - chainStart,
      chainId: parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661"),
      endpoint: chainUrl, label: "0G Mainnet EVM"
    };
  }

  services.da = {
    status:   "configured",
    endpoint: process.env.ZG_DA_DISPERSER || "disperser-testnet.0g.ai:51001",
    protocol: "gRPC",
    label:    "0G DA Disperser"
  };

  services.compute = {
    status:   process.env.ZG_COMPUTE_API_KEY ? "configured" : "disabled",
    endpoint: "https://router-api.0g.ai",
    label:    "0G Compute (TEE anti-cheat)",
    note:     process.env.ZG_COMPUTE_API_KEY ? null : "ZG_COMPUTE_API_KEY not set — anti-cheat skipped"
  };

  const statuses = Object.values(services).map(s => s.status);
  const overall  = statuses.some(s => s === "unreachable") ? "minor issues" : "healthy";

  return res.json({
    timestamp: new Date().toISOString(),
    overall,
    services,
    contracts: {
      playerSaveAnchor: process.env.ZG_ANCHOR_CONTRACT_ADDRESS || null,
      explorerUrl:      explorerAddr(process.env.ZG_ANCHOR_CONTRACT_ADDRESS)
    }
  });
};

// ── GET /0g/leaderboard/verified ─────────────────────────────────────────────

exports.getVerifiedLeaderboard = async (req, res) => {
  const filter = req.query.filter || "finalized";

  const matchStage = {};
  if (filter === "finalized") matchStage.daStatus      = "finalized";
  if (filter === "anchored")  matchStage.anchorTxHash   = { $exists: true, $ne: null };
  if (filter === "validated") matchStage.computeStatus  = "validated";

  try {
    const leaderboard = await PlayerSaveRecord.aggregate([
      { $match: matchStage },
      { $sort:  { saveIndex: -1 } },
      {
        $group: {
          _id:           "$walletAddress",
          coinSnapshot:  { $first: "$coinSnapshot" },
          saveIndex:     { $first: "$saveIndex" },
          rootHash:      { $first: "$rootHash" },
          daStatus:      { $first: "$daStatus" },
          computeStatus: { $first: "$computeStatus" },
          anchorTxHash:  { $first: "$anchorTxHash" },
          anchorBlock:   { $first: "$anchorBlock" }
        }
      },
      { $sort:  { coinSnapshot: -1 } },
      { $limit: 100 }
    ]);

    const result = leaderboard.map((entry, i) => {
      const wallet = entry._id;
      const badge  = verificationBadge({
        daStatus:      entry.daStatus,
        computeStatus: entry.computeStatus,
        anchorTxHash:  entry.anchorTxHash,
        rootHash:      entry.rootHash
      });

      return {
        rank:              i + 1,
        walletAddress:     wallet,
        displayName:       `Warrior_${wallet.slice(2, 8)}`,
        coinSnapshot:      entry.coinSnapshot,
        saveIndex:         entry.saveIndex,
        verificationBadge: badge,
        daStatus:          entry.daStatus,
        computeStatus:     entry.computeStatus,
        anchorTxHash:      entry.anchorTxHash || null,
        anchorBlock:       entry.anchorBlock  || null,
        explorerUrl:       explorerTx(entry.anchorTxHash)
      };
    });

    return res.json({ filter, total: result.length, leaderboard: result });
  } catch (err) {
    console.error("[0G UX] verified leaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

// ── GET /0g/explorer/:wallet ─────────────────────────────────────────────────

exports.getWalletExplorer = async (req, res) => {
  const wallet = req.params.wallet?.toLowerCase();

  if (!wallet) {
    return res.status(400).json({ error: "wallet address is required" });
  }

  try {
    const saves = await PlayerSaveRecord.find({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .limit(20)
      .lean();

    const trust = computeTrustScore(saves);

    let onChain = null;
    if (process.env.ZG_ANCHOR_CONTRACT_ADDRESS && process.env.ZG_ENABLED !== "false") {
      try {
        onChain = await ZeroGChain.getOnChainSave(wallet);
      } catch { /* non-critical */ }
    }

    const totalBytes = saves.reduce((sum, s) => sum + (s.fileSize || 0), 0);

    const savesView = saves.map(s => ({
      saveIndex:     s.saveIndex,
      rootHash:      s.rootHash,
      coinSnapshot:  s.coinSnapshot,
      fileSize:      formatBytes(s.fileSize),
      daStatus:      s.daStatus,
      computeStatus: s.computeStatus,
      badge:         verificationBadge(s),
      anchorTxHash:  s.anchorTxHash || null,
      explorerUrl:   explorerTx(s.anchorTxHash),
      pipeline:      buildPipeline(s),
      createdAt:     s.createdAt
    }));

    return res.json({
      wallet,
      displayName:     `Warrior_${wallet.slice(2, 8)}`,
      trustBadge:      trust.label,
      trustScore:      trust.score,
      totalSaves:      saves.length,
      totalDataStored: formatBytes(totalBytes),
      onChainAnchor:   onChain,
      saves:           savesView,
      contractUrl:     explorerAddr(process.env.ZG_ANCHOR_CONTRACT_ADDRESS)
    });
  } catch (err) {
    console.error("[0G UX] explorer error:", err);
    return res.status(500).json({ error: "Failed to load wallet explorer" });
  }
};

// ── GET /0g/stats ─────────────────────────────────────────────────────────────
// Global server stats — useful for a public dashboard or status page.

exports.getGlobalStats = async (req, res) => {
  try {
    const [
      totalPlayers,
      totalSaves,
      finalizedSaves,
      anchoredSaves,
      computeValidated,
      pendingSaves,
      failedSaves,
      totalAIRecords,
      readyModels
    ] = await Promise.all([
      PlayerProfile.countDocuments(),
      PlayerSaveRecord.countDocuments(),
      PlayerSaveRecord.countDocuments({ daStatus: "finalized" }),
      PlayerSaveRecord.countDocuments({ anchorTxHash: { $exists: true, $ne: null } }),
      PlayerSaveRecord.countDocuments({ computeStatus: "validated" }),
      PlayerSaveRecord.countDocuments({ daStatus: "pending" }),
      PlayerSaveRecord.countDocuments({ daStatus: "failed" }),
      AIRecord.countDocuments(),
      AIRecord.countDocuments({ status: "ready" })
    ]);

    const sizeAgg = await PlayerSaveRecord.aggregate([
      { $group: { _id: null, totalBytes: { $sum: "$fileSize" }, totalSamples: { $sum: 1 } } }
    ]);
    const totalBytes = sizeAgg[0]?.totalBytes || 0;

    const sampleAgg = await AIRecord.aggregate([
      { $group: { _id: null, totalSamples: { $sum: "$totalSamples" }, totalBatches: { $sum: { $size: "$sampleBatches" } } } }
    ]);

    return res.json({
      players: { total: totalPlayers },
      saves: {
        total:             totalSaves,
        finalized:         finalizedSaves,
        anchored:          anchoredSaves,
        computeValidated,
        pending:           pendingSaves,
        failed:            failedSaves,
        totalDataStored:   formatBytes(totalBytes),
        totalDataStoredBytes: totalBytes
      },
      ai: {
        totalModels:            totalAIRecords,
        readyModels,
        totalSamplesCollected:  sampleAgg[0]?.totalSamples  || 0,
        totalSampleBatches:     sampleAgg[0]?.totalBatches  || 0
      },
      contracts: {
        playerSaveAnchor: process.env.ZG_ANCHOR_CONTRACT_ADDRESS || null,
        session:          process.env.SESSION_CONTRACT_ADDRESS    || null,
        leaderboard:      process.env.LEADERBOARD_CONTRACT_ADDRESS || null
      }
    });
  } catch (err) {
    console.error("[0G UX] globalStats error:", err);
    return res.status(500).json({ error: "Failed to fetch global stats" });
  }
};

// ── GET /0g/player/overview/:wallet ──────────────────────────────────────────
// One-call public player card — profile snippet + save stats + trust + AI status.
// Designed for public profile pages on the frontend.

exports.getPlayerOverview = async (req, res) => {
  const wallet = req.params.wallet?.toLowerCase();
  if (!wallet) return res.status(400).json({ error: "wallet param required" });

  try {
    const [profile, saves, aiRecord] = await Promise.all([
      PlayerProfile.findOne({ walletAddress: wallet }).lean(),
      PlayerSaveRecord.find({ walletAddress: wallet }).sort({ saveIndex: -1 }).limit(20).lean(),
      AIRecord.findOne({ walletAddress: wallet }).lean()
    ]);

    const trust   = computeTrustScore(saves);
    const latest  = saves[0] || null;

    return res.json({
      wallet,
      displayName: `Warrior_${wallet.slice(2, 8)}`,
      profile: profile ? {
        level:           profile.PlayerProfile?.level    || 1,
        exp:             profile.PlayerProfile?.exp      || 0,
        totalTimePlayed: profile.PlayerProfile?.totalTimePlayed || 0
      } : null,
      resources: profile ? {
        coin:    profile.PlayerResources?.coin    || 0,
        gem:     profile.PlayerResources?.gem     || 0,
        stamina: profile.PlayerResources?.stamina || 0,
        medal:   profile.PlayerResources?.medal   || 0
      } : null,
      trust: {
        badge:         trust.label,
        score:         trust.score,
        totalSaves:    trust.breakdown?.totalSaves    || 0,
        finalizedSaves: trust.breakdown?.finalizedSaves || 0
      },
      ai: aiRecord ? {
        status:        aiRecord.status,
        totalSamples:  aiRecord.totalSamples,
        modelRootHash: aiRecord.modelRootHash,
        trainedAt:     aiRecord.trainedAt
      } : { status: "none", totalSamples: 0 },
      latestSave: latest ? {
        saveIndex:  latest.saveIndex,
        rootHash:   latest.rootHash,
        daStatus:   latest.daStatus,
        badge:      verificationBadge(latest),
        createdAt:  latest.createdAt
      } : null
    });
  } catch (err) {
    console.error("[0G UX] playerOverview error:", err);
    return res.status(500).json({ error: "Failed to load player overview" });
  }
};

// ── GET /0g/saves/recent ──────────────────────────────────────────────────────
// Latest saves across all players — public activity feed.
// Wallet addresses are partially masked for privacy.

exports.getRecentSaves = async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 20);

  try {
    const saves = await PlayerSaveRecord.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("walletAddress saveIndex rootHash coinSnapshot fileSize daStatus computeStatus anchorTxHash createdAt")
      .lean();

    const feed = saves.map(s => {
      const w = s.walletAddress || "";
      return {
        wallet:        w.slice(0, 6) + "..." + w.slice(-4),
        saveIndex:     s.saveIndex,
        rootHash:      s.rootHash,
        coinSnapshot:  s.coinSnapshot,
        fileSize:      formatBytes(s.fileSize),
        badge:         verificationBadge(s),
        daStatus:      s.daStatus,
        computeStatus: s.computeStatus,
        explorerUrl:   explorerTx(s.anchorTxHash),
        savedAt:       s.createdAt
      };
    });

    return res.json({ total: feed.length, saves: feed });
  } catch (err) {
    console.error("[0G UX] recentSaves error:", err);
    return res.status(500).json({ error: "Failed to fetch recent saves" });
  }
};

// ── GET /0g/compute/stats ─────────────────────────────────────────────────────
// Anti-cheat and AI inference statistics from the 0G Compute layer.

exports.getComputeStats = async (req, res) => {
  try {
    const [
      totalValidations,
      cleanValidations,
      suspiciousValidations,
      skippedValidations,
      teeVerified,
      aiReady
    ] = await Promise.all([
      PlayerSaveRecord.countDocuments({ computeStatus: "validated" }),
      PlayerSaveRecord.countDocuments({ "computeValidation.verdict": "CLEAN" }),
      PlayerSaveRecord.countDocuments({ "computeValidation.verdict": "SUSPICIOUS" }),
      PlayerSaveRecord.countDocuments({ computeStatus: "skipped" }),
      PlayerSaveRecord.countDocuments({ "computeValidation.teeVerified": true }),
      AIRecord.countDocuments({ status: "ready" })
    ]);

    const totalWithResult = cleanValidations + suspiciousValidations;

    return res.json({
      anticheat: {
        totalValidations,
        clean:            cleanValidations,
        suspicious:       suspiciousValidations,
        skipped:          skippedValidations,
        teeVerifiedCount: teeVerified,
        teeVerifiedRate:  totalValidations > 0 ? Math.round((teeVerified / totalValidations) * 100) / 100 : 0,
        cleanRate:        totalWithResult > 0  ? Math.round((cleanValidations / totalWithResult) * 100) / 100 : null
      },
      ai: {
        readyModels:  aiReady,
        model:        process.env.ZG_AI_MODEL        || "0GM-1.0-35B-A3B",
        anticheatModel: process.env.ZG_ANTICHEAT_MODEL || "deepseek/deepseek-chat-v3-0324",
        configured:   !!process.env.ZG_COMPUTE_API_KEY
      }
    });
  } catch (err) {
    console.error("[0G UX] computeStats error:", err);
    return res.status(500).json({ error: "Failed to fetch compute stats" });
  }
};

// ── GET /player/history (auth) ────────────────────────────────────────────────
// Paginated save history with full pipeline detail for the authenticated wallet.

exports.getSaveHistory = async (req, res) => {
  const wallet = req.walletAddress;
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(50, parseInt(req.query.limit) || 20);

  try {
    const total = await PlayerSaveRecord.countDocuments({ walletAddress: wallet });
    const saves = await PlayerSaveRecord.find({ walletAddress: wallet })
      .sort({ saveIndex: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const savesView = saves.map(s => ({
      saveIndex:     s.saveIndex,
      rootHash:      s.rootHash,
      coinSnapshot:  s.coinSnapshot,
      fileSize:      formatBytes(s.fileSize),
      checksum:      s.checksum,
      source:        s.source,
      badge:         verificationBadge(s),
      pipeline:      buildPipeline(s),
      createdAt:     s.createdAt
    }));

    return res.json({
      wallet,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      totalSaves: total,
      saves: savesView
    });
  } catch (err) {
    console.error("[0G UX] saveHistory error:", err);
    return res.status(500).json({ error: "Failed to load save history" });
  }
};
