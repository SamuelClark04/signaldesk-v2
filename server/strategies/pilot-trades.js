// Portfolio Pilot, buy setups. PROPOSER ONLY: builds candidates; the risk engine
// sizes and gates them, the ledger stages them, nothing executes without the
// user's approval (Approvals queue). One builder for every Pilot buy:
//   ALLOCATION  a deposit's split (4-portfolio-pilot.js, ranked leaders)
//   ADD         scaling into a healthy winner on a pullback (pilot-matrix.js)
//   ROTATION    redeploying a SELL's proceeds into the #1 ranked leader
// Levels (real daily bars, 260 sessions):
//   stop  structural: under the 20-day swing low less 0.5 ATR, but never
//         closer than MIN_STOP (8%) nor further than MAX_STOP (18%) below entry
//   T1    2.5R, sells 35% (the ledger's partial exit; exit-monitor.js)
//   T2    4.5R, the macro runner (the rest)
// Size: the dollar amount (maxNotional) in FRACTIONAL units: stocks to 0.0001
// share (risk-engine.js), so a $150 slice of SPY is 0.1953 shares, not 0. The
// risk engine may still size it smaller (risk profile, capital cap). Live Alpaca
// refuses fractional bracket orders; fractional stock buys execute on paper.
const { nearestResistance } = require('../risk/structure');
const { dailyBars, atr, marketOf } = require('./pilot-ranker');
const { PILOT_STRATEGY_ID } = require('./4-portfolio-pilot');

const CONFIG = { atrDays: 20, swingDays: 20, swingBufferAtr: 0.5, minStopPct: 0.08, maxStopPct: 0.18, entryBufferPct: 0.003, t1R: 2.5, t1Share: 0.35, t2R: 4.5 };
const KIND = {
  ALLOCATION: { setupType: 'Pilot allocation buy', verb: 'deposit allocation' },
  ADD: { setupType: 'Pilot add (winner on a pullback)', verb: 'add to a winner' },
  ROTATION: { setupType: 'Pilot rotation buy', verb: 'rotation of sale proceeds' },
};

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };

// One Pilot buy: { asset, price, amount, kind, why, idTag? } -> { candidate } or { skip }.
async function buildBuy({ asset, price, amount, kind, why, idTag }, now = Date.now()) {
  if (!(price > 0)) return { skip: 'No live price' };
  if (!(amount >= 1)) return { skip: 'Less than $1 to invest' };
  const bars = await dailyBars(asset, now);
  if (bars.length < CONFIG.atrDays + 1) return { skip: 'Not enough daily history for a structural stop' };
  const a = atr(bars, CONFIG.atrDays);
  const entryMax = round(price * (1 + CONFIG.entryBufferPct));
  const swingLow = Math.min(...bars.slice(-CONFIG.swingDays).map((b) => b.low));
  const structural = swingLow - CONFIG.swingBufferAtr * a;
  const invalidation = floorPx(Math.min(entryMax * (1 - CONFIG.minStopPct), Math.max(structural, entryMax * (1 - CONFIG.maxStopPct))));
  const risk = entryMax - invalidation;
  const pct = risk / entryMax;
  const basis = structural < entryMax * (1 - CONFIG.maxStopPct) ? `capped at ${CONFIG.maxStopPct * 100}%`
    : structural > entryMax * (1 - CONFIG.minStopPct) ? `widened to the ${CONFIG.minStopPct * 100}% minimum` : `under the ${CONFIG.swingDays}-day swing low ${round(swingLow)}`;
  const t1 = round(entryMax + CONFIG.t1R * risk);
  const t2 = round(entryMax + CONFIG.t2R * risk);
  const res = nearestResistance(bars, entryMax);
  const k = KIND[kind];
  // Allocation ids to the millisecond (a new plan in the same minute must not collide with
  // the one it replaces); ADD / ROTATION ids per day (one each per day).
  const stamp = kind === 'ALLOCATION' ? new Date(now).toISOString().slice(0, 23) : new Date(now).toISOString().slice(0, 10);
  return {
    candidate: {
      id: `${PILOT_STRATEGY_ID}:${kind === 'ALLOCATION' ? 'BUY' : kind}:${asset}:${idTag || stamp}`,
      asset, market: marketOf(asset), strategyId: PILOT_STRATEGY_ID, setupType: k.setupType, pilotKind: kind, direction: 'long', timeframe: '1D',
      tradeType: 'Core holding', expectedDuration: 'Long-term (months; T1 trims 35%, T2 is the macro runner)',
      fractional: true, // the risk engine sizes stocks to 0.0001 share
      maxNotional: amount, // the dollar amount: the risk engine never buys more
      entryZone: { min: round(price), max: entryMax },
      invalidation,
      targets: [{ level: 1, price: t1, allocation: CONFIG.t1Share }, { level: 2, price: t2, allocation: 1 - CONFIG.t1Share }],
      catalyst: { type: 'allocation', headline: null, sentimentScore: 0 },
      thesis: `Portfolio Pilot (${k.verb}): $${amount.toFixed(2)} into ${asset}. ${why} Stop ${invalidation} (${(pct * 100).toFixed(1)}% below entry, ${basis}; ATR${CONFIG.atrDays} ${round(a)}). `
        + `T1 ${t1} (${CONFIG.t1R}R) sells ${CONFIG.t1Share * 100}%; T2 ${t2} (${CONFIG.t2R}R) is the macro runner. `
        + `${res ? `Nearest daily resistance ${round(res.price)} (${res.kind}).` : 'No daily resistance overhead in the loaded history.'}`,
      confirmationCriteria: [`Buy up to $${amount.toFixed(2)} in fractional units`, `Stop ${(pct * 100).toFixed(1)}% below entry (${basis}); range ${CONFIG.minStopPct * 100}-${CONFIG.maxStopPct * 100}%`,
        `T1 ${CONFIG.t1R}R (${CONFIG.t1Share * 100}%) / T2 ${CONFIG.t2R}R; the risk engine may size smaller (risk profile, capital cap)`],
      timestamp: new Date(now).toISOString(),
    },
  };
}

// One buy per allocation recommendation with money to spend: { candidates, skipped }.
async function buyCandidates(allocation, now = Date.now()) {
  const candidates = [];
  const skipped = [];
  for (const r of allocation.recommendations) {
    if (!(r.recommendedBuyAmount > 0)) continue;
    const why = `Rank #${r.rank} of the trend ranker (${r.reason}); ${(r.currentWeight * 100).toFixed(1)}% of pilot holdings now, ${(r.targetWeight * 100).toFixed(1)}% after.`;
    const b = await buildBuy({ asset: r.asset, price: r.live ? r.price : null, amount: r.recommendedBuyAmount, kind: 'ALLOCATION', why }, now);
    if (b.skip) skipped.push({ asset: r.asset, reason: r.live ? b.skip : 'No live price (not on the live stream right now)' });
    else candidates.push(b.candidate);
  }
  return { candidates, skipped };
}

module.exports = { buildBuy, buyCandidates, CONFIG };
