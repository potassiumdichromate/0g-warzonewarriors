/**
 * BehaviorTrainer — Hybrid Behavioral AI for WarzoneWarrior
 *
 * Intelligence layers (in order of priority):
 *  1. TF.js behavioral clone  — trained from player recordings, per-frame speed (~1ms)
 *  2. 0G Compute LLM fallback — used when no TF.js model exists yet, TEE-verified (~200ms)
 *  3. Static neutral fallback — safe no-op when both above are unavailable
 *
 * ALL data lives on 0G Storage. MongoDB (AIRecord) holds only rootHashes + status.
 *
 * Training pipeline:
 *  Upload real samples → 0G Storage (rootHashes in AIRecord)
 *  [optional] Enrich with 0G Compute synthetic samples → also uploaded to 0G Storage
 *  Download all batches → TF.js train → serialize → upload model → 0G Storage (modelRootHash)
 */

const tf = require("@tensorflow/tfjs");

const AIRecord                               = require("../models/AIRecord");
const { uploadBuffer, downloadToBuffer }     = require("./ZeroGStorage");
const { predictGameAction, enrichTrainingSamples } = require("./ZeroGCompute");
const { encodeState, encodeAction, decodeAction }  = require("../utils/aiEncoder");

const MIN_SAMPLES = parseInt(process.env.AI_MIN_SAMPLES || "500");
const EPOCHS      = parseInt(process.env.AI_EPOCHS      || "50");
const BATCH_SIZE  = parseInt(process.env.AI_BATCH_SIZE  || "32");

// Whether to enrich training data with 0G Compute synthetic samples.
// Disabled by default — set AI_ENRICH=true in .env to enable.
const ENRICH_ENABLED    = process.env.AI_ENRICH === "true";
const ENRICH_TARGET     = parseInt(process.env.AI_ENRICH_COUNT || "100");
// Only enrich when real sample count is below this — no need when data is plentiful
const ENRICH_THRESHOLD  = parseInt(process.env.AI_ENRICH_THRESHOLD || "2000");

// ── Model architecture ────────────────────────────────────────────────────────

function buildModel() {
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [17], units: 64, activation: "relu" }));
  model.add(tf.layers.dense({ units: 64, activation: "relu" }));
  model.add(tf.layers.dense({ units: 32, activation: "relu" }));
  model.add(tf.layers.dense({ units: 5,  activation: "tanh" }));
  model.compile({ optimizer: "adam", loss: "meanSquaredError" });
  return model;
}

// ── Model serialization ───────────────────────────────────────────────────────
// Wire format: [4-byte LE meta length][JSON metadata][raw weight bytes]

async function serializeModel(model) {
  let artifacts = null;
  await model.save(
    tf.io.withSaveHandler(async (a) => {
      artifacts = a;
      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: "JSON" } };
    })
  );
  const metaBuf = Buffer.from(
    JSON.stringify({ modelTopology: artifacts.modelTopology, weightSpecs: artifacts.weightSpecs }),
    "utf8"
  );
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(metaBuf.length, 0);
  return Buffer.concat([lenBuf, metaBuf, Buffer.from(artifacts.weightData)]);
}

async function deserializeModel(buf) {
  const metaLen = buf.readUInt32LE(0);
  const meta    = JSON.parse(buf.slice(4, 4 + metaLen).toString("utf8"));
  const weights = buf.slice(4 + metaLen);
  return tf.loadLayersModel(
    tf.io.fromMemory(meta.modelTopology, meta.weightSpecs, weights)
  );
}

// ── In-memory model cache ─────────────────────────────────────────────────────

const _modelCache = new Map(); // walletAddress (lowercase) → tf.LayersModel

function invalidateCache(wallet) {
  const lw = wallet.toLowerCase();
  if (_modelCache.has(lw)) {
    try { _modelCache.get(lw).dispose(); } catch {}
    _modelCache.delete(lw);
  }
}

// ── Training (fire-and-forget) ────────────────────────────────────────────────

async function trainForWallet(wallet) {
  const lw     = wallet.toLowerCase();
  const record = await AIRecord.findOne({ walletAddress: lw });
  if (!record || record.sampleBatches.length === 0) {
    throw new Error("No sample batches found for this wallet");
  }

  await AIRecord.updateOne({ walletAddress: lw }, { status: "training", errorMsg: null });

  try {
    // 1. Download all sample batches from 0G in parallel
    console.log(`[BehaviorTrainer] ${wallet} — downloading ${record.sampleBatches.length} batch(es) from 0G...`);
    const batchBuffers = await Promise.all(
      record.sampleBatches.map(b => downloadToBuffer(b.rootHash))
    );

    let allSamples = batchBuffers.flatMap(buf => {
      try { return JSON.parse(buf.toString("utf8")); }
      catch { return []; }
    });
    console.log(`[BehaviorTrainer] ${wallet} — ${allSamples.length} real samples loaded.`);

    // 2. Optionally enrich with 0G Compute synthetic samples
    if (ENRICH_ENABLED && allSamples.length < ENRICH_THRESHOLD) {
      console.log(`[BehaviorTrainer] ${wallet} — requesting ${ENRICH_TARGET} synthetic samples from 0G Compute...`);
      const synthetic = await enrichTrainingSamples(allSamples.slice(0, 100), ENRICH_TARGET);

      if (synthetic.length > 0) {
        // Upload synthetic batch to 0G Storage so it's part of the immutable record
        const synBuf     = Buffer.from(JSON.stringify(synthetic), "utf8");
        const { rootHash } = await uploadBuffer(synBuf);

        await AIRecord.updateOne(
          { walletAddress: lw },
          {
            $push: { sampleBatches: { rootHash, sampleCount: synthetic.length, uploadedAt: new Date() } },
            $inc:  { totalSamples: synthetic.length }
          }
        );

        allSamples = allSamples.concat(synthetic);
        console.log(`[BehaviorTrainer] ${wallet} — enriched to ${allSamples.length} total samples (synthetic rootHash: ${rootHash})`);
      }
    }

    // 3. Encode into tensors
    const stateData  = new Float32Array(allSamples.length * 17);
    const actionData = new Float32Array(allSamples.length * 5);
    allSamples.forEach((s, i) => {
      stateData.set(encodeState(s.state),   i * 17);
      actionData.set(encodeAction(s.action), i * 5);
    });

    const xs = tf.tensor2d(stateData,  [allSamples.length, 17]);
    const ys = tf.tensor2d(actionData, [allSamples.length, 5]);

    // 4. Build + train
    const model = buildModel();
    await model.fit(xs, ys, {
      epochs:          EPOCHS,
      batchSize:       BATCH_SIZE,
      validationSplit: 0.1,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if ((epoch + 1) % 10 === 0) {
            console.log(
              `[BehaviorTrainer] ${wallet} — epoch ${epoch + 1}/${EPOCHS}` +
              ` loss=${logs.loss.toFixed(4)} val_loss=${(logs.val_loss || 0).toFixed(4)}`
            );
          }
        }
      }
    });

    xs.dispose();
    ys.dispose();

    // 5. Serialize → upload model to 0G Storage
    console.log(`[BehaviorTrainer] ${wallet} — uploading model to 0G...`);
    const modelBuf = await serializeModel(model);
    model.dispose();

    const { rootHash: modelRootHash } = await uploadBuffer(modelBuf);
    console.log(`[BehaviorTrainer] ${wallet} — model rootHash: ${modelRootHash}`);

    await AIRecord.updateOne(
      { walletAddress: lw },
      { status: "ready", modelRootHash, trainedAt: new Date(), errorMsg: null }
    );

    invalidateCache(lw);
    console.log(`[BehaviorTrainer] ${wallet} — training complete.`);

  } catch (err) {
    console.error(`[BehaviorTrainer] ${wallet} — training failed:`, err.message);
    await AIRecord.updateOne(
      { walletAddress: lw },
      { status: "error", errorMsg: err.message }
    );
    throw err;
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────

const FALLBACK_ACTION = { horizontal: 0, vertical: 0, jump: false, shoot: false, grenade: false };

/**
 * predict() — hybrid inference
 *
 * Layer 1: TF.js behavioral clone (fast, ~1ms)
 *   → ready when status="ready" and model downloaded from 0G
 *
 * Layer 2: 0G Compute LLM (strategic, ~200ms, TEE-verified)
 *   → used when TF.js model not trained yet
 *   → also used by /ai/strategy for explicit Arena-verified decisions
 *
 * Layer 3: neutral fallback
 *   → when both layers are unavailable
 */
async function predict(wallet, state) {
  const lw = wallet.toLowerCase();

  // ── Layer 1: TF.js ───────────────────────────────────────────────────────────
  if (!_modelCache.has(lw)) {
    const record = await AIRecord.findOne({ walletAddress: lw });

    if (record?.status === "ready" && record.modelRootHash) {
      try {
        console.log(`[BehaviorTrainer] Loading TF.js model from 0G for ${wallet}...`);
        const buf   = await downloadToBuffer(record.modelRootHash);
        const model = await deserializeModel(buf);
        _modelCache.set(lw, model);
      } catch (err) {
        console.warn(`[BehaviorTrainer] TF.js model load failed for ${wallet}:`, err.message);
        // Fall through to 0G Compute
      }
    }
  }

  if (_modelCache.has(lw)) {
    const model       = _modelCache.get(lw);
    const inputVec    = encodeState(state);
    const inputTensor = tf.tensor2d([Array.from(inputVec)], [1, 17]);
    const outTensor   = model.predict(inputTensor);
    const output      = Array.from(await outTensor.data());
    inputTensor.dispose();
    outTensor.dispose();

    return {
      action:     decodeAction(output),
      confidence: Math.min(1, output.reduce((s, v) => s + Math.abs(v), 0) / output.length),
      source:     "tfjs"
    };
  }

  // ── Layer 2: 0G Compute fallback ─────────────────────────────────────────────
  const computeResult = await predictGameAction(state);
  if (computeResult) {
    return { ...computeResult, confidence: 0.65 };
  }

  // ── Layer 3: neutral fallback ────────────────────────────────────────────────
  return { action: FALLBACK_ACTION, confidence: 0, source: "fallback" };
}

/**
 * strategyPredict() — always routes through 0G Compute with TEE verification.
 * Use this for Arena match decisions that need a cryptographic proof of fairness.
 */
async function strategyPredict(wallet, state) {
  const result = await predictGameAction(state);
  if (result) return result;
  return { action: FALLBACK_ACTION, confidence: 0, source: "fallback" };
}

module.exports = { trainForWallet, predict, strategyPredict, invalidateCache, MIN_SAMPLES };
