// Moonshot entry rules (Phase 79), shared by the live strategy (6-speculative-crypto.js) and its replay
// (backtest/rules-moonshots.js), so the backtest always measures the code that trades.
// The Phase 79 replay (90 days of Coinbase 5m candles, the live triggers and exits) showed the old entry
// (buy the breakout bar, at once) losing money; the variant that passed the pre-declared test was:
//   no chasing    skip a trigger when the coin is already up > 18% over 24h (exhausted pump)
//   no overbought skip a trigger when the 15m RSI(14) is > 70
//   pullback      never buy the breakout bar: ARM the trigger and buy only a retest within 1 hour
//                 (IGNITION: half of the surge given back; COIL: back to the top of the base it broke),
//                 as a resting maker buy; no pullback = no trade. Stop / targets from the fill price.
const gem = require('./gem-triggers');
const { rsi } = require('./options-signals');

const FILTERS = { max24h: 0.18, maxRsi15: 70, retrace: 0.5, armMs: 60 * 60 * 1000, rsiBars: 150 };

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

// 15m RSI(14) over the last rsiBars completed 5m bars (the replay uses the same window). -> number | null
const rsi15 = (b) => rsi(gem.to15(b.slice(-FILTERS.rsiBars)).map((x) => x.close));

// -> null (ok) | { code, text, short } why this trigger is not taken.
function chase(b, change24h) {
  if (Number.isFinite(change24h) && change24h > FILTERS.max24h) {
    return { code: 'CHASING', text: `already ${pct(change24h)} over 24h (Moonshots never buys a pump past ${pct(FILTERS.max24h)})`, short: 'Skipped: already up > 18% over 24h (no chasing)' };
  }
  const r = rsi15(b);
  if (r !== null && r > FILTERS.maxRsi15) {
    return { code: 'OVERBOUGHT', text: `15m RSI ${r.toFixed(0)} (> ${FILTERS.maxRsi15}: buying the top of the run)`, short: 'Skipped: 15m RSI over 70 (overbought)' };
  }
  return null;
}

// The resting buy after a trigger: IGNITION gives back `retrace` of its surge, measured from the close 3 (5m frame) or
// 6 (15m frame) completed 5m bars back, as replayed; COIL retests its base top. a: assess() output; live: the trigger
// price; b: the completed 5m bars.
function pullbackLimit(kind, a, live, b) {
  if (kind === 'COIL') return a.coil.baseHigh;
  const base = b[b.length - 1 - (a.ign.m.frame === '5m' ? 3 : 6)].close;
  return live - FILTERS.retrace * (live - base);
}

// Armed triggers waiting for their pullback: symbol -> { kind, limit, until, ... } (the strategy's context).
const armed = new Map();
const arm = (symbol, w) => armed.set(symbol, w);
const armedFor = (symbol) => armed.get(symbol) || null;
const disarm = (symbol) => armed.delete(symbol);
const armedSymbols = () => [...armed.keys()];
// -> [{ symbol, kind, limit, until, at, trigger }] for the Scanner / radar (no strategy internals).
const armedList = () => [...armed.entries()].map(([symbol, w]) => ({ symbol, kind: w.kind, limit: w.limit, until: w.until, at: w.at, trigger: w.triggerLive }));
const reset = () => armed.clear();

module.exports = { FILTERS, chase, rsi15, pullbackLimit, arm, armedFor, disarm, armedSymbols, armedList, reset };
