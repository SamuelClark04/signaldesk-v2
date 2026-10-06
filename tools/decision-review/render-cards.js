// One card per setup in the Decision Review report (Phase 93): what it saw, why it called up / down, why it was accepted / rejected,
// the chart before and after with the levels, the horizon table (interim vs completed), the class (underlying), the money result
// (labelled by price-source tier), the opposite side, the rule check, the evidence-backed loss causes, and every "not recorded" flag.
const { svg, esc } = require('./chart');
const T = require('./time');

const when = (ms) => (Number.isFinite(ms) ? `${T.ymd(ms)} ${String(Math.floor(T.minuteOf(ms) / 60)).padStart(2, '0')}:${String(T.minuteOf(ms) % 60).padStart(2, '0')} ET` : 'not recorded');
const n2 = (x, k = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(k));
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const CLS_TONE = { CORRECT_DIRECTION: 'good', WRONG_DIRECTION: 'bad', EARLY_ENTRY: 'warn', LATE_ENTRY: 'warn', REVERSAL_AFTER_ENTRY: 'warn', UNCLEAR: 'muted', INCOMPLETE: 'muted', PENDING: 'muted', NOT_MEASURABLE: 'muted' };
const LABEL_TONE = { CORRECT: 'good', WRONG: 'bad', FLAT: 'muted', NO_DATA: 'muted', PENDING: 'muted' };

function horizonTable(m) {
  if (!m || m.error || !m.horizons) return '';
  const cells = m.horizons.map((h) => `<td><div class="${LABEL_TONE[h.label] || ''}">${h.label}</div><div class="sub">${h.pending ? '' : `${n2(h.m)} u${h.coverage < 1 ? ` · ${Math.round(h.coverage * 100)}% bars` : ''}`}</div></td>`);
  return `<table class="hz"><tr>${m.horizons.map((h) => `<th>${h.key === 'H' ? `planned end (${esc(m.H.label)})` : h.key === 'close' ? 'session close' : h.key}${h.interim ? ' <i>interim</i>' : h.final ? ' <i>completed</i>' : ''}</th>`).join('')}</tr>`
    + `<tr>${cells.join('')}</tr></table>`
    + `<p class="sub">P0 ${n2(m.p0, 4)} (${m.p0Source}) · unit u = ${n2(m.u, 4)} (${esc(m.unit)}) · MFE ${n2(m.mfe)} u · MAE ${n2(m.mae)} u · pre-move ${n2(m.preMove)} u over ${esc(m.preMoveWindow)}`
    + `${m.stopAt ? ` · stop touched ${when(m.stopAt)}` : ''}${m.t1At ? ` · T1 touched ${when(m.t1At)}` : ''}</p>`;
}

function moneyBlock(r) {
  const out = [];
  const d = r.d;
  if (d.realized && d.realized.status === 'closed') {
    const ex = d.realized.exits.map((e) => `${esc(e.exitReason)} ${n2(e.exitPrice, 4)}`).join(', ');
    out.push(`<div><b>Recorded result</b> ${pill('LEDGER', 'src')} net $${n2(d.realized.netPnl)} · ${n2(d.realized.rNet)}R · exits ${ex}${d.realized.run ? ` · ${esc(d.realized.run)}` : ''}</div>`);
  } else if (d.realized && d.realized.status === 'open') out.push(`<div><b>Recorded result</b> ${pill('LEDGER', 'src')} still open</div>`);
  const s = r.money;
  if (s) {
    if (s.tier === 'UNAVAILABLE') out.push(`<div><b>Contract</b> ${pill('UNAVAILABLE', 'muted')} ${esc(s.why)}</div>`);
    else if (s.filled === false) out.push(`<div><b>Simulated</b> ${pill(s.tier || 'FETCHED', 'src')} not filled: ${esc(s.why)}</div>`);
    else out.push(`<div><b>Simulated ${d.market === 'options' ? (s.tier === 'ESTIMATE' ? 'contract' : 'underlying') : 'trade'}</b> ${pill(s.tier || 'FETCHED', 'src')} ${s.label ? `<i>${esc(s.label)}</i> ` : ''}`
      + `net ${n2(s.rNet)}R${s.rGross != null ? ` (gross ${n2(s.rGross)}R)` : ''}${s.exits ? ` · ${s.exits.map((e) => `${e.reason} ${n2(e.price, 4)}`).join(', ')}` : s.exit ? ` · ${s.exit.reason} ${n2(s.exit.price)}` : ''}</div>`);
  }
  if (r.opt && r.opt.tier) out.push(`<div><b>Contract (prints)</b> ${pill(r.opt.tier, r.opt.tier === 'UNAVAILABLE' ? 'muted' : 'src')} ${r.opt.tier === 'UNAVAILABLE' ? esc(r.opt.why) : `net ${n2(r.opt.rNet)}R · ${esc(r.opt.label)}`}</div>`);
  return out.join('');
}

function oppositeBlock(r) {
  const o = r.opp; const od = r.oppDir;
  if (!o && !od) return '';
  const parts = [];
  if (od) parts.push(`direction ${pill(od.label, LABEL_TONE[od.label])} at the planned end`);
  if (o && o.unavailable) parts.push(esc(o.unavailable));
  else if (o && o.filled === false) parts.push(`mirrored trade not filled: ${esc(o.why)}`);
  else if (o && o.filled) parts.push(`mirrored entry ${n2(o.rawFill, 4)} · ${pill(o.tier, 'src')} net ${n2(o.rNet)}R${o.contract ? ` · contract P&amp;L: ${esc(o.contract)}` : ''}`);
  return `<div><b>Opposite side</b> ${parts.join(' · ')}</div>`;
}

function card(r) {
  const d = r.d; const m = r.m;
  const tone = CLS_TONE[r.cls.cls] || '';
  const rej = d.outcome.group === 'REJECTED';
  const preLabel = r.chart.preSource ? `${r.chart.preSource}` : '';
  const head = `<h3 id="${esc(r.anchor)}">${esc(d.symbol || '?')} · ${esc(d.strategyId)} · ${esc(d.setupType || '')} · ${d.direction === 'short' ? 'DOWN (short / put)' : d.direction ? 'UP (long / call)' : 'direction unknown'}</h3>`;
  const badges = [pill(d.source, 'src'), pill(d.outcome.label, rej ? 'warn' : d.outcome.group === 'ACCEPTED' ? 'good' : 'muted'), pill(r.cls.cls.replace(/_/g, ' '), tone),
    ...(r.overlay ? [pill('DIRECTION CORRECT, TRADE LOST', 'warn')] : []), ...(d.evidence && d.evidence.label ? [pill(d.evidence.label, 'muted')] : [])].join(' ');
  const times = d.times || {};
  const why = [`<div><b>Decided</b> ${when(d.t0)} <span class="sub">(${esc(d.t0Source || 'MISSING')})</span>${d.evidenceFrom ? ` <span class="sub">· levels / chart from ${esc(d.evidenceFrom.record)}</span>` : ''}${times.approved ? ` · <b>approved</b> ${when(times.approved)}` : ''}`
    + `${times.entry ? ` · <b>entered</b> ${when(times.entry)}` : ''}${times.close ? ` · <b>closed</b> ${when(times.close)}` : ''}`
    + `${d.outcome.reason ? ` · <b>${rej ? 'rejected' : 'reason'}:</b> ${esc(d.outcome.reason)}` : ''}</div>`,
    d.thesis ? `<div><b>Why it called ${d.d < 0 ? 'down' : 'up'}</b> ${esc(d.thesis)}</div>` : '',
    r.signals ? `<div class="sub"><b>Recorded signal values</b> ${esc(r.signals)}</div>` : '',
    d.levels ? `<div><b>Levels</b> entry ${n2(d.levels.entry, 4)} · stop ${n2(d.levels.stop, 4)} · T1 ${n2(d.levels.t1, 4)}${d.levels.t2 ? ` · T2 ${n2(d.levels.t2, 4)}` : ''}</div>` : '<div><b>Levels</b> none (incomplete setup)</div>',
    d.option ? `<div><b>Contract</b> ${esc(d.option.label || d.option.contract || '')}${d.option.bid ? ` · recorded bid / ask ${d.option.bid} / ${d.option.ask}` : ''}${d.option.delta != null ? ` · delta ${d.option.delta}` : ''}</div>` : ''].join('');
  const rule = r.guard ? `<div><b>Rule check</b> ${pill(r.guard.verdict, r.guard.verdict === 'INCONSISTENT' ? 'bad' : r.guard.verdict === 'CONSISTENT' ? 'good' : 'muted')} ${esc(r.guard.rule)}: ${esc(r.guard.evidence)}</div>` : '';
  const att = r.attr ? `<div><b>Why it lost anyway</b> ${r.attr.causes.map((c) => `${pill(c.cause, c.cause === 'UNATTRIBUTED' ? 'muted' : 'warn')} ${esc(c.evidence)}`).join('<br>')}</div>` : '';
  const flags = (r.flags || []).map((f) => `<div class="missing"><b>Flag:</b> ${esc(f)}</div>`).join(''); // Phase 94 S0-5
  const missing = d.missing.length ? `<div class="missing"><b>Not recorded:</b> ${d.missing.map(esc).join(' · ')}</div>` : '';
  const chart = svg({ pre: r.chart.pre, post: r.chart.post, t0: d.t0, levels: d.levels, p0: m && m.p0, d: d.d, preLabel, postLabel: r.chart.postSource });
  return `<article class="card ${tone}">${head}<div class="badges">${badges}</div>${why}${flags}<p class="sub">${esc(r.cls.why)}</p>${horizonTable(m)}${moneyBlock(r)}${oppositeBlock(r)}${rule}${att}${missing}${chart}</article>`;
}

module.exports = { card, when, n2, pill, CLS_TONE, LABEL_TONE };
