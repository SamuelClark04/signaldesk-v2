// Notification engine: emails the user when a vetted setup is staged in the
// Approvals queue (any strategy: the pipeline and the Portfolio Pilot both call
// sendApprovalAlert). Subject + plain-text + HTML bodies, with a deep-link
// button straight to Opportunities → Approvals.
//
// SMTP via nodemailer, configured in .env:
//   SMTP_HOST, SMTP_PORT (465 = implicit TLS; 587/25 = STARTTLS), SMTP_USER,
//   SMTP_PASS, ALERT_EMAIL_TO, optional SMTP_FROM (default SMTP_USER) and
//   APP_PUBLIC_URL (the address you open SignalDesk at; default this machine).
// Anything missing: the alert is logged to the console instead (warned once,
// naming the missing settings, never their values). A failed send is logged and
// never blocks staging. Links carry no access token: the buttons are one-tap
// magic sign-in links (security/magic-link.js: HMAC-signed, expiring), so a
// phone lands inside the app even on a brand-new tunnel hostname. The console
// fallback never prints them (consoleText: the plain address only).
// sendTunnelReadyEmail: "[SignalDesk] Your Live Mobile Link is Ready", sent by
// security/tunnel-manager.js once per new tunnel URL (TUNNEL_EMAIL=off disables
// it) and on demand from Settings (security/mobile-link.js).
//
// The alert is informational: approving still happens in the terminal, where the
// order guard re-checks staleness and price at the moment of approval.
const nodemailer = require('nodemailer');
const { MAX_CANDIDATE_AGE_MS } = require('./order-guard');
const magic = require('../security/magic-link');

// The Cloudflare quick tunnel's address (TUNNEL_PUBLIC_URL, set at runtime by
// security/tunnel.js) wins, so emailed links work away from this PC.
const baseUrl = () => (process.env.TUNNEL_PUBLIC_URL || process.env.APP_PUBLIC_URL || (process.env.TERMINAL_URL || '').split('#')[0]
  || `http://127.0.0.1:${Number(process.env.PORT) || 3000}/`).replace(/\/*$/, '/');
const approvalsUrl = () => `${baseUrl()}#opportunities?tab=approvals`;
const expiresText = () => `${Math.round(magic.TTL_MS / 3600000)} hours`;

const usd = (x) => (Number.isFinite(x)
  ? `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : 'n/a');
const px = (x) => (Number.isFinite(x)
  ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })
  : 'n/a');
const etTime = (ms) => new Date(ms).toLocaleTimeString('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});

// Candidate text (news headlines, theses) is untrusted: escape it for HTML.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sizeLabel(o) {
  if (!Number.isFinite(o.positionSize)) return 'n/a';
  if (o.market === 'options') return `${o.positionSize} contract${o.positionSize === 1 ? '' : 's'}`;
  if (o.market === 'stocks') return `${o.positionSize} share${o.positionSize === 1 ? '' : 's'}`;
  return `${o.positionSize} coins`;
}

// Ordered label/value rows shared by the text and HTML bodies.
function detailRows(o) {
  const rows = [
    ['Asset', `${o.asset} (${o.market})`],
    ['Setup', `${o.setupType} · ${o.strategyId} · ${o.timeframe}`],
    ['Direction', String(o.direction).toUpperCase()],
    ['Entry zone', `${px(o.entryZone.min)} – ${px(o.entryZone.max)}`],
    ['Stop loss', px(o.invalidation)],
    ['Targets', (o.targets || []).map((t) => `T${t.level} ${px(t.price)} (${Math.round(t.allocation * 100)}%)`).join(', ')
      || (o.strategyId === 'portfolio-pilot' ? 'None: core holding (exits at the stop or an approved Pilot sell/trim)' : 'n/a')],
    ['Size', sizeLabel(o)],
    ['Risk', `${usd(o.dollarRisk)}${Number.isFinite(o.feeDrag) ? ` · fee drag ${o.feeDrag.toFixed(2)}R` : ''}`],
  ];
  if (o.speculative) rows.push(['Speculative', `Moonshot micro-size: ${Math.round(o.speculativeScale * 100)}% of normal risk (${(o.speculativeRiskPct * 100).toFixed(2)}% of the bankroll)`]);
  if (o.capitalCapped) rows.push(['Capital cap', `size limited to ${o.capitalCapPct * 100}% of the bankroll: risking ${(o.actualRiskPct * 100).toFixed(2)}%, not ${(o.riskPct * 100).toFixed(2)}%`]);
  if (o.optionsData) {
    const legs = (o.optionsData.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ');
    rows.push(['Options', o.optionsData.contract ? `${o.optionsData.contract} at ${o.optionsData.debit} ask (bid ${o.optionsData.bid}), ${o.optionsData.dte} DTE, delta ${Number(o.optionsData.delta).toFixed(2)}`
      : `${legs} for ${o.optionsData.debit} debit`]);
  }
  if (o.catalyst && o.catalyst.headline) rows.push(['Catalyst', `${o.catalyst.headline} (${o.catalyst.sentimentScore})`]);
  return rows;
}

function buildAlert(o) {
  const subject = `[ACTION REQUIRED]${o.speculative ? ' [SPECULATIVE MOONSHOT]' : ''} SignalDesk: ${o.direction} ${o.asset} (${o.strategyId})`;
  const created = Date.parse(o.timestamp);
  const expiry = Number.isFinite(created)
    ? `Approve before ${etTime(created + MAX_CANDIDATE_AGE_MS)}; after that the order guard expires it.`
    : 'Approve soon; the order guard expires setups after 30 minutes.';
  const rows = detailRows(o);
  const width = Math.max(...rows.map(([k]) => k.length));

  const text = [
    `A setup passed the risk and cost gate and is waiting for your approval.`,
    '',
    ...rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`),
    '',
    `Thesis: ${o.thesis || 'n/a'}`,
    '',
    expiry,
  ].join('\n');
  const link = magic.create(baseUrl(), '/#opportunities?tab=approvals');

  const long = o.direction !== 'short';
  const html = [
    '<div style="background:#0b1220;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:10px;padding:20px;color:#e5e7eb">',
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8">SignalDesk · Approvals queue</p>',
    `<h2 style="margin:0 0 12px;font-size:20px;color:${long ? '#2dd4bf' : '#fb7185'}">${escapeHtml(`${long ? 'LONG' : 'SHORT'} ${o.asset}`)}</h2>`,
    '<p style="margin:0 0 14px;font-size:14px;color:#cbd5e1">A setup passed the risk and cost gate and is waiting for your approval.</p>',
    '<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px">',
    ...rows.map(([k, v]) => `<tr><td style="color:#94a3b8;border-top:1px solid #1f2937;width:34%">${escapeHtml(k)}</td>`
      + `<td style="border-top:1px solid #1f2937;color:#f8fafc"><strong>${escapeHtml(v)}</strong></td></tr>`),
    '</table>',
    `<p style="margin:14px 0;font-size:13px;line-height:1.5;color:#cbd5e1"><em>${escapeHtml(o.thesis || '')}</em></p>`,
    `<p style="margin:0 0 18px;font-size:13px;color:#fbbf24">${escapeHtml(expiry)}</p>`,
    `<a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2f81f7;color:#ffffff;font-weight:700;text-decoration:none">Open Approvals &rarr;</a>`,
    `<p style="margin:16px 0 0;font-size:11px;color:#64748b">Informational alert: nothing has been executed. Approving re-checks price and staleness first. The button signs this device in (link valid ${expiresText()}); do not forward this email.</p>`,
    '</div></div>',
  ].join('\n');

  return { subject, html, text: `${text}\nOpen the Approvals queue (one-tap sign-in, valid ${expiresText()}): ${link}`,
    consoleText: `${text}\nOpen the Approvals queue: ${approvalsUrl()}` };
}

// Mobile link email: a one-tap sign-in button for the live tunnel + the plain address.
function buildTunnelEmail(tunnelUrl) {
  const clean = String(tunnelUrl).replace(/\/*$/, '/');
  const link = magic.create(clean, '/#today');
  const subject = '[SignalDesk] Your Live Mobile Link is Ready';
  const lines = ['SignalDesk is running and reachable from your phone.', '', `Address: ${clean}`,
    'This address changes every time SignalDesk (or its tunnel) restarts; a new email follows each change.'];
  const text = [...lines, '', `Open SignalDesk on Phone (one-tap sign-in, valid ${expiresText()}): ${link}`, '', 'Do not forward this email: the button signs a device in.'].join('\n');
  const html = [
    '<div style="background:#0b1220;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:10px;padding:22px;color:#e5e7eb">',
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8">SignalDesk · Mobile access</p>',
    '<h2 style="margin:0 0 10px;font-size:20px;color:#f8fafc">Your live mobile link is ready</h2>',
    '<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#cbd5e1">Tap the button on your phone: it signs this device in on the new address and opens the dashboard. No typing, no token.</p>',
    `<a href="${escapeHtml(link)}" style="display:block;padding:15px 22px;border-radius:10px;background:#2f81f7;color:#ffffff;font-size:17px;font-weight:700;text-align:center;text-decoration:none">Open SignalDesk on Phone &rarr;</a>`,
    '<p style="margin:18px 0 4px;font-size:12px;color:#94a3b8">Address (sign in with your access token once the button has expired):</p>',
    `<p style="margin:0 0 16px;font:14px ui-monospace,Consolas,monospace;word-break:break-all"><a href="${escapeHtml(clean)}" style="color:#38bdf8">${escapeHtml(clean)}</a></p>`,
    `<p style="margin:0;font-size:11px;line-height:1.5;color:#64748b">The button is valid for ${expiresText()}. The address changes every time SignalDesk restarts; a new email follows each change. Do not forward this email: the button signs a device in.</p>`,
    '</div></div>',
  ].join('\n');
  return { subject, text, html, consoleText: [...lines, '', '(The one-tap sign-in link is only sent by email, never printed here.)'].join('\n') };
}

// ---------- Transport ----------
const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO'];
let transporter = null;
let warnedMissing = false;

function smtp() {
  const missing = REQUIRED.filter((k) => !String(process.env[k] || '').trim());
  if (missing.length) {
    if (!warnedMissing) console.warn(`[notifier] email disabled: ${missing.join(', ')} not set in .env; alerts are logged to the console`);
    warnedMissing = true;
    return null;
  }
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465, // 587/25 upgrade with STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  }
  return transporter;
}

function logToConsole(message) {
  const rule = '─'.repeat(72);
  console.log(`[notifier] ${rule}\n[notifier] Subject: ${message.subject}\n${message.consoleText || message.text}\n[notifier] ${rule}`);
  return { delivered: 'console' };
}

async function dispatch(message) {
  const t = smtp();
  if (!t) return logToConsole(message);
  try {
    const info = await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: process.env.ALERT_EMAIL_TO,
      subject: message.subject, text: message.text, html: message.html });
    console.log(`[notifier] emailed "${message.subject}" (${info.messageId || 'sent'})`);
    return { delivered: 'email', messageId: info.messageId };
  } catch (err) {
    console.error(`[notifier] email failed (${err.code || err.message}); logging the alert instead`);
    return { ...logToConsole(message), error: err.code || err.message };
  }
}

async function sendApprovalAlert(candidate) {
  const message = buildAlert(candidate);
  const result = await dispatch(message);
  return { ...message, result };
}

// Once per tunnel URL (a restart or rotation brings a new one); force: the Settings re-send.
const emailedTunnels = new Set();
let lastTunnelEmail = null; // { url, at, delivered, error } for Settings
async function sendTunnelReadyEmail(tunnelUrl, { force = false } = {}) {
  const url = String(tunnelUrl || '');
  if (!/^https:\/\//.test(url)) return { skipped: 'not an https address' };
  if (emailedTunnels.has(url) && !force) return { skipped: 'already emailed for this tunnel' };
  emailedTunnels.add(url);
  const result = await dispatch(buildTunnelEmail(url));
  lastTunnelEmail = { url, at: Date.now(), delivered: result.delivered, error: result.error || null };
  return result;
}

// A Portfolio Pilot action on an EXTERNAL holding (execution/external-actions.js):
// the exact instruction, e.g. "Sell 1.15 shares of NVDA on Robinhood". Manual
// ones are done by the user at that broker, then confirmed in Approvals.
function buildExternalActionEmail(a) {
  const tag = a.manual ? `MANUAL · ${String(a.broker).toUpperCase()}` : `LIVE · ${String(a.broker).toUpperCase()}`;
  const subject = `[ACTION REQUIRED] [${tag}] SignalDesk: ${a.instruction}`.slice(0, 180);
  const link = magic.create(baseUrl(), '/#opportunities?tab=approvals');
  const next = a.manual ? `Place it in ${a.broker}, then open Approvals and press "Confirm Executed in ${a.broker}" so SignalDesk updates the holding.`
    : `Approving it in SignalDesk sends a real market order to ${a.broker} (only when ${a.broker} is LIVE in Settings).`;
  const rows = [['Action', a.action === 'SELL' && a.rotation ? 'SELL + ROTATE' : a.action], ['Why', a.reason], ['Live price', px(a.price)]];
  const text = [a.instruction, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', a.detail || '', '', next, `Open Approvals (one-tap sign-in, valid ${expiresText()}): ${link}`].join('\n');
  const html = [
    '<div style="background:#0b1220;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:10px;padding:20px;color:#e5e7eb">',
    `<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#fbbf24">${escapeHtml(tag)} · Portfolio Pilot</p>`,
    `<h2 style="margin:0 0 12px;font-size:19px;color:#f8fafc">${escapeHtml(a.instruction)}</h2>`,
    '<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px">',
    ...rows.map(([k, v]) => `<tr><td style="color:#94a3b8;border-top:1px solid #1f2937;width:30%">${escapeHtml(k)}</td><td style="border-top:1px solid #1f2937"><strong>${escapeHtml(v)}</strong></td></tr>`),
    '</table>',
    `<p style="margin:14px 0;font-size:13px;line-height:1.5;color:#cbd5e1">${escapeHtml(a.detail || '')}</p>`,
    `<p style="margin:0 0 18px;font-size:13px;color:#fbbf24">${escapeHtml(next)}</p>`,
    `<a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2f81f7;color:#ffffff;font-weight:700;text-decoration:none">Open Approvals &rarr;</a>`,
    `<p style="margin:16px 0 0;font-size:11px;color:#64748b">The button signs this device in (valid ${expiresText()}); do not forward this email.</p>`,
    '</div></div>',
  ].join('\n');
  return { subject, text, html, consoleText: text.replace(link, approvalsUrl()) };
}
const sendExternalActionAlert = async (a) => dispatch(buildExternalActionEmail(a));

const emailConfigured = () => REQUIRED.every((k) => String(process.env[k] || '').trim());

module.exports = { sendApprovalAlert, sendTunnelReadyEmail, sendExternalActionAlert, buildAlert, buildTunnelEmail, buildExternalActionEmail, approvalsUrl, emailConfigured,
  lastTunnelEmail: () => lastTunnelEmail };
