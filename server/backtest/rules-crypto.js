// Backtest rules, crypto (Phase 77): the LIVE strategies' logic on historical Coinbase candles, costed at OKX US
// (the waterfall's first venue: its fee floors, maker entries, taker stops, maker targets).
//   crypto-swing     4h: a >= 3% flush under the 20-bar mean within 6 bars, then the reclaim of the mean (filled at
//                    the mean, or the bar's open when it gapped over); stop under the flush low (chart-stop rule,
//                    OKX fee floor); T1 max(strictness, 2.4)R snapped under daily resistance; 2.5x daily-ATR cap;
//                    one signal per flush (the strategy's own analyse()).
//   crypto-intraday  1h: squeeze breakout, liquidity sweep, range failure, EMA21 / 24h-VWAP reclaim (the live
//                    crypto-intraday-signals.detectAll); filled at the next open (above the level, no chase);
//                    T1 2.3R (50%) / T2 3R snapped under hourly then daily resistance; 1x daily-ATR cap.
//                    Not replayed: the 15m frame, the live spread / volume gates.
const { planTargets } = require('../risk/target-plan');
const gate = require('../risk/reality-gate');
const { minStopPct } = require('../risk/cost-authority');
const { getStrictness } = require('../risk/strictness');
const cryptoSwing = require('../strategies/2-crypto-swing');
const intraday = require('../strategies/2-crypto-intraday');
const sig = require('../strategies/crypto-intraday-signals');
const { regroup } = require('./history');

const KEY = 'crypto:okx';
const same = (x) => x;
// Daily bars completed before `t` (regrouped from the replayed candles, UTC days).
const dailyBefore = (daily, t) => daily.filter((d) => d.time + 86400 <= t);

const swing = {
  id: 'crypto-swing', label: 'Crypto swing (4h flush + reclaim)', market: 'crypto', tf: '4h', warmupDays: 20, defaultDays: 90,
  symbols: () => [...cryptoSwing.CONFIG.symbols],
  context: (symbol, bars) => ({ daily: regroup(bars, 86400), lastFlush: null }),
  signal(bars, i, ctx) {
    const C = cryptoSwing.CONFIG;
    if (i < C.meanBars + 2) return null;
    const s = cryptoSwing.analyse(bars.slice(Math.max(0, i - 40), i)); // completed bars before bar i
    if (!s || ctx.lastFlush === s.flushBar.time || !(s.lastClose <= s.mean) || !(bars[i].high > s.mean)) return null;
    const price = Math.max(s.mean, bars[i].open) * 1.001;
    if (price > bars[i].high) return null;
    return { fill: 'at', price, tag: 'Capitulation reversal', feeKey: KEY, entryLiquidity: 'maker', build(entry) {
      const w = bars.slice(Math.max(0, i - 14), i);
      const range = w.reduce((x, b) => x + (b.high - b.low), 0) / w.length;
      const cs = gate.chartStop(entry, s.flushBar.low - 0.25 * range, minStopPct(KEY, 'maker', 0.29));
      ctx.lastFlush = s.flushBar.time; // signalled (a tight chart stop too); resistance below un-signals it
      if (!cs.ok) return { reject: 'CHART_STOP_TOO_TIGHT' };
      const stop = cs.invalidation;
      const daily = dailyBefore(ctx.daily, bars[i].time);
      const target = entry + Math.max(getStrictness().targetR, 2.4) * (entry - stop);
      const t = planTargets({ bars: daily, entry, stop, market: 'crypto', entryLiquidity: 'maker', fmt: same, targets: [{ level: 1, price: target, allocation: 1 }] });
      if (!t.ok) { ctx.lastFlush = null; return { reject: 'RESISTANCE_BLOCKS_TARGET' }; }
      if (!gate.atrCap(entry, t.targets[0].price, gate.dailyAtr(daily), 'swing').ok) return { reject: 'ATR_TARGET_UNREALISTIC' };
      return { stop, targets: t.targets };
    } };
  },
};

const intra = {
  id: 'crypto-intraday', label: 'Crypto intraday (1h archetypes)', market: 'crypto', tf: '1h', warmupDays: 10, defaultDays: 60,
  symbols: () => [...intraday.CONFIG.symbols],
  context: (symbol, bars) => ({ daily: regroup(bars, 86400), coils: new Map() }),
  signal(bars, i, ctx) {
    const C = intraday.CONFIG;
    if (i < C.minBars) return null;
    const w = bars.slice(Math.max(0, i - 149), i + 1);
    const s = sig.detectAll(w, '1h', ctx.coils, 'bt').find((x) => !x.skip);
    if (!s) return null;
    const entryMax = bars[i].close * (1 + C.maxChasePct) * (1 + C.entryBufferPct);
    return { fill: 'nextOpen', entryMax, minFill: s.level, tag: s.setupType, feeKey: KEY, entryLiquidity: 'maker', build(entry) {
      const cs = gate.chartStop(entry, s.swingLow - C.stopAtrBuffer * sig.barAtr(w), minStopPct(KEY, 'maker', C.feeBudget));
      if (!cs.ok) return { reject: 'CHART_STOP_TOO_TIGHT' };
      const stop = cs.invalidation;
      const risk = entry - stop;
      const planned = [{ level: 1, price: entry + C.t1R * risk, allocation: 0.5 }, { level: 2, price: entry + C.t2R * risk, allocation: 0.5 }];
      const common = { entry, stop, market: 'crypto', entryLiquidity: 'maker', fmt: same, breakout: s.breakout ? {} : null };
      const hourly = planTargets({ ...common, bars: w, lookbackDays: C.resistanceBars, unit: { bar: 'hourly', span: 'hours' }, targets: planned });
      if (!hourly.ok) return { reject: 'RESISTANCE_BLOCKS_TARGET' };
      const daily = dailyBefore(ctx.daily, bars[i].time);
      const d = planTargets({ ...common, bars: daily, lookbackDays: C.dailyLookback, targets: hourly.targets });
      if (!d.ok) return { reject: 'RESISTANCE_BLOCKS_TARGET' };
      if (!gate.atrCap(entry, d.targets[0].price, gate.dailyAtr(daily), 'intraday').ok) return { reject: 'ATR_TARGET_UNREALISTIC' };
      return { stop, targets: d.targets };
    } };
  },
};

module.exports = { swing, intra };
