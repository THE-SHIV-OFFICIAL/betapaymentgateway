// Sends emails to users FROM the owner's Gmail (users never enter an app password).
const nodemailer = require('nodemailer');
const cfg = require('./config');

let transport = null;

function getTransport() {
  if (!cfg.GMAIL_USER || !cfg.GMAIL_APP_PASSWORD) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // Port 587 uses STARTTLS
      auth: {
        user: cfg.GMAIL_USER,
        pass: cfg.GMAIL_APP_PASSWORD,
      },
      family: 4,                // Forces IPv4 to prevent Railway IPv6 hang
      connectionTimeout: 10000, // 10s connection timeout
      greetingTimeout: 10000,   // 10s greeting timeout
      socketTimeout: 15000,     // 15s socket timeout
    });
  }
  return transport;
}

const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function layout(title, rows, footer = '') {
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px">${esc(k)}</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#111827;font-size:14px">${esc(v)}</td></tr>`
    )
    .join('');

  return `<div style="background:#ffffff;padding:24px;font-family:Arial,sans-serif"><div style="max-width:520px;margin:auto;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
  <div style="background:#0b1020;padding:20px 24px;color:#7dd3fc;font-weight:800;letter-spacing:2px">${esc(cfg.BRAND)}</div>
  <div style="padding:24px"><h2 style="margin:0 0 16px;color:#111827">${esc(title)}</h2><table style="width:100%;border-collapse:collapse">${body}</table>${footer}
  <p style="margin-top:24px;color:#9ca3af;font-size:12px">Support: Telegram ${esc(cfg.SUPPORT_GROUP)} · Updates: ${esc(cfg.SUPPORT_CHANNEL)}<br/>© ${new Date().getFullYear()} ${esc(cfg.BRAND)} · by ${esc(cfg.OWNER)}</p></div></div></div>`;
}

async function send(to, subject, html, attachments) {
  const t = getTransport();
  if (!t || !to) return false;
  try {
    await t.sendMail({
      from: `"${cfg.BRAND}" <${cfg.GMAIL_USER}>`,
      to,
      subject,
      html,
      ...(attachments ? { attachments } : {}),
    });
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

module.exports = { send, layout, esc };
