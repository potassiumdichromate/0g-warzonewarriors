const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
// Ensure env is loaded before importing modules that read it
dotenv.config();
const profileRoutes = require('./routes/profileRoutes');
const intraverseTestRoutes = require('./routes/intraverseTestRoutes');
const app = express();
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 2000);
const SLOW_MONGO_MS = Number(process.env.SLOW_MONGO_MS || 200);
const ENABLE_MONGOOSE_DEBUG =
  String(process.env.MONGOOSE_DEBUG_LOGS || '').trim().toLowerCase() === 'true';

// Trust reverse proxy headers so req.ip resolves the real client IP.
// Default is 1 hop (common with Nginx/Cloudflare -> Node).
const trustProxyEnv = String(process.env.TRUST_PROXY ?? '1').trim().toLowerCase();
if (trustProxyEnv === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyEnv === 'false') {
  app.set('trust proxy', false);
} else if (!Number.isNaN(Number(trustProxyEnv))) {
  app.set('trust proxy', Number(trustProxyEnv));
} else {
  app.set('trust proxy', trustProxyEnv);
}

// ── Chain config summary at startup ──────────────────────────────────────────
//
//  Somnia chain  — IAP contract + game registration (registerUser, startGameFor)
//  0G chain      — PlayerSaveAnchor contract (rootHash anchoring only)
//  0G Storage    — binary player save files
//  0G DA         — leaderboard + save commitments
//  0G Compute    — TEE anti-cheat (optional)
//
const ZG_ENABLED = process.env.ZG_ENABLED !== 'false';
const chainSummary = {
  // Somnia — unchanged contracts
  'Somnia RPC':           process.env.SOMNIA_RPC_URL   || 'https://api.infra.mainnet.somnia.network',
  'Game Contract':        process.env.GAME_CONTRACT_ADDRESS || '(NOT SET)',
  'IAP Contract':         process.env.IAP_CONTRACT_ADDRESS  || '(NOT SET)',
  // 0G chain — root hash anchor only
  '0G Chain RPC':         process.env.ZG_RPC_URL        || 'https://evmrpc.0g.ai',
  '0G Anchor Contract':   process.env.ZG_ANCHOR_CONTRACT_ADDRESS || '(NOT SET — run: node scripts/deployAnchor.js)',
  '0G Wallet Key':        process.env.ZG_PRIVATE_KEY    ? '*** SET ***' : '(NOT SET)',
  // 0G Storage
  '0G Storage Indexer':   process.env.ZG_INDEXER_RPC    || 'https://indexer-storage-turbo.0g.ai',
  // 0G DA
  '0G DA Disperser':      process.env.ZG_DA_DISPERSER   || 'disperser-testnet.0g.ai:51001',
  // 0G Compute
  '0G Compute':           process.env.ZG_COMPUTE_API_KEY ? '*** SET ***' : '(optional — not set)',
  '0G Stack Enabled':     String(ZG_ENABLED),
};
console.log('[chain] Dual-chain config:');
Object.entries(chainSummary).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));

const allowedOrigins = [
  'https://www.warzonewarriors.xyz',
  'https://warzonewarriors.xyz',
  'http://www.warzonewarriors.xyz',
  'http://warzonewarriors.xyz',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5174',
  'https://warzonewarrior.vercel.app',
  'https://warzonewarrior-chinese.vercel.app',
  'https://magical-truffle-9ecd00.netlify.app',
  'https://warzone-test.netlify.app',
  'https://cn.warzonewarriors.xyz',
  'https://warzone-admin.vercel.app',
  'https://pub-2c48e58780b648b7a2a77316f7b0aa2c.r2.dev'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control',
    'pragma',
    'expires',
    'if-modified-since',
    'X-HTTP-Method-Override',
    // 0G binary save headers
    'X-Wallet-Address',
    'X-Save-Index',
    'X-Root-Hash',
  ],
  exposedHeaders: [
    // 0G binary load response headers (read by Unity)
    'X-Root-Hash',
    'X-Save-Index',
    'X-Da-Status',
    'X-Checksum-Sha256',
  ],
  credentials: true,
  optionsSuccessStatus: 200
};


app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request latency logging to identify slow APIs
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
    };
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn('[http][slow]', payload);
    } else {
      console.log('[http]', payload);
    }
  });
  next();
});

app.use('/warzone/intraverse', intraverseTestRoutes);
app.use('/warzone', profileRoutes);


// Routes

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// DB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  dbName: process.env.MONGO_DB_NAME || 'new-warzone',
  monitorCommands: ENABLE_MONGOOSE_DEBUG,
}).then(() => {
  console.log('MongoDB connected successfully');

  // Optional DB command logging with real durations.
  if (ENABLE_MONGOOSE_DEBUG) {
    const commandStartTimes = new Map();
    const client = mongoose.connection.getClient();

    client.on('commandStarted', (event) => {
      commandStartTimes.set(event.requestId, process.hrtime.bigint());
    });

    client.on('commandSucceeded', (event) => {
      const startedAt = commandStartTimes.get(event.requestId);
      commandStartTimes.delete(event.requestId);
      if (!startedAt) return;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const payload = {
        commandName: event.commandName,
        database: event.databaseName,
        durationMs: Number(durationMs.toFixed(2)),
      };

      if (durationMs >= SLOW_MONGO_MS) {
        console.warn('[mongo][slow]', payload);
      } else {
        console.log('[mongo]', payload);
      }
    });

    client.on('commandFailed', (event) => {
      const startedAt = commandStartTimes.get(event.requestId);
      commandStartTimes.delete(event.requestId);
      const durationMs = startedAt
        ? Number(process.hrtime.bigint() - startedAt) / 1e6
        : undefined;
      console.error('[mongo][failed]', {
        commandName: event.commandName,
        database: event.databaseName,
        durationMs: durationMs != null ? Number(durationMs.toFixed(2)) : null,
        failure: event.failure,
      });
    });

    console.log('Mongo command timing logs enabled (MONGOOSE_DEBUG_LOGS=true)');
  }
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3300;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  const { warmUp } = require('./utils/trashTalkPool');
  warmUp().catch((e) => console.warn('[trash-pool] warm-up failed:', e.message));
});
