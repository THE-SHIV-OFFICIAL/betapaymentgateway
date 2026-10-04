const cfg = require('./config');
async function notify(text) {
  if (!cfg.TG_BOT_TOKEN || !cfg.TG_CHAT_ID) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('Telegram error', r.status, await r.text());
  } catch (e) { console.error('Telegram error', e.message); }
}
module.exports = { notify };
