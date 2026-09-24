// Cost gate: rejects any sized candidate whose estimated round-trip costs
// (fees + spread/slippage) exceed MAX_FEE_DRAG of the trade's dollar risk (1R).
// Pure functions only: no state, no I/O.

// Round-trip cost as a fraction of position notional.
const ROUND_TRIP_COST_RATE = {
  crypto: 0.0264, // taker fees + spread, both legs
  stocks: 0.0010, // slippage, both legs
};

const MAX_FEE_DRAG = Number(process.env.MAX_COST_R) || 0.35;

function getRoundTripRate(market) {
  const rate = ROUND_TRIP_COST_RATE[market];
  if (rate === undefined) throw new Error(`cost-authority: unknown market "${market}"`);
  return rate;
}

// candidate must already be sized: { market, positionSize, entryPrice }.
function evaluateCosts(candidate, dollarRisk) {
  if (!(dollarRisk > 0)) {
    return { approved: false, reason: 'Invalid dollar risk', feeDrag: null };
  }
  if (ROUND_TRIP_COST_RATE[candidate.market] === undefined) {
    return { approved: false, reason: `Unknown market: ${candidate.market}`, feeDrag: null };
  }

  const notional = candidate.positionSize * candidate.entryPrice;
  const estimatedFees = notional * getRoundTripRate(candidate.market);
  const feeDrag = estimatedFees / dollarRisk;

  if (feeDrag > MAX_FEE_DRAG) {
    return { approved: false, reason: 'Cost ceiling exceeded', feeDrag, estimatedFees };
  }
  return { approved: true, feeDrag, estimatedFees };
}

module.exports = { evaluateCosts, getRoundTripRate, MAX_FEE_DRAG };
