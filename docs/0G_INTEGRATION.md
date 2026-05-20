# 0G Integration Guide

This document covers how each component of the 0G network is used in WarzoneWarrior — what it does, how we configured it, and what to watch out for when you deploy.

---

## 0G Storage

**What it is**: A decentralized file storage network. Files are split into chunks, distributed across storage nodes, and addressed by the Merkle root hash of the file content. Anyone with the root hash can download the file from any storage node.

**What we use it for**:
- Storing player save binaries (WZSV format, ~4KB each)
- Storing behavioral AI sample batches (JSON, ~100KB per batch)
- Storing trained TF.js model weights (~2–5MB each)

**How it works in the code** (`src/services/ZeroGStorage.js`):

Upload flow:
1. Write the buffer to a temp file
2. Create a `ZgFile` from the path (SDK builds chunk layout)
3. Compute the Merkle tree → extract `rootHash`
4. Call `indexer.upload(zgFile, rpcUrl, signer)` — this broadcasts the file headers on-chain and stores chunks across nodes
5. Return `{ rootHash, txHash, size, checksum }`

```javascript
const { Indexer, ZgFile } = require("@0gfoundation/0g-storage-ts-sdk");

const zgFile = await ZgFile.fromFilePath(tmpPath);
const [tree, err] = await zgFile.merkleTree();
const rootHash = tree.rootHash();
const [result, uploadErr] = await indexer.upload(zgFile, ZG_RPC_URL, signer);
```

Download flow:
1. Call `indexer.download(rootHash, destPath, true)` — fetches chunks from the network and reconstructs the file
2. Read the file back to a Buffer

**Indexer rotation**: We maintain a list of three indexer endpoints and rotate on failure. The active indexer is tracked in a module-level variable and reset on errors.

**Retry policy**: 3 attempts, 4-second base delay, exponential backoff. Controlled by `src/utils/retry.js`.

**Cost**: Each upload pays gas on 0G Mainnet (chainId 16661) from the backend wallet (`ZG_PRIVATE_KEY`). File storage itself is paid through the 0G storage mechanism. Keep the wallet funded with A0GI.

**Relevant env vars**:
```
ZG_PRIVATE_KEY=0x...               # wallet that signs uploads
OG_MAINNET_RPC=https://evmrpc.0g.ai
ZG_INDEXER_RPC=https://indexer-storage-turbo-v2.0g.ai
```

**Finding files**: After a save is uploaded, the `rootHash` is stored in `PlayerSaveRecord.rootHash`. You can view any file in the 0G Storage explorer — typically at `https://storagescan.0g.ai/` or by querying the indexer API directly.

---

## 0G Chain (EVM)

**What it is**: An EVM-compatible blockchain at chainId 16661. It runs Ethereum-standard tooling (ethers.js, hardhat, MetaMask) with 0G-specific validators and fast block times.

**What we use it for**: Anchoring save root hashes on-chain via `PlayerSaveAnchor.sol`. This creates an immutable, timestamped record linking a player's wallet address to a specific save's rootHash.

### PlayerSaveAnchor.sol

```solidity
contract PlayerSaveAnchor {
    address public immutable backendOperator;
    
    struct SaveRecord {
        bytes32 rootHash;
        uint256 saveIndex;
        uint256 timestamp;
    }
    
    mapping(address => SaveRecord) private _saves;
    
    event SaveAnchored(address indexed wallet, bytes32 rootHash, uint256 saveIndex, uint256 timestamp);
    
    constructor(address _backendOperator) {
        backendOperator = _backendOperator;
    }
    
    function anchorSave(address wallet, bytes32 rootHash, uint256 saveIndex) external {
        require(
            msg.sender == wallet || msg.sender == backendOperator,
            "Not authorized"
        );
        require(
            saveIndex > _saves[wallet].saveIndex || _saves[wallet].timestamp == 0,
            "Anti-rollback: saveIndex must increase"
        );
        _saves[wallet] = SaveRecord(rootHash, saveIndex, block.timestamp);
        emit SaveAnchored(wallet, rootHash, saveIndex, block.timestamp);
    }
    
    function getLatestSave(address wallet) external view returns (
        bytes32 rootHash, uint256 saveIndex, uint256 timestamp, bool exists
    ) { ... }
}
```

The key design choice is `backendOperator` as an immutable constructor argument. It's set to the backend's wallet at deploy time. This means the backend can anchor saves on behalf of any player wallet without requiring each player to sign a transaction — which would be impractical in a game.

The anti-rollback check (`saveIndex > _saves[wallet].saveIndex`) is enforced both in the contract and in the backend before uploading. A save with a lower or equal `saveIndex` is rejected at the API level with HTTP 409.

**Deploying**:
```bash
npm run deploy:anchor
# prints: PlayerSaveAnchor deployed to: 0x<address>
```

Set `ZG_ANCHOR_CONTRACT_ADDRESS=0x<address>` in `.env`.

**Verifying on chainscan**:
```bash
node scripts/verify-helper.mjs
# prints compiler settings, ABI-encoded constructor arg, and copy-paste instructions
```

**How it works in the code** (`src/services/ZeroGChain.js`):

```javascript
const contract = new ethers.Contract(
    process.env.ZG_ANCHOR_CONTRACT_ADDRESS,
    PlayerSaveAnchorABI,
    signer
);

const tx = await contract.anchorSave(walletAddress, rootHashBytes32, saveIndex);
const receipt = await tx.wait(1);
// returns { txHash: receipt.hash, block: receipt.blockNumber }
```

**Relevant env vars**:
```
ZG_ANCHOR_CONTRACT_ADDRESS=0x...
ZG_PRIVATE_KEY=0x...               # same key as storage — signs anchor txs
OG_MAINNET_RPC=https://evmrpc.0g.ai
OG_MAINNET_CHAIN_ID=16661
```

---

## 0G Data Availability (DA)

**What it is**: A Data Availability layer separate from the execution chain. When data is dispersed to the DA network, a quorum of DA nodes sign a BLS aggregate attesting they hold the data. This "finality" proof is stronger than just storing something in a database because it involves multiple independent signers.

**What we use it for**: Publishing player save payloads to DA after they've been stored on 0G Storage. A DA-finalized save has both storage (the actual file) and a quorum finality proof. This is what moves a player's trust badge from GOLD to PLATINUM.

**Current status**: Using the **testnet** DA disperser (`disperser-testnet.0g.ai:51001`). Mainnet DA endpoint will replace this once available.

**How it works** (`src/services/ZeroGDA.js`):

Communication is over gRPC using the protobuf definitions in `protos/disperser.proto`:

```protobuf
service Disperser {
  rpc DisperseBlob(DisperseBlobRequest) returns (DisperseBlobReply) {}
  rpc GetBlobStatus(BlobStatusRequest) returns (BlobStatusReply) {}
}
```

The DA flow:
1. Call `DisperseBlob` with the save payload bytes → returns `request_id` and initial status
2. Poll `GetBlobStatus(request_id)` every 5 seconds
3. Watch for status transitions: `PROCESSING → DISPERSING → CONFIRMED → FINALIZED`
4. `FINALIZED` means a BLS quorum has signed. Timeout after 240 seconds.
5. On finalization, store `batchId`, `blobIndex`, `batchHeaderHash`, `referenceBlockNumber` in `PlayerSaveRecord.daCommitment`

```javascript
// Simplified from ZeroGDA.js
const reply = await disperserClient.disperseBlob({
    data: Buffer.from(payloadJson),
    custom_quorum_numbers: [],
    account_id: { account_id: backendWalletAddress }
});

// Poll until finalized
while (attempts++ < MAX_ATTEMPTS) {
    await sleep(5000);
    const status = await disperserClient.getBlobStatus({ request_id: reply.request_id });
    if (status.status === BlobStatus.FINALIZED) {
        return {
            batch_id:              status.info.blob_verification_proof.batch_id,
            blob_index:            status.info.blob_verification_proof.blob_index,
            batch_header_hash:     status.info.blob_verification_proof.batch_metadata.batch_header_hash,
            reference_block_number: status.info.blob_verification_proof.batch_metadata.batch_header.reference_block_number
        };
    }
    if (status.status === BlobStatus.FAILED) throw new Error("DA dispersal failed");
}
throw new Error("DA finalization timed out after 240s");
```

**Why DA can fail**: The testnet disperser occasionally times out under load. A `daStatus: "failed"` doesn't mean the save is lost — it's still in MongoDB and 0G Storage. It just didn't get a quorum finality proof. The trust score reflects this (no DA finalization = no DA points).

**Relevant env vars**:
```
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
ZG_PRIVATE_KEY=0x...    # used as account_id for blob submissions
```

---

## 0G Compute

**What it is**: A network of LLM inference providers running in Trusted Execution Environments (TEEs). The API is OpenAI-compatible (`POST /v1/chat/completions`). What makes it special is that each provider signs their response with a key registered on-chain — you can verify the response came from a TEE without trusting the router.

**API endpoint**: `https://router-api.0g.ai/v1/chat/completions`

**Authentication**: API key from [pc.0g.ai](https://pc.0g.ai), passed as `Authorization: Bearer sk-...`

**Available models** (as of May 2026):
- `0GM-1.0-35B-A3B` — 0G's own model, default for game AI decisions
- `deepseek/deepseek-chat-v3-0324` — used for anti-cheat (reliable JSON output)
- `deepseek-v4-pro` — most capable, higher cost
- `qwen/qwen3-vl-30b-a3b-instruct`
- `qwen3.6-plus`
- `zai-org/GLM-5-FP8`, `zai-org/GLM-5.1-FP8`

**What we use it for**:

### 1. Anti-cheat validation

Every save goes through an LLM that looks for suspicious patterns in the save delta. We send the LLM:
- Previous save index and current save index
- Coin delta between saves
- Time elapsed since last save
- The raw save data (guns, levels, resources, etc.)
- The 0G Storage rootHash of this save (returned verbatim in the response as a binding check)

The LLM responds with a JSON verdict:
```json
{
  "verdict": "CLEAN",
  "confidence": 0.97,
  "flags": [],
  "summary": "All resource values within expected ranges.",
  "rootHash": "<echoed from input>"
}
```

We verify that `rootHash` in the response matches what we sent. If it doesn't, we reject the response — this prevents replay attacks where an old "CLEAN" verdict gets substituted for a new "SUSPICIOUS" one.

Setting `verify_tee: true` in the request tells the router to only use TEE-enabled providers and verify the TEE attestation before returning. The `x_0g_trace.tee_verified` boolean in the response tells us whether verification succeeded.

```javascript
const response = await fetch("https://router-api.0g.ai/v1/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.ZG_COMPUTE_API_KEY}`
    },
    body: JSON.stringify({
        model: "deepseek/deepseek-chat-v3-0324",
        messages: [
            { role: "system", content: ANTICHEAT_SYSTEM_PROMPT },
            { role: "user",   content: userMessage }
        ],
        verify_tee: true,
        temperature: 0
    })
});

const data = await response.json();
const trace = data.x_0g_trace;
// trace.tee_verified: boolean
// trace.provider: "0x<provider_address>"
// trace.billing.total_cost: neurons spent
```

### 2. Game AI fallback

When a player has no trained TF.js model (they haven't uploaded 500 samples yet), the LLM acts as the AI opponent. The system prompt describes the game rules and decision priorities:

```
You are an expert AI controller for WarzoneWarrior.
- SHOOT when the nearest enemy is within distance 200 and HP > 0.2
- GRENADE when 2+ enemies within distance 150, or cornered with low HP
- JUMP to dodge if enemy closes within distance 80
- RETREAT if HP <= 0.3
...
Respond with ONLY JSON: {"horizontal":...,"vertical":...,"jump":...,"shoot":...,"grenade":...,"reasoning":"..."}
```

The `reasoning` field in the response is surfaced to the frontend so players can see why the AI made each decision.

**Important**: LLM inference takes 100–400ms. Don't call `/ai/predict` every frame. The TF.js layer handles per-frame calls in ~1ms. The compute layer is only hit when no TF.js model exists, or when explicitly calling `/ai/strategy` for Arena matches.

### 3. Training data enrichment

Before TF.js trains, if `AI_ENRICH=true`, we ask the compute network to generate synthetic gameplay samples that match the player's style. This helps when a player has only 500–1000 samples — not enough for a diverse, high-quality model.

We send the LLM a summary of the player's play style (shoot rate, jump rate, average HP) along with a few example samples, and ask for N additional samples in the same JSON format as real gameplay recordings. The synthetic samples are uploaded to 0G Storage alongside the real ones.

### Independent TEE verification

If you want to verify a compute response yourself (without trusting the 0G router), the process is:

1. Save the `chatId` from the response (`data.id`)
2. Save the `providerAddress` from `x_0g_trace.provider`
3. Query the provider's on-chain service record to get their TEE signer address and URL
4. Fetch: `GET {provider_url}/v1/proxy/signature/{chatId}?model={model}`
5. Response: `{"text": "...", "signature": "0x..."}`
6. Use ethers: `ethers.verifyMessage(text, signature)` — should return the TEE signer address
7. Confirm TEE signer address matches what's registered on-chain

The `src/services/ZeroGCompute.js` currently stores `chatId` and `providerAddress` on the `PlayerSaveRecord.computeValidation` object so this verification is possible after the fact.

**Relevant env vars**:
```
ZG_COMPUTE_API_KEY=sk-...              # from pc.0g.ai
ZG_AI_MODEL=0GM-1.0-35B-A3B           # model for game AI decisions
ZG_ANTICHEAT_MODEL=deepseek/deepseek-chat-v3-0324   # model for anti-cheat
```

---

## Setup checklist

Getting everything connected for the first time:

**0G Storage**
- [ ] Fund backend wallet (`ZG_PRIVATE_KEY`) with A0GI on chainId 16661
- [ ] Bridge tokens via [Apollo Bridge](https://bridge.0g.ai) if starting from another chain
- [ ] Set `ZG_INDEXER_RPC` (or let it default to the turbo indexer)
- [ ] Test: call `POST /player/save/binary` and check that `PlayerSaveRecord.rootHash` is populated

**0G Chain**
- [ ] Run `npm run deploy:anchor` — fund the wallet first (needs gas)
- [ ] Copy printed address to `ZG_ANCHOR_CONTRACT_ADDRESS` in `.env`
- [ ] Verify contract: run `node scripts/verify-helper.mjs` and follow instructions on chainscan.0g.ai
- [ ] Test: save a record and confirm `anchorTxHash` appears in `PlayerSaveRecord`

**0G DA**
- [ ] No setup needed for testnet — just set `ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001`
- [ ] DA is optional for game functionality — saves work without it, they just won't be DA-finalized
- [ ] Test: check `PlayerSaveRecord.daStatus` after a save (allow ~30–120 seconds for finalization)

**0G Compute**
- [ ] Create account at [pc.0g.ai](https://pc.0g.ai)
- [ ] Add 0G tokens to your compute balance
- [ ] Create an API key under Dashboard → API Keys
- [ ] Set `ZG_COMPUTE_API_KEY=sk-...` in `.env`
- [ ] Set `ZG_AI_MODEL` if you want a different model than `0GM-1.0-35B-A3B`
- [ ] Test: check `PlayerSaveRecord.computeStatus` after a save (should be `validated` if balance is funded)

---

## Costs and token budget

| Operation | Network | Approximate cost |
|---|---|---|
| Store one save (~4KB) | 0G Storage | ~0.001–0.01 A0GI |
| Anchor save on-chain | 0G EVM gas | ~0.0001 A0GI |
| Anti-cheat validation | 0G Compute | ~0.003 USD equivalent per call |
| AI predict (LLM fallback) | 0G Compute | ~0.001 USD per call |
| DA dispersal | 0G DA (testnet) | Free on testnet |

The backend wallet handles storage and chain operations. The Compute API key handles Compute Network billing separately (neuron-based on-chain micro-payments).

For a game with 1,000 active daily players each saving once per session, rough estimate: ~10 A0GI/day in storage costs, ~$3/day in compute validation costs.

---

## Troubleshooting

**Saves not being anchored on-chain**
- Check backend wallet balance: `GET /0g/network` shows chain status
- Confirm `ZG_ANCHOR_CONTRACT_ADDRESS` is set correctly
- Check server logs for `ZeroGChain` errors

**DA finalization failing**
- Testnet disperser has occasional downtime — `daStatus: "failed"` is expected sometimes
- The save is not lost. Only the DA proof is missing.
- Can be retried manually by implementing a re-dispatch endpoint if needed

**Compute validation skipped**
- Confirm `ZG_COMPUTE_API_KEY` is set
- Check compute balance at pc.0g.ai — if it hits zero, all compute calls are skipped silently
- Validation only fires when `saveIndexDelta >= 1` (not for first-time saves)

**AI model returns fallback action**
- Check `/behavior/status/:wallet` — model may still be training
- If `status: "error"`, check `errorMsg` field — common cause is TF.js memory error during training
- Try `POST /behavior/retrain/:wallet` to restart training

**0G Storage upload failing**
- The SDK occasionally has issues with the indexer's struct format on mainnet
- Check logs for "Merkle tree error" or "Upload error"
- If uploads consistently fail, the indexer URL may have changed — update `ZG_INDEXER_RPC`
