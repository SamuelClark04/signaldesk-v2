// Strategy 4: Portfolio Pilot, "What to Buy" allocator.
// PROPOSER ONLY: pure math over positions, prices and the Trend Ranker's list
// (pilot-ranker.js). Never stages or executes. Buy-only: nothing is sold here
// (selling is the matrix's job: pilot-matrix.js).
// A deposit is split across the top MAX_LEADERS ranked leaders that are
// qualified (above their 200-day SMA), not extended (> 18% over the 50-day), and
// still under the CONCENTRATION_CAP (30%) of pilot holdings + deposit, in
// proportion to their trend score; a leader that would pass the cap is filled to
// it and the rest flows to the others. When swing setups from the scanners are
// already waiting in Approvals, up to SWING_RESERVE (20%) of the deposit is kept
// for them (they are sized by the risk engine when approved). What cannot be
// placed within the cap stays cash (unallocated), never forced into one asset.
const PILOT_STRATEGY_ID = 'portfolio-pilot';
const CONCENTRATION_CAP = 0.30;
const MAX_LEADERS = 4;
const SWING_RESERVE = 0.20;

const cents = (x) => Math.floor(x * 100) / 100; // round down: never recommend more than the deposit

function priceLookup(latestPricesMap) {
  return (asset) => (latestPricesMap instanceof Map ? latestPricesMap.get(asset) : latestPricesMap && latestPricesMap[asset]);
}

// Market value per asset of the long-term portfolio: the pilot's OWN paper
// holdings (swing / day trades are not the long-term portfolio) plus, by the
// venue scope the pilot handler passes, real holdings flagged countsAsHolding
// (SignalDesk's LIVE trades, manual Robinhood / other and broker-synced ones).
// Longs only; no fresh price = valued at the fill (average cost).
function valueHoldings(activePositions, priceOf) {
  const values = new Map();
  const notes = [];
  const own = activePositions.filter((p) => (p.strategyId === PILOT_STRATEGY_ID || p.countsAsHolding) && p.direction !== 'short' && p.market !== 'options');
  const ignored = activePositions.length - own.length;
  if (ignored) notes.push(`${ignored} paper position(s) from other strategies not counted (long-term holdings only)`);
  const outside = own.filter((p) => p.execution === 'EXTERNAL');
  if (outside.length) notes.push(`Counted outside SignalDesk: ${outside.map((p) => `${p.asset} (${p.broker})`).join(', ')}`);
  for (const p of own) {
    let price = priceOf(p.asset);
    if (!(price > 0)) { price = p.fillPrice; notes.push(`${p.asset} has no fresh price; valued at its fill price ${p.fillPrice}`); }
    values.set(p.asset, (values.get(p.asset) || 0) + p.positionSize * price);
  }
  return { values, notes };
}

// Swing setups waiting in Approvals that deserve part of the deposit (best 2 by reward).
function swingSetups(pending) {
  return (pending || []).filter((o) => o.strategyId !== PILOT_STRATEGY_ID && o.direction === 'long' && ['stocks', 'crypto'].includes(o.market))
    .map((o) => ({ id: o.id, asset: o.asset, setupType: o.setupType, notional: o.notional || 0, r: o.scenarios && (o.scenarios.plan || o.scenarios.t1) ? (o.scenarios.plan || o.scenarios.t1).r : 0 }))
    .sort((a, b) => b.r - a.r).slice(0, 2);
}

// deposit: dollars; ranking: pilot-ranker rankUniverse() rows; pending: staged orders;
// exiting: assets with a pending Pilot SELL / TRIM (never bought while being sold).
function calculateAllocation(depositAmount, activePositions, latestPricesMap, ranking, pending = [], exiting = new Set()) {
  const deposit = Number(depositAmount);
  if (!Number.isFinite(deposit) || deposit <= 0) throw new Error('Deposit amount must be a positive number');
  if (!Array.isArray(ranking)) throw new Error('No trend ranking available yet');
  const priceOf = priceLookup(latestPricesMap);
  const { values, notes } = valueHoldings(activePositions || [], priceOf);
  const portfolioValue = [...values.values()].reduce((s, v) => s + v, 0);
  const newTotal = portfolioValue + deposit;

  const swing = swingSetups(pending);
  const reserve = cents(Math.min(SWING_RESERVE * deposit, swing.reduce((s, x) => s + x.notional, 0)));
  const budget = deposit - reserve;
  if (reserve > 0) notes.push(`$${reserve.toFixed(2)} kept for ${swing.length} swing setup(s) waiting in Approvals`);

  const room = (asset) => Math.max(0, CONCENTRATION_CAP * newTotal - (values.get(asset) || 0));
  // Only assets with a LIVE price can be approved (the order guard refuses stale ones).
  const eligible = ranking.filter((r) => r.qualified && !r.extended && r.live && r.price > 0 && !exiting.has(r.asset));
  const selling = ranking.filter((r) => exiting.has(r.asset)).map((r) => r.asset);
  if (selling.length) notes.push(`Not bought while a Pilot sell / trim for it waits in Approvals: ${selling.join(', ')}`);
  const quiet = ranking.filter((r) => r.qualified && !r.extended && !r.live).slice(0, 4).map((r) => r.asset);
  if (quiet.length) notes.push(`Ranked but no live price right now (market closed or not streamed), so not bought this time: ${quiet.join(', ')}`);
  const picks = eligible.filter((r) => room(r.asset) >= 1).slice(0, MAX_LEADERS);
  const full = eligible.filter((r) => room(r.asset) < 1).map((r) => r.asset);
  if (full.length) notes.push(`At the ${CONCENTRATION_CAP * 100}% cap already: ${full.join(', ')}`);
  const extended = ranking.filter((r) => r.qualified && r.extended).map((r) => r.asset);
  if (extended.length) notes.push(`Above their 200-day SMA but more than 18% over the 50-day (not chased): ${extended.join(', ')}`);

  // Score-weighted split, capped per asset; overflow goes to the uncapped picks.
  const amount = new Map(picks.map((r) => [r.asset, 0]));
  let left = budget;
  let open = picks.slice();
  while (left > 0.01 && open.length) {
    const total = open.reduce((s, r) => s + Math.max(1, r.score), 0);
    let spent = 0;
    const next = [];
    for (const r of open) {
      const want = (left * Math.max(1, r.score)) / total;
      const cap = room(r.asset) - amount.get(r.asset);
      const give = Math.min(want, cap);
      amount.set(r.asset, amount.get(r.asset) + give);
      spent += give;
      if (cap - give > 0.01) next.push(r);
    }
    left -= spent;
    if (spent < 0.01) break;
    open = next;
  }

  const recommendations = picks.map((r, i) => {
    const currentValue = values.get(r.asset) || 0;
    const recommendedBuyAmount = cents(amount.get(r.asset));
    return { asset: r.asset, rank: i + 1, score: r.score, reason: r.reason, currentValue, currentWeight: portfolioValue > 0 ? currentValue / portfolioValue : 0,
      targetWeight: (currentValue + recommendedBuyAmount) / newTotal, recommendedBuyAmount, price: r.price, live: r.live, estimatedUnits: recommendedBuyAmount / r.price };
  });
  const allocated = recommendations.reduce((s, r) => s + r.recommendedBuyAmount, 0) + reserve;
  const unallocated = Math.max(0, Math.round((deposit - allocated) * 100) / 100);
  if (unallocated > 0.01) notes.push(`$${unallocated.toFixed(2)} stays cash: ${picks.length} leader(s) qualify and none may pass ${CONCENTRATION_CAP * 100}% of the portfolio`);
  const nonModel = [...values.keys()].filter((a) => !ranking.some((r) => r.asset === a));
  if (nonModel.length) notes.push(`Held but outside the ranked universe: ${nonModel.join(', ')}`);
  return {
    deposit, portfolioValue, newTotal, reserve, swing, unallocated, recommendations, notes, cap: CONCENTRATION_CAP,
    ranking: ranking.map((r) => ({ asset: r.asset, qualified: r.qualified, score: r.score, extended: !!r.extended, reason: r.reason, price: r.price })),
  };
}

module.exports = { calculateAllocation, valueHoldings, PILOT_STRATEGY_ID, CONCENTRATION_CAP, MAX_LEADERS, SWING_RESERVE };
