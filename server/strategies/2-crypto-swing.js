// Strategy 2: Crypto Swing, capitulation flush then reclaim of the mean (long only).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Multi-day timeframe on real Coinbase 4h candles (history-bars.js):
//   mean     = SMA of the last 20 completed 4h closes (~3.3 days)
//   setup    = within the last 6 bars (~1 day) the low flushed >= 3% under the mean
//   trigger  = the last completed bar closed at/below the mean and the LIVE price
//              is now back above it (a fresh reclaim; one signal per flush)
//   stop     = the tightest stop the fee gate allows (below)
//   target   = 3R (strict) or 2R (moderate): the live Settings dial, risk/strictness.js,
//              read on every pass
// Why: the risk engine rejects fee drag above 0.35R, and fee drag = blended
// round-trip cost / stop %. Execution is modelled leg by leg (cost-authority.js):
// the entry is a resting limit inside the zone (maker: paper, and live Coinbase
// as a post-only limit at the bid), a target exit is a resting limit (maker),
// a stop is taker + spread. US entry tier (0.50% maker / 0.90% taker + 0.10%
// spread): 0.50% + (0.50% + 1.00%) / 2 = 1.25% blended round trip / 0.34R =
// 3.7% stop, instead of the old all-taker 6%.
// Resistance (risk/target-plan.js): a major DAILY top under the target no longer
// vetoes the setup when it is far enough away: T1 (50%) snaps just under it and
// T2 (50% runner) keeps the full target, if the blended net reward still meets
// the strictness minimum; otherwise the setup is reported via takeBlocks(). The
// thesis states the plan, the news sentiment (connectors/news-sentiment.js) and
// the expected hold.
// Candles only change every 4h, so each coin's history is cached for CANDLE_TTL_MS:
// 40 coins cost at most one REST call per coin per 15 minutes (no poll loop).
const { CRYPTO } = require('../market/universe');
const { getHistory } = require('../connectors/history-bars');
const { getDailyBars } = require('../connectors/daily-bars');
const { planTargets } = require('../risk/target-plan');
const { minStopPct } = require('../risk/cost-authority');
const { getStrictness } = require('../risk/strictness');
const sentiment = require('../connectors/news-sentiment');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'crypto-swing';

const FEE_DRAG_BUDGET = 0.34; // under the gate's 0.35R, with a little room
// Maker entry: a limit inside the zone (post-only when live, coinbase-api.js).
const entryLiquidity = () => 'maker';
const stopPct = () => minStopPct('crypto', 'maker', FEE_DRAG_BUDGET);

const CONFIG = {
  symbols: [...CRYPTO], // the monitored crypto universe (server/market/universe.js)
  timeframe: '4h',
  meanBars: 20,
  flushLookback: 6,
  flushPct: 0.03,
  entryBufferPct: 0.002,
  tradeType: 'Swing Trade',
  expectedDuration: '2-7 days',
};
const CANDLE_TTL_MS = 15 * 60 * 1000;
const BAR_SEC = 4 * 3600;

const candles = new Map(); // symbol -> { at, bars } (completed 4h bars, oldest first)
const lastSignal = new Map(); // symbol -> time of the flush-low bar already signalled
let blocks = []; // setups rejected on the last pass: { id, reason, candidate }
const tally = createTally(); // why each coin produced no setup (scanner log)

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

function levels(live) {
  const entryMax = px(live * (1 + CONFIG.entryBufferPct));
  const pct = stopPct();
  const invalidation = floorPx(entryMax * (1 - pct));
  return { entryMax, invalidation, pct, target: px(entryMax + getStrictness().targetR * (entryMax - invalidation)) };
}

function candidate(symbol, live, s, now, ctx) {
  const { entryMax, invalidation, pct } = levels(live);
  const plan = ctx.target;
  const depth = ((s.mean - s.flushBar.low) / s.mean) * 100;
  return {
    id: `${STRATEGY_ID}:REVERSAL:${symbol}:${s.flushBar.time}`,
    asset: symbol,
    market: 'crypto',
    strategyId: STRATEGY_ID,
    setupType: 'Capitulation reversal',
    direction: 'long',
    timeframe: CONFIG.timeframe,
    tradeType: CONFIG.tradeType,
    expectedDuration: CONFIG.expectedDuration,
    resistance: plan.resistance,
    entryLiquidity: 'maker', // a resting limit inside the entry zone (post-only when live)
    newsSentiment: ctx.news && ctx.news.ok ? { score: ctx.news.score, label: ctx.news.label, source: ctx.news.source } : null,
    entryZone: { min: px(s.mean), max: entryMax },
    invalidation,
    targets: plan.targets,
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} flushed to ${px(s.flushBar.low)} (${depth.toFixed(1)}% under its ${CONFIG.meanBars}-bar ${CONFIG.timeframe} mean `
      + `${px(s.mean)}) and is reclaiming it at ${px(live)}. Multi-day long for a ${getStrictness().targetR}R move (${getStrictness().level} setting); `
      + `invalid below ${invalidation} (${+(pct * 100).toFixed(1)}% stop, the blended maker/taker fee floor). ${plan.text} `
      + `${sentiment.describe(ctx.news)} Expected hold: ${CONFIG.expectedDuration}.`,
    confirmationCriteria: [
      `Flush at least ${(CONFIG.flushPct * 100).toFixed(0)}% below the ${CONFIG.meanBars}-bar ${CONFIG.timeframe} mean within ${CONFIG.flushLookback} bars`,
      `Last ${CONFIG.timeframe} close at or below the mean (${px(s.lastClose)}), live price back above it`,
      `Entry at or below ${entryMax} (no chasing)`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  blocks = [];
  tally.start();
  const out = [];
  for (const symbol of CONFIG.symbols) {
    tally.checked();
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0)) { tally.skip(symbol, 'No live price'); continue; }
    try {
      const s = analyse(await completedBars(symbol, now));
      if (!s) { tally.skip(symbol, `No ${(CONFIG.flushPct * 100).toFixed(0)}% flush below the ${CONFIG.timeframe} mean`); continue; }
      if (lastSignal.get(symbol) === s.flushBar.time) { tally.skip(symbol, 'This flush was already signalled'); continue; }
      if (!(live > s.mean)) { tally.skip(symbol, 'Flushed, not yet reclaiming the mean'); continue; }
      if (!(s.lastClose <= s.mean)) { tally.skip(symbol, 'Reclaim happened earlier (not fresh)'); continue; }
      // Overhead daily resistance: snap T1 under it, or reject when it is too close.
      const { entryMax, invalidation, target } = levels(live);
      const t = planTargets({ bars: await getDailyBars(symbol, now), entry: entryMax, stop: invalidation, market: 'crypto',
        entryLiquidity: entryLiquidity(), fmt: px, targets: [{ level: 1, price: target, allocation: 1 }] });
      if (!t.ok) {
        blocks.push({ id: `${STRATEGY_ID}:REVERSAL:${symbol}:${s.flushBar.time}`, reason: `RESISTANCE_BLOCKS_TARGET: ${t.text}`,
          candidate: { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: 'Capitulation reversal', direction: 'long', timeframe: CONFIG.timeframe } });
        tally.skip(symbol, 'Rejected: resistance too close to snap T1');
        continue; // not signalled: it may qualify once price breaks the level
      }
      lastSignal.set(symbol, s.flushBar.time);
      tally.setup();
      out.push(candidate(symbol, live, s, now, { target: t, news: await sentiment.getSentiment(symbol, now) }));
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
function reset() { candles.clear(); lastSignal.clear(); blocks = []; }

// The pipeline reads (and clears) the rejected setups after each pass.
function takeBlocks() { const b = blocks; blocks = []; return b; }

module.exports = { generateCandidates, proximity, takeBlocks, takeScan: tally.take, reset, analyse, stopPct, STRATEGY_ID, CONFIG };
