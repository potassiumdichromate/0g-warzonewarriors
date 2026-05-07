# Warzone Warriors — Decentralized Infrastructure

## System Overview

```
Unity / React Native Game
        │
        │  HTTPS  (JWT in Authorization header)
        ▼
┌─────────────────────────────────────────────────────┐
│              Node.js / Express Backend               │
│                                                     │
│   POST /warzone/save/binary   ←── binary save       │
│   GET  /warzone/load/binary   ←── binary load       │
│   GET  /warzone/save/metadata                       │
│   GET  /warzone/verify                              │
│   GET  /warzone/leaderboard/decentralized           │
└──────┬──────────────────────────────────────────────┘
       │
       ├──────────────────────────────────────────────▶  MongoDB
       │                                (index / pointer only — no game data)
       │
       ├── 0G Storage ──────────────────────────────▶  Binary save files
       │   (content-addressed by Merkle rootHash)       (msgpack encoded)
       │
       ├── 0G Chain (EVM, chainId 16600) ──────────▶  PlayerSaveAnchor.sol
       │   (rootHash anchored on-chain per save)        (immutable proof)
       │
       ├── 0G DA ──────────────────────────────────▶  Leaderboard + commitments
       │   (BLS-signed by >2/3 DA nodes)               (finality in ~60–120s)
       │
       └── 0G Compute ─────────────────────────────▶  Anti-cheat validation
           (TEE-attested AI inference)                  (coin delta heuristics)
```

---

## Chain Responsibilities

| Chain | Role | Config var |
|---|---|---|
| **Somnia** (chainId 5031) | IAP purchases, game registration (`registerUser`, `startGameFor`) | `SOMNIA_RPC_URL`, `GAME_CONTRACT_ADDRESS`, `IAP_CONTRACT_ADDRESS` |
| **0G EVM** (chainId 16600) | `PlayerSaveAnchor.sol` — rootHash anchoring only | `ZG_RPC_URL`, `ZG_ANCHOR_CONTRACT_ADDRESS`, `ZG_PRIVATE_KEY` |
| **0G Storage** | Binary player save files | `ZG_INDEXER_RPC` |
| **0G DA** | Leaderboard commitments, save proofs | `ZG_DA_DISPERSER` |
| **0G Compute** | TEE anti-cheat inference | `ZG_COMPUTE_API_KEY` |

Somnia contracts are **unchanged** from the original backend. All new decentralized functionality lives exclusively on 0G infrastructure.

---

## 0G Stack — Product by Product

### 1. 0G Storage

Binary player saves are stored as msgpack-encoded files, content-addressed by Merkle rootHash.

**Upload flow:**
```
Unity sends msgpack binary
        │
        ▼
Backend: uploadBuffer(rawBuffer)
        │
        ├── Write to temp file
        ├── ZgFile.fromFilePath()
        ├── indexer.upload(zgFile, signer)
        └── Returns { rootHash, txHash, size, checksum }
```

**Download flow:**
```
GET /load/binary?wallet=0x...
        │
        ▼
Backend: downloadToBuffer(rootHash)
        │
        ├── indexer.download(rootHash, tmpPath, { withProof: true })
        ├── Merkle proof verified by SDK (tamper-proof)
        └── Returns raw buffer → streamed to Unity
```

- File: `services/ZeroGStorage.js`
- SDK: `@0gfoundation/0g-storage-ts-sdk` (ESM, loaded via dynamic `import()`)
- Indexer: `https://indexer-storage-turbo.0g.ai` (configurable via `ZG_INDEXER_RPC`)

---

### 2. 0G Chain — PlayerSaveAnchor Contract

Every save creates an immutable on-chain proof on the 0G EVM chain.

**Contract: `contracts/PlayerSaveAnchor.sol`**

```solidity
function anchorSave(address wallet, string calldata rootHash, uint64 saveIndex) external
function getLatestSave(address wallet) external view returns (string, uint64, uint64)
function hasSave(address wallet) external view returns (bool)
```

**Access control:**
- Only `msg.sender == wallet` (the player themselves) OR `msg.sender == backendOperator` may call `anchorSave`.
- `backendOperator` is set **immutably at deploy time** — the deployer wallet address. No admin key, no rotation.
- Closes the griefing vector where any address could overwrite another player's record.

**Anti-rollback (contract level):**
- `SaveRecord` contains an `exists` boolean.
- First save: sets `exists = true`, accepts any `saveIndex`.
- Subsequent saves: `saveIndex` must be **strictly greater** than the current value.
- The `exists` flag eliminates the `saveIndex == 0` bypass bug — a second anchor with index 0 is correctly rejected after the first.

**Deploy:**
```bash
# Set in .env:
# ANCHOR_BYTECODE=0x<compiled bytecode from Remix>
node scripts/deployAnchor.js
```

The deployer wallet becomes the immutable `backendOperator`. Explorer: `https://chainscan.0g.ai`

- File: `services/ZeroGChain.js`
- Uses: `ethers-v6` alias (`npm:ethers@^6`)

---

### 3. 0G DA (Data Availability)

Save commitments and leaderboard entries are dispersed to 0G DA nodes and BLS-signed by >2/3 of the committee.

**Flow:**
```
publishCommitment(payload, wallet)
        │
        ├── gRPC: DisperseBlob (disperser-testnet.0g.ai:51001)
        ├── Poll GetBlobStatus every 5s
        └── Status 3 (FINALIZED) → store BlobVerificationProof in MongoDB
```

**Finality time:** 60–120 seconds on testnet. The HTTP response is never blocked — DA runs in a `setImmediate` background pipeline. The `daStatus` field in MongoDB updates from `pending` → `finalized` once the DA nodes confirm.

**Leaderboard entries with `daStatus: "finalized"` carry a `verified: true` flag** — the score has been BLS-signed by the DA committee, not just stored in a database.

- File: `services/ZeroGDA.js`
- Proto: `proto/disperser.proto`
- gRPC client: `@grpc/grpc-js` + `@grpc/proto-loader`

---

### 4. 0G Compute — Anti-Cheat

Save validation is sent to 0G Compute's TEE-attested AI router.

**What it checks:**
- `coinDelta` (coins gained since last save) vs. time elapsed
- `saveIndex` strictly increasing
- Warzone-specific heuristics (max ~5000 coins / 30 min)

**Binding check (replay-attack prevention):**
The system prompt instructs the model to echo back the `rootHash`. The backend verifies `parsed.rootHash === rootHash` — a result from a different save file cannot be replayed against this one.

**Honest limitations:**
- `teeVerified: false` is the default path — the TEE attestation is requested but not guaranteed on testnet.
- This is a heuristic layer, not cryptographic proof. A server-side compromise can still construct fake metadata.
- Best used as a first-pass filter and demo story, not as the sole anti-cheat mechanism.

**Trigger heuristic** (`shouldTriggerCompute`): only runs when `coinDelta > 100` or `saveIndex` jumps by more than 1. Avoids spending compute tokens on every save.

- File: `services/ZeroGCompute.js`
- Router: `https://router-api.0g.ai/v1/chat/completions`

---

## MongoDB Role

MongoDB stores **only metadata pointers** — it never holds actual game data.

```
PlayerSaveRecord {
  walletAddress   → lookup key
  rootHash        → pointer to 0G Storage file
  saveIndex       → anti-rollback counter
  coinSnapshot    → leaderboard value (denormalized)
  daStatus        → pending / finalized / failed / skipped
  daCommitment    → BlobVerificationProof from DA nodes
  computeStatus   → skipped / pending / validated / rejected
  computeValidation → TEE verdict details
  anchorTxHash    → 0G chain tx hash
}
```

The actual game binary lives on 0G Storage, addressed by `rootHash`. If MongoDB is wiped, saves can be recovered from 0G Storage — rootHash is the canonical identifier.

---

## Dual-Write Strategy (Backward Compatibility)

Existing Unity builds using the legacy `POST /warzone` JSON endpoint continue working unchanged. Every JSON save also triggers a background 0G Storage upload via `persistProfileTo0G()`.

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

New Unity builds should use `POST /warzone/save/binary` directly (sends msgpack, no JSON conversion).

---

## Save Pipeline (Full)

```
POST /warzone/save/binary
        │
        ├── [middleware] rateLimiter (10/min)
        ├── [middleware] verifyUser (JWT — wallet from token)
        ├── [middleware] express.raw (binary body parser)
        │
        ├── Anti-rollback check (DB: saveIndex must increase)
        ├── uploadBuffer → 0G Storage → rootHash
        ├── PlayerSaveRecord.create (MongoDB)
        ├── HTTP 201 response ←──────────────── client unblocked here
        │
        └── setImmediate (background — never blocks response)
                ├── anchorSaveHash → PlayerSaveAnchor.sol (0G chain)
                ├── publishCommitment → 0G DA (poll until FINALIZED)
                └── validateSave → 0G Compute (if coinDelta > threshold)
```

---

## 4-Layer Verification

`GET /warzone/verify?wallet=0x...` runs all four checks:

| Layer | What it checks | Source |
|---|---|---|
| 1. DB record | PlayerSaveRecord exists, rootHash + saveIndex consistent | MongoDB |
| 2. DA proof | `daStatus === finalized`, BlobVerificationProof valid | 0G DA |
| 3. File checksum | Re-download from 0G Storage, SHA-256 matches stored checksum | 0G Storage |
| 4. Compute verdict | `computeStatus === validated`, no REJECTED flags | 0G Compute |

A save passes all 4 layers only if it was genuinely uploaded, DA-finalized, not tampered with, and passed heuristic anti-cheat.

---

## Environment Variables

### Required — Somnia (existing contracts)
```env
SOMNIA_RPC_URL=https://api.infra.mainnet.somnia.network
GAME_CONTRACT_ADDRESS=0x...
IAP_CONTRACT_ADDRESS=0x...
OWNER_PRIVATE_KEY=0x...       # Somnia backend wallet
```

### Required — 0G Stack
```env
ZG_RPC_URL=https://evmrpc.0g.ai
ZG_CHAIN_ID=16600
ZG_ANCHOR_CONTRACT_ADDRESS=0x...   # from: node scripts/deployAnchor.js
ZG_PRIVATE_KEY=0x...               # 0G chain wallet (becomes backendOperator)
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
```

### Optional — 0G Compute
```env
ZG_COMPUTE_API_KEY=...    # if not set, compute anti-cheat is skipped
```

### Optional — App Config
```env
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=new-warzone
JWT_SECRET=...
PORT=3300
ZG_ENABLED=true           # set false to disable all 0G ops (local dev)
TRUST_PROXY=1
SLOW_REQUEST_MS=2000      # log warning if request takes longer
SLOW_MONGO_MS=200         # log warning if query takes longer
MONGOOSE_DEBUG_LOGS=false # set true to log every mongo command + duration
```

### Key separation note
`ZG_PRIVATE_KEY` is currently used for both 0G Storage uploads (signing txs) and 0G chain anchoring. For production, use separate keys — one leak compromises both operations. Separate env vars (`ZG_STORAGE_KEY` / `ZG_CHAIN_KEY`) can be split in `ZeroGStorage.js` and `ZeroGChain.js`.

---

## Contract Addresses

| Contract | Chain | Address |
|---|---|---|
| `PlayerSaveAnchor` | 0G EVM (16600) | Set after `node scripts/deployAnchor.js` |
| IAP Contract | Somnia (5031) | `IAP_CONTRACT_ADDRESS` env var |
| Game Contract | Somnia (5031) | `GAME_CONTRACT_ADDRESS` env var |

---

## Rate Limits (per IP)

| Endpoint | Auth | Limit |
|---|---|---|
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

Rate limiter is in-memory (`routes/middleware/rateLimiter.js`). For multi-instance deployments, replace with Redis-backed rate limiting.

---

## UX Endpoints — What Each One Is For

| Endpoint | Purpose | When to call |
|---|---|---|
| `GET /dashboard` | Full player 0G profile in one call | Profile screen open |
| `GET /save/history` | Paginated save timeline with pipeline badges | "My saves" screen |
| `GET /save/pipeline/:rootHash` | Step-by-step progress for one save | Poll every 5–10s after saving |
| `GET /proof/:rootHash` | Shareable public proof card | "Verify on 0G" button |
| `GET /network/status` | Health of all 4 0G services | Status banner on app load |
