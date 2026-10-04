// MongoDB-backed database. Data lives in MongoDB (Railway MongoDB / MongoDB Atlas), so it
// survives every restart, redeploy and even moving to a new Railway account.
// The app keeps a fast in-memory copy (db.data) and only writes changed records to MongoDB.
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const cfg = require('./config');

const LEGACY_FILE = path.join(__dirname, '..', 'data', 'db.json');
// List collections: stored one document per record, keyed by the given field.
const LISTS = { users: 'id', orders: 'orderId', payouts: 'id' };
// Map collections: stored one document per key.
const MAPS = ['sessions', 'resets'];
const EMPTY_ARCHIVE = () => ({ orders: 0, paid: 0, volume: 0, commission: 0 });

let state = null, client = null, mdb = null;
const snap = {}; // last saved JSON per collection -> Map(key -> json)
let metaSnap = '';

function freshState() {
  return { users: [], sessions: {}, orders: [], payouts: [], usedMails: [], resets: {}, archive: EMPTY_ARCHIVE(), lastCleanupAt: null };
}
const strip = d => { const { _id, ...rest } = d; return rest; };

async function init() {
  if (!cfg.MONGO_URI) throw new Error('MONGODB_URI is not set. Add your MongoDB connection string in Railway Variables.');
  client = new MongoClient(cfg.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  mdb = client.db(cfg.MONGO_DB);
  state = freshState();

  for (const [name, key] of Object.entries(LISTS)) {
    const docs = await mdb.collection(name).find({}).toArray();
    state[name] = docs.map(strip);
    snap[name] = new Map(state[name].map(d => [d[key], JSON.stringify(d)]));
  }
  for (const name of MAPS) {
    const docs = await mdb.collection(name).find({}).toArray();
    state[name] = Object.fromEntries(docs.map(d => [d._id, strip(d)]));
    snap[name] = new Map(Object.entries(state[name]).map(([k, v]) => [k, JSON.stringify(v)]));
  }
  const meta = await mdb.collection('meta').findOne({ _id: 'meta' });
  if (meta) {
    state.usedMails = meta.usedMails || [];
    state.archive = { ...EMPTY_ARCHIVE(), ...(meta.archive || {}) };
    state.lastCleanupAt = meta.lastCleanupAt || null;
    metaSnap = JSON.stringify(metaOf());
  }

  // One-time import of the old data/db.json file (if it exists and MongoDB is empty).
  if (!state.users.length && !state.orders.length && fs.existsSync(LEGACY_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      for (const k of ['users', 'orders', 'payouts', 'usedMails']) if (Array.isArray(old[k])) state[k] = old[k];
      for (const k of MAPS) if (old[k] && typeof old[k] === 'object') state[k] = old[k];
      console.log(`Imported old data/db.json into MongoDB (${state.users.length} users, ${state.orders.length} orders).`);
    } catch (e) { console.error('Could not import data/db.json:', e.message); }
  }
  if (!state.lastCleanupAt) state.lastCleanupAt = new Date().toISOString();
  await flush();
  console.log(`MongoDB connected (db: ${cfg.MONGO_DB}) – ${state.users.length} users, ${state.orders.length} orders, ${state.payouts.length} payouts.`);
}

function metaOf() {
  return { usedMails: state.usedMails, archive: state.archive, lastCleanupAt: state.lastCleanupAt };
}

async function writeCollection(name, entries) {
  const prev = snap[name] || new Map();
  const next = new Map(); const ops = [];
  for (const [key, val] of entries) {
    if (key === undefined || key === null) continue;
    const json = JSON.stringify(val);
    next.set(key, json);
    if (prev.get(key) !== json) ops.push({ replaceOne: { filter: { _id: key }, replacement: { _id: key, ...JSON.parse(json) }, upsert: true } });
  }
  for (const key of prev.keys()) if (!next.has(key)) ops.push({ deleteOne: { filter: { _id: key } } });
  if (ops.length) await mdb.collection(name).bulkWrite(ops, { ordered: false });
  snap[name] = next;
}

async function doFlush() {
  if (!mdb || !state) return;
  for (const [name, key] of Object.entries(LISTS)) await writeCollection(name, state[name].map(d => [d[key], d]));
  for (const name of MAPS) await writeCollection(name, Object.entries(state[name]));
  const m = JSON.stringify(metaOf());
  if (m !== metaSnap) {
    await mdb.collection('meta').replaceOne({ _id: 'meta' }, JSON.parse(m), { upsert: true });
    metaSnap = m;
  }
  failed = false;
}

let chain = Promise.resolve(), timer = null, failed = false;
function flush() {
  chain = chain.then(doFlush).catch(e => { failed = true; console.error('MongoDB save failed (will retry):', e.message); });
  return chain;
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
// If MongoDB was briefly unreachable, keep retrying so nothing is lost.
setInterval(() => { if (failed) flush(); }, 15000).unref();

async function close() {
  clearTimeout(timer);
  await flush();
  if (client) await client.close().catch(() => {});
}

module.exports = { get data() { return state; }, init, save, flush, close };
