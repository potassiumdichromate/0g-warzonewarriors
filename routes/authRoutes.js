/**
 * Auth routes — wallet signature (SIWE) flow.
 *
 * GET  /warzone/auth/nonce?wallet=0x...   → { nonce, message, issuedAt, expiresIn }
 * POST /warzone/auth/login  { wallet, signature, nonce }  → { token, wallet, expiresIn }
 *
 * React Native iframe flow:
 *   1. Web app / login page calls these endpoints once at login.
 *   2. Token stored in-app (AsyncStorage / SecureStore).
 *   3. Token passed into game iframe via postMessage.
 *   4. Game includes "Authorization: Bearer <token>" in all requests.
 *   Zero wallet popups during gameplay.
 */

const router = require('express').Router();
const rateLimiter = require('./middleware/rateLimiter');
const auth = require('../controllers/authController');

// Nonce: 10/min per IP — limits wallet enumeration
const nonceLimiter = rateLimiter({ windowMs: 60_000, max: 10, message: 'Too many nonce requests — slow down' });

// Login: 5/min per IP — slows brute-force signature replays
const loginLimiter = rateLimiter({ windowMs: 60_000, max: 5, message: 'Too many login attempts — try again in a minute' });

router.get('/nonce', nonceLimiter, auth.getNonce);
router.post('/login', loginLimiter, auth.login);

module.exports = router;
