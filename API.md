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

### POST /iap/purchase
**Auth:** JWT required  
In-app purchase via Somnia IAP contract.

### GET /iap/purchase-status
**Auth:** JWT required  
Check purchase transaction status.

### GET /iap/pricing
Coin and gem pack prices.

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
| 0G DA testnet | 60–120 seconds |
| 0G DA mainnet | TBD (check 0G docs) |

The backend polls every 5 seconds up to `ZG_DA_POLL_TIMEOUT_MS` (default: 120,000ms). The HTTP save response is never blocked by DA — it completes in ~1–3 seconds. Use `GET /save/metadata` to poll `daStatus` after saving.
