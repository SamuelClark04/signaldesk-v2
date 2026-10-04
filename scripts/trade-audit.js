// Trade audit (Phase 89), READ-ONLY: node scripts/trade-audit.js [ledger-state.json] [--csv out.csv] [--since YYYY-MM-DD] [--runs paper-runs.json]
// Run it on a COPY (cp server/data/ledger-state.json /tmp/ledger-snapshot.json) to keep the original untouched; it never writes the ledger.
// Reads the ledger file (and paper-runs.json beside it: archived paper runs) ONCE, sends nothing, writes only the optional CSV.
// Safe to run on the VM next to the live server: it never requires a server module and never touches the ledger.
// Per trade: strategy, signal / staged / fill / exit times, entry rationale, quote age at the signal, contract / spread facts,
// costs, holding time, exit reason (who closed it), net, R, and evidence flags in five groups:
//   SIGNAL  late fill after the signal, entry drift from the signal's reference price
//   CONTRACT  debit share of the width, leg bid/ask vs the net mid, DTE
//   QUOTES  quote age at the signal, the indicative (non-OPRA) feed, exits booked on a model / interpolated value
//   EXEC    the paper package-fill model vs the natural price (mid +- 0.15 x the legs' bid/ask, not the full spread), fee share
//   EXIT / RECON  stops worse than -1.1R, holds past the setup's own window, manual closes, external closes, broker P&L source
// Best / worst executable price reached is NOT in the ledger (no tick history is kept): see the Phase 89 report for the
// bar-based reconstruction and why trade-print highs / lows are not executable prices.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || path.join(__dirname, '..', 'server', 'data', 'ledger-state.json');
const since = opt('--since') ? Date.parse(`${opt('--since')}T00:00:00Z`) : 0;
const crypto = require('crypto');
const digest = () => { const b = fs.readFileSync(file); return { sha256: crypto.createHash('sha256').update(b).digest('hex'), bytes: b.length }; };
const before = digest(); // Phase 89c: proof the original was not changed (re-hashed at the end)
const L = JSON.parse(fs.readFileSync(file, 'utf8'));
const runsFile = opt('--runs') || path.join(path.dirname(file), 'paper-runs.json');
const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : null;

const et = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const num = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const exitBy = (r) => (/^MANUAL_CLOSE/.test(String(r || '')) ? 'manual' : /^CLOSED_EXTERNALLY/.test(String(r || '')) ? 'external' : 'system');
const HOLD_HOURS = { 'speculative-crypto': 24, 'crypto-intraday': 24, 'equity-day': 7, 'options-quickflips': 6.5 }; // the setup's own window
const PACKAGE_SLIPPAGE = 0.15; // cost-authority.packageQuote: the paper package fill model

function auditRow(t, source) {
  const od = t.optionsData || null;
  const signal = Date.parse(t.timestamp) || null;
  const holdH = t.closedAt && t.openedAt ? (t.closedAt - t.openedAt) / 36e5 : null;
  const flags = [];
  const fillLag = signal && t.openedAt ? (t.openedAt - signal) / 1000 : null;
  if (fillLag > 300) flags.push(`SIGNAL:filled ${Math.round(fillLag / 60)} min after the signal`);
  let natural = null;
  if (od) {
    const qAge = od.refAt && od.quoteTime ? (od.refAt - od.quoteTime) / 1000 : null;
    if (qAge > 60) flags.push(`QUOTES:quote ${Math.round(qAge)} s old at the signal`);
    if (od.feed && od.feed !== 'opra') flags.push(`QUOTES:${od.feed} feed (not OPRA NBBO)`);
    if (/model|intrinsic/.test(String(t.optionsExitBasis || ''))) flags.push(`QUOTES:exit booked on a ${t.optionsExitBasis} value`);
    if (od.width && od.debit / od.width > 0.5) flags.push(`CONTRACT:debit ${Math.round((od.debit / od.width) * 100)}% of the width`);
    const combined = Number(od.combinedLegSpread) || 0;
    if (od.netMid > 0 && combined / od.netMid > 0.15) flags.push(`CONTRACT:legs' bid/ask ${Math.round((combined / od.netMid) * 100)}% of the net mid`);
    if (od.fill === 'package' && combined > 0 && t.execution !== 'LIVE' && !t.paperBroker && Number.isFinite(t.netPnl)) {
      // Natural prices: buy at the net ask (mid + combined / 2), sell at the net bid (mid - combined / 2); the model books
      // mid +- 0.15 x combined, i.e. 0.35 x combined better per side (exit legs assumed as wide as at entry).
      natural = t.netPnl - 2 * (0.5 - PACKAGE_SLIPPAGE) * combined * (od.multiplier || 100) * (t.positionSize || 1);
      flags.push(`EXEC:at natural prices ${natural >= 0 ? '+' : ''}${natural.toFixed(2)} (booked ${t.netPnl.toFixed(2)})`);
    }
    if (od.dte != null && od.dte <= 7) flags.push(`CONTRACT:${od.dte} DTE at entry`);
  }
  if (t.grossPnl && t.fees > 0 && Math.abs(t.fees / t.grossPnl) > 0.5) flags.push(`EXEC:fees ${Math.round(Math.abs(t.fees / t.grossPnl) * 100)}% of the gross`);
  if (t.rMultiple < -1.1 && exitBy(t.exitReason) === 'system') flags.push(`EXIT:stop filled at ${t.rMultiple.toFixed(2)}R (gap / slippage / fees)`);
  if (holdH && HOLD_HOURS[t.strategyId] && holdH > HOLD_HOURS[t.strategyId]) flags.push(`EXIT:held ${holdH.toFixed(1)} h (window ${HOLD_HOURS[t.strategyId]} h)`);
  if (od && od.horizon === 'intraday' && holdH > 5 * 24) flags.push(`EXIT:held ${(holdH / 24).toFixed(1)} days on a 1-5 day plan`);
  if (exitBy(t.exitReason) === 'manual') flags.push('EXIT:closed by hand');
  if (exitBy(t.exitReason) === 'external') flags.push('RECON:closed outside SignalDesk');
  if (t.execution === 'LIVE' && t.pnlSource && t.pnlSource !== 'broker') flags.push(`RECON:P&L source ${t.pnlSource}`);
  if (t.execution === 'LIVE' && Number.isFinite(t.actualFees) && Math.abs(t.actualFees - t.fees) > 0.01) flags.push(`RECON:fees ${t.fees} vs broker ${t.actualFees}`);
  if (t.bracketStatus === 'UNARMORED') flags.push('RECON:stop not resting at the venue (UNARMORED)');
  return {
    source, id: t.id, execution: t.execution, broker: t.broker || t.paperBroker || (t.execution === 'LIVE' ? '?' : 'internal paper'), strategy: t.strategyId, market: t.market,
    asset: t.asset, setup: t.setupType, timeframe: t.timeframe, direction: t.direction,
    signalAt: et(signal), stagedAt: et(t.stagedAt), approvedAt: et(t.approvedAt), filledAt: et(t.openedAt), closedAt: et(t.closedAt), fillLagS: num(fillLag, 0), holdH: num(holdH, 2),
    rationale: String((t.catalyst && t.catalyst.headline) || (t.thesis || '').split('. ')[0]).slice(0, 140),
    entry: od ? od.debit : t.fillPrice, exit: od ? num(t.optionsExitValue, 4) : t.exitPrice, exitBasis: od ? t.optionsExitBasis : t.pnlSource || '',
    quoteAgeS: od && od.refAt && od.quoteTime ? num((od.refAt - od.quoteTime) / 1000, 0) : null, feed: od ? od.feed : '', dte: od ? od.dte : null,
    legSpread: od ? od.combinedLegSpread : null, netMid: od ? od.netMid : null,
    fees: num(t.fees), gross: num(t.grossPnl), net: num(t.netPnl), r: num(t.rMultiple), netAtNatural: num(natural), exitReason: String(t.exitReason || ''), exitBy: exitBy(t.exitReason),
    flags,
  };
}

const rows = []; const records = [];
const take = (t, src) => { if (Number.isFinite(t.netPnl) && (t.closedAt || 0) >= since) { rows.push(auditRow(t, src)); records.push(t); } };
for (const t of L.tradeJournal || []) take(t, 'current');
for (const run of (runs && runs.runs) || []) for (const t of run.tradeJournal || run.journal || []) take(t, `run ${run.name || run.runId}`);
const order = rows.map((r, i) => i).sort((a, b) => (records[a].closedAt || 0) - (records[b].closedAt || 0));
rows.splice(0, rows.length, ...order.map((i) => rows[i])); records.splice(0, records.length, ...order.map((i) => records[i]));

function stats(list) {
  const w = list.filter((r) => r.net > 0); const l = list.filter((r) => r.net <= 0);
  const gw = w.reduce((s, r) => s + r.net, 0); const gl = -l.reduce((s, r) => s + r.net, 0);
  const rs = list.map((r) => r.r).filter(Number.isFinite);
  return { n: list.length, winPct: list.length ? Math.round((w.length / list.length) * 100) : 0, net: num(gw - gl), avgWin: num(w.length ? gw / w.length : 0), avgLoss: num(l.length ? -gl / l.length : 0),
    pf: gl > 0 ? num(gw / gl) : null, avgR: rs.length ? num(rs.reduce((s, x) => s + x, 0) / rs.length) : null };
}
const line = (label, s) => `${label.padEnd(46)} n ${String(s.n).padStart(3)}  win ${String(s.winPct).padStart(3)}%  net ${String(s.net).padStart(9)}  avg win ${s.avgWin}  avg loss ${s.avgLoss}  PF ${s.pf ?? '-'}  avg R ${s.avgR ?? '-'}`;
const group = (key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)); };

console.log(`TRADE AUDIT ${file}  sha256 ${before.sha256.slice(0, 16)}... ${before.bytes} bytes  (${rows.length} closed records; ${(L.activePositions || []).length} open; paper runs archived: ${runs ? (runs.runs || []).length : 0})`);
console.log(rows.length ? `first close ${rows[0].closedAt}, last ${rows[rows.length - 1].closedAt} (ET)` : 'no closed trades');
console.log('\nBY STRATEGY x EXECUTION'); for (const [k, list] of group((r) => `${r.strategy} ${r.execution}`)) console.log(line(k, stats(list)));
console.log('\nBY STRATEGY x WHO CLOSED IT'); for (const [k, list] of group((r) => `${r.strategy} ${r.execution} ${r.exitBy}`)) console.log(line(k, stats(list)));
console.log('\nBY EXIT REASON'); for (const [k, list] of group((r) => `${r.execution} ${r.exitReason.replace(/ @ .*/, '').slice(0, 30)}`)) console.log(line(k, stats(list)));
const nat = rows.filter((r) => r.netAtNatural !== null);
if (nat.length) console.log(`\nPAPER OPTION SPREADS AT NATURAL PRICES: ${nat.length} trades booked ${num(nat.reduce((s, r) => s + r.net, 0))}, at natural ${num(nat.reduce((s, r) => s + r.netAtNatural, 0))} (wins ${nat.filter((r) => r.netAtNatural > 0).length})`);
const AA = require('./audit-attribution');
rows.forEach((r, i) => { const rc = AA.reconcile(records[i], r); Object.assign(r, { estOverstatement: num(rc.overstatement), estFeeDiff: num(rc.feeDiff), estReconciledNet: num(rc.reconciled), estSpreadCostC: num(rc.spreadCost) }); });
console.log('\nA. ACCOUNTING RECONCILIATION ($; RECORDED = the ledger, untouched; the adjustments and RECONCILED are ESTIMATES: scripts/audit-attribution.js)');
for (const l of AA.bridge(records, rows)) console.log(`  ${l}`);
console.log('\nB. HYPOTHESES: why the reconciled result happened ($, reconstructed per trade; not accounting)');
for (const l of AA.table(records, rows)) console.log(`  ${l}`);
console.log('\nFLAG COUNTS (group:what)');
const fc = {}; for (const r of rows) for (const f of r.flags) { const k = f.split(':')[0] + ':' + f.split(':')[1].replace(/[-+]?\d[\d.]*/g, '#'); fc[k] = (fc[k] || 0) + 1; }
for (const [k, n] of Object.entries(fc).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\nPER TRADE');
for (const r of rows) {
  console.log(`${r.filledAt} -> ${r.closedAt} | ${r.execution} ${r.broker} | ${r.asset} ${r.strategy} ${r.setup} ${r.timeframe} | signal ${r.signalAt} (+${r.fillLagS}s) | hold ${r.holdH}h | `
    + `entry ${r.entry} exit ${r.exit} ${r.exitBasis || ''} | fees ${r.fees} net ${r.net} (${r.r}R)${r.netAtNatural !== null ? ` natural ${r.netAtNatural}` : ''} | ${r.exitReason}`);
  console.log(`    why: ${r.rationale}${r.quoteAgeS !== null ? ` | quote age ${r.quoteAgeS}s ${r.feed} | DTE ${r.dte} | legs bid/ask ${r.legSpread} vs mid ${r.netMid}` : ''}`);
  if (r.flags.length) console.log(`    flags: ${r.flags.join(' ; ')}`);
}
console.log('\nOPEN POSITIONS');
for (const p of L.activePositions || []) {
  const od = p.optionsData;
  console.log(`  ${et(p.openedAt)} ${p.execution} ${p.paperBroker || p.broker || ''} ${p.asset} ${p.strategyId} ${p.setupType || ''} ${od ? `debit ${od.debit} exp ${od.expiration}` : `fill ${p.fillPrice} stop ${p.invalidation}`}${p.fillEstimated ? ' WORKING' : ''}${p.deferredExit ? ' DEFERRED EXIT' : ''}`);
}
const csv = opt('--csv');
if (csv) {
  const cols = Object.keys(rows[0] || { id: 1 });
  const esc = (v) => { const s = Array.isArray(v) ? v.join(' ; ') : v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(csv, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  console.log(`\nCSV written: ${csv}`);
}
const after = digest();
console.log(after.sha256 === before.sha256 ? `\nInput file unchanged (sha256 ${after.sha256})` : '\nWARNING: the input file CHANGED while it was read (the live server may be writing it): audit a COPY');
