# Warzone Warriors — 0G Infrastructure Architecture

> **Partner:** 0G (Zero Gravity) — Storage · DA · Compute · EVM chain  
> **Game engine:** Unity  
> **Legacy chain:** Somnia (IAP + game registration — unchanged)  
> **New layer:** 0G full stack — every player save is decentralised

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         UNITY CLIENT                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Serialise player state → msgpack binary → POST /save/binary│   │
│  │  GET /load/binary → deserialise msgpack → apply game state  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WARZONE BACKEND (Node.js)                        │
│                                                                     │
│   Verify signature → upload binary → anchor hash → DA commit       │
│   Anti-cheat via Compute → store metadata in MongoDB index          │
└──┬──────────────┬──────────────┬──────────────┬────────────────────┘
   │              │              │              │
   ▼              ▼              ▼              ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────┐
│0G Storage│ │ 0G Chain │ │  0G DA   │ │    0G Compute         │
│          │ │ (16600)  │ │(testnet) │ │  (router-api.0g.ai)  │
│ Binary   │ │          │ │          │ │                       │
│ save     │ │ Player   │ │ Leader-  │ │ TEE anti-cheat:       │
│ files    │ │ Save     │ │ board +  │ │ validates coin delta, │
│ (msgpack)│ │ Anchor   │ │ save     │ │ rollback attempts,    │
│          │ │ contract │ │ commit-  │ │ impossible stats      │
│ Content- │ │          │ │ ments    │ │                       │
│ addressed│ │ rootHash │ │ BLS-     │ │ Result is TEE-signed  │
│ by Merkle│ │ per      │ │ signed   │ │ → cannot be forged    │
│ rootHash │ │ wallet   │ │ by nodes │ │ by us or anyone       │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    SOMNIA CHAIN (5031) — unchanged                   │
│  IAP contract (coin/gem/gun purchases) · Game registration contract  │
│  registerUser · startGameFor · endGameFor · isRegistered             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Chain Responsibilities

| Chain | ChainId | RPC | Handles |
|---|---|---|---|
| **0G EVM** | 16600 | `https://evmrpc.0g.ai` | `PlayerSaveAnchor` contract — rootHash per wallet |
| **Somnia** | 5031 | `https://api.infra.mainnet.somnia.network` | IAP contract, game session contract |

> The 0G EVM chain is where `PlayerSaveAnchor.sol` is deployed. Every save writes `wallet → rootHash → saveIndex` on-chain. This record is permanently verifiable by anyone at `https://chainscan.0g.ai` without trusting our backend.

---

## 3. 0G Product Usage

### 3.1 — 0G Storage (mainnet)

**What:** Decentralised storage for binary player save files.  
**How it works:** Files are split into 256-byte segments, each hashed into a Merkle tree. The root of that tree is the `rootHash` — a permanent content address. Same bytes always produce the same `rootHash`. The file is replicated across storage nodes.

**Config:**
```
ZG_RPC_URL=https://evmrpc.0g.ai          # 0G chain for Storage tx
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai
ZG_PRIVATE_KEY=0x...                      # pays Storage gas (0G tokens)
```

**Save flow:**
```
Unity → POST /warzone/save/binary (raw msgpack body)
Backend → writes to temp file → ZgFile.fromFilePath()
        → indexer.upload(file, rpcUrl, signer)
        → returns rootHash + txHash
        → deletes temp file
```

**Load flow:**
```
Unity → GET /warzone/load/binary?wallet=0x...
Backend → looks up latest rootHash in MongoDB
        → indexer.download(rootHash, tmpFile, withProof=true)
        → withProof=true: verifies every Merkle segment — tampered data throws
        → returns raw binary to Unity
```

**Key properties:**
- `withProof: true` on every download — tampered file is mathematically detected
- Content-addressed: rootHash is the file's identity, not a server URL
- Permanent: file exists as long as at least one node has it (replicas=3 default)

---

### 3.2 — 0G Chain (PlayerSaveAnchor contract)

**What:** Immutable on-chain record of `wallet → rootHash → saveIndex` on 0G EVM.

**Contract:** `contracts/PlayerSaveAnchor.sol`  
**Deploy:** `npm run deploy:anchor`  
**Explorer:** `https://chainscan.0g.ai`

```solidity
function anchorSave(address wallet, string calldata rootHash, uint64 saveIndex) external
function getLatestSave(address wallet) external view returns (string rootHash, uint64 saveIndex, uint64 timestamp)
```

**Properties:**
- Permissionless — anyone can call it (player, backend, third party)
- No admin key, not upgradeable
- Anti-rollback enforced at contract level (`saveIndex` must be strictly increasing)
- Called by backend after every 0G Storage upload (background, never blocks response)

**Why this matters for VCs/0G:**  
Even if Metabharat's servers go offline forever, a player can:
1. Call `getLatestSave(wallet)` on 0G chain → get `rootHash`
2. Fetch file from 0G Storage using `rootHash`
3. The Merkle proof verified by the SDK proves the file is authentic

The studio cannot alter a player's save without the player knowing.

---

### 3.3 — 0G DA (Data Availability layer)

**What:** Every save commitment and leaderboard state blob is published to 0G DA.  
**Status:** Testnet (`disperser-testnet.0g.ai:51001`) — mainnet endpoint TBD.  
**When mainnet ships:** Change one env var (`ZG_DA_DISPERSER`). No code changes.

**Config:**
```
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
ZG_DA_TLS=false          # true on mainnet
```

**What gets submitted:**
- After each save: `{ rootHash, wallet, saveIndex, coinSnapshot, ts }` blob
- Blob is BLS-signed by >2/3 of DA nodes → `FINALIZED` status
- Finality proof (batchId, blobIndex, batchHeaderHash) stored in MongoDB

**What DA proves:**  
The leaderboard score existed and was available at `referenceBlockNumber`. BLS signatures from the DA committee make retroactive forgery computationally impossible. This means a DA-backed leaderboard score has a cryptographic timestamp that we cannot fake retroactively.

**DA flow:**
```
save uploaded → setImmediate (non-blocking):
  publishCommitment({ rootHash, wallet, saveIndex, coinSnapshot })
  → DisperseBlob (gRPC)
  → poll GetBlobStatus every 5s
  → status === FINALIZED (BLS signed)
  → store DaCommitment in MongoDB
  → daStatus: 'finalized' in PlayerSaveRecord
```

---

### 3.4 — 0G Compute (TEE anti-cheat)

**What:** AI model runs inside a Trusted Execution Environment. Output is signed by an attested key — the signature is verifiable on-chain. Neither us nor 0G can fake a "CLEAN" verdict.

**Config:**
```
ZG_COMPUTE_API_KEY=sk-...          # get at pc.0g.ai → Dashboard → API Keys
ZG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZG_COMPUTE_MODEL=zai-org/GLM-5-FP8
```

**Triggers (cost-controlled — not every save):**
- First ever save from a wallet
- `coinDelta > 5000` (large single-session gain)
- `timeDeltaSeconds < 30` AND `coinDelta > 100` (rapid saves with big gains)
- `saveIndex <= previousSaveIndex` (rollback attempt)

**Anti-cheat rules (in system prompt):**
- Max ~5000 coins per 30 minutes of play
- `saveIndex` must always strictly increase
- `timeDelta < 10s` + `coinDelta > 0` → always SUSPICIOUS
- Flags: `IMPOSSIBLE_COIN_RATE`, `NEGATIVE_TIME_DELTA`, `ROLLBACK_DETECTED`, `STAT_OVERFLOW`
- Verdicts: `CLEAN` / `SUSPICIOUS` / `REJECTED`

**Binding check (anti-replay):**  
The model MUST echo back the `rootHash` in its JSON response. If the rootHash doesn't match, the result is rejected. This prevents replaying a "CLEAN" verdict from save A onto save B.

**TEE verification:**  
The `x_0g_trace.tee_verified` flag in the response confirms the inference ran inside a TEE. The provider's attestation key is registered on-chain — you can verify independently.

---

## 4. Data Flow — Complete Save Lifecycle

```
1. Unity serialises game state to msgpack binary

2. Unity POST /warzone/save/binary
   Headers: Content-Type: application/octet-stream
            X-Wallet-Address: 0x...
            X-Save-Index: 42 (optional)

3. Backend validates:
   - Wallet address format
   - Buffer not empty, not > 5MB
   - saveIndex > current latest (anti-rollback)

4. Backend uploads to 0G Storage:
   ZgFile.fromFilePath(tmpFile)
   indexer.upload(file, rpcUrl, signer)
   → rootHash = "0x..."  txHash = "0x..."

5. Backend creates PlayerSaveRecord in MongoDB:
   { walletAddress, rootHash, txHash, fileSize, checksum,
     saveIndex, coinSnapshot, daStatus: 'pending' }

6. Backend responds to Unity immediately:
   201 { ok, rootHash, txHash, saveIndex, size, daStatus: 'pending' }

7. Background pipeline (setImmediate — never blocks):

   a. 0G Compute anti-cheat (if triggered by heuristics):
      validateSave({ saveIndex, coinDelta, timeDelta, ... }, rootHash)
      → verdict: CLEAN / SUSPICIOUS / REJECTED
      → update PlayerSaveRecord.computeStatus

   b. 0G Chain anchor:
      anchorSave(wallet, rootHash, saveIndex)
      → on-chain tx on 0G EVM chain
      → update PlayerSaveRecord.anchorTxHash + anchorBlock

   c. 0G DA commitment:
      publishCommitment({ rootHash, wallet, saveIndex, coinSnapshot })
      → DisperseBlob → poll finality → FINALIZED
      → update PlayerSaveRecord.daStatus = 'finalized'
      → store daCommitment (batchId, blobIndex, batchHeaderHash)
```

---

## 5. Data Flow — Load Lifecycle

```
1. Unity GET /warzone/load/binary?wallet=0x...

2. Backend queries MongoDB for latest save:
   PlayerSaveRecord.findOne({ walletAddress }).sort({ saveIndex: -1 })

3. Backend downloads from 0G Storage:
   indexer.download(rootHash, tmpFile, withProof=true)
   withProof=true → SDK verifies every Merkle segment
   → tampered data throws before hitting disk

4. Backend responds:
   Content-Type: application/octet-stream
   X-Root-Hash: <rootHash>
   X-Save-Index: <n>
   X-Da-Status: finalized
   Body: raw msgpack binary

5. Unity deserialises msgpack → game state restored
```

---

## 6. MongoDB Role (Index Only)

MongoDB is **no longer the source of truth** for player game data.  
It stores only lightweight metadata — pointers to the actual data on 0G.

| Collection | Stores | Source of truth? |
|---|---|---|
| `PlayerSaveRecord` | rootHash, saveIndex, coinSnapshot, DA commitment, compute verdict | Pointer only |
| `WarzonePlayerProfile` | Full JSON profile (legacy + IAP delivery) | Yes (IAP still updates this) |
| `WarzoneIaAppurchases` | IAP transaction records | Yes |
| `WarzoneNameWallls` | Player display names | Yes |
| `NoncStates` | Somnia transaction nonces | Yes |

> `WarzonePlayerProfile` is still written on every `POST /warzone` (legacy JSON save). This ensures IAP delivery, leaderboard (legacy), and existing Unity builds keep working without change.

---

## 7. Dual-Write Strategy (backward compatible)

Every `POST /warzone` (existing JSON API) also triggers a background 0G upload:

```
profileController.saveProfile()
  → saves to MongoDB (WarzonePlayerProfile)   ← existing
  → runInBackground: persistProfileTo0G()     ← new (async, never delays response)
      → msgpack.encode(profileObj)
      → uploadBuffer(buffer)
      → PlayerSaveRecord.create(...)
      → runSavePipeline (anchor + DA + compute)
```

This means:
- Existing Unity builds work without any changes
- Every save is automatically replicated to 0G Storage
- The game becomes decentralised transparently

---

## 8. 4-Layer Verification (GET /warzone/verify)

```
L1 — MongoDB record exists (wallet + rootHash match)
L2 — DA proof: verifyCommitment(daCommitment) → still FINALIZED on DA nodes
L3 — File checksum: re-download from 0G Storage + SHA-256 compare
L4 — Compute verdict: TEE-attested CLEAN result (or re-run if missing)

Verdict: CLEAN (all pass) | TAMPERED (any fail) | DA_PENDING
```

---

## 9. Environment Variables

### Somnia (unchanged from legacy)
```env
SOMNIA_RPC_URL=https://api.infra.mainnet.somnia.network
SOMNIA_RPC_URLS=<comma-separated fallbacks>
SOMNIA_CHAIN_ID=5031
GAME_CONTRACT_ADDRESS=0x...
GAME_OWNER_PRIVATE_KEY=0x...
IAP_CONTRACT_ADDRESS=0x...
IAP_RPC_URL=https://api.infra.mainnet.somnia.network
IAP_CHAIN_ID=5031
```

### 0G Storage (mainnet)
```env
ZG_RPC_URL=https://evmrpc.0g.ai
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai
ZG_PRIVATE_KEY=0x...                  # pays Storage upload gas
ZG_EXPECTED_REPLICAS=3
```

### 0G Chain (anchor contract)
```env
ZG_CHAIN_ID=16600
ZG_ANCHOR_CONTRACT_ADDRESS=0x...     # from: npm run deploy:anchor
```

### 0G DA (testnet now, env-swap when mainnet ships)
```env
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
ZG_DA_TLS=false
ZG_DA_POLL_TIMEOUT_MS=120000
ZG_DA_POLL_INTERVAL_MS=5000
```

### 0G Compute (optional — anti-cheat disabled if missing)
```env
ZG_COMPUTE_API_KEY=sk-...
ZG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZG_COMPUTE_MODEL=zai-org/GLM-5-FP8
ZG_COMPUTE_MIN_CONFIDENCE=0.70
ZG_COMPUTE_TIMEOUT_MS=30000
ZG_COMPUTE_ROUTING=latency
```

### App
```env
PORT=3300
NODE_ENV=production
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=new-warzone
JWT_SECRET=...
ZG_ENABLED=true          # set false to disable all 0G features locally
```

---

## 10. Contract Addresses (to be filled after deployment)

| Contract | Chain | Address |
|---|---|---|
| `PlayerSaveAnchor` | 0G EVM (16600) | _deploy with `npm run deploy:anchor`_ |
| Game session contract | Somnia (5031) | `0xe5cB757613bE827b836029d5E2700D76466745BD` |
| IAP contract | Somnia (5031) | `0x13D6C683856eB191050A0E332B0751e03a70fc2B` |

---

## 11. Key Files

```
warzone-backend-0g/
├── contracts/
│   └── PlayerSaveAnchor.sol      ← deploy on 0G chain
├── proto/
│   └── disperser.proto           ← 0G DA gRPC schema
├── services/
│   ├── ZeroGStorage.js           ← upload / download binary saves
│   ├── ZeroGChain.js             ← anchor rootHash on 0G EVM
│   ├── ZeroGDA.js                ← DA commitments via gRPC
│   └── ZeroGCompute.js           ← TEE anti-cheat
├── models/
│   └── PlayerSaveRecord.js       ← 0G metadata index (not game data)
├── controllers/
│   └── zgController.js           ← 5 new endpoints
├── scripts/
│   └── deployAnchor.js           ← one-time 0G chain deploy
└── INFRASTRUCTURE.md             ← this file
```
