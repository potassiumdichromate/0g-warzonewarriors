/**
 * zgController — 0G decentralized save/load for WarzoneWarrior.
 *
 * Wire format (WZSV):
 *   [4 bytes] Magic: 0x57 0x5A 0x53 0x56  ("WZSV")
 *   [1 byte]  Version: 0x01
 *   [N bytes] JSON-encoded payload
 *
 * Unity sends JSON bytes wrapped in WZSV header.
 * Backend stores/returns the same format so Unity can decode it.
 */

const crypto = require("crypto");

const PlayerSaveRecord = require("../models/PlayerSaveRecord");
const PlayerProfile    = require("../models/PlayerProfile");
const ZeroGStorage     = require("../services/ZeroGStorage");
const ZeroGDA          = require("../services/ZeroGDA");
const ZeroGChain       = require("../services/ZeroGChain");
const ZeroGCompute     = require("../services/ZeroGCompute");
const { withRetry }    = require("../utils/retry");

const ZG_ENABLED = process.env.ZG_ENABLED !== "false";

// ── WZSV binary format ────────────────────────────────────────────────────────

const MAGIC   = Buffer.from([0x57, 0x5A, 0x53, 0x56]); // "WZSV"
const VERSION = 0x01;

function serializeSave(profileDoc) {
  const p = profileDoc.toObject({ getters: true });

  function mapToObj(m) {
    if (!m) return {};
    if (m instanceof Map) {
      const o = {};
      for (const [k, v] of m) o[k] = v instanceof Map ? mapToObj(v) : v;
      return o;
    }
    return m;
  }

  const payload = {
    Intraverse:                   p.Intraverse,
    PlayerProfile:                p.PlayerProfile,
    PlayerResources:              p.PlayerResources,
    PlayerRambos:                 mapToObj(p.PlayerRambos),
    PlayerRamboSkills:            mapToObj(p.PlayerRamboSkills),
    PlayerGuns:                   mapToObj(p.PlayerGuns),
    PlayerGrenades:               mapToObj(p.PlayerGrenades),
    PlayerMeleeWeapons:           mapToObj(p.PlayerMeleeWeapons),
    PlayerCampaignProgress:       p.PlayerCampaignProgress   || {},
    PlayerCampaignStageProgress:  p.PlayerCampaignStageProgress || {},
    PlayerCampaignRewardProgress: mapToObj(p.PlayerCampaignRewardProgress),
    PlayerBoosters:               mapToObj(p.PlayerBoosters),
    PlayerSelectingBooster:       p.PlayerSelectingBooster || [],
    PlayerDailyQuestData:         p.PlayerDailyQuestData   || [],
    PlayerAchievementData:        mapToObj(p.PlayerAchievementData),
    PlayerTutorialData:           p.PlayerTutorialData,
  };

  const jsonBytes = Buffer.from(JSON.stringify(payload));
  const header    = Buffer.alloc(5);
  MAGIC.copy(header);
  header[4] = VERSION;
  return Buffer.concat([header, jsonBytes]);
}

function deserializeSave(bytes) {
  if (bytes.length < 5)
    throw new Error("Save too short");
  if (bytes[0] !== 0x57 || bytes[1] !== 0x5A || bytes[2] !== 0x53 || bytes[3] !== 0x56)
    throw new Error("Invalid magic header — not a Warzone save file");
  if (bytes[4] !== VERSION)
    throw new Error(`Unsupported save version: ${bytes[4]}`);

  try {
    return JSON.parse(bytes.slice(5).toString("utf8"));
  } catch {
    throw new Error("Failed to parse save payload as JSON");
  }
}

// ── Background pipeline ───────────────────────────────────────────────────────

async function runBackgroundPipeline(record, walletAddress, rootHash, saveInput) {
  try {
    const anchorTxHash = await withRetry(
      () => ZeroGChain.anchorSaveHash(walletAddress, rootHash, record.saveIndex),
      { maxAttempts: 3, baseDelayMs: 5000, label: `anchor save ${record.saveIndex}` }
    );
    await PlayerSaveRecord.findByIdAndUpdate(record._id, { anchorTxHash });
    console.log(`[0G] Anchored save ${record.saveIndex} → ${anchorTxHash}`);
  } catch (err) {
    console.error("[0G] Anchor failed after retries:", err.message);
  }

  try {
    const proof = await withRetry(
      () => ZeroGDA.publishCommitment({
        walletAddress,
        rootHash,
        saveIndex:    record.saveIndex,
        coinSnapshot: record.coinSnapshot,
        timestamp:    Date.now()
      }),
      { maxAttempts: 2, baseDelayMs: 10000, label: `DA publish save ${record.saveIndex}` }
    );

    await PlayerSaveRecord.findByIdAndUpdate(record._id, {
      daStatus: "finalized",
      daCommitment: {
        requestId:            proof.request_id   || proof.requestId    || "",
        batchId:              String(proof.batch_id || proof.batchId   || ""),
        blobIndex:            proof.blob_index   || proof.blobIndex    || 0,
        batchHeaderHash:      proof.batch_metadata?.batch_header_hash  || "",
        referenceBlockNumber: proof.batch_metadata?.batch_header?.reference_block_number || 0,
        finalizedAt:          new Date()
      }
    });

    console.log(`[0G] DA finalized save ${record.saveIndex}`);
  } catch (err) {
    console.error("[0G] DA failed:", err.message);
    await PlayerSaveRecord.findByIdAndUpdate(record._id, { daStatus: "failed" });
  }

  const meta = {
    coinDelta:      saveInput.coinDelta      || 0,
    saveIndexDelta: saveInput.saveIndexDelta || 1
  };

  if (ZeroGCompute.shouldTriggerCompute(meta)) {
    try {
      await PlayerSaveRecord.findByIdAndUpdate(record._id, { computeStatus: "pending" });

      const verdict = await ZeroGCompute.validateSave(saveInput, rootHash);

      if (verdict.skipped) {
        await PlayerSaveRecord.findByIdAndUpdate(record._id, { computeStatus: "skipped" });
      } else {
        await PlayerSaveRecord.findByIdAndUpdate(record._id, {
          computeStatus:     verdict.valid ? "validated" : "rejected",
          computeValidation: verdict
        });
        console.log(`[0G] Compute verdict for save ${record.saveIndex}: ${verdict.verdict}`);
      }
    } catch (err) {
      console.error("[0G] Compute failed:", err.message);
    }
  }
}

// ── POST /save/binary ─────────────────────────────────────────────────────────

exports.saveBinary = async (req, res) => {
  const walletAddress = req.walletAddress;
  const buffer = req.body;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: "Empty or invalid binary payload" });
  }

  let payload;
  try {
    payload = deserializeSave(buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    // Anti-rollback: latest saveIndex from DB
    const latest       = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();
    const prevSaveIndex = latest?.saveIndex ?? -1;
    const newSaveIndex  = prevSaveIndex + 1;

    const clientIdx = req.headers["x-save-index"];
    if (clientIdx !== undefined) {
      const parsed = parseInt(clientIdx, 10);
      if (parsed <= prevSaveIndex) {
        return res.status(409).json({
          error: "Anti-rollback: saveIndex must be strictly greater than current",
          currentSaveIndex: prevSaveIndex,
          rejectedSaveIndex: parsed
        });
      }
    }

    // Upsert MongoDB profile
    const update = {
      Intraverse:                   payload.Intraverse,
      PlayerProfile:                payload.PlayerProfile,
      PlayerResources:              payload.PlayerResources,
      PlayerRambos:                 payload.PlayerRambos,
      PlayerRamboSkills:            payload.PlayerRamboSkills,
      PlayerGuns:                   payload.PlayerGuns,
      PlayerGrenades:               payload.PlayerGrenades,
      PlayerMeleeWeapons:           payload.PlayerMeleeWeapons,
      PlayerCampaignProgress:       payload.PlayerCampaignProgress,
      PlayerCampaignStageProgress:  payload.PlayerCampaignStageProgress,
      PlayerCampaignRewardProgress: payload.PlayerCampaignRewardProgress,
      PlayerBoosters:               payload.PlayerBoosters,
      PlayerSelectingBooster:       payload.PlayerSelectingBooster,
      PlayerDailyQuestData:         payload.PlayerDailyQuestData,
      PlayerAchievementData:        payload.PlayerAchievementData,
      PlayerTutorialData:           payload.PlayerTutorialData,
    };

    const profile = await PlayerProfile.findOneAndUpdate(
      { walletAddress },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const coinSnapshot = profile.PlayerResources?.coin ?? 0;
    const coinDelta    = coinSnapshot - (latest?.coinSnapshot ?? 0);

    // Upload to 0G Storage — non-fatal: DB save always succeeds
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
    let storageResult;
    if (ZG_ENABLED) {
      try {
        storageResult = await ZeroGStorage.uploadBuffer(buffer);
      } catch (err) {
        console.error("[0G] Storage upload failed (falling back to db-only):", err.message);
        storageResult = {
          rootHash: `db-${checksum.slice(0, 16)}`,
          txHash:   `db-tx-${Date.now()}`,
          size:     buffer.length,
          checksum
        };
      }
    } else {
      storageResult = {
        rootHash: `dev-${checksum.slice(0, 16)}`,
        txHash:   `dev-tx-${Date.now()}`,
        size:     buffer.length,
        checksum
      };
    }

    const record = await PlayerSaveRecord.create({
      walletAddress,
      rootHash:      storageResult.rootHash,
      txHash:        storageResult.txHash,
      fileSize:      storageResult.size,
      checksum:      storageResult.checksum,
      saveIndex:     newSaveIndex,
      coinSnapshot,
      daStatus:      "pending",
      computeStatus: "skipped",
      source:        "game_save"
    });

    res.status(201).json({
      success:   true,
      rootHash:  storageResult.rootHash,
      saveIndex: newSaveIndex,
      txHash:    storageResult.txHash,
      checksum:  storageResult.checksum,
      fileSize:  storageResult.size
    });

    setImmediate(() => {
      if (!ZG_ENABLED) return;
      runBackgroundPipeline(record, walletAddress, storageResult.rootHash, {
        coinDelta,
        saveData:       payload,
        saveIndex:      newSaveIndex,
        prevSaveIndex,
        saveIndexDelta: newSaveIndex - prevSaveIndex,
        timeElapsed:    latest?.createdAt
          ? Date.now() - new Date(latest.createdAt).getTime()
          : 0
      }).catch(err => console.error("[0G] Background pipeline error:", err.message));
    });

  } catch (err) {
    console.error("[0G] saveBinary error:", err);
    return res.status(500).json({ error: "Failed to save binary data", detail: err.message });
  }
};

// ── GET /load/binary ──────────────────────────────────────────────────────────

exports.loadBinary = async (req, res) => {
  const walletAddress = req.walletAddress;

  try {
    const profile = await PlayerProfile.findOne({ walletAddress });

    if (!profile) {
      return res.status(404).json({ error: "No save found for this wallet" });
    }

    const record = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();

    const buffer = serializeSave(profile);

    res.set({
      "Content-Type":       "application/octet-stream",
      "X-Root-Hash":        record?.rootHash    || "",
      "X-Save-Index":       String(record?.saveIndex ?? 0),
      "X-Da-Status":        record?.daStatus    || "pending",
      "X-Checksum-Sha256":  record?.checksum    || ""
    });

    return res.send(buffer);
  } catch (err) {
    console.error("[0G] loadBinary error:", err);
    return res.status(500).json({ error: "Failed to load binary data" });
  }
};

// ── GET /save/metadata ────────────────────────────────────────────────────────

exports.getSaveMetadata = async (req, res) => {
  const wallet = req.query.wallet;

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param required" });
  }

  try {
    const records = await PlayerSaveRecord.find({ walletAddress: wallet.toLowerCase() })
      .sort({ saveIndex: -1 })
      .limit(10)
      .lean();

    let onChain = null;
    if (ZG_ENABLED && process.env.ZG_ANCHOR_CONTRACT_ADDRESS) {
      try {
        onChain = await ZeroGChain.getOnChainSave(wallet);
      } catch (err) {
        console.error("[0G] getOnChainSave failed:", err.message);
      }
    }

    return res.json({ wallet, saves: records, onChain });
  } catch (err) {
    console.error("[0G] getSaveMetadata error:", err);
    return res.status(500).json({ error: "Failed to fetch metadata" });
  }
};

// ── GET /verify ───────────────────────────────────────────────────────────────

exports.verifySave = async (req, res) => {
  const wallet = req.query.wallet;

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param required" });
  }

  const layers = {
    dbRecord:         false,
    daFinalized:      false,
    checksumMatch:    false,
    computeValidated: false
  };

  try {
    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet.toLowerCase() })
      .sort({ saveIndex: -1 }).lean();

    layers.dbRecord = !!record;
    if (!record) return res.json({ wallet, layers, allPassed: false });

    layers.daFinalized = record.daStatus === "finalized";

    if (ZG_ENABLED) {
      try {
        const buf      = await ZeroGStorage.downloadToBuffer(record.rootHash);
        const checksum = crypto.createHash("sha256").update(buf).digest("hex");
        layers.checksumMatch = checksum === record.checksum;
      } catch {
        layers.checksumMatch = false;
      }
    } else {
      layers.checksumMatch = true;
    }

    layers.computeValidated = record.computeStatus === "validated";

    const allPassed = Object.values(layers).every(Boolean);

    return res.json({ wallet, layers, allPassed, saveIndex: record.saveIndex });
  } catch (err) {
    console.error("[0G] verifySave error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
};

// ── GET /leaderboard/decentralized ───────────────────────────────────────────

exports.getDecentralizedLeaderboard = async (req, res) => {
  try {
    const leaderboard = await PlayerSaveRecord.aggregate([
      { $sort: { saveIndex: -1 } },
      {
        $group: {
          _id:          "$walletAddress",
          coinSnapshot: { $first: "$coinSnapshot" },
          saveIndex:    { $first: "$saveIndex" },
          rootHash:     { $first: "$rootHash" },
          daStatus:     { $first: "$daStatus" }
        }
      },
      { $sort: { coinSnapshot: -1 } },
      { $limit: 100 }
    ]);

    const result = leaderboard.map((entry, index) => {
      const wallet = entry._id;
      return {
        rank:          index + 1,
        walletAddress: wallet,
        displayName:   `Warrior_${wallet.slice(2, 8)}`,
        coinSnapshot:  entry.coinSnapshot,
        saveIndex:     entry.saveIndex,
        daStatus:      entry.daStatus
      };
    });

    return res.json({ leaderboard: result, total: result.length });
  } catch (err) {
    console.error("[0G] getDecentralizedLeaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

// ── Exported utility for async 0G persistence ────────────────────────────────

exports.persistProfileTo0G = async (walletAddress, profileData, source = "game_save") => {
  if (!ZG_ENABLED) return;

  try {
    const latest       = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();
    const prevSaveIndex = latest?.saveIndex ?? -1;
    const newSaveIndex  = prevSaveIndex + 1;

    const jsonBytes = Buffer.from(JSON.stringify(profileData));
    const header    = Buffer.alloc(5);
    MAGIC.copy(header);
    header[4] = VERSION;
    const buffer = Buffer.concat([header, jsonBytes]);

    let storageResult;
    try {
      storageResult = await ZeroGStorage.uploadBuffer(buffer);
    } catch (err) {
      console.error("[0G] persistProfileTo0G upload failed:", err.message);
      return;
    }

    const coinSnapshot = profileData.PlayerResources?.coin ?? 0;
    const coinDelta    = coinSnapshot - (latest?.coinSnapshot ?? 0);

    const record = await PlayerSaveRecord.create({
      walletAddress,
      rootHash:      storageResult.rootHash,
      txHash:        storageResult.txHash,
      fileSize:      storageResult.size,
      checksum:      storageResult.checksum,
      saveIndex:     newSaveIndex,
      coinSnapshot,
      daStatus:      "pending",
      computeStatus: "skipped",
      source
    });

    setImmediate(() => {
      runBackgroundPipeline(record, walletAddress, storageResult.rootHash, {
        coinDelta,
        saveIndex:      newSaveIndex,
        prevSaveIndex,
        saveIndexDelta: 1,
        timeElapsed:    0
      }).catch(err => console.error("[0G] Background pipeline error:", err.message));
    });
  } catch (err) {
    console.error("[0G] persistProfileTo0G error:", err.message);
  }
};
