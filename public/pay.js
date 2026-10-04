const id = new URLSearchParams(location.search).get('id');
let timer;
async function load() {
  const box = $('#box');
  if (!id) { box.innerHTML = '<h3>Order not found</h3>'; return; }
  try {
    const { order: o } = await api('/api/v1/checkout/' + encodeURIComponent(id), { token: '' });
    if (o.status === 'PAID') { clearInterval(timer); box.innerHTML = `<div class="ico" style="margin:auto;font-size:26px">✅</div><h2 style="margin-top:12px">Payment successful</h2><p style="color:var(--muted)">${inr(o.payAmount)} paid to ${esc(o.storeName)}</p><p style="margin-top:10px"><code>${esc(o.orderId)}</code></p>`; return; }
    if (o.status === 'EXPIRED') { clearInterval(timer); box.innerHTML = `<h2>Order expired</h2><p style="color:var(--muted)">Please create a new order. If you already paid, contact support with order <code>${esc(o.orderId)}</code>.</p>`; return; }
    if (!box.dataset.ready) {
      box.dataset.ready = 1;
      box.innerHTML = `<p style="color:var(--muted)">Paying</p><h3>${esc(o.storeName)}</h3><div class="amt" style="margin:8px 0 16px">${inr(o.payAmount)}</div><div class="qr"><img src="${esc(o.qrImageUrl)}" alt="UPI QR"/></div>
      <p style="margin-top:16px;font-size:14px;color:var(--muted)">Scan with any UPI app. <b style="color:var(--gold)">Pay the exact amount ${inr(o.payAmount)}</b> (including paise).</p>
      <a class="btn" style="width:100%;margin-top:16px" href="${esc(o.upiUri)}">Pay with UPI app</a>
      <p style="margin-top:16px"><span class="pulse"></span> Waiting for payment… <span id="left"></span></p><p style="font-size:12px;color:var(--muted);margin-top:8px">Order <code>${esc(o.orderId)}</code></p>`;
    }
    const s = Math.max(0, Math.floor((new Date(o.expiresAt) - Date.now()) / 1000));
    const l = $('#left'); if (l) l.textContent = `(${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left)`;
  } catch (e) { $('#box').innerHTML = `<h3>${esc(e.message)}</h3>`; }
}
load(); timer = setInterval(load, 5000);
