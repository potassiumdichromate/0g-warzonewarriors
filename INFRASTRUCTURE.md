# Warzone Warriors — Decentralized Infrastructure

## System Overview

```
React Native Game (iframe session, JWT auth)
        │
        │  HTTPS  (Authorization: Bearer <jwt>)
        ▼
┌─────────────────────────────────────────────────────┐
│              Node.js / Express Backend               │
│                                                     │
│   POST /warzone/save/binary   ←── binary save       │
│   GET  /warzone/load/binary   ←── binary load       │
│   GET  /warzone/save/metadata                       │
│   GET  /warzone/verify                              │
│   GET  /warzone/leaderboard/decentralized           │
│   GET  /warzone/dashboard                           │
│   GET  /warzone/save/history                        │
│   GET  /warzone/save/pipeline/:rootHash             │
│   GET  /warzone/proof/:rootHash                     │
│   GET  /warzone/network/status                      │
└──────┬──────────────────────────────────────────────┘
       │
       ├──────────────────────────────────────────────▶  MongoDB
       │                                (index / pointer only — no game data)
       │
       ├── 0G Storage ──────────────────────────────▶  Binary save files
       │   (content-addressed by Merkle rootHash)       (msgpack encoded)
       │
       ├── 0G Chain EVM (chainId 16661) ───────────▶  PlayerSaveAnchor.sol
       │   (rootHash anchored on-chain per save)        (immutable proof)
       │
       ├── 0G DA ──────────────────────────────────▶  Leaderboard + commitments
       │   (BLS-signed by >2/3 DA nodes)               (finality in ~60–240s)
       │
       └── 0G Compute ─────────────────────────────▶  Anti-cheat validation
           (AI heuristic; TEE when available)           (coin delta / save patterns)
```

---

## Chain Responsibilities

Everything runs on 0G infrastructure. There is no secondary chain.

| Layer | Role | Config var |
|---|---|---|
| **0G EVM Mainnet** (chainId 16661) | `PlayerSaveAnchor.sol` — rootHash anchoring | `ZG_RPC_URL`, `ZG_ANCHOR_CONTRACT_ADDRESS`, `ZG_CHAIN_PRIVATE_KEY` |
| **0G Storage** | Binary player save files (content-addressed) | `ZG_INDEXER_RPC`, `ZG_STORAGE_PRIVATE_KEY` |
| **0G DA** | Leaderboard commitments, save proofs (BLS finality) | `ZG_DA_DISPERSER` |
| **0G Compute** | AI heuristic anti-cheat (TEE attestation when available) | `ZG_COMPUTE_API_KEY` |
| **MongoDB** | Metadata index only — pointers to 0G, never game data | `MONGO_URI` |
| **Redis** (optional) | Shared rate limiting across instances | `REDIS_URL` |

---

## 0G Stack — Product by Product

### 1. 0G Storage

Binary player saves are stored as msgpack-encoded files, content-addressed by Merkle rootHash.

**Chain:** 0G Mainnet (chainId **16661**)  
**RPC:** `https://evmrpc.0g.ai`  
**Indexer:** `https://indexer-storage-turbo.0g.ai` (with `https://indexer-storage-turbo-standard.0g.ai` as fallback)

**Upload flow:**
```
Unity sends msgpack binary
        │
        ▼
Backend: uploadBuffer(rawBuffer)
        │
        ├── Write to temp file
        ├── ZgFile.fromFilePath()
        ├── file.merkleTree() → pre-compute rootHash (reliable even on duplicate uploads)
        ├── indexer.upload(file, evmRpc, signer)
        ├── Retry up to 3× with exponential backoff on failure
        ├── Rotate indexer URL on error (turbo → turbo-standard)
        └── Returns { rootHash, txHash, size, checksum }
```

**Download flow:**
```
GET /load/binary
        │
        ▼
Backend: downloadToBuffer(rootHash)
        │
        ├── indexer.download(rootHash, tmpPath, withProof=true)
        ├── Merkle proof verified by SDK (tamper-proof)
        ├── Retry up to 3× on failure
        └── Returns raw buffer → streamed to client
```

- File: `services/ZeroGStorage.js`
- SDK: `@0gfoundation/0g-storage-ts-sdk@^1.2.9` (CommonJS build — `require()` direct, no dynamic import)
- Resilience: 3-attempt retry + indexer rotation across multiple URLs

---

### 2. 0G Chain — PlayerSaveAnchor Contract

Every save creates an immutable on-chain proof on the 0G EVM Mainnet (chainId **16661**).

**Contract: `contracts/PlayerSaveAnchor.sol`**

```solidity
constructor(address backendOperator)
function anchorSave(address wallet, string calldata rootHash, uint64 saveIndex) external
function getLatestSave(address wallet) external view returns (string, uint64, uint64)
function hasSave(address wallet) external view returns (bool)
```

**Access control:**
- Only `msg.sender == wallet` (player) OR `msg.sender == backendOperator` may call `anchorSave`.
- `backendOperator` is the deployer wallet — set **immutably at deploy time**, no admin key, no rotation.
- Prevents griefing: no random address can overwrite another player's on-chain record.

**Anti-rollback (contract level):**
- `SaveRecord` has a `bool exists` field.
- First save: `exists` sets to `true`, accepts any `saveIndex`.
- All subsequent saves: `saveIndex` must be **strictly greater** than stored value.
- The `exists` flag closes the `saveIndex == 0` bypass bug — a second anchor at index 0 is correctly rejected.

**Deploy:**
```bash
# Compile PlayerSaveAnchor.sol on https://remix.ethereum.org (Solidity 0.8.20)
# Copy the bytecode from Compilation Details, then:
ANCHOR_BYTECODE=0x<bytecode> node scripts/deployAnchor.js
```

Deployer wallet → becomes immutable `backendOperator`. Explorer: `https://chainscan.0g.ai`

- File: `services/ZeroGChain.js`
- Uses: `ethers-v6` alias (`npm:ethers@6.13.1`)

---

### 3. 0G DA (Data Availability)

Save commitments and leaderboard entries are dispersed to 0G DA nodes and BLS-signed by >2/3 of the committee.

**Endpoint:** `disperser-testnet.0g.ai:51001`  
> The 0G DA mainnet disperser does not have a public gRPC endpoint yet. This is the production endpoint used by all 0G-integrated backends currently deployed. Update `ZG_DA_DISPERSER` in `.env` when the mainnet endpoint ships — no code changes required.

**Flow:**
```
publishCommitment(payload, wallet)
        │
        ├── gRPC DisperseBlob → disperser-testnet.0g.ai:51001 (TLS auto-enabled)
        ├── Poll GetBlobStatus every 5s (timeout: 240s)
        ├── On consecutive gRPC errors: retry up to 5 before failing
        └── Status 3 (FINALIZED) → store BlobVerificationProof in MongoDB
```

**Finality time:** 60–240 seconds. The HTTP response is never blocked — DA runs in a `setImmediate` background pipeline. `daStatus` in MongoDB updates `pending` → `finalized` once the DA committee signs.

**TLS:** Auto-enabled for any endpoint containing `testnet` or `:51001`. Override with `ZG_DA_TLS=false`.

**Enum values:** Proto loader uses `enums: Number` — status comparisons (`=== 3`) work correctly.

- File: `services/ZeroGDA.js`
- Proto: `proto/disperser.proto`
- gRPC client: `@grpc/grpc-js` + `@grpc/proto-loader`

---

### 4. 0G Compute — Anti-Cheat

Save metadata is sent to the 0G Compute router for AI heuristic validation.

**Endpoint:** `https://router-api.0g.ai/v1/chat/completions`  
**Dashboard / top-up:** `https://pc.0g.ai`

**What it checks:**
- `coinDelta` (coins gained since last save) vs. time elapsed — max ~5000 coins / 30 min
- `saveIndex` strictly increasing
- Flags: `IMPOSSIBLE_COIN_RATE`, `RAPID_SAVE`, `LARGE_COIN_JUMP`, `ROLLBACK_DETECTED`

**Binding check (replay-attack prevention):**
The system prompt instructs the model to echo back the `rootHash`. Backend verifies `parsed.rootHash === rootHash` — a valid result from a different save cannot be replayed.

**TEE attestation — two-tier model:**

| `teeVerified` | What it means | How common |
|---|---|---|
| `true` | Inference ran inside a verified TEE; verdict is cryptographically signed by an on-chain-attested key — cannot be forged | Uncommon today |
| `false` | Inference ran on 0G Compute but no TEE attestation was returned for this request; verdict is a valid AI judgment but not cryptographically guaranteed | **Common path** |

We request `verify_tee: true` on every call — attestation depends on provider availability.

**Positioning:**
- This is a **probabilistic heuristic filter**, not a cryptographic proof.
- Strong deterrent: raises cost and friction for cheaters, catches obvious patterns.
- Pair with the on-chain anchor (immutable) and DA proof (BLS-finalized) for the tamper-evident guarantees.
- Skipped entirely when `ZG_COMPUTE_API_KEY` is not set.

**Trigger:** Only fires when `coinDelta > 5000`, save frequency is abnormal, or `saveIndex` rollback is detected.

- File: `services/ZeroGCompute.js`

---

## MongoDB Role

MongoDB stores **only metadata pointers** — it never holds actual game data.

```
PlayerSaveRecord {
  walletAddress    → lookup key
  rootHash         → pointer to 0G Storage file (Merkle content address)
  saveIndex        → anti-rollback counter
  coinSnapshot     → leaderboard value (denormalized for fast queries)
  daStatus         → pending / finalized / failed / skipped
  daCommitment     → BlobVerificationProof from DA nodes
  computeStatus    → skipped / pending / validated / rejected
  computeValidation → TEE verdict details
  anchorTxHash     → 0G chain tx hash
  anchorBlock      → 0G chain block number
}
```

The actual game binary lives on 0G Storage, addressed by `rootHash`. If MongoDB is wiped, saves can be recovered from 0G Storage — rootHash is the canonical identifier.

---

## Authentication System (SIWE)

Login proves wallet ownership via a signed message — no transaction, no gas, no MetaMask popups during gameplay.

```
GET /auth/nonce?wallet=0x...
        │
        └── Returns { nonce, message, issuedAt }
                │
                ▼  (client signs message — zero network call)
        ethers.signMessage(message) → signature
                │
                ▼
POST /auth/login { wallet, signature, nonce }
        │
        ├── Look up nonce in MongoDB (TTL: 5 min)
        ├── Delete nonce immediately (single-use)
        ├── ethers.verifyMessage(message, signature) → recovered address
        ├── recovered === wallet → JWT issued
        └── Returns { token, wallet, expiresIn: 604800 }
```

**Nonce model:** `models/AuthNonce.js` — MongoDB TTL index auto-expires nonces after 5 minutes. One nonce per wallet at a time.

**JWT secret:** Shared with the legacy login flow (`JWT_SECRET`). Tokens from both flows are accepted by `verifyUser` middleware.

**Raw wallet address rejection:** `verifyUser` explicitly rejects `Authorization: Bearer 0x1234...` — anyone can type an address; it proves nothing without a signature.

**React Native iframe session:**
- Web app does SIWE login once.
- JWT passed into game iframe via `window.postMessage`.
- Game includes `Authorization: Bearer <token>` in every API call.
- Zero wallet popups during gameplay.

---

## Dual-Write Strategy (Backward Compatibility)

Existing builds using the legacy `POST /warzone` JSON endpoint continue working unchanged. Every JSON save also triggers a background 0G upload via `persistProfileTo0G()`.

```
POST /warzone  (legacy JSON)
        │
        ├── Save to MongoDB (existing behavior — unchanged)
        ├── Return 200 to client (no latency added)
        └── setImmediate → persistProfileTo0G()
                │
                ├── msgpack-encode profile
                ├── uploadBuffer → 0G Storage
                ├── Create PlayerSaveRecord
                └── Background pipeline (anchor → DA → compute)
```

New builds should use `POST /warzone/save/binary` directly.

---

## Save Pipeline (Full)

```
POST /warzone/save/binary
        │
        ├── [middleware] rateLimiter (10/min per IP)
        ├── [middleware] verifyUser (JWT — wallet from token, not from headers)
        ├── [middleware] express.raw (binary body parser, 5MB limit)
        │
        ├── Anti-rollback check (DB: new saveIndex must be > current)
        ├── uploadBuffer → 0G Storage → rootHash (retry 3×, indexer rotation)
        ├── PlayerSaveRecord.create (MongoDB)
        ├── HTTP 201 response ←──────────────── client unblocked here (~1–3s)
        │
        └── setImmediate (background — never blocks response)
                ├── anchorSaveHash → PlayerSaveAnchor.sol (0G chain 16661)
                ├── publishCommitment → 0G DA (poll until FINALIZED, timeout 240s)
                └── validateSave → 0G Compute (if coinDelta > 100 or saveIndex jumps)
```

---

## 4-Layer Verification

`GET /warzone/verify?wallet=0x...` runs all four checks:

| Layer | Guarantee type | What it checks | Source |
|---|---|---|---|
| 1. DB record | Soft (index) | `PlayerSaveRecord` exists, rootHash + saveIndex consistent | MongoDB |
| 2. DA proof | **Cryptographic** | `daStatus === finalized`, BLS-signed by >2/3 of DA committee | 0G DA |
| 3. File checksum | **Cryptographic** | Re-download from 0G Storage, SHA-256 + Merkle proof match | 0G Storage |
| 4. Compute verdict | **Probabilistic** | AI heuristic: `computeStatus === validated`, verdict `CLEAN` | 0G Compute |

Layers 2 and 3 are cryptographically verifiable by anyone — the DA BLS signature and Merkle proof are publicly auditable. Layer 4 (Compute) is probabilistic: a `CLEAN` verdict means the AI found no anomaly patterns, but is not a cryptographic proof of legitimate play. Layer 1 is an index convenience layer only.

`allPassed: true` means the save is on-chain anchored, DA-finalized, file-intact, and AI-cleared. The strongest guarantees are layers 2 and 3.

---

## Environment Variables

### Required — 0G Stack
```env
# 0G EVM Mainnet
ZG_RPC_URL=https://evmrpc.0g.ai
ZG_CHAIN_ID=16661
ZG_ANCHOR_CONTRACT_ADDRESS=0x...   # printed after: node scripts/deployAnchor.js

# Key separation (recommended — each service uses its own wallet)
ZG_STORAGE_PRIVATE_KEY=0x...       # signs 0G Storage upload transactions
ZG_CHAIN_PRIVATE_KEY=0x...         # calls PlayerSaveAnchor.anchorSave() on 0G chain
# ZG_PRIVATE_KEY=0x...             # fallback if using a single key (backward compat)

# 0G Storage
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai

# 0G DA
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
# ZG_DA_TLS=true                   # auto-detected from endpoint name; override if needed

# 0G Compute (optional)
ZG_COMPUTE_API_KEY=                # skip anti-cheat if not set
```

### Required — App
```env
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=warzone-0g
JWT_SECRET=<long random string — min 32 chars>
PORT=3300
```

### Optional — Redis (shared rate limiting)
```env
# Set REDIS_URL to enable Redis-backed rate limiting across multiple instances.
# Without it, in-memory rate limiting is used (suitable for single-instance deployments).
REDIS_URL=redis://localhost:6379
```

### Optional — Observability
```env
# Prometheus metrics exposed at GET /metrics — requires: npm install prom-client
# Restrict /metrics to internal network in production (nginx allow 10.0.0.0/8)
# Grafana + Prometheus configured in docker-compose.yml and prometheus.yml
```

### Optional — Tuning
```env
ZG_ENABLED=true                    # set false to disable all 0G ops in local dev
ZG_DA_POLL_TIMEOUT_MS=240000       # DA finality poll timeout (default 240s)
ZG_DA_POLL_INTERVAL_MS=5000        # DA poll interval (default 5s)
TRUST_PROXY=1
SLOW_REQUEST_MS=2000
SLOW_MONGO_MS=200
MONGOOSE_DEBUG_LOGS=false
NODE_ENV=production
```

### Key separation — why it matters
`ZG_STORAGE_PRIVATE_KEY` and `ZG_CHAIN_PRIVATE_KEY` are separate wallets. If one key leaks, the attacker can compromise only one service layer:

| Key | What it controls | Risk if leaked |
|---|---|---|
| `ZG_STORAGE_PRIVATE_KEY` | Signs upload txs to 0G Storage | Attacker can upload arbitrary files (but not overwrite other players' anchored saves) |
| `ZG_CHAIN_PRIVATE_KEY` | Calls `anchorSave()` on 0G chain | Attacker can overwrite your backend's on-chain save pointers |

Both keys need 0G token balance to pay transaction fees. Fund them separately.  
`ZG_PRIVATE_KEY` is the backward-compatible single-key fallback for existing deployments.

---

## Contract Addresses

| Contract | Chain | ChainId | Address |
|---|---|---|---|
| `PlayerSaveAnchor` | 0G EVM Mainnet | 16661 | Set after `node scripts/deployAnchor.js` |

Explorer: `https://chainscan.0g.ai`

---

## Rate Limits (per IP)

| Endpoint | Auth | Limit |
|---|---|---|
| `GET /auth/nonce` | Public | 10 req/min |
| `POST /auth/login` | Public | 5 req/min |
| `POST /save/binary` | JWT | 10 req/min |
| `GET /load/binary` | JWT | 30 req/min |
| `GET /save/metadata` | Public | 60 req/min |
| `GET /verify` | Public | 20 req/min |
| `GET /leaderboard/decentralized` | Public | 30 req/min |
| `GET /dashboard` | JWT | 60 req/min |
| `GET /save/history` | JWT | 30 req/min |
| `GET /save/pipeline/:rootHash` | Public | 60 req/min |
| `GET /proof/:rootHash` | Public | 30 req/min |
| `GET /network/status` | Public | 20 req/min |

Rate limiter: `routes/middleware/rateLimiter.js`  
- **Without `REDIS_URL`:** In-memory (per-process) — suitable for single-instance deployments and local dev.  
- **With `REDIS_URL`:** Redis-backed (shared across all instances) — required for multi-instance / load-balanced deployments. Install: `npm install ioredis`

---

## UX Endpoints — What Each One Is For

| Endpoint | Purpose | When to call |
|---|---|---|
| `GET /dashboard` | Full player 0G profile in one call | Profile screen open |
| `GET /save/history` | Paginated save timeline with pipeline badges | "My saves" screen |
| `GET /save/pipeline/:rootHash` | Step-by-step progress for one save | Poll every 5–10s after saving |
| `GET /proof/:rootHash` | Shareable public proof card | "Verify on 0G" button |
| `GET /network/status` | Health of all 4 0G services | Status banner on app load |
