# Warzone Warriors — API Reference

Base URL: `https://your-backend.com/warzone`

All authenticated endpoints require:
```
Authorization: Bearer <jwt>
```

JWT is issued by `POST /warzone/login`. The wallet address decoded from the JWT is the authoritative identity — it cannot be overridden by headers.

---

## Authentication

### POST /login
Issue a JWT for a wallet address.

**Request**
```json
{ "walletAddress": "0x1234..." }
```

**Response 200**
```json
{
  "success": true,
  "token": "eyJ...",
  "walletAddress": "0x1234..."
}
```

---

## 0G Decentralized Endpoints

### POST /save/binary
Upload a binary player save to 0G Storage.

**Auth:** JWT required  
**Rate limit:** 10/min  
**Content-Type:** `application/octet-stream`

**Headers**
```
Authorization: Bearer <jwt>
Content-Type:  application/octet-stream
X-Save-Index:  <integer>   (optional — anti-rollback hint)
```

**Body:** raw msgpack binary (serialized player state)

**Response 201**
```json
{
  "ok": true,
  "rootHash": "0xabc123...",
  "saveIndex": 5,
  "txHash": "0xdef456...",
  "size": 2048,
  "checksum": "sha256hex...",
  "pipeline": {
    "anchor": "queued",
    "da": "queued",
    "compute": "queued"
  }
}
```

**Response 409** — rollback rejected
```json
{
  "ok": false,
  "message": "Save index rollback detected — rejected",
  "currentSaveIndex": 7,
  "receivedSaveIndex": 3
}
```

**Notes:**
- The HTTP response returns as soon as 0G Storage upload completes (~1–3s).
- Chain anchoring, DA commitment, and Compute anti-cheat run in the background.
- Poll `GET /save/metadata` to check pipeline status.

---

### GET /load/binary
Download the latest binary save from 0G Storage.

**Auth:** JWT required (loads the authenticated player's own save only)  
**Rate limit:** 30/min

**Response 200**
```
Content-Type: application/octet-stream
X-Root-Hash: 0xabc123...
X-Save-Index: 5
X-Da-Status: finalized
X-Checksum-Sha256: sha256hex...
```
Body: raw msgpack binary

**Response 404**
```json
{ "ok": false, "message": "No save found for this wallet" }
```

---

### GET /save/metadata
Fetch metadata for a wallet's latest save. No auth required.

**Rate limit:** 60/min

**Query params**
```
wallet=0x1234...   (required)
```

**Response 200**
```json
{
  "ok": true,
  "wallet": "0x1234...",
  "rootHash": "0xabc123...",
  "saveIndex": 5,
  "fileSize": 2048,
  "checksum": "sha256hex...",
  "daStatus": "finalized",
  "daCommitment": {
    "requestId": "...",
    "batchId": 42,
    "blobIndex": 3,
    "batchHeaderHash": "0x...",
    "referenceBlockNumber": 1234567,
    "finalizedAt": "2025-01-01T12:00:00.000Z"
  },
  "computeStatus": "validated",
  "computeValidation": {
    "valid": true,
    "confidence": 0.95,
    "verdict": "CLEAN",
    "flags": [],
    "teeVerified": false
  },
  "anchorTxHash": "0xdef...",
  "anchorBlock": 987654,
  "onChain": {
    "rootHash": "0xabc123...",
    "saveIndex": 5,
    "timestamp": 1700000000,
    "explorerUrl": "https://chainscan.0g.ai/tx/0xdef..."
  },
  "savedAt": "2025-01-01T12:00:00.000Z"
}
```

---

### GET /verify
Run a 4-layer integrity check on a wallet's save. Public endpoint.

**Rate limit:** 20/min

**Query params**
```
wallet=0x1234...   (required)
```

**Response 200**
```json
{
  "ok": true,
  "wallet": "0x1234...",
  "rootHash": "0xabc123...",
  "saveIndex": 5,
  "layers": {
    "db": {
      "passed": true,
      "detail": "Record found, rootHash and saveIndex consistent"
    },
    "da": {
      "passed": true,
      "detail": "DA status: finalized — BLS-signed by 0G DA committee"
    },
    "checksum": {
      "passed": true,
      "detail": "File re-downloaded from 0G Storage, SHA-256 matches"
    },
    "compute": {
      "passed": true,
      "detail": "Compute verdict: CLEAN (confidence: 0.95)"
    }
  },
  "allPassed": true,
  "verifiedAt": "2025-01-01T12:00:00.000Z"
}
```

**What each layer means:**
| Layer | Passes when |
|---|---|
| `db` | A `PlayerSaveRecord` exists in MongoDB with matching rootHash |
| `da` | `daStatus === finalized` — 0G DA nodes signed the commitment |
| `checksum` | File re-downloaded from 0G Storage and SHA-256 matches stored checksum |
| `compute` | Compute verdict is `CLEAN` or `validated` with no rejected flags |

---

### GET /leaderboard/decentralized
Top-100 players ranked by coin balance, sourced from 0G DA-backed snapshots.

**Rate limit:** 30/min

**Response 200**
```json
{
  "ok": true,
  "source": "0g-da",
  "count": 100,
  "entries": [
    {
      "rank": 1,
      "walletAddress": "0x1234...",
      "name": "DragonSlayer",
      "coin": 95000,
      "rootHash": "0xabc...",
      "daStatus": "finalized",
      "saveIndex": 12,
      "savedAt": "2025-01-01T12:00:00.000Z",
      "verified": true
    }
  ]
}
```

**`verified: true`** means `daStatus === "finalized"` — the coin balance was committed to 0G DA and BLS-signed by the DA committee. It is not just a database value.

**Name fallback:** If a player has no registered name, their display name is `Warrior_<first 6 chars of wallet>` (deterministic — same on every request).

---

## UX Endpoints — Making 0G Visible to Users

These endpoints power the player-facing UI that shows the decentralized infrastructure in action.

---

### GET /dashboard
All-in-one player profile card. One call loads the entire 0G profile screen.

**Auth:** JWT required  
**Rate limit:** 60/min

**Response 200 — player has saves**
```json
{
  "ok": true,
  "wallet": "0x1234...",
  "hasData": true,
  "trustScore": 92,
  "rank": 14,
  "totalSaves": 25,
  "daFinalizedCount": 23,
  "computeCleanCount": 22,
  "latestSave": {
    "rootHash": "0xabc...",
    "saveIndex": 24,
    "fileSize": 2048,
    "coinSnapshot": 47500,
    "savedAt": "2025-01-01T12:00:00.000Z",
    "source": "game_save"
  },
  "pipeline": {
    "storage": { "status": "done",      "label": "Saved on 0G Storage",          "rootHash": "0xabc..." },
    "chain":   { "status": "done",      "label": "Anchored on 0G Chain",          "txHash": "0xdef...", "explorerUrl": "https://chainscan.0g.ai/tx/0xdef..." },
    "da":      { "status": "finalized", "label": "Finalised by 0G DA nodes",      "commitment": { "batchId": 42 } },
    "compute": { "status": "validated", "label": "Passed anti-cheat (0G Compute)","verdict": "CLEAN" }
  },
  "onChain": {
    "rootHash": "0xabc...",
    "saveIndex": 24,
    "timestamp": 1700000000
  }
}
```

**Response 200 — no saves yet**
```json
{
  "ok": true,
  "wallet": "0x1234...",
  "hasData": false,
  "message": "No saves found — play the game to see your 0G profile"
}
```

**`trustScore`** — percentage of total saves that have been DA-finalized (0–100). Display as a badge or progress ring.

---

### GET /save/history
Paginated save timeline. Shows every save with pipeline status badges.

**Auth:** JWT required  
**Rate limit:** 30/min

**Query params**
```
page=1     (default: 1)
limit=10   (default: 10, max: 50)
```

**Response 200**
```json
{
  "ok": true,
  "wallet": "0x1234...",
  "page": 1,
  "limit": 10,
  "total": 25,
  "totalPages": 3,
  "entries": [
    {
      "saveIndex": 24,
      "rootHash": "0xabc...",
      "fileSize": 2048,
      "coinSnapshot": 47500,
      "source": "game_save",
      "savedAt": "2025-01-01T12:00:00.000Z",
      "pipeline": {
        "storage": { "status": "done",      "label": "Stored on 0G Storage" },
        "chain":   { "status": "done",      "label": "Anchored on 0G Chain", "txHash": "0xdef...", "explorerUrl": "https://chainscan.0g.ai/tx/0xdef..." },
        "da":      { "status": "finalized", "label": "Finalised by 0G DA nodes" },
        "compute": { "status": "validated", "label": "Passed anti-cheat (0G Compute)", "verdict": "CLEAN" }
      },
      "fullyVerified": true
    }
  ]
}
```

**Frontend use:** Render each `pipeline` step as a badge row. `fullyVerified: true` = show a "fully verified" checkmark on that save.

---

### GET /save/pipeline/:rootHash
Live step-by-step pipeline progress for one save. Poll this after `POST /save/binary` to drive a progress tracker UI.

**Auth:** None (rootHash is a public content address)  
**Rate limit:** 60/min

**Params:** `:rootHash` — the rootHash returned by `POST /save/binary`

**Response 200**
```json
{
  "ok": true,
  "rootHash": "0xabc...",
  "wallet": "0x1234...",
  "saveIndex": 24,
  "progress": 75,
  "allDone": false,
  "savedAt": "2025-01-01T12:00:00.000Z",
  "steps": [
    {
      "id": "storage",
      "label": "0G Storage",
      "detail": "Binary save uploaded and content-addressed",
      "status": "done",
      "value": "0xabc..."
    },
    {
      "id": "chain",
      "label": "0G Chain Anchor",
      "detail": "rootHash written to PlayerSaveAnchor contract on 0G EVM",
      "status": "done",
      "value": "0xdef...",
      "explorerUrl": "https://chainscan.0g.ai/tx/0xdef..."
    },
    {
      "id": "da",
      "label": "0G Data Availability",
      "detail": "Commitment BLS-signed by 0G DA committee",
      "status": "pending",
      "value": null,
      "finalizedAt": null
    },
    {
      "id": "compute",
      "label": "0G Compute Anti-Cheat",
      "detail": "Save validated by TEE-attested AI inference",
      "status": "skipped",
      "value": null,
      "confidence": null
    }
  ]
}
```

**Frontend use:** Poll every 5–10 seconds after saving. Drive a 4-step progress bar with `steps[n].status`. Stop polling when `allDone: true`.

**Step statuses:**
| Status | Meaning |
|---|---|
| `done` | Complete |
| `pending` | In progress — still waiting |
| `finalized` | DA finality confirmed |
| `validated` | Compute passed |
| `failed` | Step failed |
| `skipped` | Not triggered for this save |

---

### GET /proof/:rootHash
Shareable public proof card for a specific save. Anyone can open this URL and independently verify the save is real.

**Auth:** None — fully public  
**Rate limit:** 30/min

**Response 200**
```json
{
  "ok": true,
  "proof": {
    "rootHash": "0xabc...",
    "wallet": "0x1234...",
    "displayName": "DragonSlayer",
    "saveIndex": 24,
    "coinSnapshot": 47500,
    "fileSize": 2048,
    "checksum": "sha256hex...",
    "savedAt": "2025-01-01T12:00:00.000Z",

    "storage": {
      "verified": true,
      "rootHash": "0xabc...",
      "note": "File is content-addressed on 0G Storage — rootHash is the Merkle root of the file"
    },

    "chain": {
      "verified": true,
      "txHash": "0xdef...",
      "block": 987654,
      "explorerUrl": "https://chainscan.0g.ai/tx/0xdef...",
      "contractUrl": "https://chainscan.0g.ai/address/0x...",
      "onChainRecord": { "rootHash": "0xabc...", "saveIndex": 24, "timestamp": 1700000000 }
    },

    "da": {
      "verified": true,
      "status": "finalized",
      "commitment": { "batchId": 42, "blobIndex": 3, "finalizedAt": "2025-01-01T12:02:00.000Z" },
      "note": "This commitment was BLS-signed by >2/3 of 0G DA nodes"
    },

    "compute": {
      "verified": true,
      "status": "validated",
      "verdict": "CLEAN",
      "confidence": 0.95,
      "flags": [],
      "teeVerified": false
    },

    "allVerified": true
  }
}
```

**Frontend use:** Link to `/proof/:rootHash` from the player's score or leaderboard entry as a "Verify on 0G" button. Anyone — judges, other players, auditors — can open this without logging in.

---

### GET /network/status
Live health check for all four 0G services. Use this to show a status banner in the UI so players know if a delay is from the network, not the game.

**Auth:** None  
**Rate limit:** 20/min

**Response 200**
```json
{
  "ok": true,
  "allOnline": true,
  "checkedAt": "2025-01-01T12:00:00.000Z",
  "services": {
    "storage": { "service": "0G Storage", "status": "online",  "latencyMs": 143, "endpoint": "https://indexer-storage-turbo.0g.ai" },
    "chain":   { "service": "0G Chain",   "status": "online",  "latencyMs": 210, "blockNumber": 1234567, "endpoint": "https://evmrpc.0g.ai" },
    "da":      { "service": "0G DA",      "status": "unknown", "latencyMs": null, "note": "gRPC — reachability shown on first save" },
    "compute": { "service": "0G Compute", "status": "online",  "latencyMs": 380 }
  }
}
```

**Service statuses:** `online` | `degraded` | `offline` | `unknown` | `not_configured`

**Frontend use:** Show a small status strip at the top of the game UI — green dot when `allOnline: true`, yellow/red with individual service names when degraded.

---

## Legacy JSON Endpoints (unchanged)

These endpoints are fully backward-compatible with existing Unity builds.

### GET /
Fetch player profile by wallet.

**Query:** `?walletAddress=0x...`

### POST /
Save player profile (JSON).

**Body:** `{ "walletAddress": "0x...", ...profileFields }`

This endpoint also triggers a background 0G Storage upload via dual-write — existing builds get 0G coverage automatically with no code changes.

### POST /login
Issue JWT. See Authentication section above.

### GET /leaderboard
Legacy leaderboard (MongoDB-backed).

### GET /dailyQuests
Daily quest list.


---

## Error Codes

| Status | Meaning |
|---|---|
| 400 | Bad request — missing or invalid parameters |
| 401 | Unauthorized — missing or invalid JWT |
| 403 | Forbidden — authenticated but not allowed (e.g., loading another player's save) |
| 404 | Not found — no save record for this wallet |
| 409 | Conflict — save index rollback rejected |
| 413 | Payload too large — binary save exceeds 5MB |
| 429 | Rate limit exceeded — see `Retry-After` header |
| 500 | Internal server error |
| 503 | 0G stack disabled (`ZG_ENABLED=false`) |

---

## Unity / React Native Integration

### Binary Save (msgpack)

```csharp
// Serialize player state to msgpack
byte[] saveBytes = MessagePackSerializer.Serialize(playerState);

// Send to backend
var request = new UnityWebRequest(baseUrl + "/save/binary", "POST");
request.uploadHandler = new UploadHandlerRaw(saveBytes);
request.downloadHandler = new DownloadHandlerBuffer();
request.SetRequestHeader("Content-Type", "application/octet-stream");
request.SetRequestHeader("Authorization", "Bearer " + jwt);
request.SetRequestHeader("X-Save-Index", saveIndex.ToString());

yield return request.SendWebRequest();

var json = JSON.Parse(request.downloadHandler.text);
string rootHash = json["rootHash"];
int newSaveIndex = json["saveIndex"].AsInt;
```

### Binary Load (msgpack)

```csharp
var request = UnityWebRequest.Get(baseUrl + "/load/binary");
request.SetRequestHeader("Authorization", "Bearer " + jwt);
request.downloadHandler = new DownloadHandlerBuffer();

yield return request.SendWebRequest();

string rootHash = request.GetResponseHeader("X-Root-Hash");
byte[] rawBytes = request.downloadHandler.data;

PlayerState state = MessagePackSerializer.Deserialize<PlayerState>(rawBytes);
```

### React Native (iframe session)
The JWT is issued at login and passed into the game iframe via `postMessage`. The game includes it in every `Authorization: Bearer <token>` header. No wallet popup or signing prompt is required during gameplay.

---

## DA Finality Times

| Network | Typical finality |
|---|---|
| 0G DA (current endpoint) | 60–240 seconds |

**Disperser:** `disperser-testnet.0g.ai:51001` is the production endpoint used by all 0G-integrated backends currently deployed. The 0G DA mainnet disperser does not have a public gRPC endpoint yet. Update `ZG_DA_DISPERSER` in `.env` when the mainnet endpoint ships — no code changes required.

The backend polls every 5 seconds up to `ZG_DA_POLL_TIMEOUT_MS` (default: 240,000ms). The HTTP save response is never blocked by DA — it completes in ~1–3 seconds. Use `GET /save/metadata` to poll `daStatus` after saving.
