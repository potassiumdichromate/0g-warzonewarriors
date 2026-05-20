# API Reference

**Base URL:** `https://zerog-warzonewarriors.onrender.com`

All authenticated routes require `Authorization: Bearer <JWT>` in the request header.  
All request/response bodies are `application/json` unless noted as binary.

---

## Quick Reference

| Method | Full URL | Auth | Description |
|---|---|---|---|
| GET | `https://zerog-warzonewarriors.onrender.com/auth/nonce` | No | Get signing nonce |
| POST | `https://zerog-warzonewarriors.onrender.com/auth/login` | No | Verify signature, get JWT |
| POST | `https://zerog-warzonewarriors.onrender.com/player/save/binary` | Yes | Upload save → 0G pipeline |
| GET | `https://zerog-warzonewarriors.onrender.com/player/load/binary` | Yes | Download latest save |
| GET | `https://zerog-warzonewarriors.onrender.com/player/save/metadata` | No | Save history + pipeline status |
| GET | `https://zerog-warzonewarriors.onrender.com/player/verify` | No | Multi-layer save verification |
| GET | `https://zerog-warzonewarriors.onrender.com/player/leaderboard/decentralized` | No | DA-verified leaderboard |
| GET | `https://zerog-warzonewarriors.onrender.com/player/profile` | Yes | Full player profile |
| PATCH | `https://zerog-warzonewarriors.onrender.com/player/profile` | Yes | Update profile fields |
| GET | `https://zerog-warzonewarriors.onrender.com/player/profile/:wallet` | No | Public profile |
| GET | `https://zerog-warzonewarriors.onrender.com/player/leaderboard` | No | Top players by coin |
| GET | `https://zerog-warzonewarriors.onrender.com/player/history` | Yes | Paginated save history |
| GET | `https://zerog-warzonewarriors.onrender.com/player/sessions` | Yes | On-chain sessions |
| GET | `https://zerog-warzonewarriors.onrender.com/player/blockchain-stats` | Yes | Contract stats |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/dashboard` | Yes | Trust score + activity |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/activity` | Yes | Event feed |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/badge` | Yes | Trust badge |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/player/history` | Yes | Save history with pipeline |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/stats` | No | Global server stats |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/saves/recent` | No | Latest saves feed |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/compute/stats` | No | Anti-cheat + AI stats |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/player/overview/:wallet` | No | Public player card |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/network` | No | 0G service health |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/leaderboard/verified` | No | Verified leaderboard |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/proof/:wallet/:saveIndex` | No | Proof certificate |
| GET | `https://zerog-warzonewarriors.onrender.com/0g/explorer/:wallet` | No | Wallet explorer |
| POST | `https://zerog-warzonewarriors.onrender.com/behavior/upload` | No | Upload sample batch |
| GET | `https://zerog-warzonewarriors.onrender.com/behavior/status/:wallet` | No | Training status |
| POST | `https://zerog-warzonewarriors.onrender.com/behavior/retrain/:wallet` | No | Force re-train |
| POST | `https://zerog-warzonewarriors.onrender.com/ai/predict` | No | Hybrid AI action |
| POST | `https://zerog-warzonewarriors.onrender.com/ai/strategy` | No | TEE-verified AI action |
| GET | `https://zerog-warzonewarriors.onrender.com/` | No | Health check |
| GET | `https://zerog-warzonewarriors.onrender.com/stats` | No | Global stats |
| GET | `https://zerog-warzonewarriors.onrender.com/contracts` | No | Contract addresses |
| GET | `https://zerog-warzonewarriors.onrender.com/blockchain-info` | No | Contract readiness |

---

## Authentication

### GET /auth/nonce

**Full URL:** `https://zerog-warzonewarriors.onrender.com/auth/nonce`

Returns a nonce and a pre-formatted sign-in message for the given wallet. The nonce expires after 5 minutes.

**Query parameters**

| Param | Type | Required |
|---|---|---|
| wallet | string (0x address) | Yes |

**Request**
```
GET https://zerog-warzonewarriors.onrender.com/auth/nonce?wallet=0xAbCd1234...
```

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/auth/nonce?wallet=0xAbCd1234..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
  "nonce": "k9f2m7",
  "message": "Sign in to WarzoneWarrior\n\nWallet: 0xabcd1234...\nNonce: k9f2m7\nIssued At: 2026-05-20T14:00:00.000Z",
  "issuedAt": "2026-05-20T14:00:00.000Z",
  "expiresIn": 300
}
```

Rate limit: 10 requests/min

---

### POST /auth/login

**Full URL:** `https://zerog-warzonewarriors.onrender.com/auth/login`

Verifies the wallet signature and returns a JWT valid for 7 days.

**Body**

| Field | Type | Required |
|---|---|---|
| wallet | string | Yes |
| signature | string | Yes |
| nonce | string | Yes |

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xabcd1234...",
    "signature": "0x1a2b3c...",
    "nonce": "k9f2m7"
  }'
```

**Response**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "wallet": "0xabcd1234...",
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

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/save/binary`

Saves the player's current state. The game sends a WZSV-encoded binary. The backend immediately returns a save receipt, then runs the 0G pipeline (storage upload → on-chain anchor → DA dispersal → compute validation) in the background.

**Headers**
```
Authorization: Bearer <token>
Content-Type: application/octet-stream
```

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/player/save/binary" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..." \
  -H "Content-Type: application/octet-stream" \
  --data-binary @save.wzsv
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

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/load/binary`

Returns the latest save as a WZSV binary. Unity deserializes this and writes each field back into `ProfileManager`.

**Headers**
```
Authorization: Bearer <token>
```

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/load/binary" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..." \
  -o save.wzsv
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

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/save/metadata?wallet=0x...`

Returns save history and pipeline status for any wallet. No auth required.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/save/metadata?wallet=0xabcd1234..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
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

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/verify?wallet=0x...`

Runs a multi-layer verification check on a wallet's latest save.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/verify?wallet=0xabcd1234..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
  "verified": true,
  "checks": {
    "dbRecord":         { "pass": true, "saveIndex": 4 },
    "daFinalized":      { "pass": true, "batchId": 91  },
    "checksumMatch":    { "pass": true                 },
    "computeValidated": { "pass": true, "verdict": "CLEAN", "confidence": 0.97 }
  }
}
```

Rate limit: 20 requests/min

---

### GET /player/leaderboard/decentralized

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/leaderboard/decentralized`

Top 100 players ranked by coin, filtered to only show saves that have been DA-finalized.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/leaderboard/decentralized"
```

**Response**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0xabcd1234...",
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

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/profile`

Returns the full WarzonePlayerProfile for the authenticated wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/profile" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Response**
```json
{
  "walletAddress": "0xabcd1234...",
  "PlayerProfile": { "level": 14, "exp": 28000, "totalTimePlayed": 7200 },
  "PlayerResources": { "coin": 12400, "gem": 0, "stamina": 10, "medal": 3, "tournamentTicket": 1 },
  "PlayerRambos": { "0": { "id": 0, "level": 3, "isNew": false } },
  "PlayerGuns": { "0": { "id": 0, "level": 2, "ammo": 120, "isNew": false } },
  "PlayerCampaignStageProgress": { "1.1": [true, true, false] }
}
```

---

### PATCH /player/profile

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/profile`

Partially updates the authenticated player's profile. Only fields you send are changed.

**curl**
```bash
curl -X PATCH "https://zerog-warzonewarriors.onrender.com/player/profile" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..." \
  -H "Content-Type: application/json" \
  -d '{ "PlayerResources": { "coin": 15000, "gem": 5 }, "PlayerProfile": { "level": 15 } }'
```

Returns the full updated profile.

---

### GET /player/profile/:wallet

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/profile/0xabcd1234...`

Public profile lookup. No auth required. Wallet address is stripped from the response.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/profile/0xabcd1234..."
```

---

### GET /player/leaderboard

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/leaderboard`

Top players ranked by coin. Add `?wallet=0x...` to also record a leaderboard snapshot on-chain.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/leaderboard?limit=50"
```

**Response**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0xabcd1234...",
      "displayName": "Warrior_abcd12",
      "PlayerResources": { "coin": 88400, "gem": 12, "stamina": 10 },
      "PlayerProfile":   { "level": 42, "exp": 184000 }
    }
  ],
  "total": 83
}
```

---

### GET /player/history

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/player/history`

Paginated save history with full pipeline status for the authenticated wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/player/history?page=1&limit=20" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Query parameters**

| Param | Type | Default |
|---|---|---|
| page | number | 1 |
| limit | number | 20 |

**Response**
```json
{
  "wallet": "0xabcd1234...",
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
      "badge": "FULLY_VERIFIED",
      "pipeline": {
        "stored":    { "done": true, "rootHash": "0x9f3a...", "fileSize": "4.1 KB" },
        "anchored":  { "done": true, "txHash": "0xdeadbeef...", "block": 84301 },
        "finalized": { "done": true, "batchId": 91, "blobIndex": 3 },
        "validated": { "done": true, "verdict": "CLEAN", "confidence": 0.97 }
      },
      "createdAt": "2026-05-20T14:10:00.000Z"
    }
  ]
}
```

Rate limit: 30 requests/min

---

### GET /player/sessions

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/sessions`

On-chain gaming sessions for the authenticated wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/sessions" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Response**
```json
{
  "success": true,
  "sessions": [],
  "count": 14,
  "contractAddress": "0x...",
  "explorerUrl": "https://chainscan.0g.ai/address/0x..."
}
```

---

### GET /player/blockchain-stats

**Full URL:** `https://zerog-warzonewarriors.onrender.com/player/blockchain-stats`

Session and leaderboard contract stats for the authenticated wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/player/blockchain-stats" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

---

## 0G Dashboard

### GET /0g/dashboard

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/dashboard`

The main dashboard summary. Trust score, save pipeline status, recent activity, and contract links.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/dashboard" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
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
    "pipeline": { "stored": { "done": true }, "anchored": { "done": true }, "finalized": { "done": true }, "validated": { "done": true } }
  },
  "recentActivity": [],
  "contracts": {
    "playerSaveAnchor": { "address": "0x...", "explorerUrl": "https://chainscan.0g.ai/address/0x..." }
  }
}
```

Rate limit: 30 requests/min

---

### GET /0g/activity

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/activity`

Chronological event feed for the authenticated wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/activity?page=1&limit=20" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Query parameters**

| Param | Type | Default |
|---|---|---|
| page | number | 1 |
| limit | number | 20 |

**Event types:** `SAVE_STORED`, `SAVE_ANCHORED`, `DA_FINALIZED`, `DA_FAILED`, `COMPUTE_VALIDATED`, `COMPUTE_REJECTED`

**Response**
```json
{
  "wallet": "0xabcd1234...",
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

Rate limit: 30 requests/min

---

### GET /0g/badge

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/badge`

Trust badge for the authenticated wallet with a hint for the next level.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/badge" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
  "badge": "GOLD",
  "score": 74,
  "description": "Strong verification coverage. Saves are anchored and DA-finalized.",
  "breakdown": {
    "totalSaves": 12,
    "finalizedSaves": 9,
    "anchoredSaves": 11,
    "computeValidated": 4,
    "finalizedPercent": 75,
    "anchoredPercent": 91
  },
  "nextLevel": {
    "label": "PLATINUM",
    "hint": "Accumulate TEE-validated saves and reach 10+ total saves."
  }
}
```

Rate limit: 30 requests/min

---

### GET /0g/player/history

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/player/history`

Paginated save history with full per-save pipeline breakdown. Auth required.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/player/history?page=1&limit=20" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
```

See response format under [GET /player/history](#get-playerhistory) — identical shape.

Rate limit: 30 requests/min

---

### GET /0g/stats

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/stats`

Global server stats. No auth required.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/stats"
```

**Response**
```json
{
  "players": { "total": 1240 },
  "saves": {
    "total": 9820,
    "finalized": 8741,
    "anchored": 9100,
    "computeValidated": 4312,
    "pending": 141,
    "failed": 79,
    "totalDataStored": "38.4 MB",
    "totalDataStoredBytes": 40265881
  },
  "ai": {
    "totalModels": 84,
    "readyModels": 71,
    "totalSamplesCollected": 381000,
    "totalSampleBatches": 4201
  },
  "contracts": {
    "playerSaveAnchor": "0x...",
    "session": "0x...",
    "leaderboard": "0x..."
  }
}
```

Rate limit: 30 requests/min

---

### GET /0g/saves/recent

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/saves/recent`

Latest saves across all players. Wallet addresses are partially masked.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/saves/recent?limit=20"
```

**Query parameters**

| Param | Type | Default | Max |
|---|---|---|---|
| limit | number | 20 | 50 |

**Response**
```json
{
  "total": 20,
  "saves": [
    {
      "wallet": "0xabcd...1234",
      "saveIndex": 7,
      "rootHash": "0x9f3a...",
      "coinSnapshot": 14200,
      "fileSize": "4.1 KB",
      "badge": "FULLY_VERIFIED",
      "daStatus": "finalized",
      "computeStatus": "validated",
      "explorerUrl": "https://chainscan.0g.ai/tx/0xdeadbeef...",
      "savedAt": "2026-05-20T14:10:00.000Z"
    }
  ]
}
```

Rate limit: 30 requests/min

---

### GET /0g/compute/stats

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/compute/stats`

Anti-cheat and AI inference statistics.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/compute/stats"
```

**Response**
```json
{
  "anticheat": {
    "totalValidations": 4312,
    "clean": 4289,
    "suspicious": 23,
    "skipped": 5508,
    "teeVerifiedCount": 4226,
    "teeVerifiedRate": 0.98,
    "cleanRate": 0.995
  },
  "ai": {
    "readyModels": 71,
    "model": "0GM-1.0-35B-A3B",
    "anticheatModel": "deepseek/deepseek-chat-v3-0324",
    "configured": true
  }
}
```

Rate limit: 20 requests/min

---

### GET /0g/player/overview/:wallet

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/player/overview/0xabcd1234...`

Everything about a player in one call. Designed for public profile pages.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/player/overview/0xabcd1234..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
  "displayName": "Warrior_abcd12",
  "profile": { "level": 14, "exp": 28000, "totalTimePlayed": 7200 },
  "resources": { "coin": 12400, "gem": 0, "stamina": 10, "medal": 3 },
  "trust": {
    "badge": "GOLD",
    "score": 74,
    "totalSaves": 12,
    "finalizedSaves": 10
  },
  "ai": {
    "status": "ready",
    "totalSamples": 820,
    "modelRootHash": "0x4a91...",
    "trainedAt": "2026-05-19T11:00:00.000Z"
  },
  "latestSave": {
    "saveIndex": 12,
    "rootHash": "0x9f3a...",
    "daStatus": "finalized",
    "badge": "FULLY_VERIFIED",
    "createdAt": "2026-05-20T14:10:00.000Z"
  }
}
```

Rate limit: 30 requests/min

---

### GET /0g/network

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/network`

Live health status of each 0G service.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/network"
```

**Response**
```json
{
  "timestamp": "2026-05-20T14:00:00.000Z",
  "overall": "healthy",
  "services": {
    "storage": { "status": "online",     "latencyMs": 82,  "endpoint": "https://indexer-storage-turbo.0g.ai", "label": "0G Storage Indexer" },
    "chain":   { "status": "online",     "latencyMs": 104, "blockNumber": 1824301, "chainId": 16661, "endpoint": "https://evmrpc.0g.ai" },
    "da":      { "status": "configured", "endpoint": "disperser-testnet.0g.ai:51001", "protocol": "gRPC", "label": "0G DA Disperser" },
    "compute": { "status": "configured", "endpoint": "https://router-api.0g.ai", "label": "0G Compute (TEE anti-cheat)" }
  },
  "contracts": {
    "playerSaveAnchor": "0x...",
    "explorerUrl": "https://chainscan.0g.ai/address/0x..."
  }
}
```

Rate limit: 20 requests/min

---

### GET /0g/leaderboard/verified

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/leaderboard/verified`

Top 100 players filtered to only include verified saves.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/leaderboard/verified?filter=finalized"
```

**Query parameters**

| filter value | Description |
|---|---|
| `finalized` | Only DA-finalized saves (default) |
| `anchored` | Only on-chain anchored saves |
| `validated` | Only TEE-validated saves |

Rate limit: 30 requests/min

---

### GET /0g/proof/:wallet/:saveIndex

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/proof/0xabcd1234.../7`

Full proof certificate for a specific save.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/proof/0xabcd1234.../7"
```

**Response**
```json
{
  "certificate": {
    "wallet": "0xabcd1234...",
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
    "txUrl": "https://chainscan.0g.ai/tx/0xdeadbeef...",
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

Rate limit: 20 requests/min

---

### GET /0g/explorer/:wallet

**Full URL:** `https://zerog-warzonewarriors.onrender.com/0g/explorer/0xabcd1234...`

Public wallet page — all save history, trust badge, total data stored, on-chain anchor status.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/0g/explorer/0xabcd1234..."
```

Rate limit: 30 requests/min

---

## Behavioral AI

### POST /behavior/upload

**Full URL:** `https://zerog-warzonewarriors.onrender.com/behavior/upload`

Upload a batch of gameplay samples for behavioral cloning. Samples are stored on 0G Storage — not in MongoDB.

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/behavior/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xabcd1234...",
    "sessionId": "session-001",
    "samples": [
      {
        "state": {
          "posX": 100, "posY": 50, "velX": 2, "velY": 0,
          "facingRight": true, "isGrounded": true, "hpPercent": 0.85,
          "enemies": [{ "relX": 150, "relY": 0, "distance": 150, "state": "attacking", "hpPercent": 0.9 }]
        },
        "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false }
      }
    ]
  }'
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

When `totalSamples` reaches 500 (default), `trainingFired` will be `true` and training begins asynchronously.

---

### GET /behavior/status/:wallet

**Full URL:** `https://zerog-warzonewarriors.onrender.com/behavior/status/0xabcd1234...`

Training status, sample count, and model location for a wallet.

**curl**
```bash
curl "https://zerog-warzonewarriors.onrender.com/behavior/status/0xabcd1234..."
```

**Response**
```json
{
  "wallet": "0xabcd1234...",
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

`status` values: `none` → `training` → `ready` (or `error` on failure)

---

### POST /behavior/retrain/:wallet

**Full URL:** `https://zerog-warzonewarriors.onrender.com/behavior/retrain/0xabcd1234...`

Resets status and fires training again. Useful after an error or after adding more samples.

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/behavior/retrain/0xabcd1234..."
```

**Response**
```json
{ "success": true, "message": "Training started" }
```

---

## AI Inference

### POST /ai/predict

**Full URL:** `https://zerog-warzonewarriors.onrender.com/ai/predict`

Get the next game action. Response `source` field tells you which layer answered: `tfjs`, `0g-compute`, or `fallback`. Never returns an error — always returns a valid action.

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/ai/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xabcd1234...",
    "state": {
      "posX": 100, "posY": 50, "velX": 2, "velY": 0,
      "facingRight": true, "isGrounded": true, "hpPercent": 0.85,
      "enemies": [{ "relX": 150, "relY": 0, "distance": 150, "state": "attacking", "hpPercent": 0.9 }]
    }
  }'
```

**Response — TF.js model trained**
```json
{
  "action": { "horizontal": 0.8, "vertical": 0.1, "jump": false, "shoot": true, "grenade": false },
  "confidence": 0.76,
  "source": "tfjs"
}
```

**Response — no model yet, 0G Compute fallback**
```json
{
  "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false },
  "confidence": 0.65,
  "reasoning": "Enemy at distance 150 with HP at 85% — advance and engage.",
  "teeVerified": true,
  "providerAddress": "0x...",
  "source": "0g-compute"
}
```

**Response — both unavailable**
```json
{
  "action": { "horizontal": 0, "vertical": 0, "jump": false, "shoot": false, "grenade": false },
  "confidence": 0,
  "source": "fallback"
}
```

---

### POST /ai/strategy

**Full URL:** `https://zerog-warzonewarriors.onrender.com/ai/strategy`

Always routes through 0G Compute with TEE verification. Returns a signed decision with `chatId` for Arena audit trails. Latency ~200ms — cache on the Unity side for 1–2 seconds.

**curl**
```bash
curl -X POST "https://zerog-warzonewarriors.onrender.com/ai/strategy" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xabcd1234...",
    "state": {
      "posX": 100, "posY": 50, "velX": 2, "velY": 0,
      "facingRight": true, "isGrounded": true, "hpPercent": 0.85,
      "enemies": [{ "relX": 150, "relY": 0, "distance": 150, "state": "attacking", "hpPercent": 0.9 }]
    }
  }'
```

**Response**
```json
{
  "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false },
  "reasoning": "Enemy at distance 120, HP above 50% — advance and engage",
  "confidence": 0.65,
  "teeVerified": true,
  "providerAddress": "0x7a3b...",
  "chatId": "chat_x9f3a...",
  "billingCost": "1400000000000",
  "source": "0g-compute"
}
```

---

## Utility

### GET /

**Full URL:** `https://zerog-warzonewarriors.onrender.com/`

```bash
curl "https://zerog-warzonewarriors.onrender.com/"
# → "WarzoneWarrior 0G Backend Running"
```

---

### GET /stats

**Full URL:** `https://zerog-warzonewarriors.onrender.com/stats`

```bash
curl "https://zerog-warzonewarriors.onrender.com/stats"
```

---

### GET /contracts

**Full URL:** `https://zerog-warzonewarriors.onrender.com/contracts`

```bash
curl "https://zerog-warzonewarriors.onrender.com/contracts"
```

**Response**
```json
{
  "network": "0G Mainnet",
  "chainId": 16661,
  "explorer": "https://chainscan.0g.ai",
  "contracts": {
    "sessionTracker":     { "address": "0x...", "purpose": "Tracks player gaming sessions" },
    "leaderboardTracker": { "address": "0x...", "purpose": "Tracks leaderboard snapshots" },
    "playerSaveAnchor":   { "address": "0x...", "purpose": "Anchors player save root hashes" }
  }
}
```

---

### GET /blockchain-info

**Full URL:** `https://zerog-warzonewarriors.onrender.com/blockchain-info`

```bash
curl "https://zerog-warzonewarriors.onrender.com/blockchain-info"
```

Returns readiness status of the session and leaderboard on-chain services.
