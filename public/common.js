const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = d => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const badge = s => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
function toast(t) { const el = $('#toast'); if (!el) return; el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 2600); }
function showMsg(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token ?? localStorage.getItem('bbh_token');
  if (t) headers.Authorization = 'Bearer ' + t;
  let res, data;
  try { res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined }); data = await res.json(); }
  catch { throw new Error('Network error. Please try again.'); }
  if (!res.ok || data.success === false) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
  return data;
}
const formData = f => Object.fromEntries(new FormData(f).entries());
document.addEventListener('DOMContentLoaded', async () => {
  const y = $('#yr'); if (y) y.textContent = new Date().getFullYear();
  try { const c = await api('/api/v1/config', { token: '' }); $$('[data-brand]').forEach(e => e.textContent = c.brand); const cm = $('#commission'); if (cm) cm.textContent = c.commission; window.BBH = c; } catch {}
});
