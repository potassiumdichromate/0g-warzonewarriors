/**
 * Pre-generated trash talk pool.
 *
 * Keeps a rolling pool of winner + loser lines so match-end responses
 * are instant — no AI wait time for players.
 *
 * Strategy:
 *   - Server start: fill pool (10 parallel calls = 50 lines each)
 *   - Match end: pop 1 winner line + 1 loser line (instant)
 *   - When pool drops below REFILL_THRESHOLD: fire 10 more calls in background
 */

const WORKER_URL =
  process.env.TRASH_TALK_WORKER_URL ||
  'https://trash-talk-worker.ronit-sde.workers.dev/generate';

const POOL_MAX = 50;            // cap so memory stays bounded
const REFILL_THRESHOLD = 20;    // start refilling when either pool drops below this
const REFILL_BATCH_SIZE = 3;    // calls per refill — run one at a time to avoid OOM

const pool = {
  winner: /** @type {string[]} */ ([]),
  loser:  /** @type {string[]} */ ([]),
};

let refilling = false;

// Static fallbacks used only when pool is completely empty (should never happen in prod)
const FALLBACK_WINNER = [
  "Called it. The K/D speaks for itself. Next?",
  "Every move had a reason. They were reacting, I was deciding — that gap doesn't close in one match.",
  "It was never close in my head. The scoreboard just caught up with how I felt from the first rotation.",
  "Confidence isn't about not making mistakes. It's about fixing them before they cost you. Tonight I did that.",
  "I don't celebrate after wins. I close the tab, make a note, and move on. That's what consistency looks like.",
];

const FALLBACK_LOSER = [
  "Caught me off guard. Won't happen twice.",
  "A loss only hurts if you learn nothing from it. I already know exactly what broke.",
  "I didn't lose because I was outworked. I was a step behind — and I felt it. That feeling is a gift.",
  "They played a clean match. I respect it. But respect and revenge aren't opposites.",
  "Not tonight. But I've been here before, and the next chapter looks nothing like this one.",
];

/**
 * Single generation call — returns 5 winner lines + 5 loser lines.
 * Uses generic player names so lines work for any match.
 */
async function generateBatch() {
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      player1: { name: 'Player' },
      player2: { name: 'Opponent' },
      context: 'competitive PvP match just ended',
    }),
  });

  if (!res.ok) throw new Error(`Worker responded ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error('Worker returned success:false');

  return {
    winner: /** @type {string[]} */ (data.player1),
    loser:  /** @type {string[]} */ (data.player2),
  };
}

/**
 * Fires REFILL_BATCH_SIZE parallel generation calls and pushes results into pool.
 * Safe to call concurrently — guarded by `refilling` flag.
 */
async function refill() {
  if (refilling) return;
  refilling = true;

  console.log(`[trash-pool] refilling — winner: ${pool.winner.length}, loser: ${pool.loser.length}`);

  try {
    let added = 0;
    for (let i = 0; i < REFILL_BATCH_SIZE; i++) {
      try {
        const result = await generateBatch();
        pool.winner.push(...result.winner);
        pool.loser.push(...result.loser);
        added++;
      } catch (e) {
        console.warn('[trash-pool] batch failed:', e?.message);
      }
    }

    // cap pool so memory stays bounded
    if (pool.winner.length > POOL_MAX) pool.winner = pool.winner.slice(-POOL_MAX);
    if (pool.loser.length  > POOL_MAX) pool.loser  = pool.loser.slice(-POOL_MAX);

    console.log(`[trash-pool] refill done (${added}/${REFILL_BATCH_SIZE} succeeded) — winner: ${pool.winner.length}, loser: ${pool.loser.length}`);
  } finally {
    refilling = false;
  }
}

/**
 * Pop one line from the pool for a given outcome.
 * Triggers background refill if pool is running low.
 * Falls back to static lines if pool is empty.
 *
 * @param {boolean} won
 * @returns {string}
 */
function popLine(won) {
  const line = won ? pool.winner.shift() : pool.loser.shift();

  // trigger background refill if either pool is low
  const lowest = Math.min(pool.winner.length, pool.loser.length);
  if (lowest < REFILL_THRESHOLD) {
    refill().catch((e) => console.warn('[trash-pool] refill error:', e.message));
  }

  if (line) return line;

  // fallback — should only hit this if server just started and pool isn't ready yet
  const fallback = won ? FALLBACK_WINNER : FALLBACK_LOSER;
  return fallback[Math.floor(Math.random() * fallback.length)];
}

/**
 * Call once at server startup to warm the pool before any traffic arrives.
 */
async function warmUp() {
  console.log('[trash-pool] warming up...');
  await refill();
}

module.exports = { popLine, warmUp, pool };
