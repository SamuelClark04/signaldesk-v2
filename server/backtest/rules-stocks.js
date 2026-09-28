// Backtest rules, stocks (Phase 77): the LIVE strategies' entry logic and levels on historical bars, with their
// own CONFIG (one source of truth) and the same pure gates (target-plan, reality-gate).
//   equity-swing  daily bars: SMA20 > SMA50, >= 2% off the 10-day high, within 1.5% of SMA20 and above SMA50;
//                 fills at the day's close; stop under the 5-day low; T1 the 10-day high (>= 1R, 50%), T2 2R;
//                 resistance snap + 2.5x daily-ATR cap. Not replayed: the Earnings Shield, news sentiment.
//   equity-day    5-minute bars (IEX): Opening Range Breakout, the first 5m close over the 15-minute range high
//                 before 11:30 ET, >= 1.5x the range's volume, no chase (<= +0.5%), over the session VWAP, SPY over
//                 its VWAP; filled at the next bar's open (<= entry max); stop the range low (>= 0.35%); T1 2R /
//                 T2 3R; T1 within 1x the daily ATR. Exits only in the regular session; it may carry overnight.
const { planTargets } = require('../risk/target-plan');
const gate = require('../risk/reality-gate');
const swing = require('../strategies/3-equity-swing');
const orb = require('../strategies/1-equity-day');
const { OPTIONABLE_STOCKS, STOCKS } = require('../market/universe');

const cents = (x) => Math.round(x * 100) / 100;
const avgClose = (bars, from, to) => { let s = 0; for (let k = from; k <= to; k += 1) s += bars[k].close; return s / (to - from + 1); };

const equitySwing = {
  id: 'equity-swing', label: 'Equity swing (SMA20 pullback, daily)', market: 'stocks', tf: '1d', warmupDays: 120, defaultDays: 90,
  symbols: () => [...STOCKS],
  signal(bars, i) {
    const C = swing.CONFIG;
    if (i < C.slow) return null;
    const live = bars[i].close;
    const fast = avgClose(bars, i - C.fast + 1, i);
    const slow = avgClose(bars, i - C.slow + 1, i);
    let recentHigh = 0;
    for (let k = i - C.highLookback + 1; k <= i; k += 1) recentHigh = Math.max(recentHigh, bars[k].high);
    if (!(fast > slow) || !(live <= recentHigh * (1 - C.pullbackPct)) || !(Math.abs(live - fast) / fast <= C.nearSmaPct && live > slow)) return null;
    return { fill: 'close', tag: 'SMA20 pullback', feeKey: 'stocks', entryLiquidity: 'taker', build(entry) {
      const hist = bars.slice(0, i + 1);
      const swingLow = Math.min(...bars.slice(i - C.stopLookback + 1, i + 1).map((b) => b.low));
      const stop = Math.floor(Math.min(swingLow * (1 - C.stopBufferPct), entry * (1 - C.minStopPct)) * 100) / 100;
      const risk = entry - stop;
      const t = planTargets({ bars: hist, entry, stop, market: 'stocks', fmt: cents,
        targets: [{ level: 1, price: cents(Math.max(recentHigh, entry + risk)), allocation: 0.5 }, { level: 2, price: cents(entry + 2 * risk), allocation: 0.5 }] });
      if (!t.ok) return { reject: 'RESISTANCE_BLOCKS_TARGET' };
      if (!gate.atrCap(entry, t.targets[0].price, gate.dailyAtr(hist), 'swing').ok) return { reject: 'ATR_TARGET_UNREALISTIC' };
      return { stop, targets: t.targets };
    } };
  },
};

// ET session tags without a formatter per bar (Phase 75: Intl per call is slow): the offset once per UTC day.
const etHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
const offsets = new Map();
function et(t) {
  const d = Math.floor(t / 86400);
  if (!offsets.has(d)) offsets.set(d, 12 - Number(etHour.format(new Date((d * 86400 + 12 * 3600) * 1000))));
  const local = t - offsets.get(d) * 3600;
  return { date: Math.floor(local / 86400), minute: Math.floor((local % 86400) / 60) };
}
const OPEN = 570; const CLOSE = 960; const OR_END = 585;

// Per-symbol session structure: tags, session VWAP per bar, daily bars (for the ATR) and one ORB signal per day.
function sessions(bars) {
  const tags = bars.map((b) => et(b.time));
  const inSession = tags.map((x) => x.minute >= OPEN && x.minute < CLOSE);
  const vwap = new Array(bars.length).fill(null);
  const days = new Map();
  let pv = 0; let v = 0; let day = null;
  bars.forEach((b, i) => {
    if (!inSession[i]) return;
    if (tags[i].date !== day) { day = tags[i].date; pv = 0; v = 0; days.set(day, []); }
    pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume;
    vwap[i] = v > 0 ? pv / v : null;
    days.get(day).push(i);
  });
  return { tags, inSession, vwap, days };
}

const equityDay = {
  id: 'equity-day', label: 'Equity day (ORB, 5-minute)', market: 'stocks', tf: '5m', warmupDays: 25, defaultDays: 60,
  symbols: () => [...new Set(['SPY', ...OPTIONABLE_STOCKS])],
  context(symbol, bars, series) {
    const C = orb.CONFIG;
    const s = sessions(bars);
    const spy = series.SPY ? sessions(series.SPY) : null;
    const spyAt = new Map(spy ? series.SPY.map((b, i) => [b.time, spy.vwap[i] ? b.close < spy.vwap[i] : false]) : []);
    const daily = [...s.days.values()].map((ix) => ({ time: bars[ix[0]].time, open: bars[ix[0]].open, close: bars[ix[ix.length - 1]].close,
      high: Math.max(...ix.map((k) => bars[k].high)), low: Math.min(...ix.map((k) => bars[k].low)) }));
    const signals = new Map();
    [...s.days.values()].forEach((ix, d) => {
      const orBars = ix.filter((k) => s.tags[k].minute < OR_END);
      if (orBars.length < 3 || symbol === 'SPY') return;
      const orHigh = Math.max(...orBars.map((k) => bars[k].high));
      const orLow = Math.min(...orBars.map((k) => bars[k].low));
      const orAvg = orBars.reduce((x, k) => x + bars[k].volume, 0) / 3;
      const k = ix.find((j) => s.tags[j].minute >= OR_END && bars[j].close > orHigh);
      if (k === undefined || s.tags[k].minute > C.lastEntryMinute) return;
      const b = bars[k];
      if (b.close > orHigh * (1 + C.maxChasePct) || b.volume < orAvg * C.volumeMultiple || !(b.close > s.vwap[k]) || spyAt.get(b.time)) return;
      signals.set(k, { orHigh, orLow, close: b.close, atr: gate.dailyAtr(daily.slice(0, d)) });
    });
    return { signals, inSession: s.inSession };
  },
  tradable: (i, ctx) => ctx.inSession[i], // stops / targets work in the regular session only (GTC brackets)
  signal(bars, i, ctx) {
    const x = ctx.signals.get(i);
    if (!x) return null;
    const C = orb.CONFIG;
    const entryMax = cents(Math.max(x.close, x.orHigh * (1 + C.entryBufferPct)));
    return { fill: 'nextOpen', entryMax, tag: 'ORB', feeKey: 'stocks', entryLiquidity: 'taker', build() {
      const stop = Math.min(cents(x.orLow), Math.floor(entryMax * (1 - C.minStopPct) * 100) / 100);
      const risk = entryMax - stop;
      const targets = C.targets.map((t) => ({ level: t.level, price: cents(entryMax + t.r * risk), allocation: t.allocation }));
      if (!gate.atrCap(entryMax, targets[0].price, x.atr, 'intraday').ok) return { reject: 'ATR_TARGET_UNREALISTIC' };
      return { stop, targets };
    } };
  },
};

module.exports = { equitySwing, equityDay, et };
