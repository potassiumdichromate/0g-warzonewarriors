/**
 * ZeroGCompute — 0G Compute Network integration
 *
 * Used for two purposes:
 *  1. Anti-cheat: validateSave()     — verifies player save data integrity
 *  2. Behavioral AI: predictGameAction() — LLM action predictor (fallback + strategy)
 *                    enrichTrainingSamples() — synthetic sample generation before TF.js trains
 *
 * All calls use verify_tee: true so every inference is signed by a TEE provider
 * and the x_0g_trace proves which on-chain node produced the result.
 *
 * API: https://router-api.0g.ai/v1  (OpenAI-compatible)
 * Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
 */

const COMPUTE_URL = "https://router-api.0g.ai/v1/chat/completions";

// Model used for anti-cheat validation (needs reliable JSON output)
const ANTICHEAT_MODEL = process.env.ZG_ANTICHEAT_MODEL || "deepseek/deepseek-chat-v3-0324";

// Model used for game AI decisions — 0G's own model, fast + affordable
const AI_MODEL = process.env.ZG_AI_MODEL || "0GM-1.0-35B-A3B";

// ── Shared fetch helper ───────────────────────────────────────────────────────

async function callCompute({ model, messages, temperature = 0, max_tokens = 512, verify_tee = true }) {
  const response = await fetch(COMPUTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ZG_COMPUTE_API_KEY}`
    },
    body: JSON.stringify({ model, messages, verify_tee, temperature, max_tokens })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`0G Compute ${response.status}: ${body || response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const trace   = data.x_0g_trace || {};

  return { content, trace, chatId: data.id || null };
}

// ── 1. Anti-cheat validator ────────────────────────────────────────────────────

const ANTICHEAT_SYSTEM_PROMPT = `You are an anti-cheat validator for Warzone, a mobile shooter game.
Analyze this player save data and determine if it is CLEAN or SUSPICIOUS.

Rules for a CLEAN save:
- PlayerResources.coin: reasonable value (0 – 9,999,999). Sudden jumps >50,000 in one session are suspicious.
- PlayerResources.gem: 0 – 99,999. Gems are premium currency, large values are suspicious.
- PlayerProfile.level: 1 – 100. Must be consistent with exp value.
- PlayerProfile.exp: non-negative. Cannot decrease between sessions.
- PlayerRambos: characters must have valid id values (0–99) and level 1–10.
- PlayerRamboSkills: skill values must be non-negative integers 0–10 per skill.
- PlayerGuns/Grenades/MeleeWeapons: level must be 1–10, ammo/quantity non-negative.
- PlayerCampaignStageProgress: each stage array must be [bool, bool, bool].
  Stage unlock must be sequential — later stages cannot be unlocked without earlier ones.
- PlayerAchievementData: progress values must be non-negative. claimTimes must be non-negative.
- PlayerDailyQuestData: progress must be non-negative. Cannot have duplicate quest types.
- PlayerBoosters: all values non-negative integers.
- totalTimePlayed: non-negative. Cannot decrease.

Respond ONLY with a single JSON object — no markdown, no explanation:
{
  "verdict": "CLEAN" or "SUSPICIOUS",
  "confidence": number (0.0–1.0),
  "flags": string[],
  "summary": "one sentence",
  "rootHash": "<echo the rootHash field from the user message exactly>"
}`;

function shouldTriggerCompute(meta) {
  if (!process.env.ZG_COMPUTE_API_KEY) return false;
  return meta.saveIndexDelta >= 1;
}

async function validateSave(saveInput, rootHash) {
  if (!process.env.ZG_COMPUTE_API_KEY) {
    return { skipped: true, reason: "ZG_COMPUTE_API_KEY not set" };
  }

  const userMessage = JSON.stringify({
    saveIndex:     saveInput.saveIndex,
    prevSaveIndex: saveInput.prevSaveIndex,
    coinDelta:     saveInput.coinDelta,
    timeElapsed:   saveInput.timeElapsed,
    saveData:      saveInput.saveData || null,
    rootHash
  });

  const { content, trace, chatId } = await callCompute({
    model:       ANTICHEAT_MODEL,
    messages:    [
      { role: "system", content: ANTICHEAT_SYSTEM_PROMPT },
      { role: "user",   content: userMessage }
    ],
    temperature: 0
  });

  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("Failed to parse compute response as JSON"); }

  if (parsed.rootHash !== rootHash) {
    throw new Error(
      `Compute rootHash binding check failed (got ${parsed.rootHash}, expected ${rootHash}) — possible replay attack`
    );
  }

  return {
    valid:           parsed.verdict === "CLEAN",
    confidence:      parsed.confidence,
    flags:           parsed.flags || [],
    verdict:         parsed.verdict,
    rootHash:        parsed.rootHash,
    teeVerified:     trace.tee_verified     || false,
    providerAddress: trace.provider         || null,
    chatId,
    requestId:       trace.request_id       || null,
    billingCost:     trace.billing?.total_cost || null,
    validatedAt:     new Date()
  };
}

// ── 2. Game action predictor ──────────────────────────────────────────────────
//
// Called when a player has no trained TF.js model yet, or when Unity explicitly
// requests a verified strategic decision (Arena fairness proof).
//
// IMPORTANT: LLM inference takes 100–400ms. Do NOT call this every frame.
// Unity should cache the result for ~1–2 seconds between calls.

const ACTION_SYSTEM_PROMPT = `You are an expert AI controller for WarzoneWarrior, a mobile 2D action shooter.
Given the current game state, output the single best action to take right now.

Decision rules:
- SHOOT when the nearest enemy is within distance 200 and you have HP > 0.2
- GRENADE when 2+ enemies are clustered within distance 150, or when cornered with low HP
- JUMP to dodge if an enemy is within distance 80 and closing in
- HORIZONTAL: move toward nearest enemy if HP > 0.5, retreat (opposite direction) if HP <= 0.3
- VERTICAL: aim up if enemy is above (relY > 50), aim down if below (relY < -50)
- When no enemies are visible, move right to explore (horizontal: 0.5)

Respond with ONLY valid JSON — no markdown, no explanation:
{"horizontal":0.0,"vertical":0.0,"jump":false,"shoot":false,"grenade":false,"reasoning":"one sentence"}`;

/**
 * Predict next game action using 0G Compute LLM.
 * Returns null if ZG_COMPUTE_API_KEY is not set (caller should use fallback).
 */
async function predictGameAction(state) {
  if (!process.env.ZG_COMPUTE_API_KEY) return null;

  const stateMsg = JSON.stringify({
    hp:          Math.round((state.hpPercent || 0) * 100) / 100,
    pos:         { x: Math.round(state.posX || 0), y: Math.round(state.posY || 0) },
    vel:         { x: Math.round(state.velX || 0), y: Math.round(state.velY || 0) },
    grounded:    !!state.isGrounded,
    facingRight: !!state.facingRight,
    enemies:     (state.enemies || []).slice(0, 5).map(e => ({
      rel:   { x: Math.round(e.relX || 0), y: Math.round(e.relY || 0) },
      dist:  Math.round(e.distance || 0),
      hp:    Math.round((e.hpPercent || 0) * 100) / 100,
      state: e.state || "unknown"
    }))
  });

  try {
    const { content, trace, chatId } = await callCompute({
      model:      AI_MODEL,
      messages:   [
        { role: "system", content: ACTION_SYSTEM_PROMPT },
        { role: "user",   content: stateMsg }
      ],
      temperature: 0.2,
      max_tokens:  128
    });

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { return null; }

    return {
      action: {
        horizontal: Math.max(-1, Math.min(1, Number(parsed.horizontal) || 0)),
        vertical:   Math.max(-1, Math.min(1, Number(parsed.vertical)   || 0)),
        jump:       !!parsed.jump,
        shoot:      !!parsed.shoot,
        grenade:    !!parsed.grenade
      },
      reasoning:       parsed.reasoning    || null,
      teeVerified:     trace.tee_verified  || false,
      providerAddress: trace.provider      || null,
      billingCost:     trace.billing?.total_cost || null,
      chatId,
      source: "0g-compute"
    };
  } catch (err) {
    console.warn("[ZeroGCompute] predictGameAction failed:", err.message);
    return null;
  }
}

// ── 3. Training data enrichment ────────────────────────────────────────────────
//
// Before TF.js training, ask 0G Compute to generate synthetic expert samples
// that match the player's playstyle. These are uploaded to 0G Storage and
// mixed into the real samples, improving model quality with fewer real samples.

/**
 * Returns an array of synthetic samples or [] on failure.
 * targetCount: how many extra samples to generate (keep ≤ 150 for token budget).
 */
async function enrichTrainingSamples(realSamples, targetCount = 100) {
  if (!process.env.ZG_COMPUTE_API_KEY || !realSamples || realSamples.length === 0) {
    return [];
  }

  // Summarise player style from real samples so the LLM stays on-theme
  const total      = realSamples.length;
  const shootRate  = (realSamples.filter(s => s.action?.shoot).length   / total).toFixed(2);
  const jumpRate   = (realSamples.filter(s => s.action?.jump).length    / total).toFixed(2);
  const grenadeRate = (realSamples.filter(s => s.action?.grenade).length / total).toFixed(2);
  const avgHP      = (realSamples.reduce((acc, s) => acc + (s.state?.hpPercent || 0), 0) / total).toFixed(2);

  // Include a few real examples for style context
  const preview = JSON.stringify(realSamples.slice(0, 5));

  const systemPrompt =
    `You are an expert WarzoneWarrior player. Generate ${targetCount} diverse, high-quality ` +
    `training samples for behavioral cloning.\n\n` +
    `Player style: shootRate=${shootRate}, jumpRate=${jumpRate}, grenadeRate=${grenadeRate}, avgHP=${avgHP}\n` +
    `Match this style but show OPTIMAL decisions (better than average).\n\n` +
    `State fields: posX, posY, velX, velY, facingRight (bool), isGrounded (bool), hpPercent (0-1), ` +
    `enemies:[{relX, relY, distance, state, hpPercent}]\n` +
    `Action fields: horizontal (-1..1), vertical (-1..1), jump (bool), shoot (bool), grenade (bool)\n\n` +
    `Respond with ONLY a JSON array — no markdown:\n` +
    `[{"state":{...},"action":{...}},...]`;

  try {
    const { content } = await callCompute({
      model:      AI_MODEL,
      messages:   [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Example real samples: ${preview}\n\nGenerate ${targetCount} samples.` }
      ],
      temperature: 0.9,
      max_tokens:  4096,
      verify_tee:  false  // not needed for training data
    });

    // Strip markdown fences if model added them
    const cleaned = content.replace(/```json|```/g, "").trim();
    const samples = JSON.parse(cleaned);

    if (!Array.isArray(samples)) return [];

    // Validate each sample has the required shape
    const valid = samples.filter(s =>
      s?.state && s?.action &&
      typeof s.action.horizontal === "number" &&
      typeof s.action.vertical   === "number"
    );

    console.log(`[ZeroGCompute] enrichTrainingSamples: got ${valid.length}/${targetCount} valid synthetic samples`);
    return valid;
  } catch (err) {
    console.warn("[ZeroGCompute] enrichTrainingSamples failed:", err.message);
    return [];
  }
}

module.exports = {
  // Anti-cheat
  validateSave,
  shouldTriggerCompute,
  // Behavioral AI
  predictGameAction,
  enrichTrainingSamples
};
