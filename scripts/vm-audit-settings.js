// What can trade, per the code the RUNNING process loaded (Phase 89d), READ-ONLY. Used by scripts/vm-audit.sh:
//   node vm-audit-settings.js <ledger COPY> <strategy-toggles.js of the loaded commit>
// The ledger stores only the switches the user saved; the loaded code fills the rest from ITS defaults (85b: every scanner but Crypto
// Swing ON). Mirrors ledger-store: a saved map naming an id that code does not know is rejected (that code's defaults apply), and code
// with versioned pauses (Phase 89+) applies a pause the saved strategyPauseVersion has not had yet. Never requires a server module.
const fs = require('fs');
const [file, togglesFile] = process.argv.slice(2);
if (!file || !togglesFile) { console.error('usage: node vm-audit-settings.js <ledger copy> <strategy-toggles.js>'); process.exit(2); }
const L = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = L.settings || {};
let T = null;
try { T = require(require('path').resolve(togglesFile)); } catch (err) { console.log(`strategy switches: the loaded code has no readable strategy-toggles.js (${err.message})`); }

const by = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const pick = (keys) => Object.fromEntries(keys.map((k) => [k, s[k] === undefined ? '(not saved: code default)' : s[k]]));

if (T) {
  const saved = s.strategiesEnabled;
  let map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  const unknown = map ? Object.keys(map).filter((k) => !T.IDS.includes(k)) : [];
  const bad = map ? Object.entries(map).filter(([, v]) => typeof v !== 'boolean').map(([k]) => k) : [];
  let note = map ? 'saved map + code defaults for ids it does not name' : 'NO saved map: the loaded code\'s defaults';
  if (unknown.length || bad.length) { map = null; note = `saved map REJECTED by this code (unknown ${unknown.join(', ') || '-'}; not true/false ${bad.join(', ') || '-'}): its defaults`; }
  if (typeof T.applyPause === 'function') {
    const paused = T.applyPause(s.strategyPauseVersion, map);
    if (paused) { map = paused; note += `; a research pause not yet saved is applied at load (saved pauseVersion ${s.strategyPauseVersion ?? 'none'})`; }
  }
  if (typeof T.applyRadar === 'function') { // Phase 91: like ledger-store.restoreSettings, after the pause
    const radar = T.applyRadar(s.radarVersion, map);
    if (radar) { map = radar; note += `; the radar migration not yet saved is applied at load (saved radarVersion ${s.radarVersion ?? 'none'})`; }
  }
  const eff = { ...(T.DEFAULTS || {}), ...(map || {}) };
  console.log(`STRATEGY SWITCHES as the loaded code reads them (${note}):`);
  for (const id of T.IDS) console.log(`  ${(T.isEnabled(id, { strategiesEnabled: eff }) ? 'ON ' : 'off')}  ${id.padEnd(20)} ${(T.LABELS && T.LABELS[id]) || ''}`);
  console.log(`  saved map: ${JSON.stringify(saved === undefined ? null : saved)}`);
}

console.log('\nMODES + LIMITS (saved settings; "(not saved)" = the code default: stockMode / cryptoMode default paper):');
console.log(`  ${JSON.stringify(pick(['stockMode', 'cryptoMode', 'paperStockBroker', 'strategyPauseVersion', 'radarVersion', 'dailyProfitTargetOn', 'dailyProfitTarget',
  'dailyLossLimitPaper', 'dailyLossLimitLive', 'maxOpenPositions', 'maxOpenRiskPct', 'maxOptionEntriesPerDay', 'bankroll', 'cryptoBankroll', 'riskProfile']))}`);

const pos = L.activePositions || [];
const pend = L.pendingOrders || [];
console.log(`\nOPEN POSITIONS: ${pos.length}  by execution/market/strategy ${JSON.stringify(by(pos, (p) => `${p.execution}/${p.market}/${p.strategyId || 'manual'}`))}`);
for (const p of pos) console.log(`  ${String(p.execution).padEnd(5)} ${String(p.market).padEnd(7)} ${String(p.asset).padEnd(14)} ${String(p.strategyId || 'manual').padEnd(20)} opened ${p.openedAt ? new Date(p.openedAt).toISOString() : '?'}${p.fillEstimated ? '  WORKING entry' : ''}${p.paperExitOrderId ? '  working exit' : ''}${p.deferredExit ? '  deferred exit' : ''}`);
console.log(`WAITING IN APPROVALS: ${pend.length}  ${JSON.stringify(by(pend, (o) => `${o.execution || o.sizingBasis}/${o.strategyId || 'manual'}`))}`);
const j = L.tradeJournal || [];
console.log(`JOURNAL: ${j.length} records, last close ${j.length ? new Date(Math.max(...j.map((t) => t.closedAt || 0))).toISOString() : '-'}`);
