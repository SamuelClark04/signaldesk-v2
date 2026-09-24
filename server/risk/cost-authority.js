// Cost gate: rejects any sized candidate whose estimated round-trip costs
// (fees + spread/slippage) exceed MAX_FEE_DRAG of the trade's dollar risk (1R).
// Pure functions only: no state, no I/O.

// Crypto costs come from the user's Coinbase Advanced fee tier (.env):
//   COINBASE_TAKER_FEE      taker fee per leg (Intro tier: 0.009 = 0.90%)
//   COINBASE_SPREAD_BUFFER  spread/slippage allowance per leg (default 0.001)
// Round trip = 2 x (taker + buffer): market-style entry and exit both pay taker.
// A missing or invalid value falls back to the conservative defaults below
// (overstating costs is safe; understating them is not).
const DEFAULT_TAKER_FEE = 0.012;
const DEFAULT_SPREAD_BUFFER = 0.001;

function feeFromEnv(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0 && v <= max) return v;
  console.warn(`[cost-authority] ${name}=${raw} is not a fraction between 0 and ${max}; using ${fallback}`);
  return fallback;
}

const COINBASE_TAKER_FEE = feeFromEnv('COINBASE_TAKER_FEE', DEFAULT_TAKER_FEE, 0.05);
const COINBASE_SPREAD_BUFFER = feeFromEnv('COINBASE_SPREAD_BUFFER', DEFAULT_SPREAD_BUFFER, 0.02);

// Round-trip cost as a fraction of position notional.
const ROUND_TRIP_COST_RATE = {
  crypto: 2 * (COINBASE_TAKER_FEE + COINBASE_SPREAD_BUFFER), // Intro tier: 2 x (0.90% + 0.10%) = 2.00%
  stocks: 0.0010, // slippage, both legs
};

// Options are costed per contract. Alpaca charges no options commission; this
// covers the pass-through regulatory/clearing fees, both legs (conservative).
// The bid/ask spread is NOT in here: real-contract setups are bought at the ask
// and valued at the bid (option-pricing.js), so the spread is already in P/L.
// The cost gate adds it on top (see evaluateCosts) to screen out wide markets.
const OPTIONS_ROUND_TRIP_PER_CONTRACT = 0.20;

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

  // Options with a real quote: the round-trip spread cost (buy at the ask, sell
  // at the bid) counts as a cost against 1R too, like slippage for crypto.
  const od = candidate.market === 'options' ? candidate.optionsData : null;
  const spreadCost = od && od.ask > od.bid && od.bid > 0 ? (od.ask - od.bid) * od.multiplier * candidate.positionSize : 0;
  const estimatedFees = estimateRoundTripFees(candidate.market, candidate.positionSize, candidate.entryPrice) + spreadCost;
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
  COINBASE_TAKER_FEE,
  COINBASE_SPREAD_BUFFER,
  OPTIONS_ROUND_TRIP_PER_CONTRACT,
};
