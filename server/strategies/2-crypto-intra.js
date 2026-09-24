// Strategy 2: Crypto Intraday, flush-and-reclaim of the rolling mean (long only).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// The pipeline hands us one price per tick, so this module keeps a short rolling
// window of the prices it has observed (observation memory, not trading state).
// Trigger: inside the window price flushed at least FLUSH_PCT below the window
// mean, and on THIS tick it crossed back above the mean (fresh reclaim only).
//
// Stops are deliberately tight (1.5%). With crypto's ~264 bps round-trip cost,
// the risk engine's 0.35R cost gate is expected to reject these: 2.64% / 1.5%
// = 1.76R of fees. That rejection is the system working, not a bug.
const STRATEGY_ID = 'crypto-intraday';

const CONFIG = {
  symbols: ['BTC-USD'],
  windowSize: 30, // samples; one per pipeline tick (60s) => ~30 minutes
  minSamples: 10,
  flushPct: 0.004, // the dip must reach 0.4% below the window mean
  stopPct: 0.015, // tight intraday stop below the worst-case entry
  entryBufferPct: 0.001,
  targetsR: [{ level: 1, r: 2, allocation: 1 }],
};

const windows = new Map(); // symbol -> [{ price, t }]
const lastSignalAt = new Map(); // symbol -> t of the last reclaim signal (a flush triggers once)
const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);

function observe(symbol, price, now) {
  const w = windows.get(symbol) || [];
  w.push({ price, t: now });
  while (w.length > CONFIG.windowSize) w.shift();
  windows.set(symbol, w);
  return w;
}

function detectReclaim(symbol, window, now) {
  if (window.length < CONFIG.minSamples) return null;
  const prior = window.slice(0, -1);
  const current = window[window.length - 1].price;
  const previous = prior[prior.length - 1].price;
  const mean = prior.reduce((s, p) => s + p.price, 0) / prior.length;
  // Only a flush AFTER the last signal counts, so chop around the mean can't
  // re-trigger off the same dip.
  const since = lastSignalAt.get(symbol) || -Infinity;
  const fresh = prior.filter((p) => p.t > since);
  if (!fresh.length) return null;
  const low = Math.min(...fresh.map((p) => p.price));

  const flushed = low <= mean * (1 - CONFIG.flushPct);
  const reclaimed = previous <= mean && current > mean;
  if (!flushed || !reclaimed) return null;
  lastSignalAt.set(symbol, now);

  const entryMax = cents(current * (1 + CONFIG.entryBufferPct));
  const invalidation = Math.floor(entryMax * (1 - CONFIG.stopPct) * 100) / 100;
  const risk = entryMax - invalidation;
  const minute = new Date(now).toISOString().slice(0, 16); // one idea per reclaim minute

  return {
    id: `${STRATEGY_ID}:RECLAIM:${symbol}:${minute}`,
    asset: symbol,
    market: 'crypto',
    strategyId: STRATEGY_ID,
    setupType: 'Mean Reclaim',
    direction: 'long',
    timeframe: '1m',
    entryZone: { min: cents(mean), max: entryMax },
    invalidation,
    targets: CONFIG.targetsR.map((t) => ({ level: t.level, price: cents(entryMax + t.r * risk), allocation: t.allocation })),
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} flushed to ${cents(low)} (${(((mean - low) / mean) * 100).toFixed(2)}% under its `
      + `${prior.length}-sample mean ${cents(mean)}) and reclaimed it at ${cents(current)}. `
      + `Long the reclaim; invalid below ${invalidation} (${(CONFIG.stopPct * 100).toFixed(1)}% stop).`,
    confirmationCriteria: [
      `Dip to at least ${(CONFIG.flushPct * 100).toFixed(1)}% below the rolling mean`,
      `Fresh cross back above the mean (${cents(previous)} → ${cents(current)})`,
      `Entry at or below ${entryMax} (no chasing)`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

function generateCandidates(latestPricesMap, now = Date.now()) {
  const candidates = [];
  for (const symbol of CONFIG.symbols) {
    const price = lookup(latestPricesMap, symbol);
    if (!(price > 0)) continue;
    const candidate = detectReclaim(symbol, observe(symbol, price, now), now);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

// Test hook: clear observation memory.
function resetWindows() {
  windows.clear();
  lastSignalAt.clear();
}

module.exports = { generateCandidates, resetWindows, STRATEGY_ID, CONFIG };
