// Backtest runner (Phase 77): run(ruleId, days) downloads the rule's history (backtest/history.js), replays every
// symbol (backtest/engine.js) and returns one report: trades, win rate, total / average R, profit factor, max
// drawdown (R), per-symbol totals, the recent trades, why signals were skipped, and what the replay leaves out.
// Only NEW trades inside the window count (the bars before it are indicator warm-up). One run at a time; a report
// is kept REPORT_MS (the same rule + window again answers at once).
// Not replayable, so listed as unavailable: Moonshots (the historical gem catalog, Reddit / trending buzz and live
// spreads are not archived), options (no free historical option chains) and the Portfolio Pilot (a months-long
// allocator, not an entry / exit rule).
const history = require('./history');
const engine = require('./engine');
const stocks = require('./rules-stocks');
const crypto = require('./rules-crypto');
const { getStrictness } = require('../risk/strictness'); // the live Settings dial: resistance snapping / targets follow it

const RULES = Object.fromEntries([stocks.equitySwing, stocks.equityDay, crypto.swing, crypto.intra].map((r) => [r.id, r]));
const UNAVAILABLE = {
  'speculative-crypto': 'Moonshots: the historical gem catalog, Reddit / CoinGecko buzz and live spreads are not archived',
  'options-system': 'Options spreads: no free historical option chains (bids / asks per strike) to price the spreads',
  'portfolio-pilot': 'Portfolio Pilot: a months-long allocator (rank, deposit, rebalance), not an entry / exit rule',
};
const DAY_CHOICES = [30, 60, 90];
const REPORT_MS = 10 * 60 * 1000;
const reports = new Map(); // `${rule}|${days}` -> report
let running = null;

const catalog = () => ({ rules: Object.values(RULES).map((r) => ({ id: r.id, label: r.label, market: r.market, tf: r.tf, defaultDays: r.defaultDays })),
  unavailable: Object.entries(UNAVAILABLE).map(([id, why]) => ({ id, why })), days: DAY_CHOICES, running: running ? running.key : null });

async function execute(rule, days, now, progress) {
  const t0 = Date.now();
  const symbols = rule.symbols();
  progress(`Downloading ${days + rule.warmupDays} days of ${rule.tf} bars for ${symbols.length} symbols`);
  const h = await history.load(symbols, rule.tf, rule.market, days + rule.warmupDays, now, progress);
  if (!h.ok) return { ok: false, error: h.error };
  const since = Math.floor((now - days * 864e5) / 1000);
  const trades = [];
  const skipped = {};
  const bySymbol = [];
  for (const [n, symbol] of Object.keys(h.series).entries()) {
    const bars = h.series[symbol];
    if (bars.length < 30) continue;
    progress(`Replaying ${symbol} (${n + 1} of ${symbols.length})`);
    const ctx = rule.context ? rule.context(symbol, bars, h.series) : {};
    const from = bars.findIndex((b) => b.time >= since);
    if (from < 0) continue;
    const r = await engine.replay(symbol, bars, rule, ctx, from);
    trades.push(...r.trades);
    for (const [k, v] of Object.entries(r.skipped)) skipped[k] = (skipped[k] || 0) + v;
    if (r.trades.length) bySymbol.push({ symbol, trades: r.trades.length, totalR: r.trades.reduce((s, t) => s + t.netR, 0) });
  }
  const s = engine.summarize(trades);
  const first = Object.values(h.series).find((b) => b.length);
  return {
    ok: true, rule: rule.id, label: rule.label, days, tf: rule.tf, strictness: getStrictness().label, market: rule.market, symbols: Object.keys(h.series).length, missing: h.missing,
    from: new Date(since * 1000).toISOString().slice(0, 10), to: new Date((first ? first[first.length - 1].time : since) * 1000).toISOString().slice(0, 10),
    ...s, bySymbol: bySymbol.sort((a, b) => b.totalR - a.totalR),
    recent: trades.sort((a, b) => b.openedAt - a.openedAt).slice(0, 25), skipped,
    notes: [
      `Strategy strictness: ${getStrictness().label} (the Settings dial in force now: its resistance and target rules are replayed).`,
      'Long setups only (as live). Filled at the modelled price; stop first when a bar touches both; the stop never moves (the ratchet is manual); nothing closes on time.',
      rule.market === 'crypto' ? 'Costed at OKX US fees (maker entry / targets, taker stop) plus the spread buffer; the live spread, volume and depth gates are not replayed.'
        : 'Costed with 0.05% slippage a leg (commission-free); IEX bars (a slice of the consolidated volume). Earnings and news filters are not replayed.',
      'Signals are independent per symbol: the portfolio caps (open-risk ceiling, direction limit, one trade per symbol across strategies) are not applied here.',
      'A past edge is no promise of a future one; small samples (under ~30 trades) are noise.',
    ],
    runtimeMs: Date.now() - t0, at: now,
  };
}

// -> the report ({ ok, ... }) or { ok: false, error }. progress(text): status lines while it runs.
async function run(ruleId, days = null, { now = Date.now(), progress = () => {}, fresh = false } = {}) {
  if (UNAVAILABLE[ruleId]) return { ok: false, error: `Not replayable: ${UNAVAILABLE[ruleId]}` };
  const rule = RULES[ruleId];
  if (!rule) return { ok: false, error: `unknown backtest rule "${ruleId}"` };
  const d = Number(days) || rule.defaultDays;
  if (!DAY_CHOICES.includes(d)) return { ok: false, error: `days must be one of ${DAY_CHOICES.join(', ')}` };
  const key = `${rule.id}|${d}|${getStrictness().level}`; // a report is only reused under the same strictness
  const hit = reports.get(key);
  if (!fresh && hit && now - hit.at < REPORT_MS) return { ...hit, cached: true };
  if (running) return { ok: false, busy: true, error: `A backtest is already running (${running.key.split('|').slice(0, 2).join(', ')} days); try again when it finishes` };
  running = { key, promise: execute(rule, d, now, progress) };
  try {
    const r = await running.promise;
    if (r.ok) reports.set(key, r);
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally { running = null; }
}

module.exports = { run, catalog, RULES, UNAVAILABLE, DAY_CHOICES, reset: () => { reports.clear(); running = null; } };
