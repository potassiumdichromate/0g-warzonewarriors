# Architecture

Warzone Warriors is an AI-native arcade shooter where player progression becomes verifiable, persistent, and portable through decentralized infrastructure.

- Players truly own their progression.
- Saves cannot be silently manipulated.
- AI opponents evolve from real player behavior.

## The problem this solves

Traditional game backends store everything in a central database. The developer controls the database. That means player saves can be modified, leaderboards can be manipulated, and if the company shuts down, all save data disappears.

WarzoneWarrior uses 0G's infrastructure to make saves verifiable and persistent outside the developer's control. A player can prove their save is authentic by pointing to the on-chain anchor hash, the DA finality proof, and the TEE validation report. None of those can be forged.

MongoDB still exists, but it's the hot layer — fast reads for game requests. The ground truth lives on the decentralized stack.

---

## High-level components

```
┌─────────────────────────────────────────────────────────────────┐
│  Unity (WebGL)                                                  │
│  BackendSyncManager.cs → sends/receives WZSV binary             │
│  ZGSaveManager.cs      → serializes ProfileManager data         │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼──────────────────────────────────────────┐
│  Express.js Backend (Node 18)                                   │
│                                                                 │
│  ┌─────────────┐  ┌────────────────┐  ┌──────────────────────┐ │
│  │  Auth       │  │  Save / Load   │  │  Behavioral AI       │ │
│  │  SIWE/JWT   │  │  WZSV binary   │  │  Neural + 0G Compute  │ │
│  └─────────────┘  └────────┬───────┘  └──────────────────────┘ │
│                            │                                    │
│  ┌─────────────────────────▼──────────────────────────────────┐ │
│  │  MongoDB (hot layer)                                        │ │
│  │  PlayerProfile, PlayerSaveRecord, AuthNonce, AIRecord       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────────┘
                       │ background pipeline
          ┌────────────┼────────────┬─────────────────┐
          │            │            │                  │
    ┌─────▼──────┐ ┌───▼────┐ ┌────▼──────┐ ┌────────▼────────┐
    │ 0G Storage │ │ 0G EVM │ │ 0G DA     │ │ 0G Compute      │
    │ (files)    │ │ (chain)│ │ (gRPC)    │ │ (LLM inference) │
    └────────────┘ └────────┘ └───────────┘ └─────────────────┘
```

---

## Request flow: saving a game

This is the most important flow to understand.

```
Unity                       Backend                    0G Stack
  │                            │
  │── POST /player/save/binary ──►│
  │   (WZSV binary, ~4KB)       │
  │                             │── Validate WZSV magic header
  │                             │── Deserialize JSON payload
  │                             │── Anti-rollback check (saveIndex++)
  │                             │── Write PlayerProfile to MongoDB
  │◄── 201 { saveIndex, rootHash } ─│
  │   (Unity gets response here)│
  │                             │
  │          [background, async - Unity doesn't wait for this]
  │                             │── Upload binary to 0G Storage
  │                             │     └─ ZgFile → Merkle tree → indexer.upload()
  │                             │     └─ returns rootHash + txHash
  │                             │
  │                             │── Anchor on-chain
  │                             │     └─ PlayerSaveAnchor.anchorSave(wallet, rootHash, saveIndex)
  │                             │     └─ returns anchorTxHash + block number
  │                             │
  │                             │── Dispatch to DA
  │                             │     └─ gRPC DisperseBlob to disperser
  │                             │     └─ poll GetBlobStatus until FINALIZED (240s timeout)
  │                             │     └─ returns batch_id, blob_index, batch_header_hash
  │                             │
  │                             │── Compute anti-cheat (if API key set)
  │                             │     └─ POST router-api.0g.ai/v1/chat/completions
  │                             │     └─ LLM checks coin/exp/level/equipment consistency
  │                             │     └─ verify_tee: true → signed by TEE provider
  │                             │
  │                             │── Update PlayerSaveRecord with all hashes + statuses
```

The key design choice: Unity gets a response as soon as MongoDB is updated and the binary is queued. The 0G pipeline runs in `setImmediate()` — the game never waits for it. This keeps save latency under 100ms even when 0G storage takes 5–10 seconds.

---

## Data layers

### MongoDB (hot/index layer)

MongoDB is used for:
- Fast profile reads/writes (the game hits this every save/load)
- Index records that point to 0G storage (rootHashes, DA statuses)
- Auth nonces (5-min TTL)
- AI training metadata (rootHashes of sample batches and trained models)

MongoDB stores **no** raw gameplay data. Sample batches and model weights live on 0G Storage. MongoDB holds the rootHashes that point to them.

### 0G Storage (permanent file layer)

Every player save binary and every AI data object (sample batches, trained models) is a file on 0G Storage. The SDK builds a Merkle tree over the file and submits it to the network. The `rootHash` of the tree becomes the file's permanent address.

Files are content-addressed: the same binary always produces the same rootHash. This is what makes tamper-proofing possible — if anyone modifies the save file, the rootHash changes and no longer matches what's on-chain.

### 0G Chain (verification layer)

`PlayerSaveAnchor.sol` is a simple contract with one function: `anchorSave(wallet, rootHash, saveIndex)`. It enforces that `saveIndex` always increases (anti-rollback), then emits a `SaveAnchored` event and stores the mapping.

Anyone can call `getLatestSave(wallet)` on the contract and compare the returned rootHash against what's in MongoDB. If they don't match, something was tampered with.

### 0G DA (finality layer)

The Data Availability layer adds BLS-aggregate signature finality. When a save is dispersed to the DA network and returns `FINALIZED`, a quorum of DA nodes have signed off that they have the data. This is a stronger guarantee than just "it's in a database somewhere."

The DA commitment (`batchId`, `blobIndex`, `batchHeaderHash`) is stored in `PlayerSaveRecord.daCommitment`. The trust score formula weights DA finalization heavily because it's the strongest data-availability proof.

### 0G Compute (validation/intelligence layer)

The Compute layer runs LLMs in Trusted Execution Environments (TEEs). Every call returns a `tee_verified` boolean and a provider address. The TEE provider signs the response with EIP-191, so the signature can be verified on-chain against the provider's registered key.

This is used for two things:
1. Anti-cheat: an LLM analyzes save deltas for suspicious patterns (coin jumps, exp decreases, impossible unlock sequences)
2. Behavioral AI: when no TF.js model exists yet, the LLM acts as a fallback AI opponent

---

## Behavioral AI architecture

The AI system layers three inference sources:

```
POST /ai/predict
        │
        ▼
  [Local model cached?] ──YES──► Local neural inference (~1ms)
        │ NO                      source: "local-neural"
        ▼
  [ZG_COMPUTE_API_KEY set?] ──YES──► 0G Compute LLM (~200ms, TEE-signed)
        │ NO                          source: "0g-compute"
        ▼
  Neutral action (0, 0, false, false, false)
                                      source: "fallback"
```

The local neural inference layer handles the fast per-frame path. The neural net is a simple 4-layer dense network (17→64→64→32→5) trained on behavioral cloning — it learns to mimic the player's inputs from their gameplay recordings.

0G Compute handles the cold-start problem. New players have no recordings, so no local model exists. The LLM plays the game "intelligently" (using the game rules as its system prompt) until enough samples accumulate for the local inference layer to take over. Once the local model is ready, Compute is only invoked for the explicit `/ai/strategy` endpoint used in Arena matches.

The data pipeline for training:

```
Unity uploads sample batches
        │
        ▼
  POST /behavior/upload
        │── serialize batch as JSON
        │── upload to 0G Storage → rootHash
        │── push rootHash to AIRecord.sampleBatches[]
        │
        ▼
  [totalSamples >= 500?] ──YES──► trainForWallet() fires async
                                          │
                                          ▼
                                   download all batch buffers from 0G
                                          │
                                          ▼
                                   [AI_ENRICH=true?] ──YES──► 0G Compute generates
                                          │                    synthetic samples
                                          │                    upload to 0G Storage
                                          ▼
                                   TF.js train (50 epochs)
                                          │
                                          ▼
                                   serialize model weights → Buffer
                                          │
                                          ▼
                                   upload model to 0G Storage → modelRootHash
                                          │
                                          ▼
                                   AIRecord.status = "ready"
                                   AIRecord.modelRootHash = rootHash
```

---

## Authentication

SIWE (Sign-In with Ethereum) — the wallet is the identity, no username/password.

```
GET /auth/nonce?wallet=0x...
        │── create AuthNonce record (5-min TTL)
        │── return { nonce, message }
        │
        ▼ client signs message with private key
        │
POST /auth/login { wallet, signature, nonce }
        │── verify EIP-191 signature with ethers.verifyMessage
        │── confirm signature recovers to wallet address
        │── confirm nonce exists and isn't expired
        │── return JWT (7-day HS256)
        │
        ▼ subsequent requests
        │
Authorization: Bearer <JWT>
        │── auth.js middleware verifies JWT
        │── req.walletAddress = decoded wallet
```

---

## Save format (WZSV)

```
┌────────────┬─────────┬────────────────────────────────────────┐
│ 4 bytes    │ 1 byte  │ N bytes                                │
│ "WZSV"     │ 0x01    │ UTF-8 JSON (full player state)         │
│ magic      │ version │                                        │
└────────────┴─────────┴────────────────────────────────────────┘
```

The magic header lets the backend immediately reject non-save files before parsing. The version byte allows future format changes without breaking old clients.

The JSON payload contains all profile fields: `PlayerProfile`, `PlayerResources`, `PlayerRambos`, `PlayerGuns`, `PlayerCampaignStageProgress`, etc. Unity's `ZGSaveManager.cs` handles serialization and deserialization on the game side.

---

## Trust score

The trust score (0–100) is a composite of how thoroughly a player's saves have been verified:

```
Base score:                      10 pts
DA finalization rate × 40:       up to 40 pts  (strongest signal)
On-chain anchoring rate × 25:    up to 25 pts
Any TEE-validated saves:         15 pts
>= 10 total saves:               10 pts
>= 5 total saves:                5 pts
                                ─────────
Maximum:                         100 pts
```

The weighting reflects verification strength. DA finalization is hardest to fake (requires a BLS quorum). On-chain anchoring is permanent but cheaper to achieve. TEE validation adds an independent anti-cheat pass.

---

## Rate limiting

All routes use `express-rate-limit` with a sliding 60-second window per IP. The limits are:

- Auth nonce: 10/min — generous since it's stateless
- Auth login: 5/min — tight to prevent brute-force signature grinding
- Save binary: 10/min — saves are heavy (full profile payload + 0G upload)
- Load binary: 30/min — reads are cheap
- Dashboard/activity: 30/min — can be cached on the frontend
- Proof/verify: 20/min — involves contract calls, somewhat expensive

---

## Error handling philosophy

The backend distinguishes between player-facing errors and pipeline errors.

Player-facing errors (auth failures, invalid save format, anti-rollback violations) return immediately with 4xx status codes. The game handles these directly.

Pipeline errors (0G Storage upload fails, chain call reverts, DA times out) are logged and recorded in `PlayerSaveRecord` as status fields (`daStatus: "failed"`, etc.) but don't cause the save operation to fail from the game's perspective. The save is still in MongoDB. The trust score reflects incomplete verification, but the data isn't lost.

This is intentional. Decentralized infrastructure has higher latency and occasional failures compared to a single centralized service. The game needs to be resilient to that.

---

## Deployment considerations

**MongoDB**: Atlas works well. Use a `warzonewarrior` database name. The `PlayerProfile` schema uses dot-key encoding for `PlayerCampaignStageProgress` (stage keys like `"1.1"` are stored as `"1__dot__1"` to avoid MongoDB's dot-notation restrictions).

**Backend hosting**: Render, Railway, or Fly.io all work. The backend needs Node 18+, outbound internet access for 0G network calls, and enough memory for TF.js training (at least 512MB, 1GB recommended if training fires frequently).

**0G wallet**: The backend wallet (`ZG_PRIVATE_KEY`) pays for:
- 0G Storage uploads (~0.01 A0GI per file)
- On-chain anchor transactions (gas on 0G Mainnet)
Keep it funded. The backend logs balance warnings if it gets low.

**TF.js training**: Training runs synchronously in the Node.js process (it's async but not in a worker thread). For a busy server with many players training simultaneously, consider moving training to a separate worker or queue. Each training run takes ~30 seconds for 500 samples on a standard VPS.
