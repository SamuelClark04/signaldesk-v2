// The Decision Review report (Phase 93 spec 10): ONE self-contained local HTML file (no scripts, no external fonts), never published.
// First screen: the four questions (accepted trades that chose the wrong side, rejected setups that moved as predicted, repeated mistakes,
// what was known before the decision). Then the three measures kept apart, the opposite side, the rule checks, the loss causes, the
// incomplete setups, and one card per setup.
const { esc } = require('./chart');
const { card, n2, pill, CLS_TONE } = require('./render-cards');
const { wilson } = require('./patterns');
const { TEXT } = require('./classify');

const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : '-');
const ci = (k, n) => { const [a, b] = wilson(k, n); return a === null ? '' : ` <span class="sub">[${Math.round(a * 100)}-${Math.round(b * 100)}%]</span>`; };
const link = (r) => `<a href="#${esc(r.anchor)}">${esc(r.d.symbol || '?')} ${esc((r.d.setupType || '').split(' · ')[0])} ${r.d.direction === 'short' ? '↓' : '↑'}</a>`;
const table = (head, rows) => `<table class="t"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

function questions(R, P) {
  const acc = R.filter((r) => r.d.outcome.group === 'ACCEPTED');
  const rej = R.filter((r) => r.d.outcome.group === 'REJECTED');
  const q1 = acc.filter((r) => ['WRONG_DIRECTION', 'LATE_ENTRY'].includes(r.cls.cls));
  const q2 = rej.filter((r) => ['CORRECT_DIRECTION', 'EARLY_ENTRY'].includes(r.cls.cls) || (r.cls.cls === 'INCOMPLETE' && r.endLabel === 'CORRECT'));
  const list = (xs, extra) => (xs.length ? `<ul>${xs.map((r) => `<li>${link(r)} · ${esc(r.d.strategyId)} · ${pill(r.cls.cls.replace(/_/g, ' '), CLS_TONE[r.cls.cls])}${extra ? ` ${extra(r)}` : ''}</li>`).join('')}</ul>` : '<p class="sub">None in this data.</p>');
  const rep = new Map();
  for (const r of R) { if (!['WRONG_DIRECTION', 'LATE_ENTRY', 'EARLY_ENTRY', 'REVERSAL_AFTER_ENTRY'].includes(r.cls.cls)) continue; const k = `${r.d.strategyId}|${(r.d.setupType || '').split(' · ')[0]}|${r.cls.cls}`; rep.set(k, (rep.get(k) || 0) + 1); }
  const repRows = [...rep].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const [s, t, c] = k.split('|'); return [esc(s), esc(t), pill(c.replace(/_/g, ' '), CLS_TONE[c]), n]; });
  const q4 = P.flagged.length ? table(['Before the decision', 'Bin', 'Measure', 'n', 'Rate', 'All setups'], P.flagged.map((t) => [esc(t.feature), esc(t.bin), t.metric === 'wrong' ? 'wrong direction' : 'rejected but went the called way', t.n, `${pct(t.k, t.n)}${ci(t.k, t.n)}`, pct(Math.round(t.base * 1000), 1000)]))
    : `<p>No pre-decision condition separates wrong from right calls yet (${P.eligible} bins had at least ${P.minN} setups; none passed the ${P.fdr * 100}% false-discovery test). Bins are provisional until 4 weeks of recorded decisions.</p>`
      + table(['Strongest so far (not significant)', 'Bin', 'Measure', 'n', 'Rate', 'All'], P.tests.filter((t) => t.n >= 5 && t.rate !== null).sort((a, b) => a.p - b.p).slice(0, 6)
        .map((t) => [esc(t.feature), esc(t.bin), t.metric === 'wrong' ? 'wrong direction' : 'missed (rejected, went the called way)', t.n, `${pct(t.k, t.n)}${ci(t.k, t.n)}`, t.base === null ? '-' : `${Math.round(t.base * 100)}%`]));
  return `<section><h2>1. Accepted trades that chose the wrong side (${q1.length} of ${acc.length})</h2>${list(q1, (r) => `net ${n2(r.d.realized && r.d.realized.rNet)}R`)}`
    + `<h2>2. Rejected setups that moved as predicted (${q2.length} of ${rej.length})</h2>${list(q2, (r) => `· ${esc(r.d.outcome.reason || r.d.outcome.label)}${r.guard ? ` · rule ${r.guard.verdict}` : ''}`)}`
    + `<h2>3. Repeated mistakes (2+ of the same kind)</h2>${repRows.length ? table(['Strategy', 'Setup', 'Mistake', 'Count'], repRows) : '<p class="sub">No mistake repeats twice yet.</p>'}`
    + `<h2>4. What was known before the decision</h2>${q4}</section>`;
}

function measures(R) {
  const groups = [['Accepted', (r) => r.d.outcome.group === 'ACCEPTED'], ['Rejected', (r) => r.d.outcome.group === 'REJECTED']];
  const keys = ['5m', '15m', '30m', '60m', 'close', 'H'];
  const dirRows = [];
  for (const [g, f] of groups) {
    const xs = R.filter(f);
    for (const k of keys) {
      const ls = xs.map((r) => (r.m && r.m.horizons ? (r.m.horizons.find((h) => h.key === k) || {}).label : null)).filter(Boolean);
      const c = ls.filter((x) => x === 'CORRECT').length; const w = ls.filter((x) => x === 'WRONG').length;
      dirRows.push([g, k === 'H' ? 'planned end (completed)' : `${k} (interim)`, c, w, ls.filter((x) => x === 'FLAT').length, ls.filter((x) => x === 'NO_DATA' || x === 'PENDING').length, `${pct(c, c + w)}${ci(c, c + w)}`]);
    }
  }
  const classes = ['CORRECT_DIRECTION', 'WRONG_DIRECTION', 'EARLY_ENTRY', 'LATE_ENTRY', 'REVERSAL_AFTER_ENTRY', 'UNCLEAR', 'INCOMPLETE', 'PENDING', 'NOT_MEASURABLE'];
  const clsRows = classes.map((c) => [pill(c.replace(/_/g, ' '), CLS_TONE[c]), ...groups.map(([, f]) => R.filter(f).filter((r) => r.cls.cls === c).length), `<span class="sub">${esc(TEXT[c])}</span>`]);
  const money = (xs, pick) => { const v = xs.map(pick).filter(Number.isFinite); return v.length ? `${v.length} · mean ${n2(v.reduce((a, b) => a + b, 0) / v.length)}R · total ${n2(v.reduce((a, b) => a + b, 0))}R` : '-'; };
  const acc = R.filter(groups[0][1]); const rej = R.filter(groups[1][1]);
  const profRows = [['Accepted: recorded (LEDGER)', money(acc, (r) => r.d.realized && r.d.realized.rNet)], ['Accepted: simulated on fetched bars (stocks / crypto)', money(acc.filter((r) => r.d.market !== 'options'), (r) => r.money && r.money.rNet)],
    ['Rejected: hypothetical, simulated (stocks / crypto)', money(rej.filter((r) => r.d.market !== 'options'), (r) => r.money && r.money.rNet)], ['Options: contract estimate from prints', money(R, (r) => r.opt && r.opt.rNet)],
    ['Options: underlying proxy (not an option result)', money(R.filter((r) => r.d.market === 'options'), (r) => r.money && r.money.rNet)]];
  const oppRows = groups.map(([g, f]) => { const xs = R.filter(f); const od = xs.map((r) => r.oppDir && r.oppDir.label).filter(Boolean);
    const both = xs.filter((r) => r.money && r.money.filled && r.opp && r.opp.filled); // the SAME setups on both sides (options: underlying proxies)
    const unfilled = (k) => xs.filter((r) => r[k] && r[k].filled === false).length; // S0-4: unfilled sides are counted, never dropped
    return [g, od.filter((x) => x === 'CORRECT').length, od.filter((x) => x === 'WRONG').length, money(both, (r) => r.money.rNet), money(both, (r) => r.opp.rNet), `${unfilled('money')} / ${unfilled('opp')}`]; });
  const rules = new Map();
  for (const r of R.filter((x) => x.guard)) { const k = `${r.guard.rule}|${r.guard.verdict}`; const e = rules.get(k) || { n: 0, avoided: 0, missed: 0 }; e.n += 1;
    const end = r.endLabel; if (end === 'WRONG') e.avoided += 1; if (end === 'CORRECT') e.missed += 1; rules.set(k, e); }
  const ruleRows = [...rules].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => { const [rule, v] = k.split('|'); return [esc(rule), pill(v, v === 'INCONSISTENT' ? 'bad' : v === 'CONSISTENT' ? 'good' : 'muted'), e.n, e.avoided, e.missed]; });
  const causes = new Map(); for (const r of R.filter((x) => x.attr)) for (const c of r.attr.causes) causes.set(c.cause, (causes.get(c.cause) || 0) + 1);
  return `<section><h2>Direction accuracy (underlying only)</h2>${table(['Group', 'Horizon', 'Correct', 'Wrong', 'Flat', 'No data / pending', 'Correct of decisive [95%]'], dirRows)}`
    + `<h2>Completed outcome classes</h2>${table(['Class', 'Accepted', 'Rejected', 'Definition'], clsRows)}`
    + `<h2>Trade profitability (kept apart from direction)</h2>${table(['Result', 'n · mean · total'], profRows)}`
    + `<h2>Opposite side (the same entry opportunity: mirrored levels, the same window, costs and allocation)</h2>${table(['Group', 'Opposite direction correct', 'Opposite wrong', 'Original trade (simulated, both filled)', 'Opposite trade (simulated, both filled)', 'Unfilled (original / opposite)'], oppRows)}`
    + `<h2>Did each rejection follow its rule?</h2>${ruleRows.length ? table(['Rule', 'Verdict', 'Setups', 'Went against the call (avoided)', 'Went the called way (missed)'], ruleRows) : '<p class="sub">No rejections in this data.</p>'}`
    + `<h2>Direction correct but the trade lost: causes the records support</h2>${causes.size ? table(['Cause', 'Setups'], [...causes].map(([c, n]) => [pill(c, c === 'UNATTRIBUTED' ? 'muted' : 'warn'), n])) : '<p class="sub">None.</p>'}</section>`;
}

const CSS = `:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#ddd;--card:#fff;--good:#1d7a46;--bad:#b3261e;--warn:#9a6700;--src:#3b5bdb;--pre:#9a9a94;--up:#1d7a46;--dn:#b3261e}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9c9b94;--line:#33332f;--card:#1c1c1a;--good:#5cc28a;--bad:#ff8a80;--warn:#e3b341;--src:#8fa6ff;--pre:#6f6f69;--up:#5cc28a;--dn:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:16px;max-width:1100px;margin:auto}
h1{font-size:22px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:0 0 6px}.sub{color:var(--muted);font-size:12px}
table{border-collapse:collapse;margin:6px 0;font-size:12.5px;width:100%}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:6px;padding:12px;margin:12px 0}.card.good{border-left-color:var(--good)}.card.bad{border-left-color:var(--bad)}.card.warn{border-left-color:var(--warn)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:10px;padding:0 7px;font-size:11.5px}.pill.good{color:var(--good);border-color:var(--good)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.src{color:var(--src);border-color:var(--src)}.pill.muted{color:var(--muted)}
.good{color:var(--good)}.bad{color:var(--bad)}.muted{color:var(--muted)}.missing{color:var(--warn);font-size:12px;margin-top:4px}.badges{margin:2px 0 6px}
.hz td,.hz th{font-size:11.5px;text-align:center}.hz i{color:var(--muted);font-style:normal;font-size:10px}
svg.chart{width:100%;height:auto;margin-top:8px}.wick{stroke-width:1}.wick.pre,.body.pre{stroke:var(--pre);fill:var(--pre)}.wick.up,.body.up{stroke:var(--up);fill:var(--up)}.wick.dn,.body.dn{stroke:var(--dn);fill:var(--dn)}
.lvl{stroke-dasharray:4 3;stroke-width:1}.lvl.entry{stroke:var(--src)}.lvl.stop{stroke:var(--bad)}.lvl.t1,.lvl.t2{stroke:var(--good)}.lvl-t{font-size:10px}.lvl-t.entry{fill:var(--src)}.lvl-t.stop{fill:var(--bad)}.lvl-t.t1,.lvl-t.t2{fill:var(--good)}
.t0{stroke:var(--fg);stroke-width:1;stroke-dasharray:2 2}.ax{font-size:10px;fill:var(--muted)}a{color:var(--src)}`;

function render(R, P, meta) {
  const by = (f) => R.filter(f).length;
  const head = `<h1>Decision Review</h1><p class="sub">Generated ${esc(meta.generated)} from ${esc(meta.archive)} · local and private (not published) · ${R.length} setups:`
    + ` ${by((r) => r.d.source === 'RECORDED')} RECORDED, ${by((r) => r.d.source === 'LEDGER')} LEDGER, ${by((r) => r.d.source === 'RECONSTRUCTED')} RECONSTRUCTED.`
    + ` Direction and timing are judged on the underlying chart; money results are kept separate and labelled by price source.</p>`
    + `<p class="sub">Recorder: ${meta.recorder.files ? `${meta.recorder.files} day file(s); latest status: ${esc(meta.recorderStatus || 'none')}` : 'no recorder files in this archive (all setups are reconstructed from the ledger and logs)'}`
    + `${meta.recorder.missingRecords.length ? ` · <b class="bad">${meta.recorder.missingRecords.length} ledger record(s) after the recorder started have no recorded decision</b>` : ''} · market data: ${meta.bars.requests} requests, ${meta.bars.cacheHits} cached, ${meta.bars.errors} errors${meta.bars.lastError ? ` (${esc(meta.bars.lastError)})` : ''}.</p>`;
  const inc = R.filter((r) => r.cls.cls === 'INCOMPLETE');
  const incTable = inc.length ? table(['Setup', 'Path', 'Reason', '5m', '15m', '30m', '60m', 'Close', 'Planned end'], inc.map((r) => [link(r), esc(r.d.outcome.label), esc((r.d.outcome.reason || '').slice(0, 90)),
    ...['5m', '15m', '30m', '60m', 'close', 'H'].map((k) => { const h = r.m && r.m.horizons && r.m.horizons.find((x) => x.key === k); return h ? h.label : '-'; })])) : '<p class="sub">None.</p>';
  const order = { ACCEPTED: 0, REJECTED: 1, PENDING: 2, UNKNOWN: 3 };
  const cards = [...R].sort((a, b) => (order[a.d.outcome.group] - order[b.d.outcome.group]) || ((b.d.t0 || 0) - (a.d.t0 || 0))).map(card).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decision Review</title><style>${CSS}</style></head><body>`
    + `${head}${questions(R, P)}${measures(R)}<section><h2>Incomplete setups (a direction, no executable levels): horizon labels only</h2>${incTable}</section>`
    + `<section><h2>Every setup</h2>${cards}</section></body></html>`;
}

module.exports = { render };
