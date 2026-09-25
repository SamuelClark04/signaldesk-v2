// Strategy 2b: Crypto Intraday, fast 15m / 1h day trades on the most liquid
// Coinbase pairs (long only), alongside the 4h crypto swing (2-crypto-swing.js).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Real Coinbase candles (history-bars.js, 150 per timeframe), completed bars
// only, re-fetched once per new bar per symbol; a failed fetch is retried next
// pass (never cached as "no history"). Four archetypes, each evaluated on 15m
// AND on 1h independently (crypto-intraday-signals.js): squeeze breakout,
// liquidity sweep, range failure, EMA21 / 24h-VWAP pullback reclaim.
// Reality gate (risk/reality-gate.js, Phase 54):
//   stop   under the chart structure (swing / sweep / range low less 0.25 of the
//          timeframe's ATR). A chart stop under 3.2% is REJECTED ("Chart stop
//          too tight for Coinbase fee tier"), never stretched; from 3.2% it may
//          widen to the maker fee floor (4.6% at the Intro tier)
//   T1     2.0R (50%), T2 3.0R (runner); T1 must sit within 1.0x the DAILY ATR
//          (a 1-24h hold cannot plan a multi-day move)
//   ceiling T1 snaps under hourly resistance (last 48 bars) AND under the daily
//          30- / 100-day highs; a squeeze is exempt from a high only when it is
//          breaking it (entry within 0.5%): risk/target-plan.js
// The risk engine then demands >= 1.25 : 1 NET reward : risk at T1 alone.
// The live price must still be above the trigger level and within 0.5% of the
// trigger close (no chasing). Entry: a limit inside the zone (maker).
const { getHistory } = require('../connectors/history-bars');
const { getDailyBars } = require('../connectors/daily-bars');
const { minStopPct } = require('../risk/cost-authority');
const { planTargets } = require('../risk/target-plan');
const gate = require('../risk/reality-gate');
const sig = require('./crypto-intraday-signals');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'crypto-intraday';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'UNI', 'NEAR', 'APT', 'ARB', 'RENDER', 'PEPE', 'LTC'].map((s) => `${s}-USD`);
const TF = { '15m': { sec: 900, hold: '1-6 hours' }, '1h': { sec: 3600, hold: '4-24 hours' } };
const CONFIG = {
  symbols: SYMBOLS, minBars: 80, stopAtrBuffer: 0.25, entryBufferPct: 0.002, maxChasePct: 0.005, t1R: 2.0, t2R: 3.0,
  resistanceBars: 48, dailyLookback: 100, feeBudget: 0.34, tradeType: 'Day Trade',
};

const bars = new Map(); // `${symbol}|${tf}` -> { slot, bars } (completed bars, oldest first)
const lastSignal = new Set(); // candidate ids already proposed
const coils = new Map(); // `${symbol}|${tf}` -> { high, low } for proximity
let blocks = [];
const tally = createTally();

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);

async function completed(symbol, tf, now) {
  const { sec } = TF[tf];
  const slot = Math.floor(now / 1000 / sec);
  const key = `${symbol}|${tf}`;
  const hit = bars.get(key);
  if (hit && hit.slot === slot) return hit.bars;
  const r = await getHistory(symbol, tf);
  if (!r.ok) return hit ? hit.bars : []; // not cached: retried on the next pass
  const list = r.bars.filter((b) => (b.time + sec) * 1000 <= now);
  bars.set(key, { slot, bars: list });
  return list;
}

// One signal -> a candidate, or { skip } (and a block for the Scanner when a gate rejects it).
function candidate(symbol, tf, s, b, live, ctx, now) {
  const L = b[b.length - 1];
  const id = `${STRATEGY_ID}:${s.kind}:${symbol}:${tf}:${L.time}`;
  const shell = { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: s.setupType, direction: 'long', timeframe: tf };
  const reject = (reason, short) => { blocks.push({ id, reason, candidate: shell }); return { skip: `Rejected: ${short}` }; };
  const entryMax = round(Math.min(live, L.close * (1 + CONFIG.maxChasePct)) * (1 + CONFIG.entryBufferPct));
  const floor = minStopPct('crypto', 'maker', CONFIG.feeBudget);
  const structural = s.swingLow - CONFIG.stopAtrBuffer * sig.barAtr(b);
  const cs = gate.chartStop(entryMax, structural, floor);
  if (!cs.ok) return reject(`CHART_STOP_TOO_TIGHT: ${cs.reason}`, gate.CHART_STOP_REASON.toLowerCase());
  const invalidation = floorPx(cs.invalidation);
  const risk = entryMax - invalidation;
  const planned = [{ level: 1, price: round(entryMax + CONFIG.t1R * risk), allocation: 0.5 }, { level: 2, price: round(entryMax + CONFIG.t2R * risk), allocation: 0.5 }];
  const common = { entry: entryMax, stop: invalidation, market: 'crypto', entryLiquidity: 'maker', fmt: round, breakout: s.breakout ? {} : null };
  const hourly = planTargets({ ...common, bars: ctx.hourly, lookbackDays: CONFIG.resistanceBars, unit: { bar: 'hourly', span: 'hours' }, targets: planned });
  if (!hourly.ok) return reject(hourly.reason, 'resistance too close to snap T1');
  const daily = planTargets({ ...common, bars: ctx.daily, lookbackDays: CONFIG.dailyLookback, targets: hourly.targets });
  if (!daily.ok) return reject(daily.reason, 'under the daily 30/100-day high');
  const t1 = daily.targets[0].price;
  const cap = gate.atrCap(entryMax, t1, ctx.atr, 'intraday');
  if (!cap.ok) return reject(`ATR_TARGET_UNREALISTIC: ${cap.reason}`, 'T1 beyond 1x the daily ATR');
  const ceiling = gate.dailyCeiling(ctx.daily, entryMax);
  const why = { SQUEEZE: `broke out of a tight ${sig.CONFIG.squeezeBars}-bar ${tf} range (${((s.range || 0) * 100).toFixed(1)}% wide, top ${round(s.level)})`,
    SWEEP: `swept the ${tf} ${sig.CONFIG.sweepBars}-bar low ${round(s.level)} (to ${round(s.swingLow)}) and closed back above it`,
    RANGEFAIL: `failed a breakdown under its ${sig.CONFIG.rangeBars}-bar ${tf} range low ${round(s.level)} and closed back inside`,
    PULLBACK: `is in a ${tf} uptrend and reclaimed its ${s.setupType.split(' ').slice(1, -1).join(' ')} ${round(s.level)} after a pullback` }[s.kind];
  return {
    id, ...shell, tradeType: CONFIG.tradeType, expectedDuration: TF[tf].hold, entryLiquidity: 'maker', resistance: daily.resistance || hourly.resistance,
    entryZone: { min: round(Math.min(live, s.level * 1.001)), max: entryMax },
    invalidation,
    targets: daily.targets,
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} ${why} on ${s.relVol.toFixed(1)}x relative volume. Day trade: limit entry up to ${entryMax} (maker), stop ${invalidation} `
      + `(${((risk / entryMax) * 100).toFixed(1)}%: ${cs.widened ? `the chart stop ${(((entryMax - structural) / entryMax) * 100).toFixed(1)}% widened to the maker-fee floor` : 'under the chart structure'}). `
      + `T1 is ${cap.mult.toFixed(2)}x the daily ATR away. ${hourly.text} ${daily.text} ${ceiling.text}. Expected hold: ${TF[tf].hold}.`,
    confirmationCriteria: [
      `${s.setupType} on the latest completed ${tf} bar, ${s.relVol.toFixed(1)}x volume`,
      `Live price above the trigger level ${round(s.level)} and within ${CONFIG.maxChasePct * 100}% of the trigger close`,
      `Chart stop >= ${gate.MIN_CHART_STOP * 100}% (never stretched); T1 ${CONFIG.t1R}R within 1x the daily ATR; T1 alone >= ${gate.MIN_T1_NET_RR} : 1 net`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function evaluate(symbol, live, now) {
  const hourly = await completed(symbol, '1h', now);
  const daily = await getDailyBars(symbol, now);
  const ctx = { hourly, daily, atr: gate.dailyAtr(daily) };
  const why = [];
  let rejected = null;
  for (const tf of Object.keys(TF)) {
    const b = tf === '1h' ? hourly : await completed(symbol, tf, now);
    if (b.length < CONFIG.minBars) { why.push(`${tf}: only ${b.length} bars (needs ${CONFIG.minBars})`); continue; }
    const skips = [];
    for (const s of sig.detectAll(b, tf, coils, `${symbol}|${tf}`)) {
      if (s.skip) { skips.push(s.skip); continue; }
      const L = b[b.length - 1];
      if (!(live > s.level) || live > L.close * (1 + CONFIG.maxChasePct)) { skips.push(`${s.setupType} but price ${live > s.level ? 'ran away' : 'fell back under the level'}`); continue; }
      const c = candidate(symbol, tf, s, b, live, ctx, now);
      if (c.skip) { rejected = rejected || `${tf}: ${c.skip}`; skips.push(c.skip); continue; }
      if (lastSignal.has(c.id)) { skips.push('already proposed'); continue; }
      lastSignal.add(c.id);
      return c;
    }
    why.push(`${tf}: ${skips.find((x) => /volume|ran away|fell back|coiled|swept|broke down/.test(x)) || skips[skips.length - 1]}`);
  }
  return tally.skip(symbol, rejected || why.join('; ') || 'No setup');
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
      const c = await evaluate(symbol, live, now);
      if (c) { out.push(c); tally.setup(); }
    } catch (err) {
      console.error(`[crypto-intraday] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

// Startup backfill: every pair's 15m and 1h history (and daily bars) before the first pass.
async function backfill(now = Date.now()) {
  for (const symbol of CONFIG.symbols) {
    for (const tf of Object.keys(TF)) await completed(symbol, tf, now).catch(() => []);
    await getDailyBars(symbol, now).catch(() => []);
  }
}

// "Heating up": coiled ranges the live price is still under (cached analyses only).
function proximity(latestPricesMap) {
  const out = [];
  for (const [key, c] of coils) {
    const [symbol, tf] = key.split('|');
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0) || live >= c.high) continue;
    out.push({ symbol, strategyId: STRATEGY_ID, trigger: c.high, distancePct: (c.high - live) / live, label: `${tf} squeeze; breakout above ${round(c.high)}` });
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { bars.clear(); lastSignal.clear(); coils.clear(); blocks = []; }

module.exports = { generateCandidates, backfill, proximity, takeBlocks, takeScan: tally.take, reset, candidate, pullback: sig.pullback, squeeze: sig.squeeze, ema: sig.ema, STRATEGY_ID, CONFIG, TF };
