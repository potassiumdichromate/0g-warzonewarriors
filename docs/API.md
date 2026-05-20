# API Reference

Base URL: `https://your-backend.onrender.com`  
All authenticated routes require `Authorization: Bearer <JWT>` in the request header.  
All request/response bodies are `application/json` unless noted.

---

## Authentication

### GET /auth/nonce

Returns a nonce and a pre-formatted sign-in message for the given wallet. The nonce expires after 5 minutes.

**Query parameters**

| Param | Type | Required |
|---|---|---|
| wallet | string (0x address) | Yes |

**Request**
```
GET /auth/nonce?wallet=0xAbCd...
```

**Response**
```json
{
  "wallet": "0xabcd...",
  "nonce": "k9f2m7",
  "message": "Sign in to WarzoneWarrior\n\nWallet: 0xabcd...\nNonce: k9f2m7\nIssued At: 2026-05-20T14:00:00.000Z",
  "issuedAt": "2026-05-20T14:00:00.000Z",
  "expiresIn": 300
}
```

Rate limit: 10 requests/min

---

### POST /auth/login

Verifies the wallet signature and returns a JWT valid for 7 days.

**Body**

| Field | Type | Required |
|---|---|---|
| wallet | string | Yes |
| signature | string | Yes |
| nonce | string | Yes |

**Request**
```json
{
  "wallet": "0xabcd...",
  "signature": "0x1234...",
  "nonce": "k9f2m7"
}
```

**Response**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "wallet": "0xabcd...",
  "expiresIn": 604800
}
```

Rate limit: 5 requests/min

---

## Save & Load

These endpoints use a binary format. The request/response body is raw bytes, not JSON.

**WZSV binary format**
```
Bytes 0–3 : Magic header — 0x57 0x5A 0x53 0x56 ("WZSV")
Byte  4   : Version — 0x01
Bytes 5+  : UTF-8 JSON payload (full player state)
```

---

### POST /player/save/binary

Saves the player's current state. The game sends a WZSV-encoded binary. The backend immediately returns a save receipt, then runs the 0G pipeline (storage upload → on-chain anchor → DA dispersal → compute validation) in the background.

**Headers**
```
Authorization: Bearer <token>
Content-Type: application/octet-stream
```

**Response headers**
```
X-Root-Hash: <0G storage root hash>
X-Save-Index: <monotonic save counter>
X-Checksum-Sha256: <hex sha256 of the buffer>
```

**Response**
```json
{
  "success": true,
  "saveIndex": 7,
  "rootHash": "0x9f3a...",
  "checksum": "a3f1b9...",
  "fileSize": 4096,
  "message": "Save received. 0G pipeline running in background."
}
```

Errors:
- `400` — invalid WZSV magic or version byte
- `409` — `saveIndex` did not increase (anti-rollback rejected)
- `401` — missing or expired JWT

Rate limit: 10 requests/min

---

### GET /player/load/binary

Returns the latest save as a WZSV binary. Unity deserializes this and writes each field back into `ProfileManager`.

**Headers**
```
Authorization: Bearer <token>
```

**Response headers**
```
Content-Type: application/octet-stream
X-Root-Hash: <root hash of this save on 0G Storage>
X-Save-Index: <save number>
X-Da-Status: finalized | pending | failed | skipped
X-Checksum-Sha256: <hex sha256>
```

Response body is binary (WZSV format).

Errors:
- `404` — no save found for this wallet
- `401` — JWT required

Rate limit: 30 requests/min

---

### GET /player/save/metadata

Returns save history and pipeline status for any wallet. No auth required.

**Query parameters**

| Param | Type | Description |
|---|---|---|
| wallet | string | Wallet address |

**Response**
```json
{
  "wallet": "0xabcd...",
  "totalSaves": 5,
  "latestSaveIndex": 4,
  "saves": [
    {
      "saveIndex": 4,
      "rootHash": "0x9f3a...",
      "coinSnapshot": 12400,
      "fileSize": 4096,
      "daStatus": "finalized",
      "computeStatus": "validated",
      "anchorTxHash": "0xdeadbeef...",
      "anchorBlock": 84301,
      "source": "game_save",
      "createdAt": "2026-05-20T14:10:00.000Z"
    }
  ]
}
```

Rate limit: 60 requests/min

---

### GET /player/verify

Runs a multi-layer verification check on a wallet's latest save.

**Query parameters**

| Param | Type | Description |
|---|---|---|
| wallet | string | Wallet address |

**Response**
```json
{
  "wallet": "0xabcd...",
  "verified": true,
  "checks": {
    "dbRecord":          { "pass": true,  "saveIndex": 4 },
    "daFinalized":       { "pass": true,  "batchId": 91  },
    "checksumMatch":     { "pass": true                  },
    "computeValidated":  { "pass": true,  "verdict": "CLEAN", "confidence": 0.97 }
  }
}
```

Rate limit: 20 requests/min

---

### GET /player/leaderboard/decentralized

Top 100 players ranked by coin, filtered to only show saves that have been DA-finalized. This is the "verified" leaderboard — each entry has a provable save on 0G.

**Response**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0xabcd...",
      "displayName": "Warrior_abcd12",
      "coinSnapshot": 88400,
      "saveIndex": 12,
      "daStatus": "finalized",
      "anchorTxHash": "0xdeadbeef..."
    }
  ],
  "total": 47
}
```

Rate limit: 30 requests/min

---

## Player Profile

### GET /player/profile

Returns the full WarzonePlayerProfile for the authenticated wallet.

**Auth required**

**Response**
```json
{
  "walletAddress": "0xabcd...",
  "PlayerProfile": { "level": 14, "exp": 28000, "totalTimePlayed": 7200 },
  "PlayerResources": { "coin": 12400, "gem": 0, "stamina": 10, "medal": 3, "tournamentTicket": 1 },
  "PlayerRambos": { "0": { "id": 0, "level": 3, "isNew": false } },
  "PlayerGuns": { ... },
  "PlayerCampaignStageProgress": { "1.1": [true, true, false] },
  ...
}
```

---

### PATCH /player/profile

Partially updates the authenticated player's profile. Only the fields you send will be changed. `walletAddress` is ignored even if included.

**Auth required**

**Body** — any subset of profile fields:
```json
{
  "PlayerResources": { "coin": 15000, "gem": 5 },
  "PlayerProfile": { "level": 15 }
}
```

Returns the updated full profile.

---

### GET /player/profile/:wallet

Public profile lookup. Does not require auth. Strips the wallet address from the response.

**Response** — same shape as full profile minus `walletAddress`

---

### GET /player/leaderboard

Top players ranked by coin count. Optionally include `?wallet=0x...` to also record a leaderboard snapshot on-chain for that wallet.

**Query parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| limit | number | 100 | Max entries (hard cap 200) |
| wallet | string | — | If provided, records on-chain snapshot |

**Response**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0xabcd...",
      "displayName": "Warrior_abcd12",
      "PlayerResources": { "coin": 88400, ... },
      "PlayerProfile":   { "level": 42, ... }
    }
  ],
  "total": 83
}
```

---

### GET /player/history

Paginated save history for the authenticated wallet, with full pipeline status per save.

**Auth required**

**Query parameters**

| Param | Type | Default |
|---|---|---|
| page | number | 1 |
| limit | number | 20 |

**Response**
```json
{
  "wallet": "0xabcd...",
  "page": 1,
  "totalPages": 3,
  "totalSaves": 52,
  "saves": [
    {
      "saveIndex": 52,
      "rootHash": "0x9f3a...",
      "coinSnapshot": 14200,
      "fileSize": "4.1 KB",
      "source": "game_save",
      "pipeline": {
        "stored":    { "done": true,  "rootHash": "0x9f3a..." },
        "anchored":  { "done": true,  "txHash": "0xdeadbeef...", "block": 84301 },
        "finalized": { "done": true,  "batchId": 91, "blobIndex": 3 },
        "validated": { "done": true,  "verdict": "CLEAN", "confidence": 0.97 }
      },
      "createdAt": "2026-05-20T14:10:00.000Z"
    }
  ]
}
```

Rate limit: 30 requests/min

---

### GET /player/sessions

Returns on-chain gaming sessions for the authenticated wallet from the SessionTracker contract.

**Auth required**

**Response**
```json
{
  "success": true,
  "sessions": [ ... ],
  "count": 14,
  "contractAddress": "0x...",
  "explorerUrl": "https://chainscan.0g.ai/address/0x..."
}
```

---

### GET /player/blockchain-stats

Returns session and leaderboard contract stats for the authenticated wallet.

**Auth required**

---

## 0G Dashboard

### GET /0g/dashboard

The main dashboard summary. Returns trust score, save pipeline status, recent activity, and contract links — everything a frontend needs for a "My Account" page.

**Auth required**

**Response**
```json
{
  "wallet": "0xabcd...",
  "summary": {
    "totalSaves": 12,
    "finalizedSaves": 10,
    "pendingSaves": 1,
    "failedSaves": 1,
    "anchoredSaves": 11,
    "totalDataStored": "49.2 KB"
  },
  "trustScore": {
    "score": 82,
    "label": "PLATINUM",
    "description": "Maximum trust. Saves are anchored, DA-finalized, and TEE-validated.",
    "breakdown": {
      "totalSaves": 12,
      "finalizedSaves": 10,
      "anchoredSaves": 11,
      "computeValidated": 8,
      "finalizedPercent": 83,
      "anchoredPercent": 91
    }
  },
  "latestSave": {
    "saveIndex": 12,
    "rootHash": "0x9f3a...",
    "coinSnapshot": 14200,
    "fileSize": "4.1 KB",
    "pipeline": { ... }
  },
  "recentActivity": [ ... ],
  "contracts": {
    "playerSaveAnchor": {
      "address": "0x...",
      "explorerUrl": "https://chainscan.0g.ai/address/0x..."
    }
  }
}
```

---

### GET /0g/activity

Chronological event feed for the authenticated wallet. Each event represents one step of the save pipeline completing.

**Auth required**

**Query parameters**

| Param | Type | Default |
|---|---|---|
| page | number | 1 |
| limit | number | 20 |

**Event types:** `SAVE_STORED`, `SAVE_ANCHORED`, `DA_FINALIZED`, `DA_FAILED`, `COMPUTE_VALIDATED`, `COMPUTE_REJECTED`

**Response**
```json
{
  "wallet": "0xabcd...",
  "page": 1,
  "totalPages": 2,
  "totalEvents": 38,
  "hasMore": true,
  "events": [
    {
      "id": "12-anchored",
      "type": "SAVE_ANCHORED",
      "saveIndex": 12,
      "timestamp": "2026-05-20T14:10:02.000Z",
      "title": "Save #12 anchored on-chain",
      "description": "Root hash recorded permanently on the 0G EVM blockchain at block 84301.",
      "status": "success",
      "data": { "txHash": "0xdeadbeef...", "block": 84301 },
      "explorerUrl": "https://chainscan.0g.ai/tx/0xdeadbeef..."
    }
  ]
}
```

---

### GET /0g/badge

Returns the trust badge for the authenticated wallet with a hint for reaching the next level.

**Auth required**

**Response**
```json
{
  "wallet": "0xabcd...",
  "badge": "GOLD",
  "score": 74,
  "description": "Strong verification coverage. Saves are anchored and DA-finalized.",
  "breakdown": { ... },
  "nextLevel": {
    "label": "PLATINUM",
    "hint": "Accumulate TEE-validated saves and reach 10+ total saves."
  }
}
```

---

### GET /0g/network

Returns the current status of each 0G network component. Pings the storage indexer and EVM RPC in real time. DA and Compute status is config-derived.

**No auth required**

**Response**
```json
{
  "timestamp": "2026-05-20T14:00:00.000Z",
  "overall": "healthy",
  "services": {
    "storage":  { "status": "online",      "latencyMs": 82,  "endpoint": "https://indexer-storage-turbo.0g.ai" },
    "chain":    { "status": "online",      "latencyMs": 104, "blockNumber": 1824301, "chainId": 16661 },
    "da":       { "status": "configured",  "endpoint": "disperser-testnet.0g.ai:51001", "protocol": "gRPC" },
    "compute":  { "status": "configured",  "endpoint": "https://router-api.0g.ai" }
  },
  "contracts": {
    "playerSaveAnchor": "0x...",
    "explorerUrl": "https://chainscan.0g.ai/address/0x..."
  }
}
```

---

### GET /0g/stats

Global server stats — total players, total saves, and pipeline verification breakdowns.

**No auth required**

**Response**
```json
{
  "players": {
    "total": 1240,
    "active": 312
  },
  "saves": {
    "total": 9820,
    "finalized": 8741,
    "anchored": 9100,
    "computeValidated": 4312,
    "pending": 141,
    "failed": 79,
    "totalDataStored": "38.4 MB"
  },
  "ai": {
    "totalModels": 84,
    "totalSampleBatches": 4201,
    "totalSamplesCollected": 381000
  },
  "contracts": {
    "playerSaveAnchor": "0x...",
    "session": "0x...",
    "leaderboard": "0x..."
  }
}
```

---

### GET /0g/proof/:wallet/:saveIndex

Returns a full proof certificate for a specific save. Useful for dispute resolution or displaying to players.

**No auth required**

**Response**
```json
{
  "certificate": {
    "wallet": "0xabcd...",
    "saveIndex": 7,
    "rootHash": "0x9f3a...",
    "issuedAt": "2026-05-20T14:10:00.000Z",
    "verified": true,
    "badge": "FULLY_VERIFIED"
  },
  "storage": {
    "rootHash": "0x9f3a...",
    "txHash": "0xabc...",
    "explorerUrl": "https://chainscan.0g.ai/tx/0xabc...",
    "fileSize": "4.1 KB",
    "checksum": "a3f1b9...",
    "network": "0G Storage"
  },
  "onChain": {
    "contractAddress": "0x...",
    "txHash": "0xdeadbeef...",
    "block": 84301,
    "chainId": 16661,
    "network": "0G Mainnet"
  },
  "da": {
    "status": "finalized",
    "finalized": true,
    "commitment": {
      "batchId": 91,
      "blobIndex": 3,
      "batchHeaderHash": "0xff00...",
      "referenceBlockNumber": 84280,
      "finalizedAt": "2026-05-20T14:10:15.000Z"
    }
  },
  "compute": {
    "status": "validated",
    "verdict": "CLEAN",
    "details": {
      "valid": true,
      "confidence": 0.97,
      "flags": [],
      "teeVerified": true,
      "providerAddress": "0x..."
    }
  }
}
```

---

### GET /0g/leaderboard/verified

Top 100 players, filtered to only include verified saves. The `filter` param controls what "verified" means.

**No auth required**

**Query parameters**

| Param | Value | Description |
|---|---|---|
| filter | `finalized` | Only DA-finalized saves (default) |
| filter | `anchored` | Only on-chain anchored saves |
| filter | `validated` | Only TEE-validated saves |

---

### GET /0g/explorer/:wallet

Public wallet page — all save history, trust badge, total data stored, and on-chain anchor status.

**No auth required**

---

### GET /0g/compute/stats

Anti-cheat and AI inference statistics from the 0G Compute layer.

**No auth required**

**Response**
```json
{
  "anticheat": {
    "totalValidations": 4312,
    "clean": 4289,
    "suspicious": 23,
    "skipped": 5508,
    "teeVerifiedRate": 0.98,
    "cleanRate": 0.995
  },
  "ai": {
    "totalModels": 84,
    "computeFallbacksServed": 1203,
    "strategyCallsServed": 441,
    "teeVerifiedRate": 1.0
  }
}
```

---

### GET /0g/player/overview/:wallet

A single call that returns everything about a player: profile, save stats, trust score, and AI training status. Designed for public profile pages on the frontend.

**No auth required**

**Response**
```json
{
  "wallet": "0xabcd...",
  "displayName": "Warrior_abcd12",
  "profile": {
    "level": 14,
    "exp": 28000,
    "totalTimePlayed": 7200
  },
  "resources": {
    "coin": 12400,
    "gem": 0,
    "stamina": 10
  },
  "trust": {
    "badge": "GOLD",
    "score": 74,
    "totalSaves": 12,
    "finalizedSaves": 10
  },
  "ai": {
    "status": "ready",
    "totalSamples": 820,
    "modelRootHash": "0x...",
    "trainedAt": "2026-05-19T11:00:00.000Z"
  },
  "latestSave": {
    "saveIndex": 12,
    "rootHash": "0x9f3a...",
    "daStatus": "finalized",
    "createdAt": "2026-05-20T14:10:00.000Z"
  }
}
```

---

## Behavioral AI

### POST /behavior/upload

Upload a batch of gameplay samples for behavioral cloning. Each sample is one frame of gameplay: what the game state was, and what the player did.

**No auth required** (wallet is in the body)

**Body**
```json
{
  "wallet": "0xabcd...",
  "sessionId": "optional-session-id",
  "samples": [
    {
      "state": {
        "posX": 100, "posY": 50,
        "velX": 2,   "velY": 0,
        "facingRight": true,
        "isGrounded": true,
        "hpPercent": 0.85,
        "playerState": "running",
        "enemies": [
          { "relX": 150, "relY": 0, "distance": 150, "state": "attacking", "hpPercent": 0.9 }
        ]
      },
      "action": {
        "horizontal": 1,
        "vertical": 0,
        "jump": false,
        "shoot": true,
        "grenade": false
      }
    }
  ]
}
```

**Response**
```json
{
  "success": true,
  "batchRootHash": "0x7f2a...",
  "received": 128,
  "totalSamples": 384,
  "trainingFired": false
}
```

When `totalSamples` reaches `AI_MIN_SAMPLES` (default 500), `trainingFired` will be `true` and training begins asynchronously.

---

### GET /behavior/status/:wallet

Returns the current training status, sample count, and model location.

**Response**
```json
{
  "wallet": "0xabcd...",
  "totalSamples": 820,
  "samplesNeeded": 0,
  "readyToTrain": true,
  "status": "ready",
  "batchCount": 7,
  "modelRootHash": "0x4a91...",
  "trainedAt": "2026-05-19T11:00:00.000Z",
  "errorMsg": null,
  "explorerUrl": "https://explorer.0g.ai/storage/0x4a91..."
}
```

Possible `status` values: `none` (no samples yet), `training` (in progress), `ready` (model available), `error` (training failed).

---

### POST /behavior/retrain/:wallet

Resets status to `none` and fires training again. Useful after adding more samples or clearing an error.

**Response**
```json
{ "success": true, "message": "Training started" }
```

---

## AI Inference

### POST /ai/predict

Get the next game action for a player's AI opponent. The response includes a `source` field indicating which layer produced the answer.

**Body**
```json
{
  "wallet": "0xabcd...",
  "state": {
    "posX": 100, "posY": 50,
    "velX": 2,   "velY": 0,
    "facingRight": true,
    "isGrounded": true,
    "hpPercent": 0.85,
    "enemies": [
      { "relX": 150, "relY": 0, "distance": 150, "state": "attacking", "hpPercent": 0.9 }
    ]
  }
}
```

**Response (TF.js model)**
```json
{
  "action": { "horizontal": 0.8, "vertical": 0.1, "jump": false, "shoot": true, "grenade": false },
  "confidence": 0.76,
  "source": "tfjs"
}
```

**Response (0G Compute fallback — no trained model yet)**
```json
{
  "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false },
  "confidence": 0.65,
  "reasoning": "Enemy at distance 150 with player HP at 85% — advance and engage.",
  "teeVerified": true,
  "providerAddress": "0x...",
  "source": "0g-compute"
}
```

**Response (fallback — both unavailable)**
```json
{
  "action": { "horizontal": 0, "vertical": 0, "jump": false, "shoot": false, "grenade": false },
  "confidence": 0,
  "source": "fallback"
}
```

This endpoint never returns an error status — Unity always gets a valid action object.

---

### POST /ai/strategy

Same as `/ai/predict` but always routed through 0G Compute with `verify_tee: true`. Returns a TEE-signed decision with a `chatId` that can be stored as an audit trail for Arena matches.

Latency: ~200ms. Cache the result on the Unity side for 1–2 seconds.

**Response**
```json
{
  "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false },
  "reasoning": "Enemy at distance 120, HP above 50% — advance and engage",
  "confidence": 0.65,
  "teeVerified": true,
  "providerAddress": "0x...",
  "chatId": "chat_x9f3a...",
  "billingCost": "1400000000000",
  "source": "0g-compute"
}
```

---

## Utility

### GET /

```json
"WarzoneWarrior 0G Backend Running"
```

### GET /stats

Global statistics across all players and saves.

### GET /contracts

Returns contract addresses and their purposes.

```json
{
  "network": "0G Mainnet",
  "chainId": 16661,
  "explorer": "https://chainscan.0g.ai",
  "contracts": {
    "sessionTracker":    { "address": "0x...", "purpose": "Tracks player gaming sessions" },
    "leaderboardTracker": { "address": "0x...", "purpose": "Tracks leaderboard snapshots" },
    "playerSaveAnchor":  { "address": "0x...", "purpose": "Anchors player save root hashes" }
  }
}
```

### GET /blockchain-info

Returns readiness status of the session and leaderboard on-chain services.
