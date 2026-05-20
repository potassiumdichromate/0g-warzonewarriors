const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

const PROTO_PATH   = path.join(__dirname, "../../protos/disperser.proto");
const DA_ENDPOINT  = process.env.ZG_DA_DISPERSER || "disperser-testnet.0g.ai:51001";
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS       = 240_000;

let _client = null;

function getClient() {
  if (_client) return _client;

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true
  });

  const proto = grpc.loadPackageDefinition(packageDef);

  const creds = DA_ENDPOINT.includes("testnet") || DA_ENDPOINT.includes(":51001")
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  _client = new proto.disperser.Disperser(DA_ENDPOINT, creds);
  return _client;
}

function disperseBlob(data) {
  return new Promise((resolve, reject) => {
    getClient().DisperseBlob({ data }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function getBlobStatus(requestId) {
  return new Promise((resolve, reject) => {
    getClient().GetBlobStatus({ request_id: requestId }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

async function pollUntilFinalized(requestId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    let status;
    try {
      status = await getBlobStatus(requestId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[DA] GetBlobStatus error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors >= 5) throw new Error(`DA polling failed after 5 consecutive errors: ${err.message}`);
      continue;
    }

    if (status.status === 3 || status.status === "FINALIZED") {
      return status.info?.blob_verification_proof ?? status;
    }

    if (status.status === 4 || status.status === "FAILED") {
      throw new Error("DA blob finalization failed (disperser rejected blob)");
    }

    console.log(`[DA] Blob status: ${status.status} — waiting...`);
  }

  throw new Error(`DA finalization timeout after ${TIMEOUT_MS / 1000}s`);
}

async function publishCommitment(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const reply = await disperseBlob(data);

  if (!reply.request_id) {
    throw new Error("DA DisperseBlob returned no request_id");
  }

  return pollUntilFinalized(reply.request_id);
}

async function verifyCommitment(commitment) {
  try {
    const requestId = Buffer.from(commitment.requestId || "", "hex");
    const status = await getBlobStatus(requestId);
    return status.status === 3 || status.status === "FINALIZED";
  } catch {
    return false;
  }
}

module.exports = { publishCommitment, verifyCommitment };
