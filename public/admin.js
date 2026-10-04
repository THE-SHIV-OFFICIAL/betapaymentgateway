let pw = sessionStorage.getItem('bbh_admin') || '';
const A = (p, o = {}) => api(p, { ...o, token: pw });
$('#f-admin').onsubmit = async e => { e.preventDefault(); pw = e.target.password.value;
  try { await A('/api/v1/admin/login', { method: 'POST' }); sessionStorage.setItem('bbh_admin', pw); open(); } catch (err) { showMsg($('#aMsg'), err.message); } };
async function open() { $('#aLogin').classList.add('hidden'); $('#aApp').classList.remove('hidden'); load(); }
async function load() {
  try {
    const d = await A('/api/v1/admin/overview'); const t = d.totals;
    $('#imapState').innerHTML = d.imap.ok ? '<span class="badge b-PAID">GMAIL CONNECTED</span>' : `<span class="badge b-EXPIRED" title="${esc(d.imap.error || '')}">GMAIL ERROR</span>`;
    $('#aStats').innerHTML = [['Accounts', t.users, ''], ['Paid orders', t.paid, 'green'], ['Volume', inr(t.volume), 'cyan'], [`Your ${d.settings.commission}% earning`, inr(t.commission), 'gold']].map(([k, v, c]) => `<div class="card stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
    if (d.cleanup) $('#cleanState').textContent = `History kept ${d.cleanup.retentionDays} days · next clean ${d.cleanup.nextAt ? new Date(d.cleanup.nextAt).toLocaleDateString('en-IN') : '—'}`;
    const store = id => (d.users.find(u => u.id === id) || {}).storeName || '—';
    $('#aPayouts').innerHTML = d.payouts.map(p => `<tr><td>${esc(store(p.userId))}</td><td><code>${esc(p.upi)}</code></td><td>${inr(p.amount)}</td><td>${badge(p.status)}</td><td>${p.status === 'PENDING' ? `<button class="btn sm" data-po="${p.id}">Mark paid</button> <button class="btn danger sm" data-pr="${p.id}">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No requests.</td></tr>';
    $('#aUsers').innerHTML = d.users.map(u => `<tr><td>${esc(u.storeName)}</td><td>${esc(u.email)}</td><td>${inr(u.stats.volume)}</td><td>${inr(u.stats.balance)}</td><td>${badge(u.status)}</td><td><button class="btn ghost sm" data-ut="${u.id}">${u.status === 'active' ? 'Block' : 'Unblock'}</button></td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No accounts.</td></tr>';
    $('#aOrders').innerHTML = d.orders.map(o => `<tr><td><code>${esc(o.orderId)}</code></td><td>${esc(o.store)}</td><td>${inr(o.payAmount)}</td><td>${badge(o.status)}</td><td>${o.status !== 'PAID' ? `<button class="btn ghost sm" data-om="${o.orderId}">Mark paid</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No orders.</td></tr>';
  } catch (e) { if (e.status === 401) { sessionStorage.removeItem('bbh_admin'); location.reload(); } else toast(e.message); }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.po) await A('/api/v1/admin/payouts/' + b.dataset.po, { method: 'POST', body: { action: 'paid' } });
    else if (b.dataset.pr) await A('/api/v1/admin/payouts/' + b.dataset.pr, { method: 'POST', body: { action: 'reject' } });
    else if (b.dataset.ut) await A('/api/v1/admin/users/' + b.dataset.ut + '/toggle', { method: 'POST' });
    else if (b.dataset.om) { if (!confirm('Mark this order as paid manually?')) return; await A('/api/v1/admin/orders/' + b.dataset.om + '/mark-paid', { method: 'POST' }); }
    else return;
    toast('Done ✓'); load();
  } catch (err) { toast(err.message); }
});
$('#aRefresh').onclick = load;
$('#aClean').onclick = async () => {
  if (!confirm('Email all history older than the retention period to each user (and you), then delete it from the website? Accounts and balances stay safe.')) return;
  try { const r = await A('/api/v1/admin/cleanup', { method: 'POST' }); const x = r.result;
    toast(`Cleaned ${x.orders} orders, ${x.payouts} payouts for ${x.users} users` + (x.failed.length ? ` · email failed: ${x.failed.length}` : '')); load();
  } catch (err) { toast(err.message); }
};
if (pw) open();
