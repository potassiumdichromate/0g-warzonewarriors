// Converts Warzone game state / action objects to fixed-size float vectors
// for the behavioral-cloning neural network (input: 17 floats, output: 5 floats).

const MAX_ENEMIES = 5;

/**
 * state → Float32Array(17)
 *   [0-3]   posX, posY, velX, velY
 *   [4-6]   facingRight (0|1), isGrounded (0|1), hpPercent (0..1)
 *   [7-16]  up to 5 enemies × (relX, relY)
 */
function encodeState(state) {
  const v = new Float32Array(17);
  v[0] = state.posX      || 0;
  v[1] = state.posY      || 0;
  v[2] = state.velX      || 0;
  v[3] = state.velY      || 0;
  v[4] = state.facingRight ? 1 : 0;
  v[5] = state.isGrounded  ? 1 : 0;
  v[6] = Math.max(0, Math.min(1, state.hpPercent || 0));

  const enemies = (state.enemies || []).slice(0, MAX_ENEMIES);
  for (let i = 0; i < MAX_ENEMIES; i++) {
    const e = enemies[i];
    v[7 + i * 2]     = e ? (e.relX || 0) : 0;
    v[7 + i * 2 + 1] = e ? (e.relY || 0) : 0;
  }
  return v;
}

/**
 * action → Float32Array(5)
 *   [0] horizontal  (-1..1)
 *   [1] vertical    (-1..1)
 *   [2] jump        (0|1)
 *   [3] shoot       (0|1)
 *   [4] grenade     (0|1)
 */
function encodeAction(action) {
  const v = new Float32Array(5);
  v[0] = Math.max(-1, Math.min(1, action.horizontal || 0));
  v[1] = Math.max(-1, Math.min(1, action.vertical   || 0));
  v[2] = action.jump    ? 1 : 0;
  v[3] = action.shoot   ? 1 : 0;
  v[4] = action.grenade ? 1 : 0;
  return v;
}

/** Float32Array(5) → action object */
function decodeAction(output) {
  return {
    horizontal: Math.max(-1, Math.min(1, output[0])),
    vertical:   Math.max(-1, Math.min(1, output[1])),
    jump:    output[2] > 0.5,
    shoot:   output[3] > 0.5,
    grenade: output[4] > 0.5
  };
}

module.exports = { encodeState, encodeAction, decodeAction };
