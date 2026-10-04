// Monthly history cleanup.
// - Orders/payouts older than RETENTION_DAYS are emailed to each user (CSV files) from the owner's Gmail.
// - Only after the email is sent are those records deleted.
// - Totals (balance, earned, volume, paid out) are carried forward in user.archive, so balances never change.
// - User accounts are NEVER deleted. Pending orders and pending payouts are never deleted.
const db = require('./db');
const cfg = require('./config');
const mail = require('./mailer');

const r2 = n => Math.round(n * 100) / 100;
const DAY = 864e5;
const emptyUserArchive = () => ({ totalOrders: 0, paidOrders: 0, volume: 0, commission: 0, earned: 0, paidOut: 0 });

function csv(rows, cols) {
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}
const ORDER_COLS = ['orderId', 'status', 'amount', 'payAmount', 'commission', 'merchantNet', 'note', 'customerEmail', 'createdAt', 'paidAt'];
const PAYOUT_COLS = ['id', 'status', 'amount', 'upi', 'createdAt', 'doneAt'];
const ist = d => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

// Old = created before cutoff and finished (not PENDING).
const oldOrder = (o, cutoff) => o.status !== 'PENDING' && new Date(o.createdAt).getTime() < cutoff;
const oldPayout = (p, cutoff) => p.status !== 'PENDING' && new Date(p.createdAt).getTime() < cutoff;

let busy = false;
async function runCleanup({ force = false } = {}) {
  if (busy) return { ok: false, error: 'Cleanup already running.' };
  const D = db.data; const now = Date.now();
  const last = D.lastCleanupAt ? new Date(D.lastCleanupAt).getTime() : 0;
  if (!force && now - last < cfg.CLEANUP_EVERY_DAYS * DAY) return { ok: true, skipped: true };
  if (!cfg.GMAIL_USER || !cfg.GMAIL_APP_PASSWORD) return { ok: false, error: 'Gmail not configured – history is kept until email works.' };
  busy = true;
  try {
    const cutoff = now - cfg.RETENTION_DAYS * DAY;
    const result = { ok: true, users: 0, orders: 0, payouts: 0, failed: [] };

    // Housekeeping: drop expired sessions and reset codes (users are not touched).
    for (const [t, s] of Object.entries(D.sessions)) if (s.exp < now) delete D.sessions[t];
    for (const [e, r] of Object.entries(D.resets)) if (r.exp < now) delete D.resets[e];

    const allOldOrders = D.orders.filter(o => oldOrder(o, cutoff));
    const allOldPayouts = D.payouts.filter(p => oldPayout(p, cutoff));
    const period = `till ${ist(cutoff)}`;

    // 1) Owner copy of everything being removed (if this fails, nothing is deleted – retried later).
    if (allOldOrders.length || allOldPayouts.length) {
      const store = id => (D.users.find(u => u.id === id) || {}).storeName || '';
      const ok = await mail.send(cfg.GMAIL_USER, `${cfg.BRAND} – history backup (${period})`,
        mail.layout('Monthly history backup', [['Orders', allOldOrders.length], ['Payouts', allOldPayouts.length], ['Period', period]],
          '<p style="color:#374151;font-size:14px">Full CSV backup attached. These records are now removed from the website. All user accounts and balances stay safe.</p>'),
        [
          { filename: `all-orders-${new Date(cutoff).toISOString().slice(0, 10)}.csv`, content: csv(allOldOrders.map(o => ({ ...o, store: store(o.userId) })), ['store', ...ORDER_COLS]) },
          { filename: `all-payouts-${new Date(cutoff).toISOString().slice(0, 10)}.csv`, content: csv(allOldPayouts.map(p => ({ ...p, store: store(p.userId) })), ['store', ...PAYOUT_COLS]) },
        ]);
      if (!ok) return { ok: false, error: 'Owner backup email failed – nothing deleted, will retry.' };
    }

    // 2) Per user: email their old history, then delete it and carry totals forward.
    const deleteOrders = new Set(), deletePayouts = new Set();
    for (const u of D.users) {
      const orders = allOldOrders.filter(o => o.userId === u.id);
      const payouts = allOldPayouts.filter(p => p.userId === u.id);
      if (!orders.length && !payouts.length) continue;
      const paid = orders.filter(o => o.status === 'PAID');
      const paidOut = payouts.filter(p => p.status === 'PAID');
      const sent = await mail.send(u.email, `${cfg.BRAND} – your payment history (${period})`,
        mail.layout('Your monthly payment history', [
          ['Store', u.storeName], ['Period', period], ['Orders', orders.length], ['Paid orders', paid.length],
          ['Volume', `₹${r2(paid.reduce((s, o) => s + o.payAmount, 0))}`], ['Your earning', `₹${r2(paid.reduce((s, o) => s + o.merchantNet, 0))}`],
          ['Withdrawn', `₹${r2(paidOut.reduce((s, p) => s + p.amount, 0))}`],
        ], '<p style="color:#374151;font-size:14px">Your full history for this period is attached as CSV files (open in Excel / Google Sheets). These old records are removed from your dashboard, but <b>your account and total balance stay exactly the same</b>.</p>'),
        [
          { filename: `orders-${new Date(cutoff).toISOString().slice(0, 10)}.csv`, content: csv(orders, ORDER_COLS) },
          { filename: `payouts-${new Date(cutoff).toISOString().slice(0, 10)}.csv`, content: csv(payouts, PAYOUT_COLS) },
        ]);
      if (!sent) { result.failed.push(u.email); continue; } // keep their data, try again next run
      const a = u.archive = { ...emptyUserArchive(), ...(u.archive || {}) };
      a.totalOrders += orders.length; a.paidOrders += paid.length;
      a.volume = r2(a.volume + paid.reduce((s, o) => s + o.payAmount, 0));
      a.commission = r2(a.commission + paid.reduce((s, o) => s + o.commission, 0));
      a.earned = r2(a.earned + paid.reduce((s, o) => s + o.merchantNet, 0));
      a.paidOut = r2(a.paidOut + paidOut.reduce((s, p) => s + p.amount, 0));
      orders.forEach(o => deleteOrders.add(o.orderId)); payouts.forEach(p => deletePayouts.add(p.id));
      result.users++; result.orders += orders.length; result.payouts += payouts.length;
    }
    // Orders whose user no longer exists: owner already has the backup.
    const userIds = new Set(D.users.map(u => u.id));
    allOldOrders.filter(o => !userIds.has(o.userId)).forEach(o => deleteOrders.add(o.orderId));
    allOldPayouts.filter(p => !userIds.has(p.userId)).forEach(p => deletePayouts.add(p.id));

    // Global admin totals carried forward.
    const gone = allOldOrders.filter(o => deleteOrders.has(o.orderId));
    const gPaid = gone.filter(o => o.status === 'PAID');
    D.archive.orders += gone.length; D.archive.paid += gPaid.length;
    D.archive.volume = r2(D.archive.volume + gPaid.reduce((s, o) => s + o.payAmount, 0));
    D.archive.commission = r2(D.archive.commission + gPaid.reduce((s, o) => s + o.commission, 0));

    D.orders = D.orders.filter(o => !deleteOrders.has(o.orderId));
    D.payouts = D.payouts.filter(p => !deletePayouts.has(p.id));
    D.lastCleanupAt = new Date(now).toISOString();
    await db.flush();
    console.log(`History cleanup done: ${result.orders} orders, ${result.payouts} payouts removed for ${result.users} users.` + (result.failed.length ? ` Email failed for: ${result.failed.join(', ')}` : ''));
    return result;
  } finally { busy = false; }
}

function startScheduler() {
  const tick = () => runCleanup().catch(e => console.error('Cleanup error:', e.message));
  setTimeout(tick, 60000);                 // shortly after startup
  setInterval(tick, 6 * 60 * 60 * 1000);   // check every 6 hours
}

module.exports = { runCleanup, startScheduler, emptyUserArchive };
