// Quick Flips forward paper test report (Phase 89c), READ-ONLY: node scripts/quickflips-forward-report.js <ledger copy> --start YYYY-MM-DD
// Implements docs/research/phase89-protocol-2a-clarification.md exactly: per-trade E1 / X1 / RT / Q (US $ per share of premium; quotes =
// Alpaca INDICATIVE as stored, fills = Alpaca Paper averages), the 40-trade execution checkpoint, the 100-trade futility check, the
// 150-trade verdict, INCONCLUSIVE after 12 months with fewer than 150 trades. Never writes the ledger; prints its sha256 before / after.
const fs = require('fs'); const crypto = require('crypto');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!file || !opt('--start')) { console.error('usage: node scripts/quickflips-forward-report.js <ledger copy> --start YYYY-MM-DD [--now YYYY-MM-DD]'); process.exit(2); }
const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const h0 = digest();
const L = JSON.parse(fs.readFileSync(file, 'utf8'));
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const day = (ms) => NY.format(new Date(ms));
const start = Date.parse(`${opt('--start')}T00:00:00-05:00`); const now = opt('--now') ? Date.parse(`${opt('--now')}T23:59:00-05:00`) : Date.now();
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const QF = (t) => t.strategyId === 'options-quickflips' && t.market === 'options';
const atAlpaca = (t) => t.paperBroker === 'alpaca' || t.brokerEnvironment === 'alpaca-paper';

// One trade (a journal record; trims / parts merged by their parent id) -> the protocol's measures.
function measure(t) {
  const od = t.optionsData || {}; const w = t.exitWork || {}; const q0 = w.q0 || null;
  const fill = Number(od.debit); const ask = Number(od.plannedDebit); const mid = Number(od.netMid); const exitFill = Number(t.optionsExitValue);
  const target = w.kind === 'target' || /^TAKE_PROFIT/.test(String(t.exitReason));
  const E1 = Number.isFinite(ask) && ask > 0 && fill > 0 ? fill - ask : null;
  const X1 = target ? (w.limit > 0 ? w.limit - exitFill : (od.exitRule && od.exitRule.targetValue) - exitFill) : q0 && q0.bid >= 0 ? q0.bid - exitFill : null;
  const RT = mid > 0 && fill > 0 ? (fill - mid) + (target ? 0 : q0 && q0.mid > 0 ? q0.mid - exitFill : NaN) : null;
  return { id: t.parentId || t.id, asset: t.asset, openedAt: t.openedAt, closedAt: t.closedAt, exitReason: String(t.exitReason || ''), net: t.netPnl, risk: t.dollarRisk,
    r: t.dollarRisk > 0 ? t.netPnl / t.dollarRisk : null, E1, X1, RT: Number.isFinite(RT) ? RT : null, Q: od.refAt && od.quoteTime ? (od.refAt - od.quoteTime) / 1000 : null,
    overnight: t.openedAt && t.closedAt && day(t.openedAt) !== day(t.closedAt), manual: /^MANUAL_CLOSE/.test(String(t.exitReason || '')) };
}
function merge(list) { // parts of one trade (partial closes) -> one trade, net summed, the last exit's measures
  const by = new Map();
  for (const m of list) { const x = by.get(m.id); if (!x) by.set(m.id, { ...m }); else by.set(m.id, { ...m, net: x.net + m.net, risk: x.risk + m.risk, r: (x.net + m.net) / ((x.risk + m.risk) || 1), overnight: x.overnight || m.overnight }); }
  return [...by.values()].sort((a, b) => a.closedAt - b.closedAt);
}
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const max = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
function pf(ts) { const w = ts.filter((t) => t.net > 0).reduce((a, t) => a + t.net, 0); const l = -ts.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0); return l > 0 ? w / l : (w > 0 ? Infinity : 0); }
function maxDD(ts) { let eq = 0; let pk = 0; let dd = 0; for (const t of ts) { eq += t.r || 0; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); } return dd; }
function bootLower(ts, alpha = 0.05, iters = 5000) {
  let a = 89; const rng = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const days = [...ts.reduce((m, t) => m.set(day(t.openedAt), [...(m.get(day(t.openedAt)) || []), t.r || 0]), new Map()).values()];
  if (!days.length) return null;
  const means = [];
  for (let i = 0; i < iters; i += 1) { let s = 0; let n = 0; for (let j = 0; j < days.length; j += 1) for (const r of days[Math.floor(rng() * days.length)]) { s += r; n += 1; } means.push(n ? s / n : 0); }
  return means.sort((x, y) => x - y)[Math.floor(alpha * iters)];
}

const journal = (L.tradeJournal || []).filter((t) => QF(t) && (t.openedAt || 0) >= start);
const trades = merge(journal.filter(atAlpaca).map(measure));
const internal = journal.filter((t) => !atAlpaca(t)).length;
const canceled = (L.discardedOrders || []).filter((o) => QF(o) && o.status === 'void' && (o.voidedAt || 0) >= start && /^ENTRY_/.test(String(o.voidReason || ''))).length; // ledger-live.voidLivePosition
const live = journal.filter((t) => t.execution === 'LIVE').length;
const fmt = (x, d = 3) => (x === null || x === undefined ? '-' : Number.isFinite(x) ? x.toFixed(d) : String(x));
console.log(`QUICK FLIPS FORWARD TEST  ${file}  sha256 ${h0.slice(0, 16)}...  start ${opt('--start')}  trades ${trades.length} (Alpaca Paper)  internal-paper excluded ${internal}  entries canceled unfilled ${canceled}`);
console.log('units: US$ per share of premium (x100 per contract). quotes: Alpaca INDICATIVE as stored; fills: Alpaca Paper (simulated)');
for (const t of trades) console.log(`  ${day(t.openedAt)} ${t.asset} ${t.exitReason.padEnd(16)} net ${fmt(t.net, 2)} R ${fmt(t.r, 2)} | E1 ${fmt(t.E1)} X1 ${fmt(t.X1)} RT ${fmt(t.RT)} Q ${fmt(t.Q, 0)}s${t.overnight ? ' OVERNIGHT' : ''}${t.manual ? ' MANUAL' : ''}`);

const cp = trades.slice(0, 40);
if (cp.length === 40) {
  const miss = cp.filter((t) => t.E1 === null || t.X1 === null).length;
  const checks = { overnight: cp.filter((t) => t.overnight).length === 0, realMoney: live === 0, ruleExits: cp.filter((t) => !t.manual).length >= 0.95 * cp.length,
    meanE1: mean(cp.map((t) => t.E1)) <= 0.05, meanX1: mean(cp.map((t) => t.X1)) <= 0.05, missing: miss <= 4 };
  console.log(`\n40-TRADE EXECUTION CHECKPOINT: ${Object.values(checks).every(Boolean) ? 'PASSED (continue)' : 'FAILED (fix the mechanics; the count restarts)'} ${JSON.stringify(checks)}`);
  console.log(`  E1 mean ${fmt(mean(cp.map((t) => t.E1)))} median ${fmt(median(cp.map((t) => t.E1)))} max ${fmt(max(cp.map((t) => t.E1)))} | X1 mean ${fmt(mean(cp.map((t) => t.X1)))} median ${fmt(median(cp.map((t) => t.X1)))} max ${fmt(max(cp.map((t) => t.X1)))} | missing ${miss}`);
} else console.log(`\n40-TRADE EXECUTION CHECKPOINT: not reached (${trades.length} / 40)`);
if (trades.length >= 100) {
  const f = trades.slice(0, 100); const mr = mean(f.map((t) => t.r));
  console.log(`100-TRADE FUTILITY: ${pf(f) < 0.8 || mr < -0.15 ? 'STOP (FAIL)' : 'continue'} (PF ${fmt(pf(f), 2)}, mean R ${fmt(mr)})`);
}
let verdict = 'IN PROGRESS';
if (trades.length >= 150) {
  const v = trades.slice(0, 150); const by = (s) => v.filter((t) => t.asset === s);
  const c = { pf: pf(v) >= 1.15, meanR: mean(v.map((t) => t.r)) > 0, boot: bootLower(v) > 0, dd: maxDD(v) < 15, spy: pf(by('SPY')) > 0.9, qqq: pf(by('QQQ')) > 0.9, rt: mean(v.map((t) => t.RT)) <= 0.06 };
  verdict = Object.values(c).every(Boolean) ? 'PASS' : 'FAIL';
  console.log(`150-TRADE VERDICT: ${verdict} ${JSON.stringify(c)} (PF ${fmt(pf(v), 2)}, mean R ${fmt(mean(v.map((t) => t.r)))}, boot lower ${fmt(bootLower(v))}, DD ${fmt(maxDD(v), 1)}R, mean RT ${fmt(mean(v.map((t) => t.RT)))})`);
} else if (now - start >= 365 * 864e5) verdict = 'INCONCLUSIVE (12 months, fewer than 150 trades)';
console.log(`STATUS: ${verdict}`);
console.log(digest() === h0 ? `input unchanged (sha256 ${h0})` : 'WARNING: the input file changed while it was read: use a COPY');
