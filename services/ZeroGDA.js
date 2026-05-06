/**
 * ZeroGDA — publish and verify data availability commitments on 0G DA.
 *
 * 0G DA is a Data Availability layer: you submit a blob, >2/3 of DA nodes BLS-sign it,
 * and you get back a finality proof. This proof proves the data existed and was available
 * at a specific block — retroactive forgery is computationally impossible.
 *
 * Current status:
 *   DA testnet:  disperser-testnet.0g.ai:51001  (Galileo, chain 16602)
 *   DA mainnet:  endpoint TBD — set ZG_DA_DISPERSER env var when it ships
 *
 * NOTE: DA runs async (setImmediate) — never awaited in request handlers.
 * BlobStatus codes: 0=UNKNOWN 1=PROCESSING 2=FAILED 3=FINALIZED 4=INSUFFICIENT_SIGNATURES
 */

const path  = require('path');
const grpc  = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const DA_DISPERSER    = process.env.ZG_DA_DISPERSER     || 'disperser-testnet.0g.ai:51001';
const DA_USE_TLS      = (process.env.ZG_DA_TLS || 'false').toLowerCase() === 'true';
const POLL_TIMEOUT_MS = Number(process.env.ZG_DA_POLL_TIMEOUT_MS  || 120_000);
const POLL_INTERVAL_MS = Number(process.env.ZG_DA_POLL_INTERVAL_MS || 5_000);

const BLOB_STATUS = { UNKNOWN: 0, PROCESSING: 1, FAILED: 2, FINALIZED: 3, INSUFFICIENT_SIGNATURES: 4 };

let _client = null;

function getClient() {
  if (_client) return _client;

  const protoPath = path.resolve(__dirname, '../proto/disperser.proto');
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef);
  const creds = DA_USE_TLS
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  _client = new proto.disperser.Disperser(DA_DISPERSER, creds);
  console.log('[0G DA] gRPC client initialised —', DA_DISPERSER, DA_USE_TLS ? '(TLS)' : '(insecure)');
  return _client;
}

function disperseBlob(data, accountAddress) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    client.DisperseBlob(
      {
        data,
        custom_quorum_numbers: [],
        account_id: { account_id: accountAddress.toLowerCase() },
      },
      (err, reply) => {
        if (err) return reject(err);
        if (reply.result === BLOB_STATUS.FAILED) return reject(new Error('DA dispersal FAILED immediately'));
        resolve(reply.request_id.toString('hex'));
      },
    );
  });
}

function pollFinality(requestId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const client = getClient();

    const tick = () => {
      if (Date.now() > deadline) return reject(new Error(`DA finality timeout after ${POLL_TIMEOUT_MS}ms`));

      client.GetBlobStatus(
        { request_id: Buffer.from(requestId, 'hex') },
        (err, reply) => {
          if (err) return reject(err);

          if (reply.status === BLOB_STATUS.FINALIZED) {
            const proof = reply.blob_verification_proof || {};
            const meta  = proof.batch_metadata || {};
            return resolve({
              requestId,
              batchId:             proof.batch_id ?? 0,
              blobIndex:           proof.blob_index ?? 0,
              batchHeaderHash:     meta.batch_header_hash
                ? Buffer.from(meta.batch_header_hash).toString('hex')
                : '',
              referenceBlockNumber: reply.signed_batch?.header?.reference_block_number ?? 0,
              finalizedAt:          new Date(),
            });
          }

          if (reply.status === BLOB_STATUS.FAILED || reply.status === BLOB_STATUS.INSUFFICIENT_SIGNATURES) {
            return reject(new Error(`DA failed with status ${reply.status}`));
          }

          // PROCESSING or UNKNOWN — keep polling
          setTimeout(tick, POLL_INTERVAL_MS);
        },
      );
    };

    tick();
  });
}

/**
 * Publish any JSON-serialisable payload to 0G DA.
 * Returns a DaCommitment once FINALIZED (BLS signed by >2/3 nodes).
 * Call this inside setImmediate — never block a request handler on it.
 */
async function publishCommitment(payload, accountAddress) {
  const data = Buffer.from(JSON.stringify(payload), 'utf-8');
  const requestId = await disperseBlob(data, accountAddress);
  console.log('[0G DA] blob dispersed, polling for finality…', { requestId });
  const commitment = await pollFinality(requestId);
  console.log('[0G DA] FINALIZED', commitment);
  return commitment;
}

/**
 * Verify a stored commitment is still valid on DA.
 */
function verifyCommitment(commitment) {
  return new Promise(resolve => {
    if (!commitment?.requestId) return resolve(false);
    const client = getClient();
    client.GetBlobStatus(
      { request_id: Buffer.from(commitment.requestId, 'hex') },
      (err, reply) => {
        if (err) return resolve(false);
        resolve(
          reply.status === BLOB_STATUS.FINALIZED &&
          reply.blob_verification_proof?.batch_id === commitment.batchId &&
          reply.blob_verification_proof?.blob_index === commitment.blobIndex,
        );
      },
    );
  });
}

module.exports = { publishCommitment, verifyCommitment };
