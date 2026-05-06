// controllers/newDBController.js
const mongoose = require('mongoose');
const PlayerProfile = require('../models/PlayerProfile');
const WarzoneNameWallet = require('../models/nameWallet');

const EVENT_DB_URI =
  process.env.EVENT_DB_URI ||
  process.env.NEW_MONGO_URI ||
  process.env.NEW_DB_URI;
const EVENT_DB_NAME =
  process.env.EVENT_DB_NAME ||
  process.env.NEW_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  'new-warzone';

let newDbConn;
let AltProfile;
let AltNameWallet;
const PERF_SLOW_STEP_MS = Number(process.env.API_SLOW_STEP_MS || 500);
const PERF_LOGS_ENABLED =
  String(process.env.API_PERF_LOGS ?? 'true').trim().toLowerCase() !== 'false';

function createPerfLogger(scope, meta = {}) {
  const start = process.hrtime.bigint();
  let last = start;

  const log = (phase, durationMs, extra = {}) => {
    if (!PERF_LOGS_ENABLED) return;
    const payload = {
      scope,
      phase,
      durationMs: Number(durationMs.toFixed(2)),
      ...meta,
      ...extra,
    };
    if (durationMs >= PERF_SLOW_STEP_MS) {
      console.warn('[perf][slow]', payload);
    } else {
      console.log('[perf]', payload);
    }
  };

  return {
    step(phase, extra = {}) {
      const now = process.hrtime.bigint();
      const durationMs = Number(now - last) / 1e6;
      last = now;
      log(phase, durationMs, extra);
    },
    done(extra = {}) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      log('total', durationMs, extra);
    },
  };
}

async function getAltModels() {
  const perf = createPerfLogger('getAltModels');
  if (AltProfile && AltNameWallet) return { AltProfile, AltNameWallet };

  if (!newDbConn) {
    if (!EVENT_DB_URI) {
      throw new Error('EVENT_DB_URI is not configured');
    }

    newDbConn = mongoose.createConnection(EVENT_DB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      dbName: EVENT_DB_NAME,
    });
    newDbConn.on('connected', () => console.log('[newDB] connected'));
    newDbConn.on('error', (err) => console.error('[newDB] connection error:', err));
    await newDbConn.asPromise();
    perf.step('connect_alt_db');
  }

  // Reuse existing schemas on this separate connection
  AltProfile = newDbConn.model('WarzonePlayerProfile', PlayerProfile.schema);
  AltNameWallet = newDbConn.model('WarzoneNameWallet', WarzoneNameWallet.schema);
  perf.step('init_models');
  perf.done();

  return { AltProfile, AltNameWallet };
}

// GET all entries from the specific DB (no limit)
exports.getSpecificDBLeaderboard = async (req, res) => {
  const perf = createPerfLogger('getSpecificDBLeaderboard');
  try {
    const { AltProfile, AltNameWallet } = await getAltModels();
    perf.step('getAltModels');
    const walletAddress = String(req.query.walletAddress || '').trim();

    const docs = await AltProfile
      .find()
      .sort({ 'PlayerResources.coin': -1 })
      .limit(100); // top 100 entries
    perf.step('find_profiles');
    const walletAddresses = docs.map(d => d.walletAddress);

    // Optional: attach names if present in the same DB
    const nameDocs = await AltNameWallet.find({ walletAddress: { $in: walletAddresses } });
    perf.step('find_names', { walletCount: walletAddresses.length });
    const nameMap = Object.fromEntries(nameDocs.map(n => [n.walletAddress, n.name]));

    const data = docs.map(d => {
      const obj = d.toObject(); // apply schema getters/decoders
      return {
        ...obj,
        name: nameMap[obj.walletAddress] || null,
      };
    });

    let profile = null;
    if (walletAddress) {
      const walletLower = walletAddress.toLowerCase();
      profile = data.find((item) => String(item.walletAddress || '').toLowerCase() === walletLower) || null;
    }

    perf.step('map_response');
    perf.done({ count: data.length, hasProfile: Boolean(profile) });
    res.json({ success: true, count: data.length, data, profile });
  } catch (err) {
    console.error('getSpecificDBLeaderboard error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch data from specific DB' });
  }
};

// Optional: merged result across current default DB + the specific DB
exports.getMergedLeaderboard = async (req, res) => {
  const perf = createPerfLogger('getMergedLeaderboard');
  try {
    const { AltProfile } = await getAltModels();
    perf.step('getAltModels');
    const [currentDocs, altDocs] = await Promise.all([
      // Default connection model (current DB)
      PlayerProfile.find(),
      // Alt connection model (specific DB)
      AltProfile.find(),
    ]);
    perf.step('find_current_and_alt', {
      currentCount: currentDocs.length,
      altCount: altDocs.length,
    });

    // Merge by walletAddress (last in wins)
    const byWallet = new Map();
    for (const d of [...currentDocs, ...altDocs]) {
      const obj = d.toObject();
      byWallet.set(obj.walletAddress, obj);
    }

    const data = Array.from(byWallet.values());
    perf.step('merge_maps');
    perf.done({ count: data.length });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('getMergedLeaderboard error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch merged data' });
  }
};
