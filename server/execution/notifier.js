// Notification engine: alerts the user that a vetted setup is waiting in the
// Approvals Queue. Builds a subject plus plain-text and HTML bodies, then hands
// them to dispatch(). Dispatch is SIMULATED (console) for now; swapping in a real
// transport later only means replacing dispatch().
//
// The alert is informational: approving still happens in the terminal, where the
// order guard re-checks staleness and price at the moment of approval.
const { MAX_CANDIDATE_AGE_MS } = require('./order-guard');

const TERMINAL_URL = process.env.TERMINAL_URL
  || `http://127.0.0.1:${Number(process.env.PORT) || 3000}/#opportunities`;

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
    ['Targets', (o.targets || []).map((t) => `T${t.level} ${px(t.price)} (${Math.round(t.allocation * 100)}%)`).join(', ') || 'n/a'],
    ['Size', sizeLabel(o)],
    ['Risk', `${usd(o.dollarRisk)}${Number.isFinite(o.feeDrag) ? ` · fee drag ${o.feeDrag.toFixed(2)}R` : ''}`],
  ];
  if (o.optionsData) {
    const legs = (o.optionsData.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ');
    rows.push(['Options', `${legs} for ${o.optionsData.debit} debit`]);
  }
  if (o.catalyst && o.catalyst.headline) rows.push(['Catalyst', `${o.catalyst.headline} (${o.catalyst.sentimentScore})`]);
  return rows;
}

function buildAlert(o) {
  const subject = `[ACTION REQUIRED] SignalDesk: ${o.direction} ${o.asset} (${o.strategyId})`;
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
    `Review it in the terminal: ${TERMINAL_URL}`,
  ].join('\n');

  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:14px;color:#0f172a">',
    '<p>A setup passed the risk and cost gate and is waiting for your approval.</p>',
    '<table cellpadding="4" style="border-collapse:collapse">',
    ...rows.map(([k, v]) => `<tr><td style="color:#64748b">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`),
    '</table>',
    `<p><em>${escapeHtml(o.thesis || '')}</em></p>`,
    `<p>${escapeHtml(expiry)}</p>`,
    `<p><a href="${escapeHtml(TERMINAL_URL)}">Open the Approvals Queue</a></p>`,
    '</div>',
  ].join('\n');

  return { subject, text, html };
}

// SIMULATED transport: log instead of sending. Replace with SMTP/API later.
async function dispatch(message) {
  const rule = '─'.repeat(72);
  console.log(`[notifier] ${rule}\n[notifier] Subject: ${message.subject}\n${message.text}\n[notifier] ${rule}`);
  return { delivered: 'console' };
}

async function sendApprovalAlert(candidate) {
  const message = buildAlert(candidate);
  await dispatch(message);
  return message;
}

module.exports = { sendApprovalAlert, buildAlert, TERMINAL_URL };
