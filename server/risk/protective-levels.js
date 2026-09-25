// Protective levels for holdings SignalDesk did not open itself: manual
// holdings (Robinhood, Fidelity, a cold wallet...) and broker-synced balances
// (Coinbase / Alpaca) bought outside the app. The Portfolio Pilot's structural
// plan, measured from the price when the levels are set (the risk FROM HERE):
//   stop  the highest support at least MIN_STOP (8%) under the price: the 20-day
//         swing low, the 50-day or the 200-day SMA, each less 0.5 ATR(20); none
//         that deep -> the 8% minimum; never further than MAX_STOP (18%)
//   T1    price + 2.5R (sells 35%), T2 price + 4.5R (the rest)
// Real daily bars (pilot-ranker.js dailyBars, cached). Pure otherwise.
const { dailyBars, sma, atr } = require('../strategies/pilot-ranker');
const { CONFIG: PILOT } = require('../strategies/pilot-trades');

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };

// Levels from `bars` at `price`: { ref, invalidation, t1, t2, stopPct, basis }.
function levelsFrom(bars, price) {
  const ref = price > 0 ? price : bars.length ? bars[bars.length - 1].close : null;
  if (!(ref > 0)) return null;
  const minStop = ref * (1 - PILOT.minStopPct);
  const maxStop = ref * (1 - PILOT.maxStopPct);
  let stop = minStop;
  let basis = `${PILOT.minStopPct * 100}% minimum (no support 8-18% below)`;
  if (bars.length > PILOT.atrDays) {
    const buffer = PILOT.swingBufferAtr * atr(bars, PILOT.atrDays);
    const supports = [['20-day swing low', Math.min(...bars.slice(-PILOT.swingDays).map((b) => b.low))],
      ...(bars.length >= 50 ? [['50-day SMA', sma(bars, 50)]] : []), ...(bars.length >= 200 ? [['200-day SMA', sma(bars, 200)]] : [])]
      .map(([name, level]) => [name, level - buffer]).filter(([, level]) => level <= minStop);
    if (supports.length) {
      const [name, level] = supports.reduce((best, s) => (s[1] > best[1] ? s : best));
      stop = Math.max(level, maxStop);
      basis = level < maxStop ? `capped at ${PILOT.maxStopPct * 100}% (the ${name} is further)` : `under the ${name}`;
    }
  }
  const invalidation = floorPx(stop);
  const risk = ref - invalidation;
  return { ref: round(ref), invalidation, t1: round(ref + PILOT.t1R * risk), t2: round(ref + PILOT.t2R * risk), stopPct: risk / ref, basis };
}

async function protectiveLevels(asset, price, now = Date.now()) {
  const bars = await dailyBars(asset, now);
  const lv = levelsFrom(bars, price);
  return lv ? { ...lv, at: now } : null;
}

module.exports = { protectiveLevels, levelsFrom, T1_SHARE: PILOT.t1Share };
