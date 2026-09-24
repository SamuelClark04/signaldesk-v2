// Live scanner log: the last MAX_ENTRIES things the market scan concluded, so
// the engine is visibly working even when the gates stop every trade.
//   scan      one line per strategy per pass: symbols checked and why each
//             produced no setup (reasons tallied by the strategy itself, e.g.
//             "No volatility squeeze x22: SPY, IWM, ..."), replaced every pass
//   rejected  a setup a strategy shield or the risk engine turned down
//   staged    a setup that passed every gate and waits for approval
// The same event repeating (a setup re-proposed and re-rejected every 60s) is
// collapsed: it moves to the top with its count and latest time. In memory only.
// Observational: nothing here feeds a trading decision.
const { bucket } = require('./rejection-stats');

const MAX_ENTRIES = 20;
const SYMBOLS_SHOWN = 8;
const NAMES = { 'equity-day': 'Equity day (ORB)', 'crypto-swing': 'Crypto swing', 'equity-swing': 'Equity swing', 'options-system': 'Options swing' };

let entries = []; // newest first
let listener = null;

function add(key, entry, now = Date.now()) {
  const prev = entries.find((e) => e.key === key);
  entries = entries.filter((e) => e.key !== key);
  entries.unshift({ ...entry, key, at: now, firstAt: prev ? prev.firstAt : now, count: prev ? prev.count + 1 : 1 });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

// A strategy's pass: { checked, reasons: { reason: [symbols] } } (see takeScan()).
function scanned(strategyId, scan, now = Date.now()) {
  if (!scan) return;
  const reasons = Object.entries(scan.reasons || {}).sort((a, b) => b[1].length - a[1].length)
    .map(([reason, symbols]) => ({ reason, count: symbols.length, symbols: symbols.slice(0, SYMBOLS_SHOWN), more: Math.max(0, symbols.length - SYMBOLS_SHOWN) }));
  const setups = scan.setups || 0;
  add(`scan|${strategyId}`, { kind: 'scan', strategyId, strategy: NAMES[strategyId] || strategyId, checked: scan.checked, setups, reasons,
    text: `${NAMES[strategyId] || strategyId}: checked ${scan.checked} symbol${scan.checked === 1 ? '' : 's'}, ${setups ? `${setups} setup${setups === 1 ? '' : 's'} formed` : 'no setup formed'}` }, now);
}

function rejected(id, rawReason, candidate = {}, now = Date.now()) {
  const label = bucket(rawReason);
  add(`rej|${id}|${label}`, { kind: 'rejected', id, symbol: candidate.asset || String(id).split(':')[2] || id, market: candidate.market || null,
    strategyId: candidate.strategyId || String(id).split(':')[0], strategy: NAMES[candidate.strategyId] || candidate.strategyId || '',
    text: label, detail: String(rawReason) }, now);
}

function staged(order, now = Date.now()) {
  add(`staged|${order.id}`, { kind: 'staged', id: order.id, symbol: order.asset, market: order.market, strategyId: order.strategyId,
    strategy: NAMES[order.strategyId] || order.strategyId,
    text: `Staged for approval: ${order.positionSize} ${order.market === 'options' ? 'contracts' : order.market === 'crypto' ? 'units' : 'shares'}, risk $${Number(order.dollarRisk).toFixed(0)}`,
    detail: order.capitalCapped ? `Capital cap bound: risking ${(order.actualRiskPct * 100).toFixed(2)}%` : '' }, now);
}

const snapshot = () => entries.map((e) => ({ ...e, reasons: e.reasons && e.reasons.map((r) => ({ ...r, symbols: [...r.symbols] })) }));

// Called by the pipeline once per pass, after everything is logged.
function publish() { if (listener) listener(snapshot()); }
function onChange(fn) { listener = fn; }
function reset() { entries = []; }

module.exports = { scanned, rejected, staged, snapshot, publish, onChange, reset, MAX_ENTRIES };
