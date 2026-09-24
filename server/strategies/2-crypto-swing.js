// Strategy 2: Crypto Swing, capitulation flush then reclaim of the mean (long only).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Multi-day timeframe on real Coinbase 4h candles (history-bars.js):
//   mean     = SMA of the last 20 completed 4h closes (~3.3 days)
//   setup    = within the last 6 bars (~1 day) the low flushed >= 3% under the mean
//   trigger  = the last completed bar closed at/below the mean and the LIVE price
//              is now back above it (a fresh reclaim; one signal per flush)
//   stop     = 8% under the worst-case entry;  target = 3R (24%)
// Why 8%: crypto round-trip costs are ~2.64% of the position, and the risk
// engine rejects fee drag above 0.35R. 2.64% / 8% = 0.33R clears it; a 4% stop
// (0.66R) would still be rejected every time.
// Candles only change every 4h, so each coin's history is cached for CANDLE_TTL_MS:
// 40 coins cost at most one REST call per coin per 15 minutes (no poll loop).
const { CRYPTO } = require('../market/universe');
const { getHistory } = require('../connectors/history-bars');

const STRATEGY_ID = 'crypto-swing';

const CONFIG = {
  symbols: [...CRYPTO], // the monitored crypto universe (server/market/universe.js)
  timeframe: '4h',
  meanBars: 20,
  flushLookback: 6,
  flushPct: 0.03,
  stopPct: 0.08,
  entryBufferPct: 0.002,
  targetsR: [{ level: 1, r: 3, allocation: 1 }],
};
const CANDLE_TTL_MS = 15 * 60 * 1000;
const BAR_SEC = 4 * 3600;

const candles = new Map(); // symbol -> { at, bars } (completed 4h bars, oldest first)
const lastSignal = new Map(); // symbol -> time of the flush-low bar already signalled

// Keep precision for sub-dollar coins: 2 decimals from $100, 4 from $1, else ~4 significant digits.
const decimalsFor = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(x))));
const px = (x) => { const f = 10 ** decimalsFor(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimalsFor(x); return Math.floor(x * f) / f; };
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);

async function completedBars(symbol, now) {
  const hit = candles.get(symbol);
  if (hit && now - hit.at < CANDLE_TTL_MS) return hit.bars;
  const r = await getHistory(symbol, CONFIG.timeframe);
  const bars = r.ok ? r.bars.filter((b) => (b.time + BAR_SEC) * 1000 <= now) : (hit ? hit.bars : []);
  candles.set(symbol, { at: now, bars });
  return bars;
}

// The flush state from completed bars: { mean, flushBar, lastClose } or null.
function analyse(bars) {
  if (bars.length < CONFIG.meanBars + 1) return null;
  const mean = bars.slice(-CONFIG.meanBars).reduce((s, b) => s + b.close, 0) / CONFIG.meanBars;
  const recent = bars.slice(-CONFIG.flushLookback);
  const flushBar = recent.reduce((lo, b) => (b.low < lo.low ? b : lo), recent[0]);
  const flushed = flushBar.low <= mean * (1 - CONFIG.flushPct);
  return flushed ? { mean, flushBar, lastClose: bars[bars.length - 1].close } : null;
}

function candidate(symbol, live, s, now) {
  const entryMax = px(live * (1 + CONFIG.entryBufferPct));
  const invalidation = floorPx(entryMax * (1 - CONFIG.stopPct));
  const risk = entryMax - invalidation;
  const depth = ((s.mean - s.flushBar.low) / s.mean) * 100;
  return {
    id: `${STRATEGY_ID}:REVERSAL:${symbol}:${s.flushBar.time}`,
    asset: symbol,
    market: 'crypto',
    strategyId: STRATEGY_ID,
    setupType: 'Capitulation reversal',
    direction: 'long',
    timeframe: CONFIG.timeframe,
    entryZone: { min: px(s.mean), max: entryMax },
    invalidation,
    targets: CONFIG.targetsR.map((t) => ({ level: t.level, price: px(entryMax + t.r * risk), allocation: t.allocation })),
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} flushed to ${px(s.flushBar.low)} (${depth.toFixed(1)}% under its ${CONFIG.meanBars}-bar ${CONFIG.timeframe} mean `
      + `${px(s.mean)}) and is reclaiming it at ${px(live)}. Multi-day long for a ${CONFIG.targetsR[0].r}R move; `
      + `invalid below ${invalidation} (${(CONFIG.stopPct * 100).toFixed(0)}% stop).`,
    confirmationCriteria: [
      `Flush at least ${(CONFIG.flushPct * 100).toFixed(0)}% below the ${CONFIG.meanBars}-bar ${CONFIG.timeframe} mean within ${CONFIG.flushLookback} bars`,
      `Last ${CONFIG.timeframe} close at or below the mean (${px(s.lastClose)}), live price back above it`,
      `Entry at or below ${entryMax} (no chasing)`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  const out = [];
  for (const symbol of CONFIG.symbols) {
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0)) continue;
    try {
      const s = analyse(await completedBars(symbol, now));
      if (!s || lastSignal.get(symbol) === s.flushBar.time) continue; // no flush, or this flush already signalled
      if (!(s.lastClose <= s.mean && live > s.mean)) continue; // not a fresh reclaim
      lastSignal.set(symbol, s.flushBar.time);
      out.push(candidate(symbol, live, s, now));
    } catch (err) {
      console.error(`[crypto-swing] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

// "Heating up": flushed and below the mean, i.e. the reclaim (trigger) is ahead.
// Uses cached candles only (no fetch) and the live prices.
function proximity(latestPricesMap) {
  const out = [];
  for (const [symbol, { bars }] of candles) {
    const live = lookup(latestPricesMap, symbol);
    const s = live > 0 ? analyse(bars) : null;
    if (!s || live > s.mean || lastSignal.get(symbol) === s.flushBar.time) continue;
    out.push({ symbol, strategyId: STRATEGY_ID, trigger: s.mean, distancePct: (s.mean - live) / live,
      label: `Flushed ${(((s.mean - s.flushBar.low) / s.mean) * 100).toFixed(1)}%; reclaim of the ${CONFIG.timeframe} mean ${px(s.mean)}` });
  }
  return out;
}

// Test hook.
function reset() { candles.clear(); lastSignal.clear(); }

module.exports = { generateCandidates, proximity, reset, analyse, STRATEGY_ID, CONFIG };
