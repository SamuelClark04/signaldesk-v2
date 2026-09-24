// Cost gate: rejects any sized candidate whose estimated round-trip costs
// (fees + spread/slippage) exceed MAX_FEE_DRAG of the trade's dollar risk (1R).
// Pure functions only: no state, no I/O.

// Round-trip cost as a fraction of position notional.
const ROUND_TRIP_COST_RATE = {
  crypto: 0.0264, // taker fees + spread, both legs
  stocks: 0.0010, // slippage, both legs
};

// Options are costed per contract, not per notional: flat fees + slippage, both legs.
const OPTIONS_ROUND_TRIP_PER_CONTRACT = 3.00;

const MAX_FEE_DRAG = Number(process.env.MAX_COST_R) || 0.35;

function getRoundTripRate(market) {
  const rate = ROUND_TRIP_COST_RATE[market];
  if (rate === undefined) throw new Error(`cost-authority: unknown market "${market}"`);
  return rate;
}

// Round-trip cost in dollars for a sized position. The ledger uses the same
// function at close, so the gate and the journal never disagree on fees.
// For stocks/crypto, pass entry and exit prices; options ignore them.
function estimateRoundTripFees(market, positionSize, entryPrice, exitPrice = entryPrice) {
  if (market === 'options') return OPTIONS_ROUND_TRIP_PER_CONTRACT * positionSize;
  // Round-trip rate is split evenly across the entry and exit legs.
  return (getRoundTripRate(market) / 2) * positionSize * (entryPrice + exitPrice);
}

// candidate must already be sized: { market, positionSize, entryPrice }.
function evaluateCosts(candidate, dollarRisk) {
  if (!(dollarRisk > 0)) {
    return { approved: false, reason: 'Invalid dollar risk', feeDrag: null };
  }
  if (candidate.market !== 'options' && ROUND_TRIP_COST_RATE[candidate.market] === undefined) {
    return { approved: false, reason: `Unknown market: ${candidate.market}`, feeDrag: null };
  }

  const estimatedFees = estimateRoundTripFees(candidate.market, candidate.positionSize, candidate.entryPrice);
  const feeDrag = estimatedFees / dollarRisk;

  if (feeDrag > MAX_FEE_DRAG) {
    return { approved: false, reason: 'Cost ceiling exceeded', feeDrag, estimatedFees };
  }
  return { approved: true, feeDrag, estimatedFees };
}

module.exports = {
  evaluateCosts,
  estimateRoundTripFees,
  getRoundTripRate,
  MAX_FEE_DRAG,
  OPTIONS_ROUND_TRIP_PER_CONTRACT,
};
