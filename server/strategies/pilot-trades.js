// Portfolio Pilot, trade generation. PROPOSER ONLY: builds candidates and action
// proposals; the risk engine sizes and gates buys, the ledger stages them, and
// nothing executes without the user's approval (Approvals queue).
//   Buys     one candidate per underweight asset from calculateAllocation():
//            entry = live price (+0.3% zone); stop = the WIDER of the 20-day swing
//            low less 0.5 ATR and 2 ATR under entry (a core buy needs room),
//            capped at MAX_STOP_PCT. NO take-profit: a core holding is not
//            sold at a fixed target. It leaves only at its stop, or through a
//            Pilot SELL / TRIM the user approves (the ledger also ignores
//            targets on Pilot positions). Size is the allocator's dollar amount
//            (maxNotional), and never more than the risk engine allows.
//   Defense  every open stock/crypto position (not day trades or options),
//            on real daily bars (260 days):
//            SELL  the last close AND the live price are under the 200-day SMA
//                  (long-term trend broken: move to cash)
//            TRIM  price is far above the 50-day SMA, by percent AND by ATRs
//                  (stocks 20% and 3 ATR; crypto, far more volatile, 35% and
//                  4 ATR); sell TRIM_FRACTION
const { getHistory } = require('../connectors/history-bars');
const { nearestResistance } = require('../risk/structure');
const { PILOT_STRATEGY_ID } = require('./4-portfolio-pilot');

const CONFIG = {
  atrDays: 20, swingDays: 20, stopAtr: 2, swingBufferAtr: 0.5, maxStopPct: 0.2, entryBufferPct: 0.003,
  sma200: 200, sma50: 50, trimFraction: 1 / 3,
  extended: { stocks: { pct: 0.2, atr: 3 }, crypto: { pct: 0.35, atr: 4 } },
  skipStrategies: new Set(['equity-day']), // intraday trades have their own exits
};
const BARS_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // symbol -> { at, bars }
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };
const sma = (bars, n) => bars.slice(-n).reduce((s, b) => s + b.close, 0) / n;
function atr(bars, n) {
  const w = bars.slice(-n - 1);
  let sum = 0;
  for (let i = 1; i < w.length; i += 1) sum += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  return sum / (w.length - 1);
}

// Completed daily bars (today's forming bar dropped), cached for hours.
async function dailyBars(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  if (!hit || now - hit.at >= BARS_TTL_MS) {
    const r = await getHistory(symbol, '1d-long');
    cache.set(symbol, { at: now, bars: r.ok ? r.bars : (hit ? hit.bars : []) });
  }
  const today = etDate.format(now);
  const done = symbol.includes('-') ? (b) => (b.time + 86400) * 1000 <= now : (b) => etDate.format(b.time * 1000) < today;
  return cache.get(symbol).bars.filter(done);
}

const marketOf = (asset) => (asset.includes('-') ? 'crypto' : 'stocks');

// One fully formed buy per recommendation with money to spend. Returns
// { candidates, skipped: [{ asset, reason }] }.
async function buyCandidates(allocation, now = Date.now()) {
  const candidates = [];
  const skipped = [];
  const stamp = new Date(now).toISOString().slice(0, 16);
  for (const r of allocation.recommendations) {
    if (!(r.recommendedBuyAmount > 0)) continue;
    if (!(r.price > 0)) { skipped.push({ asset: r.asset, reason: 'No live price' }); continue; }
    const bars = await dailyBars(r.asset, now);
    if (bars.length < CONFIG.atrDays + 1) { skipped.push({ asset: r.asset, reason: 'Not enough daily history for a volatility stop' }); continue; }
    const a = atr(bars, CONFIG.atrDays);
    const entryMax = round(r.price * (1 + CONFIG.entryBufferPct));
    const swingLow = Math.min(...bars.slice(-CONFIG.swingDays).map((b) => b.low));
    const rawStop = Math.min(swingLow - CONFIG.swingBufferAtr * a, entryMax - CONFIG.stopAtr * a);
    const invalidation = floorPx(Math.max(rawStop, entryMax * (1 - CONFIG.maxStopPct)));
    const res = nearestResistance(bars, entryMax);
    const basis = rawStop < entryMax * (1 - CONFIG.maxStopPct) ? `capped at ${CONFIG.maxStopPct * 100}%`
      : invalidation <= swingLow - CONFIG.swingBufferAtr * a + 1e-9 ? `under the ${CONFIG.swingDays}-day swing low ${round(swingLow)}` : `${CONFIG.stopAtr} ATR under entry`;
    candidates.push({
      id: `${PILOT_STRATEGY_ID}:BUY:${r.asset}:${stamp}`,
      asset: r.asset, market: marketOf(r.asset), strategyId: PILOT_STRATEGY_ID, setupType: 'Pilot allocation buy', direction: 'long', timeframe: '1D',
      tradeType: 'Core holding', expectedDuration: 'Long-term (rebalanced with each deposit)',
      maxNotional: r.recommendedBuyAmount, // the allocator's dollar amount: the risk engine never buys more
      entryZone: { min: round(r.price), max: entryMax },
      invalidation,
      targets: [], // core holding: exits via stop or an approved Pilot SELL / TRIM only
      catalyst: { type: 'allocation', headline: null, sentimentScore: 0 },
      thesis: `Portfolio Pilot: ${r.asset} is ${(r.currentWeight * 100).toFixed(1)}% of pilot holdings against a ${(r.targetWeight * 100).toFixed(0)}% target, `
        + `so $${r.recommendedBuyAmount.toFixed(2)} of the $${allocation.deposit.toFixed(2)} deposit goes to it. Stop ${invalidation} (${basis}; ATR${CONFIG.atrDays} ${round(a)}), `
        + `No fixed take-profit: held until the stop, or a Pilot SELL / TRIM you approve. `
        + `${res ? `Nearest daily resistance ${round(res.price)} (${res.kind}).` : 'No daily resistance overhead in the loaded history.'}`,
      confirmationCriteria: [`Buy up to $${r.recommendedBuyAmount.toFixed(2)} (allocator)`, `Stop ${basis}`, `Risk engine may size smaller (risk profile, capital cap)`],
      timestamp: new Date(now).toISOString(),
    });
  }
  return { candidates, skipped };
}

// Defensive review of open positions. Returns [{ id, action, positionId, asset,
// market, fraction, price, reason, detail, levels }] (at most one per position).
async function reviewPositions(positions, priceOf, now = Date.now()) {
  const date = etDate.format(now);
  const out = [];
  for (const p of positions) {
    if (p.market === 'options' || p.direction === 'short' || CONFIG.skipStrategies.has(p.strategyId)) continue;
    const live = priceOf(p.asset);
    if (!(live > 0)) continue;
    const bars = await dailyBars(p.asset, now);
    if (bars.length < CONFIG.sma200) continue; // no 200-day average: no verdict
    const s200 = sma(bars, CONFIG.sma200);
    const s50 = sma(bars, CONFIG.sma50);
    const a = atr(bars, CONFIG.atrDays);
    const lastClose = bars[bars.length - 1].close;
    const base = { positionId: p.id, asset: p.asset, market: p.market, price: live, execution: p.execution || 'PAPER', adopted: !!p.adopted,
      levels: { sma200: round(s200), sma50: round(s50), atr: round(a) } };
    if (lastClose < s200 && live < s200) {
      out.push({ ...base, id: `pilot:SELL:${p.id}:${date}`, action: 'SELL', fraction: 1, reason: 'Below the 200-day average: move to cash',
        detail: `${p.asset} closed at ${round(lastClose)} and trades at ${round(live)}, under its 200-day SMA ${round(s200)}. The long-term trend has broken; the defensive rule is to exit and hold cash.` });
    } else if (live >= s50 * (1 + CONFIG.extended[p.market].pct) && live - s50 >= CONFIG.extended[p.market].atr * a) {
      out.push({ ...base, id: `pilot:TRIM:${p.id}:${date}`, action: 'TRIM', fraction: CONFIG.trimFraction, reason: 'Extended far above the 50-day average: trim a third',
        detail: `${p.asset} at ${round(live)} is ${(((live / s50) - 1) * 100).toFixed(1)}% and ${((live - s50) / a).toFixed(1)} ATR above its 50-day SMA ${round(s50)}. Selling a third locks in part of the move; the rest keeps its stop and target.` });
    }
  }
  return out;
}

module.exports = { buyCandidates, reviewPositions, dailyBars, CONFIG };
