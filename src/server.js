require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const connectDB = require("./config/db");

connectDB();

const app = express();

const allowedOrigins = [
  "https://warzonewarriors.xyz",
  "https://0g.warzonewarriors.xyz",
  "https://api.warzonewarriors.xyz",
  "http://localhost:3000",
  "http://localhost:5173",
  "https://pub-2c48e58780b648b7a2a77316f7b0aa2c.r2.dev/0gai/WarzoneV2/index.html",
  "https://pub-2c48e58780b648b7a2a77316f7b0aa2c.r2.dev",
  "https://0g-testfrontend.vercel.app"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Wallet-Address",
    "X-Save-Index",
    "X-Root-Hash"
  ],
  exposedHeaders: [
    "X-Root-Hash",
    "X-Save-Index",
    "X-Da-Status",
    "X-Checksum-Sha256"
  ]
}));

app.use(express.json({ limit: "1mb" }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",     require("./routes/authRoutes"));
app.use("/0g",       require("./routes/zgUXRoutes"));
app.use("/warzone",  require("./routes/crossGameRewardRoutes"));
app.use("/player",   require("./routes/profileRoutes"));
app.use("/player",   require("./routes/crossGameRewardRoutes"));
app.use("/player",   require("./routes/player.routes"));
app.use("/behavior", require("./routes/behaviorRoutes"));
app.use("/ai",       require("./routes/aiRoutes"));

// ── Utility endpoints ─────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("WarzoneWarrior 0G Backend Running"));

app.get("/blockchain-info", (_, res) => {
  const sessionService     = require("./blockchain/sessionService");
  const leaderboardService = require("./blockchain/leaderboardService");

  res.json({
    status: "online",
    services: {
      sessions:    { ready: sessionService.isReady(),     contractInfo: sessionService.getContractInfo() },
      leaderboard: { ready: leaderboardService.isReady(), contractInfo: leaderboardService.getContractInfo() }
    },
    network: {
      name:    "0G Mainnet",
      chainId: parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661"),
      rpcUrl:  process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai",
      explorer: "https://chainscan.0g.ai"
    }
  });
});

app.get("/stats", async (_, res) => {
  try {
    const PlayerProfile    = require("./models/PlayerProfile");
    const PlayerSaveRecord = require("./models/PlayerSaveRecord");
    const sessionService     = require("./blockchain/sessionService");
    const leaderboardService = require("./blockchain/leaderboardService");

    const [totalSessions, totalSnapshots, totalPlayers, totalSaves] = await Promise.all([
      sessionService.getTotalSessions().catch(() => 0),
      leaderboardService.getTotalSnapshots().catch(() => 0),
      PlayerProfile.countDocuments(),
      PlayerSaveRecord.countDocuments()
    ]);

    res.json({
      totalPlayers,
      totalSessions,
      totalLeaderboardSnapshots: totalSnapshots,
      totalDecentralizedSaves:   totalSaves,
      contracts: {
        sessions:         process.env.SESSION_CONTRACT_ADDRESS,
        leaderboard:      process.env.LEADERBOARD_CONTRACT_ADDRESS,
        playerSaveAnchor: process.env.ZG_ANCHOR_CONTRACT_ADDRESS
      }
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/contracts", (_, res) => {
  res.json({
    network: "0G Mainnet",
    chainId: 16661,
    explorer: "https://chainscan.0g.ai",
    contracts: {
      sessionTracker: {
        address: process.env.SESSION_CONTRACT_ADDRESS,
        purpose: "Tracks player gaming sessions (0G Mainnet chainId 16661)"
      },
      leaderboardTracker: {
        address: process.env.LEADERBOARD_CONTRACT_ADDRESS,
        purpose: "Tracks leaderboard snapshots (0G Mainnet chainId 16661)"
      },
      playerSaveAnchor: {
        address: process.env.ZG_ANCHOR_CONTRACT_ADDRESS,
        purpose: "Anchors player save root hashes (0G Mainnet chainId 16661)"
      }
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║      🎮  WarzoneWarrior 0G Backend Server  🎮        ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("");
  console.log("🔗 0G Infrastructure:");
  console.log(`   ⛓️  Mainnet RPC:  ${process.env.OG_MAINNET_RPC         || "https://evmrpc.0g.ai (default)"}`);
  console.log(`   🔢 Chain ID:     ${process.env.OG_MAINNET_CHAIN_ID    || "16661 (mainnet)"}`);
  console.log(`   📦 Storage:      ${process.env.ZG_INDEXER_RPC         || "❌ ZG_INDEXER_RPC not set"}`);
  console.log(`   📡 DA Disperser: ${process.env.ZG_DA_DISPERSER        || "❌ ZG_DA_DISPERSER not set"} (testnet)`);
  console.log(`   📜 Anchor:       ${process.env.ZG_ANCHOR_CONTRACT_ADDRESS || "❌ ZG_ANCHOR_CONTRACT_ADDRESS not set"}`);
  console.log(`   🔑 Operator Key: ${process.env.ZG_PRIVATE_KEY ? "✅ Set" : "❌ ZG_PRIVATE_KEY not set"}`);
  console.log(`   🧠 Compute:      ${process.env.ZG_COMPUTE_API_KEY     ? "✅ Set" : "⚠️  Skipped (ZG_COMPUTE_API_KEY not set)"}`);
  console.log(`   🚦 Enabled:      ${process.env.ZG_ENABLED !== "false" ? "✅ true" : "⚠️  false (dev mode)"}`);
  console.log("");
  console.log("📡 Save / Load:");
  console.log(`   POST   /player/save/binary`);
  console.log(`   GET    /player/load/binary`);
  console.log(`   GET    /player/save/metadata?wallet=0x...`);
  console.log(`   GET    /player/verify?wallet=0x...`);
  console.log(`   GET    /player/leaderboard/decentralized`);
  console.log("");
  console.log("🖥️  Player Profile:");
  console.log(`   GET    /player/profile`);
  console.log(`   PATCH  /player/profile`);
  console.log(`   GET    /player/profile/:wallet   (public)`);
  console.log(`   GET    /player/leaderboard        (public)`);
  console.log("");
  console.log("🖥️  Dashboard / UX:");
  console.log(`   GET    /0g/dashboard              (auth) — trust score, pipeline status, recent activity`);
  console.log(`   GET    /0g/activity               (auth) — paginated event feed`);
  console.log(`   GET    /0g/badge                  (auth) — BRONZE/SILVER/GOLD/PLATINUM`);
  console.log(`   GET    /0g/player/history         (auth) — paginated save history + pipeline per save`);
  console.log(`   GET    /0g/stats                         — global player/save/AI counts`);
  console.log(`   GET    /0g/saves/recent                  — latest saves across all players`);
  console.log(`   GET    /0g/compute/stats                 — anti-cheat + AI inference stats`);
  console.log(`   GET    /0g/player/overview/:wallet       — public player card (profile+trust+AI)`);
  console.log(`   GET    /0g/network                       — live 0G service health`);
  console.log(`   GET    /0g/leaderboard/verified          — verified leaderboard`);
  console.log(`   GET    /0g/proof/:wallet/:saveIndex       — full proof certificate`);
  console.log(`   GET    /0g/explorer/:wallet              — wallet explorer`);
  console.log("");
  console.log("🧠 Behavioral AI (all data on 0G Storage):");
  console.log(`   POST   /behavior/upload            (upload sample batch → 0G Storage)`);
  console.log(`   GET    /behavior/status/:wallet    (training status + 0G model link)`);
  console.log(`   POST   /behavior/retrain/:wallet   (force re-train)`);
  console.log(`   POST   /ai/predict                 (TF.js → 0G Compute fallback → neutral)`);
  console.log(`   POST   /ai/strategy                (0G Compute TEE-verified, Arena proof)`);
  console.log(`   🤖 AI model:   ${process.env.ZG_AI_MODEL        || "0GM-1.0-35B-A3B (default)"}`);
  console.log(`   🧪 Enrichment: ${process.env.AI_ENRICH === "true" ? "✅ enabled" : "⚠️  disabled (set AI_ENRICH=true)"}`);
  console.log("");
  console.log("✅ Server ready!");
  console.log("═══════════════════════════════════════════════════════");
});
