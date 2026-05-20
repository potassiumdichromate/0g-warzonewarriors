const mongoose = require("mongoose");
const { Schema } = mongoose;

const DOT_ENC = "__dot__";

function toPlainObject(input) {
  if (!input) return {};
  if (input instanceof Map) {
    const out = {};
    for (const [k, v] of input.entries()) out[String(k)] = v;
    return out;
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith("$__")) continue;
      out[k] = v;
    }
    return out;
  }
  return {};
}

function encodeObjKeys(input) {
  const obj = toPlainObject(input);
  const out = {};
  for (const [k, v] of Object.entries(obj))
    out[String(k).replace(/\./g, DOT_ENC)] = v;
  return out;
}

function decodeObjKeys(obj) {
  const plain = toPlainObject(obj);
  const out = {};
  for (const [k, v] of Object.entries(plain))
    out[String(k).replace(new RegExp(DOT_ENC, "g"), ".")] = v;
  return out;
}

function normalizeStageArray(val) {
  if (!Array.isArray(val)) return [false, false, false];
  return [Boolean(val[0]), Boolean(val[1]), Boolean(val[2])];
}

function encodeStageProgressObj(input) {
  const encoded = encodeObjKeys(input);
  for (const k of Object.keys(encoded)) encoded[k] = normalizeStageArray(encoded[k]);
  return encoded;
}

function decodeStageProgressObj(obj) {
  const decoded = decodeObjKeys(obj);
  for (const k of Object.keys(decoded)) decoded[k] = normalizeStageArray(decoded[k]);
  return decoded;
}

const GunSchema = new Schema({
  id:    { type: Number, required: true },
  level: { type: Number, default: 1 },
  ammo:  { type: Number, default: 0 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const GrenadeSchema = new Schema({
  id:       { type: Number, required: true },
  level:    { type: Number, default: 1 },
  quantity: { type: Number, default: 0 },
  isNew:    { type: Boolean, default: false }
}, { _id: false });

const MeleeSchema = new Schema({
  id:    { type: Number, required: true },
  level: { type: Number, default: 1 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const DailyQuestSchema = new Schema({
  type:      { $type: Number, required: true, min: 0 },
  progress:  { $type: Number, required: true, min: 0 },
  isClaimed: { $type: Boolean, required: true }
}, { _id: false, typeKey: "$type" });

const PlayerProfileSchema = new Schema({
  walletAddress: { type: String, required: true, unique: true, index: true },

  Intraverse: {
    userId:   { type: String, default: "" },
    userName: { type: String, default: "" },
  },

  PlayerProfile: {
    level:           { type: Number, default: 1 },
    exp:             { type: Number, default: 0 },
    totalTimePlayed: { type: Number, default: 0 }
  },

  PlayerResources: {
    coin:             { type: Number, default: 1000 },
    gem:              { type: Number, default: 0 },
    stamina:          { type: Number, default: 0 },
    medal:            { type: Number, default: 0 },
    tournamentTicket: { type: Number, default: 0 }
  },

  PlayerRambos:       { type: Map, of: new Schema({ id: Number, level: Number }, { _id: false }), default: {} },
  PlayerRamboSkills:  { type: Map, of: { type: Map, of: Number }, default: {} },
  PlayerGuns:         { type: Map, of: GunSchema,     default: {} },
  PlayerGrenades:     { type: Map, of: GrenadeSchema, default: {} },
  PlayerMeleeWeapons: { type: Map, of: MeleeSchema,   default: {} },

  PlayerCampaignProgress: {
    type: Schema.Types.Mixed,
    default: {},
    set: encodeObjKeys,
    get: decodeObjKeys
  },

  PlayerCampaignStageProgress: {
    type: Schema.Types.Mixed,
    default: {},
    set: encodeStageProgressObj,
    get: decodeStageProgressObj
  },

  PlayerCampaignRewardProgress: { type: Map, of: Schema.Types.Mixed, default: {} },
  PlayerBoosters:                { type: Map, of: Number,             default: {} },
  PlayerSelectingBooster:        { type: [Number],                    default: [] },
  PlayerDailyQuestData:          { type: [DailyQuestSchema],          default: [] },
  PlayerAchievementData:         { type: Map, of: Schema.Types.Mixed, default: {} },

  PlayerTutorialData: {
    Character:    { type: Boolean, default: false },
    Booster:      { type: Boolean, default: false },
    ActionInGame: { type: Boolean, default: false }
  }
}, {
  timestamps: true,
  minimize: false,
  versionKey: false,
  toJSON:   { getters: true },
  toObject: { getters: true }
});

PlayerProfileSchema.index({ "PlayerResources.coin": -1 });

module.exports = mongoose.models.WarzonePlayerProfile
  || mongoose.model("WarzonePlayerProfile", PlayerProfileSchema);
