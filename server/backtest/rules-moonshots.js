// Moonshots (System 6) replay rule (Phase 79): the live trigger code itself (6-speculative-crypto assess() /
// liquidity(), gem-triggers) on 5m candles, with the live entry rules (strategies/moonshot-entry.js), stop / targets
// and the engine's cost gates. History has no buzz, news or bid / ask: the no-buzz path (the volume-only catalyst
// credit) and an unknown spread (4 / 8 points), so it replays the technical + volume trigger only.
// Too heavy for the in-app runner (dozens of coins x 26k bars on an e2-micro): used offline (the Phase 79 research).
// variant: { chase: bool (the 24h / RSI filters), pullback: bool } (live = both true); legacy = both false.
const spec = require('../strategies/6-speculative-crypto');
const entry = require('../strategies/moonshot-entry');

const C = spec.CONFIG;
const DAY = 288; // 5m bars

// btc: BTC-USD 5m bars (relative strength); feeKey: 'crypto' (Coinbase) / 'crypto:kraken' / 'crypto:okx'.
function make(variant, feeKey, btc) {
  const btcIdx = new Map(btc.map((b, i) => [b.time, i]));
  return { market: 'crypto', signal(bars, i, ctx) {
    if (i < 2 * DAY || bars[i].time - ctx.last < C.cooldownMs / 1000) return null;
    const c = bars[i].close;
    const pre = Math.max(c / bars[i - 3].close - 1, c / bars[i - 6].close - 1, c / bars[i - 12].close - 1);
    if (pre < 0.015) return null; // cheap pre-filter: every trigger needs a >= 1.5% move in the last hour
    let volumeUsd = 0; let prev = 0;
    for (let k = i - DAY + 1; k <= i; k += 1) volumeUsd += bars[k].volume * bars[k].close;
    for (let k = i - 2 * DAY + 1; k <= i - DAY; k += 1) prev += bars[k].volume * bars[k].close;
    if (volumeUsd < C.catalystVolumeUsd) return null;
    const volChange = prev > 0 ? volumeUsd / prev - 1 : null;
    const change24h = c / bars[i - DAY].close - 1;
    const w = bars.slice(i - 149, i + 1);
    const j = btcIdx.get(bars[i].time);
    const b = j !== undefined && j >= 149 ? { live: btc[j].close, bars: btc.slice(j - 149, j + 1) } : null;
    const a = spec.assess(w, c, 'X', { btc: b, volumeUsd, volChange });
    if (!a.trigger || a.best.total < C.qualify) return null;
    const s = a.best;
    if (!spec.liquidity({ volumeUsd, volChange, relVol: s.m && s.m.relVol, buzz: null }).ok) return null;
    if (variant.chase && entry.chase(w, change24h)) return null;
    ctx.last = bars[i].time;
    const kind = a.trigger;
    const floor = spec.stopFloor(kind); // the live floor (Coinbase's on every venue); fees / gates at feeKey
    const structural = kind === 'COIL' ? a.coil.structural : Math.min(...w.slice(-C.swingBars).map((x) => x.low)) * (1 - C.stopBufferPct);
    const levels = (ref) => {
      const stop = spec.stopFor(kind, ref, structural, floor);
      if (stop.reject) return { reject: 'CHART_STOP_TOO_TIGHT' };
      const [t1R, t2R] = kind === 'COIL' ? [C.coilT1R, C.coilT2R] : [C.t1R, C.t2R];
      const risk = ref - stop.price;
      return { stop: stop.price, targets: [{ level: 1, price: ref + t1R * risk, allocation: 0.5 }, { level: 2, price: ref + t2R * risk, allocation: 0.5 }] };
    };
    const base = { tag: kind, feeKey, speculative: true, meta: { change24h } };
    if (variant.pullback) return { ...base, fill: 'limit', limit: entry.pullbackLimit(kind, a, c, w), validBars: entry.FILTERS.armMs / 300000, entryLiquidity: 'maker', build: (fill) => levels(fill) };
    const entryMax = c * (1 + C.entryBufferPct);
    return { ...base, fill: 'nextOpen', entryMax, entryLiquidity: kind === 'COIL' ? 'maker' : 'taker', build: () => levels(entryMax) };
  } };
}

module.exports = { make };
