/**
 * ZeroGCompute — verifiable AI validation via 0G Compute Router.
 *
 * 0G Compute runs inference inside a TEE (Trusted Execution Environment).
 * The provider signs the response with an EIP-191 key that is attested on-chain.
 * This means: if the model says "CLEAN", that statement is cryptographically signed
 * and cannot be forged by us or anyone else.
 *
 * Compute router: https://router-api.0g.ai/v1
 * Dashboard / API keys / deposit: https://pc.0g.ai
 * Model: zai-org/GLM-5-FP8 (default — change via ZG_COMPUTE_MODEL env var)
 *
 * COST: Only trigger on high-stakes events or suspicious heuristics.
 * Every call costs 0G tokens deposited at pc.0g.ai.
 */

const ZG_COMPUTE_BASE_URL   = process.env.ZG_COMPUTE_BASE_URL   || 'https://router-api.0g.ai/v1';
const ZG_COMPUTE_API_KEY    = process.env.ZG_COMPUTE_API_KEY    || '';
const ZG_COMPUTE_MODEL      = process.env.ZG_COMPUTE_MODEL      || 'zai-org/GLM-5-FP8';
const ZG_COMPUTE_TIMEOUT_MS = Number(process.env.ZG_COMPUTE_TIMEOUT_MS || 30_000);
const MIN_CONFIDENCE        = Number(process.env.ZG_COMPUTE_MIN_CONFIDENCE || 0.70);

// Warzone-specific anti-cheat system prompt.
// The model MUST echo the rootHash back (binding check) to prevent result replay attacks.
const ANTI_CHEAT_SYSTEM_PROMPT = `
You are a strict anti-cheat validator for Warzone Warriors, a competitive blockchain game.
Your job: analyse a player save event and determine if it's legitimate.

Respond ONLY with valid JSON matching this exact schema:
{
  "rootHash": "<echo the rootHash field from input — required for integrity binding>",
  "valid": <boolean>,
  "confidence": <float 0.0-1.0>,
  "flags": [<array of anomaly strings, or empty>],
  "verdict": "<CLEAN | SUSPICIOUS | REJECTED>",
  "reasoning": "<one sentence>"
}

Rules:
- Verdict CLEAN: confidence > ${MIN_CONFIDENCE}, no critical flags
- Verdict SUSPICIOUS: confidence 0.4-${MIN_CONFIDENCE}, or minor flags
- Verdict REJECTED: confidence < 0.4, or critical flags present
- Critical flags (always REJECTED): "IMPOSSIBLE_COIN_RATE", "NEGATIVE_TIME_DELTA", "ROLLBACK_DETECTED", "STAT_OVERFLOW"
- Suspicious flags: "RAPID_SAVE", "LARGE_COIN_JUMP", "FIRST_SAVE"
- Max legitimate coin gain: ~5000 per 30 minutes of play (based on game economy)
- saveIndex must always be greater than previousSaveIndex
- timeDeltaSeconds < 10 and coinDelta > 0 is always suspicious

Output ONLY the JSON object. No markdown. No explanation outside the JSON.
`.trim();

/**
 * Heuristic: decide whether to spend a compute call on this save.
 * Saves tokens for the cases that actually matter.
 */
function shouldTriggerCompute(meta) {
  if (!ZG_COMPUTE_API_KEY) return false;  // compute not configured
  if (meta.isFirstSave) return true;       // always validate the baseline
  if (meta.coinDelta > 5000) return true;  // large jump
  if (meta.timeDeltaSeconds != null && meta.timeDeltaSeconds < 30 && meta.coinDelta > 100) return true;
  if (meta.saveIndex <= (meta.previousSaveIndex ?? -1)) return true;  // rollback
  return false;
}

/**
 * Validate a save event via 0G Compute.
 *
 * @param {object} saveInput  - metadata about this save (no raw PII, no full binary)
 * @param {string} rootHash   - binding key — model MUST echo this back
 * @returns {Promise<object>}  ComputeValidation result
 */
async function validateSave(saveInput, rootHash) {
  if (!ZG_COMPUTE_API_KEY) {
    return {
      valid: true,
      confidence: 1.0,
      flags: [],
      verdict: 'CLEAN',
      rootHash,
      teeVerified: false,
      teeVerifiedIndependently: false,
      providerAddress: null,
      chatId: null,
      requestId: null,
      billingCost: '0',
      validatedAt: new Date(),
      skipped: true,
      reason: 'ZG_COMPUTE_API_KEY not configured',
    };
  }

  const body = {
    model: ZG_COMPUTE_MODEL,
    messages: [
      { role: 'system', content: ANTI_CHEAT_SYSTEM_PROMPT },
      { role: 'user',   content: JSON.stringify({ rootHash, ...saveInput }) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 300,
    verify_tee: true,
    provider: { sort: process.env.ZG_COMPUTE_ROUTING || 'latency' },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZG_COMPUTE_TIMEOUT_MS);

  let rawRes;
  try {
    rawRes = await fetch(`${ZG_COMPUTE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZG_COMPUTE_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!rawRes.ok) {
    const errText = await rawRes.text().catch(() => '');
    throw new Error(`0G Compute HTTP ${rawRes.status}: ${errText.slice(0, 200)}`);
  }

  const data = await rawRes.json();
  const trace  = data.x_0g_trace || {};
  const chatId = rawRes.headers.get('ZG-Res-Key') || data.id || null;
  const content = data.choices?.[0]?.message?.content || '';

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`0G Compute returned non-JSON: ${content.slice(0, 200)}`);
  }

  // BINDING CHECK — prevents replaying a result from a different save
  if (parsed.rootHash !== rootHash) {
    throw new Error(
      `0G Compute binding violation: rootHash mismatch. ` +
      `Expected ${rootHash}, got ${parsed.rootHash}`,
    );
  }

  const confidence = Number(parsed.confidence ?? 0);
  const valid = parsed.valid === true && confidence >= MIN_CONFIDENCE;

  console.log('[0G Compute]', {
    verdict: parsed.verdict,
    confidence,
    flags: parsed.flags,
    teeVerified: trace.tee_verified === true,
    rootHash,
  });

  return {
    valid,
    confidence,
    flags:                    parsed.flags ?? [],
    verdict:                  parsed.verdict,
    rootHash:                 parsed.rootHash,
    teeVerified:              trace.tee_verified === true,
    teeVerifiedIndependently: false,
    providerAddress:          trace.provider || null,
    chatId,
    requestId:                trace.request_id || null,
    billingCost:              String(trace.billing?.total_cost ?? '0'),
    validatedAt:              new Date(),
  };
}

module.exports = { validateSave, shouldTriggerCompute };
