const crypto  = require("crypto");
const { ethers } = require("ethers");
const jwt     = require("jsonwebtoken");
const AuthNonce = require("../models/AuthNonce");

function jwtSecret() {
  const s = process.env.BROWSER_JWT_SECRET;
  if (!s || s === "dev-secret-change-me") {
    console.warn("[auth] WARNING: BROWSER_JWT_SECRET is not set or is the default. Set a real secret in production.");
  }
  return s || "dev-secret-change-me";
}

function buildLoginMessage(wallet, nonce, issuedAt) {
  return [
    "Sign in to WarzoneWarrior",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    "",
    "Signing this message grants access to WarzoneWarrior only.",
    "It will not trigger a blockchain transaction or cost gas fees."
  ].join("\n");
}

exports.getNonce = async (req, res) => {
  const wallet = req.query.wallet?.toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  await AuthNonce.deleteMany({ wallet });

  const nonce    = crypto.randomBytes(16).toString("hex");
  const nonceDoc = await AuthNonce.create({ wallet, nonce });
  const issuedAt = nonceDoc.createdAt.toISOString();

  const message = buildLoginMessage(wallet, nonce, issuedAt);

  return res.json({
    wallet,
    nonce,
    issuedAt,
    message,
    expiresIn: 300
  });
};

exports.login = async (req, res) => {
  const { wallet, signature, nonce } = req.body || {};

  if (!wallet || !signature || !nonce) {
    return res.status(400).json({ error: "wallet, signature, and nonce are all required" });
  }

  const normalizedWallet = wallet.toLowerCase().trim();

  if (!/^0x[0-9a-f]{40}$/i.test(normalizedWallet)) {
    return res.status(400).json({ error: "Invalid wallet address format" });
  }

  const nonceDoc = await AuthNonce.findOneAndDelete({ wallet: normalizedWallet, nonce });

  if (!nonceDoc) {
    return res.status(401).json({
      error: "Invalid or expired nonce.",
      hint:  "Request a fresh nonce via GET /auth/nonce?wallet=<address>"
    });
  }

  const issuedAt = nonceDoc.createdAt.toISOString();
  const message  = buildLoginMessage(normalizedWallet, nonce, issuedAt);

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return res.status(401).json({ error: "Malformed signature" });
  }

  if (recovered !== normalizedWallet) {
    return res.status(401).json({
      error: "Signature verification failed — signing address does not match wallet"
    });
  }

  const token = jwt.sign(
    { walletAddress: normalizedWallet, sub: normalizedWallet },
    jwtSecret(),
    { expiresIn: "7d", algorithm: "HS256" }
  );

  return res.json({
    token,
    wallet:    normalizedWallet,
    expiresIn: 7 * 24 * 60 * 60,
    tokenType: "Bearer"
  });
};
