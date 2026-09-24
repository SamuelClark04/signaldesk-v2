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
// never blocks staging. The link carries no access token: on a LAN/remote setup
// open it from a browser that already has access.
//
// The alert is informational: approving still happens in the terminal, where the
// order guard re-checks staleness and price at the moment of approval.
const nodemailer = require('nodemailer');
const { MAX_CANDIDATE_AGE_MS } = require('./order-guard');

const BASE_URL = (process.env.APP_PUBLIC_URL || (process.env.TERMINAL_URL || '').split('#')[0]
  || `http://127.0.0.1:${Number(process.env.PORT) || 3000}/`).replace(/\/*$/, '/');
const TERMINAL_URL = `${BASE_URL}#opportunities?tab=approvals`;

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
    `Open the Approvals queue: ${TERMINAL_URL}`,
  ].join('\n');

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
    `<a href="${escapeHtml(TERMINAL_URL)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2f81f7;color:#ffffff;font-weight:700;text-decoration:none">Open Approvals &rarr;</a>`,
    '<p style="margin:16px 0 0;font-size:11px;color:#64748b">Informational alert: nothing has been executed. Approving re-checks price and staleness first.</p>',
    '</div></div>',
  ].join('\n');

  return { subject, text, html };
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
  console.log(`[notifier] ${rule}\n[notifier] Subject: ${message.subject}\n${message.text}\n[notifier] ${rule}`);
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

module.exports = { sendApprovalAlert, buildAlert, TERMINAL_URL };
