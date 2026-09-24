// Strategy 2b: Crypto Intraday, fast 15m / 1h day trades on the most liquid
// Coinbase pairs (long only), alongside the 4h crypto swing (2-crypto-swing.js).
// PROPOSER ONLY: returns Canonical Candidates; never sizes, stages or executes.
//
// Real Coinbase candles (history-bars.js), completed bars only, re-fetched once
// per new bar per symbol (no poll loop). Two setups, each on 15m and on 1h:
//   Trend pullback reclaim   EMA9 > EMA21 > EMA50 (uptrend); within the last
//                            PULLBACK_BARS bars price dipped to the EMA21 or the
//                            rolling 24h VWAP; the latest bar closed back ABOVE
//                            that level after the bar before closed at/under it,
//                            on expanding volume (>= 1.2x the 20-bar average)
//   Volatility squeeze       the 12 bars before the latest sat in a tight range
//   breakout                 (<= 2% of price on 15m, 3.5% on 1h) and the latest
//                            closed above it on >= 1.8x relative volume
// Stop: under the swing low (pullback) or the range low (squeeze), never tighter
// than the crypto fee floor (cost-authority.js minStopPct, maker entry: 4.6% at
// the Intro tier). Entry is a limit inside the zone (maker: paper, and a
// live post-only limit at the bid). Targets: T1 1.5R (50%), T2 3R (runner),
// T1 snapped under resistance from the last 48 hourly bars (risk/target-plan.js;
// the squeeze breakout's own range is exempt). The live price must still be
// above the trigger level and within 0.5% of the trigger close (no chasing).
const { getHistory } = require('../connectors/history-bars');
const { minStopPct } = require('../risk/cost-authority');
const { planTargets } = require('../risk/target-plan');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'crypto-intraday';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'UNI', 'NEAR', 'APT', 'ARB', 'RENDER', 'PEPE', 'LTC'].map((s) => `${s}-USD`);
const TF = { '15m': { sec: 900, squeezePct: 0.02, hold: '1-6 hours' }, '1h': { sec: 3600, squeezePct: 0.035, hold: '4-24 hours' } };
const CONFIG = {
  symbols: SYMBOLS, pullbackBars: 6, volBars: 20, reclaimVol: 1.2, squeezeBars: 12, breakoutVol: 1.8,
  stopBufferPct: 0.002, entryBufferPct: 0.002, maxChasePct: 0.005, t1R: 1.5, t2R: 3, resistanceBars: 48, feeBudget: 0.34,
  tradeType: 'Day Trade',
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
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// EMA series aligned with `values` (null until the first full window).
function ema(values, n) {
  const k = 2 / (n + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  out[n - 1] = avg(values.slice(0, n));
  for (let i = n; i < values.length; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Rolling VWAP of the `win` bars ending at i (typical price x volume).
function vwapAt(b, i, win) {
  const w = b.slice(Math.max(0, i - win + 1), i + 1);
  const vol = w.reduce((s, x) => s + (x.volume || 0), 0);
  return vol > 0 ? w.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / vol : null;
}

async function completed(symbol, tf, now) {
  const { sec } = TF[tf];
  const slot = Math.floor(now / 1000 / sec);
  const key = `${symbol}|${tf}`;
  const hit = bars.get(key);
  if (hit && hit.slot === slot) return hit.bars;
  const r = await getHistory(symbol, tf);
  const list = r.ok ? r.bars.filter((b) => (b.time + sec) * 1000 <= now) : (hit ? hit.bars : []);
  bars.set(key, { slot, bars: list });
  return list;
}

// Trend pullback reclaim on the latest completed bar: { kind, level, levelName, swingLow, relVol } or a skip reason.
function pullback(b, tf) {
  const n = b.length;
  const closes = b.map((x) => x.close);
  const e9 = ema(closes, 9); const e21 = ema(closes, 21); const e50 = ema(closes, 50);
  const L = n - 1; const P = n - 2;
  if (!(e50[L] > 0)) return { skip: 'Not enough history' };
  if (!(e9[L] > e21[L] && e21[L] > e50[L])) return { skip: `${tf}: no uptrend (EMA9 > EMA21 > EMA50)` };
  const win = tf === '15m' ? 96 : 24; // 24 hours of bars
  const levels = [['EMA21', e21], ['24h VWAP', b.map((_, i) => vwapAt(b, i, win))]];
  for (const [name, series] of levels) {
    const dipped = b.slice(n - 1 - CONFIG.pullbackBars, n - 1).some((x, j) => x.low <= series[n - 1 - CONFIG.pullbackBars + j]);
    if (!dipped || !(closes[P] <= series[P]) || !(closes[L] > series[L])) continue;
    const relVol = b[L].volume / avg(b.slice(L - CONFIG.volBars, L).map((x) => x.volume));
    if (!(relVol >= CONFIG.reclaimVol)) return { skip: `${tf}: ${name} reclaim on ${relVol.toFixed(1)}x volume (needs ${CONFIG.reclaimVol}x)` };
    return { kind: 'PULLBACK', setupType: `${tf} ${name} reclaim`, level: series[L], swingLow: Math.min(...b.slice(-CONFIG.pullbackBars - 1).map((x) => x.low)), relVol };
  }
  return { skip: `${tf}: uptrend, no fresh EMA21 / VWAP reclaim` };
}

// Squeeze breakout on the latest completed bar.
function squeeze(b, tf, key) {
  const n = b.length;
  if (n < CONFIG.squeezeBars + CONFIG.volBars + 1) return { skip: 'Not enough history' };
  const box = b.slice(n - 1 - CONFIG.squeezeBars, n - 1);
  const high = Math.max(...box.map((x) => x.high)); const low = Math.min(...box.map((x) => x.low));
  const L = b[n - 1];
  if ((high - low) / L.close > TF[tf].squeezePct) { coils.delete(key); return { skip: `${tf}: no tight ${CONFIG.squeezeBars}-bar range` }; }
  coils.set(key, { high, low });
  if (!(L.close > high)) return { skip: `${tf}: coiled, no breakout yet` };
  const relVol = L.volume / avg(b.slice(n - 1 - CONFIG.volBars, n - 1).map((x) => x.volume));
  if (!(relVol >= CONFIG.breakoutVol)) return { skip: `${tf}: breakout on ${relVol.toFixed(1)}x volume (needs ${CONFIG.breakoutVol}x)` };
  return { kind: 'SQUEEZE', setupType: `${tf} squeeze breakout`, level: high, swingLow: low, relVol, range: (high - low) / L.close };
}

function candidate(symbol, tf, sig, b, live, hourly, now) {
  const L = b[b.length - 1];
  const entryMax = round(Math.min(live, L.close * (1 + CONFIG.maxChasePct)) * (1 + CONFIG.entryBufferPct));
  const floor = minStopPct('crypto', 'maker', CONFIG.feeBudget);
  const structural = sig.swingLow * (1 - CONFIG.stopBufferPct);
  const invalidation = floorPx(Math.min(structural, entryMax * (1 - floor)));
  const risk = entryMax - invalidation;
  const atr = avg(b.slice(-14).map((x) => x.high - x.low));
  const plan = planTargets({ bars: hourly, entry: entryMax, stop: invalidation, market: 'crypto', entryLiquidity: 'maker', fmt: round,
    lookbackDays: CONFIG.resistanceBars, unit: { bar: 'hourly', span: 'hours' }, breakout: sig.kind === 'SQUEEZE' ? { atr } : null,
    targets: [{ level: 1, price: round(entryMax + CONFIG.t1R * risk), allocation: 0.5 }, { level: 2, price: round(entryMax + CONFIG.t2R * risk), allocation: 0.5 }] });
  const id = `${STRATEGY_ID}:${sig.kind}:${symbol}:${tf}:${L.time}`;
  const shell = { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: sig.setupType, direction: 'long', timeframe: tf };
  if (!plan.ok) { blocks.push({ id, reason: plan.reason, candidate: shell }); return { skip: 'Rejected: resistance too close to snap T1' }; }
  return {
    id, ...shell, tradeType: CONFIG.tradeType, expectedDuration: TF[tf].hold, entryLiquidity: 'maker', resistance: plan.resistance,
    entryZone: { min: round(Math.min(live, sig.level * 1.001)), max: entryMax },
    invalidation,
    targets: plan.targets,
    catalyst: { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} ${sig.kind === 'SQUEEZE'
      ? `broke out of a tight ${CONFIG.squeezeBars}-bar ${tf} range (${(sig.range * 100).toFixed(1)}% wide, top ${round(sig.level)}) on ${sig.relVol.toFixed(1)}x relative volume`
      : `is in a ${tf} uptrend (EMA9 > EMA21 > EMA50) and reclaimed its ${sig.setupType.split(' ').slice(1, -1).join(' ')} ${round(sig.level)} after a pullback, on ${sig.relVol.toFixed(1)}x volume`}. `
      + `Day trade: limit entry up to ${entryMax} (maker), stop ${invalidation} (${((risk / entryMax) * 100).toFixed(1)}%: `
      + `${invalidation < structural ? 'the maker-fee floor' : sig.kind === 'SQUEEZE' ? 'under the range low' : 'under the swing low'}). ${plan.text} Expected hold: ${TF[tf].hold}.`,
    confirmationCriteria: [
      sig.kind === 'SQUEEZE' ? `${CONFIG.squeezeBars}-bar range <= ${(TF[tf].squeezePct * 100).toFixed(1)}%, close above it on >= ${CONFIG.breakoutVol}x volume`
        : `EMA9 > EMA21 > EMA50 on ${tf}; close back above the level on >= ${CONFIG.reclaimVol}x volume`,
      `Live price above the trigger level ${round(sig.level)} and within ${CONFIG.maxChasePct * 100}% of the trigger close`,
      `Targets: T1 ${CONFIG.t1R}R (50%) / T2 ${CONFIG.t2R}R, stop never tighter than the ${(floor * 100).toFixed(1)}% fee floor`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function evaluate(symbol, live, now) {
  const hourly = await completed(symbol, '1h', now);
  const skips = [];
  for (const tf of Object.keys(TF)) {
    const b = tf === '1h' ? hourly : await completed(symbol, tf, now);
    if (b.length < 60) { skips.push(`${tf}: not enough history`); continue; }
    for (const sig of [squeeze(b, tf, `${symbol}|${tf}`), pullback(b, tf)]) {
      if (sig.skip) { skips.push(sig.skip); continue; }
      const L = b[b.length - 1];
      if (!(live > sig.level) || live > L.close * (1 + CONFIG.maxChasePct)) { skips.push(`${tf}: ${sig.setupType} but price ${live > sig.level ? 'ran away' : 'fell back under the level'}`); continue; }
      const c = candidate(symbol, tf, sig, b, live, hourly, now);
      if (c.skip) { skips.push(c.skip); continue; }
      if (lastSignal.has(c.id)) { skips.push('Already proposed'); continue; }
      lastSignal.add(c.id);
      return c;
    }
  }
  return tally.skip(symbol, skips.find((x) => /Rejected|volume|ran away|fell back/.test(x)) || skips[skips.length - 1] || 'No setup');
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

module.exports = { generateCandidates, proximity, takeBlocks, takeScan: tally.take, reset, pullback, squeeze, ema, STRATEGY_ID, CONFIG, TF };
