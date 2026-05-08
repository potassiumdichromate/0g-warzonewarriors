/**
 * authController — wallet signature-based authentication (SIWE pattern).
 *
 * Flow:
 *   1. Client calls GET /auth/nonce?wallet=0x... — gets a one-time nonce + exact message to sign.
 *   2. Client signs the message with their wallet (ethers.signMessage, MetaMask, WalletConnect, etc.)
 *   3. Client calls POST /auth/login { wallet, signature, nonce } — server recovers the signing
 *      address from the signature and verifies it matches the claimed wallet.
 *   4. Server issues a 7-day JWT. Client includes it as "Authorization: Bearer <token>" from here on.
 *
 * For the React Native iframe session:
 *   - The web app / login page calls this flow once at login time.
 *   - The resulting JWT is passed into the game iframe via postMessage.
 *   - The game includes it in every request header. Zero wallet popups during gameplay.
 *
 * Nonces:
 *   - Stored in MongoDB with a 5-min TTL index, deleted immediately on use (single-use).
 *   - One nonce per wallet — any previous nonce is cleared before issuing a fresh one.
 *
 * Security properties:
 *   - Proves the caller holds the private key for the wallet address.
 *   - Nonce prevents replay attacks.
 *   - Raw wallet addresses passed as Bearer tokens are explicitly rejected.
 */

const crypto    = require('crypto');
const { ethers } = require('ethers');
const jwt       = require('jsonwebtoken');
const AuthNonce = require('../models/AuthNonce');

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'your-secret-key') {
    console.warn('[auth] WARNING: JWT_SECRET is not set or is the default. Set a real secret in production.');
  }
  return s || 'dev-secret-change-me';
}

/**
 * The exact message the client must sign.
 * Uses EIP-4361 (Sign-In with Ethereum) style format.
 * Changing this format invalidates all in-flight nonces — version it if needed.
 */
function buildLoginMessage(wallet, nonce, issuedAt) {
  return [
    'Sign in to Warzone Warriors',
    '',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    '',
    'Signing this message proves ownership of your wallet.',
    'It will not trigger a blockchain transaction or cost gas fees.',
  ].join('\n');
}

// GET /auth/nonce?wallet=0x...
exports.getNonce = async (req, res) => {
  try {
    const wallet = (req.query.wallet || '').toLowerCase().trim();

    if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // One nonce per wallet — clear any existing before issuing a new one
    await AuthNonce.deleteMany({ wallet });

    const nonce    = crypto.randomBytes(16).toString('hex');
    const nonceDoc = await AuthNonce.create({ wallet, nonce });
    const issuedAt = nonceDoc.createdAt.toISOString();
    const message  = buildLoginMessage(wallet, nonce, issuedAt);

    return res.json({
      wallet,
      nonce,
      issuedAt,
      message,       // client signs this exact string
      expiresIn: 300 // seconds
    });
  } catch (err) {
    console.error('[authController] getNonce error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /auth/login  { wallet, signature, nonce }
exports.login = async (req, res) => {
  try {
    const { wallet, signature, nonce } = req.body || {};

    if (!wallet || !signature || !nonce) {
      return res.status(400).json({ error: 'wallet, signature, and nonce are all required' });
    }

    const normalizedWallet = wallet.toLowerCase().trim();

    if (!/^0x[0-9a-f]{40}$/i.test(normalizedWallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // Look up and immediately delete — nonces are single-use
    const nonceDoc = await AuthNonce.findOneAndDelete({ wallet: normalizedWallet, nonce });

    if (!nonceDoc) {
      return res.status(401).json({
        error: 'Invalid or expired nonce.',
        hint:  'Request a fresh nonce via GET /auth/nonce?wallet=<address>',
      });
    }

    // Recover the signing address
    const issuedAt = nonceDoc.createdAt.toISOString();
    const message  = buildLoginMessage(normalizedWallet, nonce, issuedAt);

    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'Malformed signature' });
    }

    if (recovered !== normalizedWallet) {
      return res.status(401).json({
        error: 'Signature verification failed — signing address does not match wallet',
      });
    }

    // Issue JWT — same secret as the existing login flow for full compatibility
    const token = jwt.sign(
      { walletAddress: normalizedWallet, sub: normalizedWallet, siwe: true },
      jwtSecret(),
      { expiresIn: '7d', algorithm: 'HS256' }
    );

    return res.json({
      token,
      wallet:    normalizedWallet,
      expiresIn: 7 * 24 * 60 * 60,
      tokenType: 'Bearer',
    });
  } catch (err) {
    console.error('[authController] login error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
