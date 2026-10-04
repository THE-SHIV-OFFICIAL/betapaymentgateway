const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');
const mail = require('./lib/mailer');
const imap = require('./lib/imap');
const tg = require('./lib/telegram');
const cleanup = require('./lib/cleanup');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const D = () => db.data;
const r2 = n => Math.round(n * 100) / 100;
const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()) && s.length <= 120;
const isVpa = s => typeof s === 'string' && /^[a-zA-Z0-9._-]{1,64}@[a-zA-Z]{2,32}$/.test(s.trim());
const clean = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const baseUrl = req => cfg.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// --- simple in-memory rate limiter (per IP) for auth routes ---
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a minute.' });
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}

function publicUser(u) {
  const orders = D().orders.filter(o => o.userId === u.id);
  const paid = orders.filter(o => o.status === 'PAID');
  const paidOut = D().payouts.filter(p => p.userId === u.id && p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
  const pendingOut = D().payouts.filter(p => p.userId === u.id && p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
  // Totals from history that was already emailed + cleaned (keeps balance correct forever).
  const a = { ...cleanup.emptyUserArchive(), ...(u.archive || {}) };
  const earned = a.earned + paid.reduce((s, o) => s + o.merchantNet, 0);
  const totalPaidOut = a.paidOut + paidOut;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    storeName: u.storeName,
    payoutUpi: u.payoutUpi,
    webhookUrl: u.webhookUrl || '',
    apiKey: u.apiKey,
    status: u.status,
    createdAt: u.createdAt,
    stats: {
      totalOrders: a.totalOrders + orders.length,
      paidOrders: a.paidOrders + paid.length,
      volume: r2(a.volume + paid.reduce((s, o) => s + o.payAmount, 0)),
      commission: r2(a.commission + paid.reduce((s, o) => s + o.commission, 0)),
      earned: r2(earned),
      paidOut: r2(totalPaidOut),
      pendingPayout: r2(pendingOut),
      balance: r2(earned - totalPaidOut - pendingOut),
    },
  };
}

const publicOrder = o => ({
  orderId: o.orderId,
  amount: o.amount,
  payAmount: o.payAmount,
  commission: o.commission,
  merchantNet: o.merchantNet,
  note: o.note,
  customerEmail: o.customerEmail,
  status: o.status,
  upiUri: o.upiUri,
  qrImageUrl: o.qrImageUrl,
  payUrl: o.payUrl,
  createdAt: o.createdAt,
  expiresAt: o.expiresAt,
  paidAt: o.paidAt || null,
});

// ====================== CONFIG (public) ====================== //
app.get('/api/v1/config', (req, res) =>
  res.json({
    brand: cfg.BRAND,
    owner: cfg.OWNER,
    commission: cfg.COMMISSION,
    group: cfg.SUPPORT_GROUP,
    channel: cfg.SUPPORT_CHANNEL,
    ownerTg: cfg.OWNER_TG,
  })
);

// ====================== ACCOUNTS ====================== //
app.post('/api/v1/auth/signup', limit(10, 60000), async (req, res) => {
  const { name, email, password, storeName, payoutUpi } = req.body || {};
  if (!clean(name)) return res.status(400).json({ success: false, error: 'Name is required.' });
  if (!isEmail(email)) return res.status(400).json({ success: false, error: 'Enter a valid email.' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
  if (payoutUpi && !isVpa(payoutUpi))
    return res.status(400).json({ success: false, error: 'Enter a valid UPI ID (example: name@fam).' });

  const em = email.trim().toLowerCase();
  if (D().users.some(u => u.email === em))
    return res.status(409).json({ success: false, error: 'This email already has an account. Please log in.' });

  const user = {
    id: 'usr_' + crypto.randomBytes(6).toString('hex'),
    name: clean(name),
    email: em,
    password: auth.hashPassword(password),
    storeName: clean(storeName) || clean(name),
    payoutUpi: payoutUpi ? payoutUpi.trim().toLowerCase() : '',
    webhookUrl: '',
    apiKey: auth.token('ANJALI_'),
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  D().users.push(user);
  db.save();

  // 1. Welcome email to the newly registered user
  await mail.send(
    em,
    `Welcome to ${cfg.BRAND}`,
    mail.layout(
      'Your account is ready',
      [
        ['Name', user.name],
        ['Store', user.storeName],
        ['Login email', em],
        ['Commission', `${cfg.COMMISSION}% per payment`],
      ],
      `<p style="color:#374151;font-size:14px">Your API key is available in your dashboard. Every payment you receive will be emailed to you.</p>`
    )
  );

  // 2. Alert email to the OWNER with merchant details (Name, Email, Store, UPI, etc.)
  if (cfg.GMAIL_USER) {
    await mail.send(
      cfg.GMAIL_USER,
      `👤 New Merchant Registered – ${user.storeName}`,
      mail.layout('New Merchant Onboarded', [
        ['Name', user.name],
        ['Email', em],
        ['Store Name', user.storeName],
        ['Payout UPI', user.payoutUpi || 'Not set yet'],
        ['User ID', user.id],
        ['Commission Rate', `${cfg.COMMISSION}%`],
        ['Registered At', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })],
      ])
    );
  }

  // 3. Telegram notification
  tg.notify(`🆕 New account: <b>${mail.esc(user.storeName)}</b> (${mail.esc(em)})`);

  res.json({ success: true, token: auth.createSession(user.id), user: publicUser(user) });
});

app.post('/api/v1/auth/login', limit(15, 60000), (req, res) => {
  const { email, password } = req.body || {};
  const user = isEmail(email) && D().users.find(u => u.email === email.trim().toLowerCase());
  if (!user || !auth.checkPassword(String(password || ''), user.password))
    return res.status(401).json({ success: false, error: 'Wrong email or password.' });
  if (user.status !== 'active')
    return res.status(403).json({ success: false, error: 'This account is blocked. Contact support.' });
  res.json({ success: true, token: auth.createSession(user.id), user: publicUser(user) });
});

app.post('/api/v1/auth/logout', auth.requireUser, (req, res) => {
  delete D().sessions[req.sessionToken];
  db.save();
  res.json({ success: true });
});

app.post('/api/v1/auth/forgot', limit(5, 60000), async (req, res) => {
  const { email } = req.body || {};
  const user = isEmail(email) && D().users.find(u => u.email === email.trim().toLowerCase());
  if (user) {
    const code = String(crypto.randomInt(100000, 999999));
    D().resets[user.email] = { code, exp: Date.now() + 15 * 60000, tries: 0 };
    db.save();
    await mail.send(
      user.email,
      `${cfg.BRAND} password reset code`,
      mail.layout('Reset your password', [['Your code', code], ['Valid for', '15 minutes']])
    );
  }
  res.json({ success: true, message: 'If this email has an account, a reset code was sent.' });
});

app.post('/api/v1/auth/reset', limit(10, 60000), (req, res) => {
  const { email, code, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const r = D().resets[em];
  const user = D().users.find(u => u.email === em);
  if (!r || !user || r.exp < Date.now() || r.tries >= 5)
    return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
  if (String(code).trim() !== r.code) {
    r.tries++;
    db.save();
    return res.status(400).json({ success: false, error: 'Wrong code.' });
  }
  if (typeof password !== 'string' || password.length < 6)
    return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });

  user.password = auth.hashPassword(password);
  delete D().resets[em];
  for (const [t, s] of Object.entries(D().sessions)) if (s.userId === user.id) delete D().sessions[t];
  db.save();
  res.json({ success: true, message: 'Password changed. Please log in.' });
});

// ====================== DASHBOARD ====================== //
app.get('/api/v1/me', auth.requireUser, (req, res) => res.json({ success: true, user: publicUser(req.user) }));

app.patch('/api/v1/me', auth.requireUser, (req, res) => {
  const { storeName, payoutUpi, webhookUrl, name } = req.body || {};
  if (payoutUpi !== undefined && payoutUpi !== '' && !isVpa(payoutUpi))
    return res.status(400).json({ success: false, error: 'Enter a valid UPI ID.' });
  if (webhookUrl && !/^https?:\/\/.{3,300}$/.test(webhookUrl))
    return res.status(400).json({ success: false, error: 'Webhook must start with http:// or https://' });

  if (name !== undefined && clean(name)) req.user.name = clean(name);
  if (storeName !== undefined && clean(storeName)) req.user.storeName = clean(storeName);
  if (payoutUpi !== undefined) req.user.payoutUpi = payoutUpi.trim().toLowerCase();
  if (webhookUrl !== undefined) req.user.webhookUrl = webhookUrl.trim();

  db.save();
  res.json({ success: true, user: publicUser(req.user) });
});

app.post('/api/v1/me/rotate-key', auth.requireUser, (req, res) => {
  req.user.apiKey = auth.token('ANJALI_');
  db.save();
  res.json({ success: true, user: publicUser(req.user) });
});

app.get('/api/v1/me/orders', auth.requireUser, (req, res) => {
  const orders = D().orders.filter(o => o.userId === req.user.id).slice(-200).reverse().map(publicOrder);
  res.json({ success: true, orders });
});

app.get('/api/v1/me/payouts', auth.requireUser, (req, res) => {
  res.json({ success: true, payouts: D().payouts.filter(p => p.userId === req.user.id).reverse() });
});

app.post('/api/v1/me/payouts', auth.requireUser, (req, res) => {
  const u = publicUser(req.user);
  const amt = r2(Number(req.body?.amount));
  if (!req.user.payoutUpi)
    return res.status(400).json({ success: false, error: 'Add your payout UPI ID in Settings first.' });
  if (!(amt >= 1) || amt > u.stats.balance)
    return res.status(400).json({ success: false, error: `You can withdraw up to ₹${u.stats.balance}.` });

  const p = {
    id: 'pay_' + crypto.randomBytes(5).toString('hex'),
    userId: req.user.id,
    amount: amt,
    upi: req.user.payoutUpi,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };
  D().payouts.push(p);
  db.save();

  tg.notify(`💸 Payout request ₹${amt} → ${mail.esc(p.upi)} (${mail.esc(req.user.storeName)})`);
  mail.send(
    cfg.GMAIL_USER,
    `Payout request ₹${amt}`,
    mail.layout('New payout request', [
      ['Store', req.user.storeName],
      ['Email', req.user.email],
      ['UPI', p.upi],
      ['Amount', `₹${amt}`],
    ])
  );
  res.json({ success: true, payout: p });
});

// ====================== PAYMENTS API (for merchant websites/bots) ====================== //
function uniquePayAmount(amount) {
  // Adds random paise so each pending order has a unique amount we can match in the alert email.
  const pending = new Set(D().orders.filter(o => o.status === 'PENDING').map(o => o.payAmount.toFixed(2)));
  const base = Math.floor(amount);
  for (let i = 0; i < 200; i++) {
    const p = r2(base + crypto.randomInt(1, 99) / 100);
    if (!pending.has(p.toFixed(2))) return p;
  }
  return null;
}

function createOrder(user, { amount, customerEmail, note }, req) {
  const amt = Number(amount);
  if (!(amt >= 1 && amt <= 100000))
    throw Object.assign(new Error('Amount must be between ₹1 and ₹1,00,000.'), { status: 400 });
  if (customerEmail && !isEmail(customerEmail))
    throw Object.assign(new Error('Customer email is not valid.'), { status: 400 });
  if (!cfg.UPI_ID)
    throw Object.assign(new Error('Payments are not configured yet.'), { status: 503 });

  const payAmount = uniquePayAmount(amt);
  if (!payAmount)
    throw Object.assign(new Error('Too many pending orders for this amount. Try again shortly.'), { status: 429 });

  const orderId = 'SHIV' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const commission = r2((payAmount * cfg.COMMISSION) / 100);
  const upiUri = `upi://pay?pa=${encodeURIComponent(cfg.UPI_ID)}&pn=${encodeURIComponent(cfg.UPI_NAME)}&am=${payAmount.toFixed(2)}&tn=${encodeURIComponent(orderId)}&cu=INR`;
  const o = {
    orderId,
    userId: user.id,
    amount: r2(amt),
    payAmount,
    commission,
    merchantNet: r2(payAmount - commission),
    note: clean(note, 120) || `Payment to ${user.storeName}`,
    customerEmail: customerEmail ? customerEmail.trim().toLowerCase() : '',
    status: 'PENDING',
    upiUri,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(upiUri)}`,
    payUrl: `${baseUrl(req)}/pay?id=${orderId}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + cfg.ORDER_EXPIRY_MIN * 60000).toISOString(),
  };

  D().orders.push(o);
  db.save();
  wakePoller();
  return o;
}

app.post('/api/v1/payments/create', auth.requireApiKey, (req, res) => {
  try {
    res.json({ success: true, order: publicOrder(createOrder(req.user, req.body || {}, req)) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// backward compatible old route
app.post('/api/v1/payments/create-qr', auth.requireApiKey, (req, res) => {
  try {
    res.json({ success: true, order: publicOrder(createOrder(req.user, req.body || {}, req)) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// Dashboard test payment (logged-in)
app.post('/api/v1/me/test-payment', auth.requireUser, (req, res) => {
  try {
    res.json({ success: true, order: publicOrder(createOrder(req.user, req.body || {}, req)) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

function statusHandler(req, res) {
  const id = req.params.orderId || req.body?.orderId;
  const o = D().orders.find(x => x.orderId === id && x.userId === req.user.id);
  if (!o) return res.status(404).json({ success: false, error: 'Order not found.' });
  res.json({ success: true, verified: o.status === 'PAID', order: publicOrder(o) });
}

app.get('/api/v1/payments/:orderId', auth.requireApiKey, statusHandler);
app.post('/api/v1/payments/verify-imap', auth.requireApiKey, async (req, res) => {
  await pollOnce().catch(() => {});
  statusHandler(req, res);
});

// Public checkout page data (no secrets)
app.get('/api/v1/checkout/:orderId', (req, res) => {
  const o = D().orders.find(x => x.orderId === req.params.orderId);
  if (!o) return res.status(404).json({ success: false, error: 'Order not found.' });
  const u = D().users.find(x => x.id === o.userId);
  res.json({
    success: true,
    order: {
      orderId: o.orderId,
      payAmount: o.payAmount,
      note: o.note,
      status: o.status,
      upiUri: o.upiUri,
      qrImageUrl: o.qrImageUrl,
      expiresAt: o.expiresAt,
      paidAt: o.paidAt || null,
      storeName: u ? u.storeName : cfg.BRAND,
    },
  });
});

// ====================== ADMIN (owner only) ====================== //
function requireAdmin(req, res, next) {
  const p = auth.bearer(req) || '';
  const a = Buffer.from(p);
  const b = Buffer.from(cfg.ADMIN_PASSWORD || '');
  if (!cfg.ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ success: false, error: 'Wrong admin password.' });
  next();
}

app.post('/api/v1/admin/login', limit(8, 60000), requireAdmin, (req, res) => res.json({ success: true }));

app.get('/api/v1/admin/overview', requireAdmin, async (req, res) => {
  const paid = D().orders.filter(o => o.status === 'PAID');
  res.json({
    success: true,
    settings: {
      upi: cfg.UPI_ID,
      gmail: cfg.GMAIL_USER,
      commission: cfg.COMMISSION,
      telegram: !!(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID),
    },
    imap: lastPoll,
    cleanup: {
      lastAt: D().lastCleanupAt,
      retentionDays: cfg.RETENTION_DAYS,
      everyDays: cfg.CLEANUP_EVERY_DAYS,
      nextAt: D().lastCleanupAt
        ? new Date(new Date(D().lastCleanupAt).getTime() + cfg.CLEANUP_EVERY_DAYS * 864e5).toISOString()
        : null,
    },
    totals: {
      users: D().users.length,
      orders: D().archive.orders + D().orders.length,
      paid: D().archive.paid + paid.length,
      volume: r2(D().archive.volume + paid.reduce((s, o) => s + o.payAmount, 0)),
      commission: r2(D().archive.commission + paid.reduce((s, o) => s + o.commission, 0)),
    },
    users: D().users.map(publicUser).map(u => ({ ...u, apiKey: u.apiKey.slice(0, 14) + '…' })),
    payouts: D().payouts.slice().reverse(),
    orders: D().orders.slice(-100).reverse().map(o => ({
      ...publicOrder(o),
      store: (D().users.find(u => u.id === o.userId) || {}).storeName,
    })),
  });
});

app.post('/api/v1/admin/payouts/:id', requireAdmin, (req, res) => {
  const p = D().payouts.find(x => x.id === req.params.id);
  if (!p || p.status !== 'PENDING') return res.status(404).json({ success: false, error: 'Payout not found.' });
  p.status = req.body?.action === 'reject' ? 'REJECTED' : 'PAID';
  p.doneAt = new Date().toISOString();
  db.save();
  const u = D().users.find(x => x.id === p.userId);
  if (u)
    mail.send(
      u.email,
      `Payout ${p.status.toLowerCase()} – ₹${p.amount}`,
      mail.layout(`Payout ${p.status.toLowerCase()}`, [
        ['Amount', `₹${p.amount}`],
        ['UPI', p.upi],
        ['Status', p.status],
      ])
    );
  res.json({ success: true, payout: p });
});

app.post('/api/v1/admin/users/:id/toggle', requireAdmin, (req, res) => {
  const u = D().users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
  u.status = u.status === 'active' ? 'blocked' : 'active';
  db.save();
  res.json({ success: true, status: u.status });
});

app.post('/api/v1/admin/orders/:id/mark-paid', requireAdmin, (req, res) => {
  const o = D().orders.find(x => x.orderId === req.params.id);
  if (!o || o.status === 'PAID') return res.status(400).json({ success: false, error: 'Order not found or already paid.' });
  markPaid(o, 'manual');
  res.json({ success: true });
});

// Email + clean history older than RETENTION_DAYS right now (normally runs automatically every month).
app.post('/api/v1/admin/cleanup', requireAdmin, async (req, res) => {
  const r = await cleanup.runCleanup({ force: true });
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  res.json({ success: true, result: r });
});

app.get('/health', (req, res) => res.json({ status: 'OK', brand: cfg.BRAND, imap: lastPoll.ok }));

// ====================== PAYMENT WATCHER ====================== //
let lastPoll = { ok: null, at: null, error: null };
let running = false,
  wakeTimer = null;

function markPaid(o, mailId) {
  o.status = 'PAID';
  o.paidAt = new Date().toISOString();
  o.mailId = mailId;
  if (mailId !== 'manual') D().usedMails.push(mailId);
  if (D().usedMails.length > 5000) D().usedMails = D().usedMails.slice(-3000);
  db.save();

  const u = D().users.find(x => x.id === o.userId);
  if (!u) return;

  const rows = [
    ['Order ID', o.orderId],
    ['Amount paid', `₹${o.payAmount.toFixed(2)}`],
    ['Note', o.note],
    ['Paid at', new Date(o.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })],
  ];

  // 1. Merchant notification email
  mail.send(
    u.email,
    `✅ Payment received ₹${o.payAmount.toFixed(2)} – ${o.orderId}`,
    mail.layout('Payment received', [
      ...rows,
      [`Commission (${cfg.COMMISSION}%)`, `₹${o.commission.toFixed(2)}`],
      ['Your earning', `₹${o.merchantNet.toFixed(2)}`],
      ['Customer', o.customerEmail || '—'],
    ])
  );

  // 2. Owner notification email (Payment alert with full breakdown)
  if (cfg.GMAIL_USER) {
    mail.send(
      cfg.GMAIL_USER,
      `🔔 Payment received ₹${o.payAmount.toFixed(2)} – ${u.storeName}`,
      mail.layout('New Payment Received', [
        ['Store', u.storeName],
        ['Merchant Email', u.email],
        ['Order ID', o.orderId],
        ['Amount Paid', `₹${o.payAmount.toFixed(2)}`],
        ['Commission Kept', `₹${o.commission.toFixed(2)} (${cfg.COMMISSION}%)`],
        ['Merchant Earning', `₹${o.merchantNet.toFixed(2)}`],
        ['Customer', o.customerEmail || '—'],
        ['Paid At', new Date(o.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })],
      ])
    );
  }

  // 3. Customer confirmation email (if email provided)
  if (o.customerEmail) {
    mail.send(o.customerEmail, `Payment successful – ${u.storeName}`, mail.layout(`Thank you! Paid to ${u.storeName}`, rows));
  }

  // 4. Telegram alert
  tg.notify(`✅ <b>₹${o.payAmount.toFixed(2)}</b> received\nStore: ${mail.esc(u.storeName)}\nOrder: <code>${o.orderId}</code>`);

  // 5. Merchant webhook dispatch
  if (u.webhookUrl) {
    fetch(u.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BBH-Signature': crypto.createHmac('sha256', u.apiKey).update(o.orderId).digest('hex'),
      },
      body: JSON.stringify({ event: 'payment.paid', order: publicOrder(o) }),
    }).catch(e => console.error('Webhook failed:', e.message));
  }
}

async function pollOnce() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    for (const o of D().orders) if (o.status === 'PENDING' && new Date(o.expiresAt).getTime() < now) o.status = 'EXPIRED';
    const pending = D().orders.filter(o => o.status === 'PENDING');
    if (!pending.length) {
      db.save();
      return;
    }
    if (!cfg.GMAIL_USER || !cfg.GMAIL_APP_PASSWORD) {
      lastPoll = { ok: false, at: new Date().toISOString(), error: 'Gmail not configured' };
      return;
    }
    const oldest = new Date(Math.min(...pending.map(o => new Date(o.createdAt).getTime())) - 864e5);
    const mails = await imap.fetchRecent(oldest);
    const used = new Set(D().usedMails);
    for (const o of pending) {
      const created = new Date(o.createdAt).getTime();
      const hit = mails.find(m => !used.has(m.msgId) && imap.matches(m.text, o));
      if (hit) {
        used.add(hit.msgId);
        markPaid(o, hit.msgId);
      }
      void created;
    }
    lastPoll = { ok: true, at: new Date().toISOString(), error: null, scanned: mails.length };
    db.save();
  } catch (e) {
    lastPoll = { ok: false, at: new Date().toISOString(), error: e.responseText || e.message };
    console.error('IMAP poll failed:', lastPoll.error);
  } finally {
    running = false;
  }
}

function wakePoller() {
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => pollOnce(), 5000);
}

app.get('/api/*', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  try {
    await db.init();
  } catch (e) {
    console.error('Cannot connect to MongoDB:', e.message);
    process.exit(1);
  }
  setInterval(() => pollOnce(), Math.max(10, cfg.POLL_SECONDS) * 1000);
  cleanup.startScheduler();
  const server = app.listen(cfg.PORT, async () => {
    console.log(`\n${cfg.BRAND} payment gateway running on http://localhost:${cfg.PORT}`);
    console.log(`UPI: ${cfg.UPI_ID || 'NOT SET'} | Commission: ${cfg.COMMISSION}% | Gmail: ${cfg.GMAIL_USER || 'NOT SET'}`);
    if (!cfg.ADMIN_PASSWORD) console.log('WARNING: ADMIN_PASSWORD not set - admin panel disabled.');
    const t = await imap.testLogin();
    console.log(t.ok ? 'Gmail IMAP login: OK' : `Gmail IMAP login FAILED: ${t.error}`);
    lastPoll = { ok: t.ok, at: new Date().toISOString(), error: t.ok ? null : t.error };
  });

  // Railway sends SIGTERM on restart/redeploy – save everything to MongoDB before exiting.
  const shutdown = async sig => {
    console.log(`${sig} received – saving data to MongoDB...`);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
