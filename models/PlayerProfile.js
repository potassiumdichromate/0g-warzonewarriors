// // models/PlayerProfile.js
// const mongoose = require('mongoose');
// const { Schema } = mongoose;

// /* -------- inventories -------- */
// const GunSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   ammo: { type: Number, default: 0 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// const GrenadeSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   quantity: { type: Number, default: 0 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// const MeleeSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// /* -------- ONLY this sub-schema uses a custom typeKey so a field named "type" is allowed -------- */
// const DailyQuestSchema = new Schema({
//   type:      { $type: Number, required: true, min: 0 },
//   progress:  { $type: Number, required: true, min: 0 },
//   isClaimed: { $type: Boolean, required: true }
// }, { _id: false, typeKey: '$type' });

// /* -------- main schema (keep default "type") -------- */
// const PlayerProfileSchema = new Schema({
//   walletAddress: { type: String, required: true, unique: true, index: true },

//   PlayerProfile: {
//     level: { type: Number, default: 1 },
//     exp:   { type: Number, default: 0 }
//   },

//   PlayerResources: {
//     coin: { type: Number, default: 1000 },
//     gem:  { type: Number, default: 0 },
//     stamina: { type: Number, default: 0 },
//     medal:   { type: Number, default: 0 },
//     tournamentTicket: { type: Number, default: 0 }
//   },

//   // Map<string, {id, level}>
//   PlayerRambos: { type: Map, of: new Schema({ id: Number, level: Number }, { _id: false }), default: {} },

//   // Map<string, Map<string, number>>
//   PlayerRamboSkills: { type: Map, of: { type: Map, of: Number }, default: {} },

//   // inventories as Map<string, subdoc>
//   PlayerGuns:        { type: Map, of: GunSchema,     default: {} },
//   PlayerGrenades:    { type: Map, of: GrenadeSchema, default: {} },
//   PlayerMeleeWeapons:{ type: Map, of: MeleeSchema,   default: {} },

//   PlayerCampaignProgress:       { type: Map, of: Schema.Types.Mixed, default: {} },
//   PlayerCampaignStageProgress:  { type: Map, of: [Boolean],           default: {} },
//   PlayerCampaignRewardProgress: { type: Map, of: Schema.Types.Mixed,  default: {} },

//   PlayerBoosters: { type: Map, of: Number, default: {} },

//   PlayerSelectingBooster: { type: [Number], default: [] },

//   // IMPORTANT: parent uses normal "type", inner schema uses $type – so this is fine
//   PlayerDailyQuestData: { type: [DailyQuestSchema], default: [] },

//   PlayerAchievementData: { type: Map, of: Schema.Types.Mixed, default: {} },
//   PlayerTutorialData: {
//     Character: { type: Boolean, default: false },
//     Booster:   { type: Boolean, default: false },
//     ActionInGame: { type: Boolean, default: false }
//   }
// }, {
//   timestamps: true,
//   minimize: false,
//   versionKey: false
// });

// module.exports = mongoose.model('WarzonePlayerProfile', PlayerProfileSchema);


// models/PlayerProfile.js


//New

// models/PlayerProfile.js
// const mongoose = require('mongoose');
// const { Schema } = mongoose;

// /* ---------- dot-key helpers for PlayerCampaignProgress ---------- */
// const DOT_ENC = '__dot__';

// function encodeCampaignProgressObj(input) {
//   if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
//   const out = {};
//   for (const [k, v] of Object.entries(input)) {
//     out[String(k).replace(/\./g, DOT_ENC)] = v;
//   }
//   return out;
// }

// function decodeCampaignProgressObj(obj) {
//   if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
//   const out = {};
//   for (const [k, v] of Object.entries(obj)) {
//     out[String(k).replace(new RegExp(DOT_ENC, 'g'), '.')] = v;
//   }
//   return out;
// }

// /* ---------------- inventories ---------------- */
// const GunSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   ammo: { type: Number, default: 0 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// const GrenadeSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   quantity: { type: Number, default: 0 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// const MeleeSchema = new Schema({
//   id: { type: Number, required: true },
//   level: { type: Number, default: 1 },
//   isNew: { type: Boolean, default: false }
// }, { _id: false });

// /* ---- ONLY this sub-schema needs a literal field named "type" ---- */
// const DailyQuestSchema = new Schema({
//   type:      { $type: Number, required: true, min: 0 },
//   progress:  { $type: Number, required: true, min: 0 },
//   isClaimed: { $type: Boolean, required: true }
// }, { _id: false, typeKey: '$type' });

// /* ---------------- main schema ---------------- */
// const PlayerProfileSchema = new Schema({
//   walletAddress: { type: String, required: true, unique: true, index: true },

//   PlayerProfile: {
//     level: { type: Number, default: 1 },
//     exp:   { type: Number, default: 0 }
//   },

//   PlayerResources: {
//     coin: { type: Number, default: 1000 },
//     gem:  { type: Number, default: 0 },
//     stamina: { type: Number, default: 0 },
//     medal:   { type: Number, default: 0 },
//     tournamentTicket: { type: Number, default: 0 }
//   },

//   // Map<string, {id, level}>
//   PlayerRambos: { type: Map, of: new Schema({ id: Number, level: Number }, { _id: false }), default: {} },

//   // Map<string, Map<string, number>>
//   PlayerRamboSkills: { type: Map, of: { type: Map, of: Number }, default: {} },

//   // inventories as Map<string, subdoc>
//   PlayerGuns:        { type: Map, of: GunSchema,     default: {} },
//   PlayerGrenades:    { type: Map, of: GrenadeSchema, default: {} },
//   PlayerMeleeWeapons:{ type: Map, of: MeleeSchema,   default: {} },

//   // Campaign progress: accept payload with dotted keys, store encoded, return decoded
//   PlayerCampaignProgress: {
//     type: Schema.Types.Mixed,
//     default: {},
//     set: encodeCampaignProgressObj,
//     get: decodeCampaignProgressObj
//   },

//   PlayerCampaignStageProgress:  { type: Map, of: [Boolean],           default: {} },
//   PlayerCampaignRewardProgress: { type: Map, of: Schema.Types.Mixed,  default: {} },

//   PlayerBoosters: { type: Map, of: Number, default: {} },

//   PlayerSelectingBooster: { type: [Number], default: [] },

//   // Daily quests keep "type" as a data field via sub-schema typeKey
//   PlayerDailyQuestData: { type: [DailyQuestSchema], default: [] },

//   PlayerAchievementData: { type: Map, of: Schema.Types.Mixed, default: {} },
//   PlayerTutorialData: {
//     Character: { type: Boolean, default: false },
//     Booster:   { type: Boolean, default: false },
//     ActionInGame: { type: Boolean, default: false }
//   }
// }, {
//   timestamps: true,
//   minimize: false,
//   versionKey: false,
//   toJSON:   { getters: true },   // ensure decode getter runs in API responses
//   toObject: { getters: true }
// });

// models/PlayerProfile.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* ---------------- dot-key helpers (for keys like "1.1") ---------------- */
const DOT_ENC = '__dot__';

// Convert Map or plain object -> clean plain object, ignoring Mongoose internals
function toPlainObject(input) {
  if (!input) return {};
  // Mongoose Map or native Map
  if (input instanceof Map) {
    const out = {};
    for (const [k, v] of input.entries()) out[String(k)] = v;
    return out;
  }
  // Plain object
  if (typeof input === 'object' && !Array.isArray(input)) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith('$__')) continue; // strip mongoose internals
      out[k] = v;
    }
    return out;
  }
  return {};
}

function encodeObjKeys(input) {
  const obj = toPlainObject(input);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[String(k).replace(/\./g, DOT_ENC)] = v;
  }
  return out;
}
function decodeObjKeys(obj) {
  const plain = toPlainObject(obj);
  const out = {};
  for (const [k, v] of Object.entries(plain)) {
    out[String(k).replace(new RegExp(DOT_ENC, 'g'), '.')] = v;
  }
  return out;
}

/* ---- Legacy CampaignProgress (object-of-objects) ---- */
function encodeCampaignProgressObj(input) { return encodeObjKeys(input); }
function decodeCampaignProgressObj(obj)   { return decodeObjKeys(obj); }

/* ---- StageProgress (Map<string, [bool,bool,bool]>) ---- */
function normalizeStageArray(val) {
  if (!Array.isArray(val)) return [false, false, false];
  return [Boolean(val[0]), Boolean(val[1]), Boolean(val[2])];
}
function encodeStageProgressObj(input) {
  const encoded = encodeObjKeys(input);     // dot-safe + plainified
  for (const k of Object.keys(encoded)) {
    encoded[k] = normalizeStageArray(encoded[k]);
  }
  return encoded;
}
function decodeStageProgressObj(obj) {
  const decoded = decodeObjKeys(obj);       // restore dots + plainified
  for (const k of Object.keys(decoded)) {
    decoded[k] = normalizeStageArray(decoded[k]);
  }
  return decoded;
}

/* ---------------- inventories ---------------- */
const GunSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  ammo: { type: Number, default: 0 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const GrenadeSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  quantity: { type: Number, default: 0 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const MeleeSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

/* ---- daily quest with literal "type" ---- */
const DailyQuestSchema = new Schema({
  type:      { $type: Number, required: true, min: 0 },
  progress:  { $type: Number, required: true, min: 0 },
  isClaimed: { $type: Boolean, required: true }
}, { _id: false, typeKey: '$type' });

/* ---------------- main schema ---------------- */
const PlayerProfileSchema = new Schema({
  walletAddress: { type: String, required: true, unique: true, index: true },

  Intraverse: {
    userId: { type: String, default: '' },
    userName: { type: String, default: '' },
  },

  PlayerProfile: {
    level: { type: Number, default: 1 },
    exp:   { type: Number, default: 0 },
    totalTimePlayed: { type: Number, default: 0}
  },

  PlayerResources: {
    coin: { type: Number, default: 1000 },
    gem:  { type: Number, default: 0 },
    stamina: { type: Number, default: 0 },
    medal:   { type: Number, default: 0 },
    tournamentTicket: { type: Number, default: 0 }
  },

  PlayerRambos: { type: Map, of: new Schema({ id: Number, level: Number }, { _id: false }), default: {} },
  PlayerRamboSkills: { type: Map, of: { type: Map, of: Number }, default: {} },

  PlayerGuns:        { type: Map, of: GunSchema,     default: {} },
  PlayerGrenades:    { type: Map, of: GrenadeSchema, default: {} },
  PlayerMeleeWeapons:{ type: Map, of: MeleeSchema,   default: {} },

  // Legacy campaign progress (kept empty but dot-safe)
  PlayerCampaignProgress: {
    type: Schema.Types.Mixed,
    default: {},
    set: encodeCampaignProgressObj,
    get: decodeCampaignProgressObj
  },

  // Actual stage progress (dot-safe keys + fixed-size boolean arrays)
  // Actual stage progress (dot-safe keys + fixed-size boolean arrays)
PlayerCampaignStageProgress: {
  type: Schema.Types.Mixed,
  default: {},
  set: encodeStageProgressObj,  // accepts plain object or Map; encodes dots + normalizes arrays
  get: decodeStageProgressObj
},

  PlayerCampaignRewardProgress: { type: Map, of: Schema.Types.Mixed, default: {} },

  PlayerBoosters: { type: Map, of: Number, default: {} },

  PlayerSelectingBooster: { type: [Number], default: [] },

  PlayerDailyQuestData: { type: [DailyQuestSchema], default: [] },

  PlayerAchievementData: { type: Map, of: Schema.Types.Mixed, default: {} },

  PlayerTutorialData: {
    Character: { type: Boolean, default: false },
    Booster:   { type: Boolean, default: false },
    ActionInGame: { type: Boolean, default: false }
  }

}, {
  timestamps: true,
  minimize: false,                 // keep empty {}
  versionKey: false,
  toJSON:   { getters: true },     // decode getters in API responses
  toObject: { getters: true }
});

// Supports leaderboard queries sorting by coin balance.
PlayerProfileSchema.index({ 'PlayerResources.coin': -1 });

module.exports = mongoose.models.WarzonePlayerProfile
  || mongoose.model('WarzonePlayerProfile', PlayerProfileSchema);
