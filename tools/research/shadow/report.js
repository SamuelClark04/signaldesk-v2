// Phase 95 Task 8.x (plan 10.5): the shadow-paper report, reports/shadow-<through>.html (+ .json), local and private (git-ignored).
// It states what the numbers are: INDICATIVE_ESTIMATE results are estimates from the free plan's approximated option quotes and never
// show executable profit; competing rules are shown side by side, never summed; wins AND losses, unfilled and skipped are all listed.
const fs = require('fs');
const path = require('path');
const et = require('../../../server/services/et-time');
const { RULES, EXITS_VERSION, LIMITS } = require('./books');
const { TRIGGERS_VERSION } = require('./opportunities');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
const tm = (ms) => (ms ? (() => { const p = et.parts(ms); return `${p.ymd} ${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`; })() : '—');
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

function ruleRows(outcomes) {
  return RULES.map((r) => {
    const mine = outcomes.filter((o) => o.rule === r.id); const filled = mine.filter((o) => o.status === 'FILLED');
    const closed = filled.filter((o) => o.exit.status === 'CLOSED'); const nets = closed.map((o) => o.exit.net);
    const stops = closed.filter((o) => o.exit.reason === 'STOP').map((o) => o.exit.lossBeyondStop);
    const n = (s) => mine.filter((o) => o.status === s).length; const sum = nets.reduce((a, b) => a + b, 0);
    return [esc(r.id), mine.length, filled.length, n('UNFILLED'), n('NO_SELECTION'), n('INSUFFICIENT_EXPIRY'), n('PENDING'), closed.length, filled.length - closed.length,
      nets.filter((x) => x > 0).length, nets.filter((x) => x <= 0).length, `<span class="${cls(sum)}">${money(sum)}</span>`, money(nets.length ? sum / nets.length : null),
      money(closed.length ? closed.reduce((a, o) => a + (o.stressNet ?? 0), 0) / closed.length : null), money(nets.length ? Math.min(...nets) : null),
      money(stops.length ? stops.reduce((a, b) => a + b, 0) / stops.length : null), (() => { const l = median(filled.map((o) => o.entry.latencyMs)); return l === null ? '—' : `${Math.round(l / 1000)} s`; })(),
      closed.length < 30 ? '<span class="warn">too few to judge</span>' : ''];
  });
}

function write({ result, through, outDir, collection, opraStatus }) {
  const { outcomes, books, days, opportunities, dataThrough } = result;
  const label = outcomes.find((o) => o.label)?.label || 'INDICATIVE_ESTIMATE';
  const bySource = {}; for (const o of opportunities) bySource[o.source] = (bySource[o.source] || 0) + 1;
  const ctrl = new Map(); // rule -> avg net of CONTROL opportunities
  for (const r of RULES) { const n = outcomes.filter((o) => o.rule === r.id && o.opp.source === 'CONTROL' && o.exit && o.exit.status === 'CLOSED').map((o) => o.exit.net); ctrl.set(r.id, n.length ? n.reduce((a, b) => a + b, 0) / n.length : null); }
  const bookRows = books.slice().sort((a, b) => a.family.localeCompare(b.family) || RULES.findIndex((r) => r.id === a.rule) - RULES.findIndex((r) => r.id === b.rule)).map((b) => {
    const s = b.summary; const c = ctrl.get(b.rule);
    return [esc(b.family), esc(b.rule), esc(b.label), s.opportunities, s.entered, s.open, s.wins, s.losses, `<span class="${cls(s.net)}">${money(s.net)}</span>`, money(s.stressNet), s.pf ?? '—',
      money(s.maxDrawdown), `${s.returnPct}%`, money(s.avg), b.family === 'CONTROL' ? '(baseline)' : s.avg !== null && c !== null ? money(s.avg - c) : '—',
      esc(Object.entries(s.skips).map(([k, v]) => `${k} ${v}`).join(', ') || '—')];
  });
  const trades = outcomes.filter((o) => o.status === 'FILLED').sort((a, b) => b.opp.tAvail - a.opp.tAvail).slice(0, 600).map((o) => [esc(o.opp.symbol), esc(o.opp.trigger), esc(o.opp.dir), esc(o.rule),
    esc(o.selection.contract), tm(o.entry.quote.t_quote), money(o.entry.price * 100), o.exit.status === 'CLOSED' ? esc(o.exit.reason) : `OPEN${o.exit.pending ? ` (${esc(o.exit.pendingReason)} pending)` : ''}`,
    tm(o.exit.exitAt), o.exit.status === 'CLOSED' ? `<span class="${cls(o.exit.net)}">${money(o.exit.net)}</span>` : `mark ${money(o.exit.mark)}`, money(o.stressNet), esc((o.exit.labels || []).join(' ')), esc(o.mode)]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shadow Options Report</title>
<style>:root{--bg:#fff;--fg:#1b1f24;--mut:#5b6470;--line:#d8dde3;--pos:#0a7a3d;--neg:#b42318;--warn:#9a6700;--box:#fff8e6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e9ed;--mut:#9aa4b0;--line:#2a3038;--pos:#4ade80;--neg:#f87171;--warn:#fbbf24;--box:#2a2414}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:0;padding:16px;max-width:1500px}h1{font-size:22px}h2{font-size:17px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:12.5px;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:4px 7px;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warn)}.box{background:var(--box);border:1px solid var(--warn);padding:10px 12px;border-radius:6px}
.mut{color:var(--mut)}</style></head><body>
<h1>Shadow options research: ${esc(days[0] || '—')} to ${esc(through)}</h1>
<p class="mut">Generated ${esc(new Date().toISOString())}. Data through ${tm(dataThrough)} ET. ${esc(TRIGGERS_VERSION)}, ${esc(EXITS_VERSION)}. Each book: $${LIMITS.capital.toLocaleString('en-US')} declared, 1 contract,
fees $${LIMITS.fees} per contract per side (assumption). Entries fill at the ASK of the first eligible quote >= 5 s after the decision; exits fill at the BID of the next quote after the trigger. Research only: nothing here places an order.</p>
<div class="box"><b>Price label: ${esc(label)}.</b> ${label === 'MARKET_QUOTE' ? 'Real OPRA quotes.' : `These results use Alpaca's free <i>indicative</i> option quotes, which Alpaca describes as not for strategy validation. They are estimates: they cannot show that a rule makes executable profit. Real-quote validation: <b>UNAVAILABLE</b> (${esc(opraStatus)}).`}</div>
<h2>Collection</h2>${table(['session', 'selection lines', 'quote rows', 'underlyings'], (collection || []).map((c) => [esc(c.day), c.candidates, c.quotes, c.underlyings]))}
<p>Opportunities: ${Object.entries(bySource).map(([k, v]) => `${esc(k)} ${v}`).join(', ') || 'none'}. Not in ${esc(TRIGGERS_VERSION)}: T4 relative-strength divergence, T5 peer shock / sector lag (need the company map), T6 classified event arrival (NEWS_FIRST stands in, both sides), T7 quiet-range break.</p>
<h2>Exit rules side by side (every opportunity, no book limits)</h2>
<p class="mut">The same opportunities under each exit rule. Rules compete: never add these rows together.</p>
${table(['rule', 'opps', 'filled', 'unfilled', 'no selection', 'short expiry', 'pending', 'closed', 'open', 'wins', 'losses', 'net', 'avg', 'avg stressed', 'worst', 'avg loss beyond stop', 'median entry latency', ''], ruleRows(outcomes))}
<h2>Research books (opportunity family x rule)</h2>
<p class="mut">Limits per book: max 3 open (Q / H) or 5 (D / W), 1 per symbol, 10 entries a day, stop for the day at −$300, the debit must fit the cash left. "vs control" = the book's average trade minus the 10:00 / 11:30 / 14:00 control average under the same rule.</p>
${table(['family', 'rule', 'label', 'opps', 'entered', 'open', 'wins', 'losses', 'net', 'stressed', 'PF', 'max DD', 'return', 'avg', 'vs control', 'skipped (reason)'], bookRows)}
<h2>Trades (newest ${trades.length}; wins and losses)</h2>
${table(['symbol', 'trigger', 'dir', 'rule', 'contract', 'entry', 'debit', 'exit', 'exit time', 'net', 'stressed', 'labels', 'mode'], trades)}
</body></html>`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `shadow-${through}.html`);
  fs.writeFileSync(file, html);
  fs.writeFileSync(path.join(outDir, `shadow-${through}.json`), JSON.stringify({ through, days, label, opraStatus, bySource, books: books.map((b) => ({ id: b.id, ...b.summary })) }, null, 1));
  return file;
}

module.exports = { write };
