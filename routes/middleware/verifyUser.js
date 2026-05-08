/**
 * verifyUser — JWT authentication middleware.
 *
 * Accepts two token formats for backward compatibility:
 *
 *   1. Authorization: Bearer <JWT>
 *      Issued by POST /login (legacy) or POST /auth/login (SIWE).
 *      Both use the same JWT_SECRET — no code path change needed.
 *
 *   2. Body: { jwt: "<token>", source: "browser" }
 *      Legacy browser client flow — still supported.
 *
 * Security: raw wallet addresses (0x + 40 hex chars) as Bearer tokens are
 * explicitly rejected with a helpful error pointing to the SIWE flow.
 * "Authorization: Bearer 0x1234..." proves nothing — anyone can type any address.
 *
 * Sets req.walletAddress (lowercase) for downstream handlers.
 */

const jwt = require('jsonwebtoken');

function jwtSecret() {
  return process.env.JWT_SECRET || 'your-secret-key';
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
}

function extractWallet(payload) {
  const candidates = [
    payload?.walletAddress,
    payload?.address,
    payload?.wallet,
    payload?.sub,
  ];
  const w = candidates.find(v => typeof v === 'string' && v.trim().length > 0);
  return w ? w.trim().toLowerCase() : null;
}

const verifyUser = (req, res, next) => {
  // ── Option 1: Legacy body JWT (browser client flow) ──────────────────────────
  const { jwt: bodyJwt, source } = req.body || {};
  if (bodyJwt && source === 'browser') {
    try {
      const payload = verifyToken(bodyJwt);
      const wallet  = extractWallet(payload);
      if (!wallet) return res.status(401).json({ success: false, message: 'Missing wallet in token payload' });
      req.walletAddress = wallet;
      return next();
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired browser JWT' });
    }
  }

  // ── Option 2: Authorization: Bearer <JWT> ────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
      detail:  'Send a JWT as: Authorization: Bearer <token>',
      hint:    'GET /warzone/auth/nonce?wallet=<address> → sign → POST /warzone/auth/login → use token',
    });
  }

  const token = authHeader.slice(7).trim();

  // Reject raw Ethereum addresses — zero proof of key ownership.
  // The old login flow accepted "Bearer 0xABC" — this is the security hole being closed.
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return res.status(401).json({
      success: false,
      message: 'Raw wallet address is not a valid auth token.',
      detail:  'A wallet address proves nothing without a signature.',
      step1:   'GET /warzone/auth/nonce?wallet=<address>',
      step2:   'Sign the returned message with your wallet (ethers.signMessage)',
      step3:   'POST /warzone/auth/login  →  receive JWT',
      step4:   'Authorization: Bearer <JWT>',
    });
  }

  try {
    const payload = verifyToken(token);
    const wallet  = extractWallet(payload);
    if (!wallet) return res.status(401).json({ success: false, message: 'Missing wallet in token payload' });
    req.walletAddress = wallet;
    return next();
  } catch (error) {
    console.error('[verifyUser] JWT verification error:', error.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

module.exports = verifyUser;
