const crypto = require('crypto');
const db = require('./db');
const SESSION_DAYS = 30;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
const token = (p, n = 24) => p + crypto.randomBytes(n).toString('hex');
function createSession(userId) {
  const t = token('sess_');
  db.data.sessions[t] = { userId, exp: Date.now() + SESSION_DAYS * 864e5 };
  db.save();
  return t;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
function requireUser(req, res, next) {
  const t = bearer(req);
  const s = t && db.data.sessions[t];
  if (!s || s.exp < Date.now()) return res.status(401).json({ success: false, error: 'Please log in again.' });
  const user = db.data.users.find(u => u.id === s.userId);
  if (!user) return res.status(401).json({ success: false, error: 'Account not found.' });
  req.user = user; req.sessionToken = t; next();
}
function requireApiKey(req, res, next) {
  const k = bearer(req) || req.headers['x-api-key'];
  const user = k && db.data.users.find(u => u.apiKey === k);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid API key. Get yours from the dashboard.' });
  if (user.status !== 'active') return res.status(403).json({ success: false, error: 'This account is blocked. Contact support.' });
  req.user = user; next();
}
module.exports = { hashPassword, checkPassword, token, createSession, requireUser, requireApiKey, bearer };
