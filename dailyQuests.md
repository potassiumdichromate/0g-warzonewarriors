# Daily Quests API

This document covers the daily quests endpoint exposed by `profileRoutes`.

## GET /dailyQuests/type/:type

Fetch a daily quest for the given quest type.

### Rate Limit
- 20 requests per minute per IP

### Path Params
- `type` (number): Quest type identifier.

### Query Params
- `walletAddress` (string, required): Player wallet address.

### Response Headers
- `X-Request-Id`: Unique request ID for tracing.
- `X-RateLimit-Limit`: Max requests per window.
- `X-RateLimit-Remaining`: Remaining requests in window.
- `X-RateLimit-Reset`: UNIX seconds when the window resets.
- `Retry-After`: Present only on rate-limit responses.

### Possible `type` values
The handler recognizes these types and rewards:
- `0` → `Boss Slayer`
- `1` → `Mass Annihilation`
- `9` → `Tank Buster`
- `10` → `Hardcore Victor`
- `11` → `Stage Runner`

Other numeric values are accepted but return an empty `reward`.

### Possible Responses

#### 200 OK
```json
{
  "success": true,
  "status": 200,
  "wallet": "0x...",
  "completed": false,
  "score": 0,
  "isClaimed": false,
  "reward": "Boss Slayer"
}
```
Notes:
- `completed`, `score`, and `isClaimed` depend on the player’s stored progress.
- `reward` maps to the `type` above.

#### 400 Bad Request — missing `walletAddress`
```json
{
  "success": false,
  "error": "walletAddress is required",
  "requestId": "..."
}
```

#### 400 Bad Request — invalid `type`
```json
{
  "success": false,
  "error": "type must be a number",
  "requestId": "..."
}
```

#### 429 Too Many Requests — rate limiter
```json
{
  "ok": false,
  "error": "Too many requests, please try again later.",
  "status": 429,
  "retryAfterMs": 12345,
  "retryAfterSeconds": 13,
  "resetAt": "2026-02-12T12:34:56.789Z"
}
```

#### 429 Server Error — catch block
```json
{
  "ok": false,
  "status": 429,
  "error": "Server Error, Please Retry ",
  "requestId": "..."
}
```

### Example Request
```http
GET /dailyQuests/type/1?walletAddress=0x579276691c3636D15238c1Fc9202e4b2d67De4a0
```
