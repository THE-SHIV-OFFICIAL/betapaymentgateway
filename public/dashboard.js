let me = null;
function authTab(t) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  ['login', 'signup', 'forgot'].forEach(x => $('#f-' + x).classList.toggle('hidden', x !== t));
  $('#authMsg').className = 'msg';
}
$$('.tabs button').forEach(b => b.onclick = () => authTab(b.dataset.t));
function busy(form, on) { const b = form.querySelector('button:not([type=button])'); if (b) b.disabled = on; }

$('#f-login').onsubmit = async e => { e.preventDefault(); busy(e.target, true);
  try { const d = await api('/api/v1/auth/login', { method: 'POST', body: formData(e.target), token: '' }); localStorage.setItem('bbh_token', d.token); start(d.user); }
  catch (err) { showMsg($('#authMsg'), err.message); } finally { busy(e.target, false); } };
$('#f-signup').onsubmit = async e => { e.preventDefault(); busy(e.target, true);
  try { const d = await api('/api/v1/auth/signup', { method: 'POST', body: formData(e.target), token: '' }); localStorage.setItem('bbh_token', d.token); start(d.user); toast('Account created 🎉'); }
  catch (err) { showMsg($('#authMsg'), err.message); } finally { busy(e.target, false); } };
$('#sendCode').onclick = async () => { const f = $('#f-forgot');
  try { const d = await api('/api/v1/auth/forgot', { method: 'POST', body: { email: f.email.value }, token: '' }); showMsg($('#authMsg'), d.message, true); }
  catch (err) { showMsg($('#authMsg'), err.message); } };
$('#f-forgot').onsubmit = async e => { e.preventDefault();
  try { const d = await api('/api/v1/auth/reset', { method: 'POST', body: formData(e.target), token: '' }); showMsg($('#authMsg'), d.message, true); setTimeout(() => authTab('login'), 1200); }
  catch (err) { showMsg($('#authMsg'), err.message); } };

function panel(p) { $$('.side button[data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === p)); $$('.panel').forEach(x => x.classList.toggle('on', x.id === 'p-' + p)); if (p === 'orders' || p === 'overview') loadOrders(); if (p === 'payouts') loadPayouts(); }
$$('.side button[data-p]').forEach(b => b.onclick = () => panel(b.dataset.p));
$('#logout').onclick = async () => { try { await api('/api/v1/auth/logout', { method: 'POST' }); } catch {} localStorage.removeItem('bbh_token'); location.reload(); };

function render(u) {
  me = u; const s = u.stats;
  $('#uName').textContent = u.name; $('#uStore').textContent = u.storeName; $('#uEmail').textContent = u.email;
  $('#s-balance').textContent = inr(s.balance); $('#s-volume').textContent = inr(s.volume); $('#s-paid').textContent = s.paidOrders; $('#s-out').textContent = inr(s.paidOut);
  $('#w-bal').textContent = inr(s.balance); $('#w-upi').textContent = u.payoutUpi || 'Add UPI in Settings';
  $('#apiKey').textContent = u.apiKey;
  $('#snippet').textContent = `const res = await fetch('${location.origin}/api/v1/payments/create', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ${u.apiKey}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ amount: 99, customerEmail: 'buyer@gmail.com', note: 'Premium' })
});
const { order } = await res.json();
console.log(order.payUrl); // send this link to your customer`;
  const f = $('#f-settings'); f.name.value = u.name; f.storeName.value = u.storeName; f.payoutUpi.value = u.payoutUpi; f.webhookUrl.value = u.webhookUrl;
}
function start(u) { $('#authBox').classList.add('hidden'); $('#app').classList.remove('hidden'); render(u); loadOrders(); }

async function refreshMe() { try { render((await api('/api/v1/me')).user); } catch {} }
async function loadOrders() {
  try {
    const { orders } = await api('/api/v1/me/orders');
    const row = o => `<tr><td><code>${esc(o.orderId)}</code><br/><small style="color:var(--muted)">${esc(o.note)}</small></td><td>${inr(o.payAmount)}</td>`;
    $('#recent').innerHTML = orders.slice(0, 6).map(o => row(o) + `<td>${badge(o.status)}</td><td>${when(o.createdAt)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:var(--muted)">No payments yet. Try a test payment.</td></tr>';
    $('#allOrders').innerHTML = orders.map(o => row(o) + `<td>${inr(o.merchantNet)}</td><td>${esc(o.customerEmail || '—')}</td><td>${badge(o.status)}</td><td>${when(o.paidAt || o.createdAt)}</td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No payments yet.</td></tr>';
    refreshMe();
  } catch (e) { if (e.status === 401) { localStorage.removeItem('bbh_token'); location.reload(); } }
}
$('#refresh').onclick = loadOrders;
async function loadPayouts() {
  const { payouts } = await api('/api/v1/me/payouts');
  $('#payouts').innerHTML = payouts.map(p => `<tr><td>${inr(p.amount)}</td><td>${badge(p.status)}</td><td>${when(p.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--muted)">No withdrawals yet.</td></tr>';
}
$('#f-payout').onsubmit = async e => { e.preventDefault();
  try { await api('/api/v1/me/payouts', { method: 'POST', body: { amount: Number(e.target.amount.value) } }); showMsg($('#payMsg'), 'Request sent. You will get an email when it is paid.', true); e.target.reset(); loadPayouts(); refreshMe(); }
  catch (err) { showMsg($('#payMsg'), err.message); } };
$('#f-settings').onsubmit = async e => { e.preventDefault();
  try { const d = await api('/api/v1/me', { method: 'PATCH', body: formData(e.target) }); render(d.user); showMsg($('#setMsg'), 'Saved ✓', true); }
  catch (err) { showMsg($('#setMsg'), err.message); } };
$('#copyKey').onclick = () => { navigator.clipboard.writeText(me.apiKey); toast('API key copied'); };
$('#rotate').onclick = async () => { if (!confirm('Make a new key? The old key will stop working.')) return; render((await api('/api/v1/me/rotate-key', { method: 'POST' })).user); toast('New key created'); };

let testTimer = null;
$('#f-test').onsubmit = async e => { e.preventDefault(); busy(e.target, true);
  try {
    const { order } = await api('/api/v1/me/test-payment', { method: 'POST', body: formData(e.target) });
    $('#testMsg').className = 'msg';
    $('#testOut').innerHTML = `<div class="qr"><img src="${esc(order.qrImageUrl)}" alt="UPI QR"/></div><div class="amt" style="margin-top:14px">${inr(order.payAmount)}</div><p>Pay exactly this amount</p><p style="margin-top:8px"><span class="pulse"></span> <span id="tStatus">Waiting for payment…</span></p><div class="row" style="justify-content:center;margin-top:14px"><a class="btn sm" href="${esc(order.upiUri)}">Open UPI app</a><a class="btn ghost sm" target="_blank" href="${esc(order.payUrl)}">Checkout page</a></div>`;
    clearInterval(testTimer);
    testTimer = setInterval(async () => { try { const { order: o } = await api('/api/v1/checkout/' + order.orderId, { token: '' }); if (o.status !== 'PENDING') { clearInterval(testTimer); $('#tStatus').innerHTML = badge(o.status); loadOrders(); if (o.status === 'PAID') toast('Payment received ✅'); } } catch {} }, 5000);
  } catch (err) { showMsg($('#testMsg'), err.message); } finally { busy(e.target, false); } };

(async () => {
  if (!localStorage.getItem('bbh_token')) return $('#authBox').classList.remove('hidden');
  try { start((await api('/api/v1/me')).user); } catch { localStorage.removeItem('bbh_token'); $('#authBox').classList.remove('hidden'); }
})();
