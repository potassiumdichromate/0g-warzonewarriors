# Warzone Warriors — API Reference

> Base URL: `https://api.warzonewarriors.xyz/warzone`  
> All requests from Unity use `Content-Type: application/json` unless noted.  
> JWT token from `/login` required where marked **[AUTH]**.

---

## Authentication

### POST /login
Login or register a player by wallet address. Returns JWT.

**Request:**
```json
{
  "walletAddress": "0xabc123...",
  "walletProviderType": "metamask"
}
```
**Response `200`:**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "walletAddress": "0xabc123...",
    "isNewUser": false
  }
}
```

---

## Player Profile (Legacy JSON — existing Unity builds)

### GET /
Get player profile by wallet address.

**Query:** `?walletAddress=0xabc123...`

**Response `200`:** Full PlayerProfile JSON (same shape as Mongoose document).

---

### POST /
Save player profile (full JSON body). Also triggers 0G Storage dual-write in background.

**Request:**
```json
{
  "walletAddress": "0xabc123...",
  "PlayerProfile": { "level": 5, "exp": 1200 },
  "PlayerResources": { "coin": 4500, "gem": 20, "stamina": 0, "medal": 0 },
  "PlayerGuns": { "0": { "id": 0, "level": 1, "ammo": 0, "isNew": false } },
  "PlayerRambos": { "0": { "id": 0, "level": 2 } },
  "PlayerBoosters": { "Hp": 1, "Damage": 0 }
}
```
**Response `200`:** Saved profile JSON.

---

## 0G Storage — Binary Save / Load (New Unity path)

### POST /save/binary  `[AUTH optional]`
Upload a binary (msgpack) player save to 0G Storage.  
Anchor rootHash on 0G chain + DA commitment run in background.

**Headers:**
```
Content-Type: application/octet-stream
X-Wallet-Address: 0xabc123...
X-Save-Index: 42           (optional — backend infers if omitted)
```
**Body:** Raw msgpack binary (Unity serialises with MessagePack-CSharp)

**Response `201`:**
```json
{
  "ok": true,
  "rootHash": "0x3a9f1c2d...",
  "txHash": "0xb7e2a4c1...",
  "saveIndex": 42,
  "size": 1842,
  "daStatus": "pending",
  "message": "Save uploaded to 0G Storage. DA commitment running in background."
}
```

**Error `409` (rollback rejected):**
```json
{
  "ok": false,
  "message": "Save index rollback detected — rejected",
  "currentSaveIndex": 42,
  "receivedSaveIndex": 10
}
```

---

### GET /load/binary
Download the latest binary save for a wallet from 0G Storage.  
Merkle-proof verified on download — tampered data throws before returning.

**Query:** `?wallet=0xabc123...`

**Response `200`:**
```
Content-Type: application/octet-stream
X-Root-Hash: 0x3a9f1c2d...
X-Save-Index: 42
X-Da-Status: finalized
X-Checksum-Sha256: f3a1b2...

<raw msgpack binary body>
```

**Error `404`:**
```json
{ "ok": false, "message": "No save found for this wallet on 0G Storage" }
```

---

### GET /save/metadata
Get metadata for a wallet's latest save — rootHash, on-chain anchor, DA commitment.  
Unity can show players their own on-chain proof link.

**Query:** `?wallet=0xabc123...`

**Response `200`:**
```json
{
  "ok": true,
  "hasSave": true,
  "walletAddress": "0xabc123...",
  "rootHash": "0x3a9f1c2d...",
  "storageTxHash": "0xb7e2a4c1...",
  "saveIndex": 42,
  "fileSize": 1842,
  "coinSnapshot": 4500,
  "onChainAnchor": {
    "rootHash": "0x3a9f1c2d...",
    "saveIndex": 42,
    "timestamp": 1746532800
  },
  "daStatus": "finalized",
  "daCommitment": {
    "requestId": "a3b4c5...",
    "batchId": 1021,
    "blobIndex": 3,
    "batchHeaderHash": "d9e1f2...",
    "referenceBlockNumber": 998021,
    "finalizedAt": "2026-05-06T10:00:00.000Z"
  },
  "computeStatus": "validated",
  "computeVerdict": "CLEAN",
  "savedAt": "2026-05-06T09:58:00.000Z"
}
```

---

### GET /verify
4-layer integrity check for a specific rootHash.  
Use this to prove to auditors / players that a save is legitimate.

**Query:** `?wallet=0xabc123...&rootHash=0x3a9f1c2d...`

**Response `200` — all clean:**
```json
{
  "ok": true,
  "verdict": "CLEAN",
  "checks": {
    "dbRecord": true,
    "daFinalized": true,
    "daProofValid": true,
    "checksumValid": true,
    "computeValid": true
  },
  "daStatus": "finalized",
  "computeVerdict": "CLEAN",
  "rootHash": "0x3a9f1c2d...",
  "saveIndex": 42,
  "savedAt": "2026-05-06T09:58:00.000Z"
}
```

**Response `200` — tampered:**
```json
{
  "ok": true,
  "verdict": "TAMPERED",
  "checks": {
    "dbRecord": true,
    "daFinalized": true,
    "daProofValid": true,
    "checksumValid": false,
    "computeValid": true
  }
}
```

---

## Leaderboards

### GET /leaderboard
Legacy leaderboard from MongoDB — top 100 by coins.

**Response `200`:** Array of player objects with `name`, `PlayerResources.coin`, etc.

---

### GET /leaderboard/decentralized
Leaderboard derived from 0G Storage saves (`PlayerSaveRecord.coinSnapshot`).  
Each entry shows its DA status — `verified: true` means the score has a BLS proof.

**Response `200`:**
```json
{
  "ok": true,
  "source": "0g-da",
  "count": 100,
  "entries": [
    {
      "rank": 1,
      "walletAddress": "0xabc123...",
      "name": "SnipeKing42",
      "coin": 98500,
      "rootHash": "0x3a9f1c2d...",
      "daStatus": "finalized",
      "saveIndex": 187,
      "savedAt": "2026-05-06T09:58:00.000Z",
      "verified": true
    }
  ]
}
```

> `verified: true` = score was BLS-signed by >2/3 of 0G DA nodes.

---

## Daily Quests & Achievements

### GET /dailyQuests
**Query:** `?walletAddress=0x...`  
**Response:** `{ PlayerDailyQuestData: [...] }`

### GET /dailyQuests/type/:type
**Query:** `?walletAddress=0x...`  
**Response:** `{ completed, score, isClaimed, reward }`

### GET /achieveQuests/type/:type
**Query:** `?walletAddress=0x...`  
**Response:** `{ completed, score, isClaimed, reward }`

---

## Player Names

### POST /name
Check if a display name is available.
```json
{ "name": "SnipeKing42" }
```
**Response:** `{ "success": true, "message": "Name is available" }`

### POST /saveName  `[AUTH]`
Save a display name for the authenticated wallet.
```json
{ "name": "SnipeKing42", "walletAddress": "0x..." }
```

### GET /name  `[AUTH]`
Get the display name for the authenticated wallet.  
**Response:** `{ "name": "SnipeKing42", "isDefault": false }`

---

## In-App Purchases (Somnia chain — unchanged)

### POST /iap/purchase  `[AUTH]`
Submit an IAP transaction for verification and delivery.

**Request:**
```json
{
  "category": "Coins",
  "product": "1000",
  "orderId": "ord_abc123",
  "txHash": "0xabcdef..."
}
```
**Categories:** `Coins` | `Gems` | `Guns`  
**Coin products:** `100` | `500` | `1000` | `2000`  
**Gem products:** `100` | `300` | `500` | `1000`  
**Gun products:** `Shotgun` | `AWP` | `Tesla` | `Laser` | `Fireball` | `FlameThrower` | etc.

**Response `202`:**
```json
{
  "ok": true,
  "message": "Purchase accepted for background verification",
  "data": {
    "walletAddress": "0x...",
    "PlayerResources": { "coin": 5500, "gem": 20 },
    "purchase": { "status": "pending_verification", "orderId": "ord_abc123" }
  }
}
```

### GET /iap/purchase-status  `[AUTH]`
**Query:** `?orderId=ord_abc123` or `?txHash=0xabcdef...`  
**Response:** Same shape as purchase response with updated `status`.

### GET /iap/pricing
Returns all pack prices.
```json
{
  "ok": true,
  "data": {
    "coins": [
      { "product": "100",  "amount": 100,  "priceEth": "0.5" },
      { "product": "500",  "amount": 500,  "priceEth": "2"   },
      { "product": "1000", "amount": 1000, "priceEth": "4"   },
      { "product": "2000", "amount": 2000, "priceEth": "7.5" }
    ],
    "gems": [
      { "product": "100",  "amount": 100,  "priceEth": "0.5" },
      { "product": "300",  "amount": 300,  "priceEth": "1.5" },
      { "product": "500",  "amount": 500,  "priceEth": "2.5" },
      { "product": "1000", "amount": 1000, "priceEth": "5"   }
    ]
  }
}
```

---

## Trash Talk

### GET /trash-talk/line
Returns a pre-generated trash talk line (instant, no AI wait).
```json
{ "line": "Your aim is so bad you couldn't hit the floor if you fell.", "type": "loser" }
```

### POST /trash-talk/generate
Triggers background generation of new lines.

---

## Health

### GET /health
```json
{ "status": "OK", "timestamp": "2026-05-06T10:00:00.000Z" }
```

---

## Unity Integration Guide

### Binary Save (C# — MessagePack-CSharp)

```csharp
// Serialise
byte[] binary = MessagePackSerializer.Serialize(playerData);

UnityWebRequest req = new UnityWebRequest(baseUrl + "/warzone/save/binary", "POST");
req.uploadHandler   = new UploadHandlerRaw(binary);
req.downloadHandler = new DownloadHandlerBuffer();
req.SetRequestHeader("Content-Type", "application/octet-stream");
req.SetRequestHeader("X-Wallet-Address", walletAddress);
req.SetRequestHeader("X-Save-Index", saveIndex.ToString());
yield return req.SendWebRequest();

// Parse response
var res = JsonUtility.FromJson<SaveResponse>(req.downloadHandler.text);
Debug.Log("Saved to 0G: " + res.rootHash);
```

### Binary Load (C# — MessagePack-CSharp)

```csharp
UnityWebRequest req = UnityWebRequest.Get(baseUrl + "/warzone/load/binary?wallet=" + walletAddress);
yield return req.SendWebRequest();

byte[] binary = req.downloadHandler.data;
PlayerData data = MessagePackSerializer.Deserialize<PlayerData>(binary);
string rootHash  = req.GetResponseHeader("X-Root-Hash");
string daStatus  = req.GetResponseHeader("X-Da-Status");
Debug.Log("Loaded from 0G: " + rootHash + " DA: " + daStatus);
```

---

## Error Codes

| HTTP | Meaning |
|---|---|
| `400` | Bad request — missing or invalid parameter |
| `401` | Unauthorized — JWT missing or expired |
| `403` | Forbidden — wallet mismatch |
| `404` | Not found — no save / player / purchase |
| `409` | Conflict — rollback detected / duplicate order |
| `413` | Payload too large — save file > 5MB |
| `500` | Internal server error |
| `503` | 0G features disabled (`ZG_ENABLED=false`) |
