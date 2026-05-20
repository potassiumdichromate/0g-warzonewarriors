# WarzoneWarrior — 0G Backend

Warzone Warriors is an AI-native arcade shooter where player progression becomes verifiable, persistent, and portable through decentralized infrastructure.

- Players truly own their progression.
- Saves cannot be silently manipulated.
- AI opponents evolve from real player behavior.

This backend handles everything the Unity game needs to persist state, verify saves, and run AI opponents — all routed through 0G's decentralized infrastructure instead of a centralized cloud. Players sign in with their Ethereum wallet, saves are stored on 0G's decentralized storage network, root hashes get anchored on-chain so saves can't be tampered with, and behavioral AI models are trained from gameplay recordings and stored the same way.

---

## What's in here

```
warzone-backend-0g/
├── src/
│   ├── server.js              — Express app, CORS, route mounting
│   ├── config/db.js           — MongoDB connection
│   ├── middleware/auth.js     — JWT verification middleware
│   ├── models/                — Mongoose schemas
│   │   ├── PlayerProfile.js   — Full WarzonePlayerProfile (guns, rambos, campaign, etc.)
│   │   ├── PlayerSaveRecord.js — Per-save metadata (rootHash, DA status, on-chain anchor)
│   │   ├── AuthNonce.js       — SIWE nonce store (5-min TTL)
│   │   └── AIRecord.js        — Behavioral AI training metadata
│   ├── controllers/           — Route handlers
│   ├── routes/                — Express routers
│   ├── services/              — 0G network integrations
│   │   ├── ZeroGStorage.js    — Upload/download files via 0G Storage SDK
│   │   ├── ZeroGChain.js      — On-chain save anchoring (PlayerSaveAnchor contract)
│   │   ├── ZeroGDA.js         — Data Availability via gRPC disperser
│   │   ├── ZeroGCompute.js    — Anti-cheat + AI predictions via 0G Compute LLM
│   │   └── BehaviorTrainer.js — Local neural inference layer + 0G Compute fallback
│   ├── blockchain/            — SessionTracker + LeaderboardTracker contracts
│   └── utils/                 — retry.js, aiEncoder.js
├── contracts/
│   └── PlayerSaveAnchor.sol   — Anti-rollback save anchor (Solidity 0.8.20)
├── scripts/
│   ├── deploy.js              — Hardhat deploy script
│   ├── transfer-ownership.mjs — Move contract ownership to new key
│   └── verify-helper.mjs      — Print constructor args for chainscan verification
└── protos/
    └── disperser.proto        — gRPC definitions for 0G DA
```

---

## Prerequisites

- Node.js 18 or later
- MongoDB (Atlas or self-hosted)
- A funded 0G Mainnet wallet (for storage uploads and on-chain anchoring)
- A 0G Compute API key — get one at [pc.0g.ai](https://pc.0g.ai) (optional, enables anti-cheat and AI)

---

## Setup

```bash
git clone <repo>
cd warzone-backend-0g
npm install --legacy-peer-deps
cp .env.example .env
```

Fill in `.env` — the required fields are:

```
MONGO_URI=mongodb+srv://...
BROWSER_JWT_SECRET=<any 32+ char random string>
ZG_PRIVATE_KEY=0x<your funded wallet private key>
```

Everything else has a working default. See `.env.example` for the full list with explanations.

### Deploy the smart contract

Before the save/load system works, you need to deploy `PlayerSaveAnchor.sol` to 0G Mainnet:

```bash
npm run deploy:anchor
```

Copy the printed address into your `.env`:

```
ZG_ANCHOR_CONTRACT_ADDRESS=0x<printed address>
```

Then start the server:

```bash
npm start        # production
npm run dev      # development with hot-reload
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB connection string |
| `BROWSER_JWT_SECRET` | Yes | JWT signing secret (32+ chars) |
| `ZG_PRIVATE_KEY` | Yes | Backend wallet key — pays for 0G Storage uploads and chain anchoring |
| `ZG_ANCHOR_CONTRACT_ADDRESS` | Yes | Address of deployed PlayerSaveAnchor |
| `OG_MAINNET_RPC` | No | 0G EVM RPC (default: `https://evmrpc.0g.ai`) |
| `ZG_INDEXER_RPC` | No | 0G Storage indexer (default: turbo indexer) |
| `ZG_DA_DISPERSER` | No | gRPC DA endpoint (default: testnet) |
| `ZG_COMPUTE_API_KEY` | No | 0G Compute API key — enables anti-cheat + AI |
| `ZG_AI_MODEL` | No | LLM for game AI (default: `0GM-1.0-35B-A3B`) |
| `AI_ENRICH` | No | Set `true` to enrich training data with synthetic samples |
| `AI_MIN_SAMPLES` | No | Samples needed before training fires (default: 500) |
| `SESSION_CONTRACT_ADDRESS` | No | SessionTracker contract address |
| `LEADERBOARD_CONTRACT_ADDRESS` | No | LeaderboardTracker contract address |
| `PORT` | No | HTTP port (default: 3001) |

---

## How authentication works

The game uses Sign-In with Ethereum (SIWE). There's no username/password — the player's Ethereum wallet is their identity.

1. The React frontend calls `GET /auth/nonce?wallet=0x...`
2. The player signs the returned message with MetaMask or their in-game wallet
3. `POST /auth/login` verifies the signature and returns a JWT
4. The React frontend passes the JWT to Unity via URL param: `?jwt=<token>`
5. Unity stores it in `PlayerPrefs["ZGJwt"]` and sends it as `Authorization: Bearer <token>` on every API call

JWTs are valid for 7 days. They're HS256-signed with `BROWSER_JWT_SECRET`.

---

## Save / Load pipeline

When Unity calls `POST /player/save/binary`, the flow is:

1. The binary arrives (WZSV format: 4-byte magic + version byte + JSON payload)
2. Anti-rollback check — `saveIndex` must be strictly greater than the last stored value
3. MongoDB profile is updated immediately
4. HTTP 201 is returned to Unity (the game doesn't wait for the rest)
5. In the background:
   - Binary is uploaded to 0G Storage → `rootHash`
   - `rootHash` is anchored on-chain via `PlayerSaveAnchor.anchorSave()`
   - Payload is dispersed to 0G DA → polls for `FINALIZED` status
   - If `ZG_COMPUTE_API_KEY` is set, 0G Compute validates the save for suspicious patterns

The load path (`GET /player/load/binary`) just reads from MongoDB and re-serializes to WZSV.

---

## Behavioral AI

The game records player inputs during gameplay (position, velocity, enemy positions, actions taken). These are uploaded in batches to `POST /behavior/upload`. Each batch is stored as a JSON blob on 0G Storage — not in MongoDB.

Once 500 samples accumulate, local neural inference training fires automatically:

1. All sample batches are downloaded from 0G Storage
2. If `AI_ENRICH=true`, 0G Compute generates additional synthetic expert samples
3. A neural net trains on the merged dataset (17-float state → 5-float action)
4. The trained model is serialized and uploaded to 0G Storage
5. The `AIRecord` in MongoDB is updated with the model's `rootHash`

When Unity calls `POST /ai/predict`, the response comes from:
- **Local neural inference** if a trained model exists (~1ms per call)
- **0G Compute LLM** if no model has been trained yet (~200ms, TEE-verified)
- **Neutral fallback** if both are unavailable (returns all zeros, never crashes)

For Arena matches, `POST /ai/strategy` always routes through 0G Compute with TEE verification so the decision has a cryptographic proof attached.

---

## Trust score system

Each player gets a trust score (0–100) based on their save verification history:

| Badge | Score | What it means |
|---|---|---|
| BRONZE | 0–30 | Saves are uploading. Anchoring/DA in progress. |
| SILVER | 31–55 | Most saves anchored on-chain. DA finalization ongoing. |
| GOLD | 56–80 | Strong coverage — anchored + DA-finalized. |
| PLATINUM | 81–100 | Full stack — anchored, DA-finalized, and TEE-validated. |

The score weights DA finalization (40 pts), on-chain anchoring (25 pts), and TEE validation (15 pts). Reach 10+ saves for a bonus 10 pts.

---

## Smart contract verification

After deploying `PlayerSaveAnchor.sol`, run:

```bash
node scripts/verify-helper.mjs
```

This prints everything you need to paste into [chainscan.0g.ai](https://chainscan.0g.ai) for source verification: compiler settings, constructor argument ABI encoding, and the source file.

---

## Scripts

```bash
npm start                       # start server
npm run dev                     # hot-reload with nodemon
npm run compile:contracts       # compile Solidity with hardhat
npm run deploy:anchor           # deploy PlayerSaveAnchor to 0G Mainnet
npm run deploy:anchor:testnet   # deploy to 0G Newton testnet
npm run transfer-ownership      # transfer contract ownership (see script for env vars)
npm run verify-helper           # print chainscan verification instructions
```

---

## Rate limits

All routes are rate-limited per IP:

- Auth nonce: 10 requests/min
- Auth login: 5 requests/min
- Save binary: 10 requests/min
- Load binary: 30 requests/min
- Most read endpoints: 20–60 requests/min

---

## Notes

- The 0G DA layer runs on **testnet** by default (`disperser-testnet.0g.ai:51001`). Mainnet DA will be available once finalized.
- The local neural inference layer runs in pure JS mode (`@tensorflow/tfjs`) for easy deployment. If you need faster training, swap in `@tensorflow/tfjs-node` and install the native add-ons.
- MongoDB stores no raw gameplay data or model weights. Only metadata (rootHashes, statuses, player profile state).
- The `ZG_ENABLED=false` flag disables all 0G network calls for local development without any wallet configured.
