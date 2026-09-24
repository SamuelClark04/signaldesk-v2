// Cost gate: rejects any sized candidate whose estimated round-trip costs
// (fees + spread/slippage) exceed MAX_FEE_DRAG of the trade's dollar risk (1R).
// Pure functions only: no state, no I/O.

// Crypto costs come from the user's Coinbase Advanced fee tier (.env). Defaults:
// the Intro tier (< $10K 30-day volume), as filled in the user's order history:
//   COINBASE_MAKER_FEE      resting limit orders (0.006 = 0.60%: post-only entries, T1 limits)
//   COINBASE_TAKER_FEE      orders that cross the spread (0.012 = 1.20%: stops, market exits)
//   COINBASE_SPREAD_BUFFER  spread/slippage allowance for a TAKER leg (default 0.001)
// Legs are costed by how they really execute:
//   entry   maker when the strategy rests a limit inside its entry zone
//           (candidate.entryLiquidity = 'maker'), on paper AND live: live
//           Coinbase sends it as a post-only limit at the bid (coinbase-api.js),
//           which Coinbase refuses rather than fill as taker; otherwise taker
//   target  a resting limit sell (the live bracket's take-profit leg): maker
//   stop    a triggered stop crosses the spread: taker + spread buffer
// The gate's exit leg is the average of the target (maker) and stop (taker)
// outcomes: a trade ends at one or the other. A missing or invalid value falls
// back to the conservative defaults below (overstating costs is safe).
const DEFAULT_MAKER_FEE = 0.006; // Intro tier (< $10K), verified from filled orders (24 Sep 2026)
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
// Never above the taker rate (a maker leg cannot cost more than crossing the spread).
const COINBASE_MAKER_FEE = Math.min(COINBASE_TAKER_FEE, feeFromEnv('COINBASE_MAKER_FEE', DEFAULT_MAKER_FEE, 0.05));
const COINBASE_SPREAD_BUFFER = feeFromEnv('COINBASE_SPREAD_BUFFER', DEFAULT_SPREAD_BUFFER, 0.02);

// Cost of one leg as a fraction of that leg's notional.
const LEG_RATE = {
  crypto: { maker: COINBASE_MAKER_FEE, taker: COINBASE_TAKER_FEE + COINBASE_SPREAD_BUFFER },
  stocks: { maker: 0.0005, taker: 0.0005 }, // slippage per leg (no commission)
};

// Options are costed per contract. Alpaca charges no options commission; this
// covers the pass-through regulatory/clearing fees, both legs (conservative),
// per option leg (a vertical spread has two). The bid/ask spread is NOT in here:
// contracts are bought at the ask and valued at the bid (option-pricing.js), so
// the spread is already in P/L. The cost gate adds it on top (evaluateCosts).
const OPTIONS_ROUND_TRIP_PER_CONTRACT = 0.20;

const MAX_FEE_DRAG = Number(process.env.MAX_COST_R) || 0.35;

function legRate(market, liquidity = 'taker') {
  const rates = LEG_RATE[market];
  if (!rates) throw new Error(`cost-authority: unknown market "${market}"`);
  return liquidity === 'maker' ? rates.maker : rates.taker;
}

// All-taker round trip (the conservative rate: marks, manual closes, System 6).
const getRoundTripRate = (market) => 2 * legRate(market, 'taker');

// The gate's blended round trip: entry leg + the average of a target (maker)
// and a stop (taker) exit.
const blendedRoundTripRate = (market, entryLiquidity = 'taker') =>
  legRate(market, entryLiquidity) + (legRate(market, 'maker') + legRate(market, 'taker')) / 2;

// Tightest stop (fraction of entry) whose blended costs stay within `budget` R,
// rounded UP to 0.1%. Crypto with a maker entry at the Intro tier: 0.60% +
// (0.60% maker T1 + 1.30% taker stop incl. spread) / 2 = 1.55% round trip
// -> 4.6% stop (paper and live), fee drag 0.337R <= 0.35R.
const minStopPct = (market, entryLiquidity, budget = 0.34) =>
  Math.ceil((blendedRoundTripRate(market, entryLiquidity) / budget) * 1000 - 1e-9) / 1000;

// Round-trip cost in dollars for a sized position. The ledger uses the same
// function at close, so the gate and the journal never disagree on fees.
// legs: { entry, exit } liquidity ('maker' | 'taker'; default taker both), or
// for options { optionLegs } (contracts per spread); stocks/crypto need prices.
function estimateRoundTripFees(market, positionSize, entryPrice, exitPrice = entryPrice, legs = {}) {
  if (market === 'options') return OPTIONS_ROUND_TRIP_PER_CONTRACT * positionSize * (legs.optionLegs || 1);
  return positionSize * (legRate(market, legs.entry) * entryPrice + legRate(market, legs.exit) * exitPrice);
}

// candidate must already be sized: { market, positionSize, entryPrice, entryLiquidity? }.
function evaluateCosts(candidate, dollarRisk) {
  if (!(dollarRisk > 0)) {
    return { approved: false, reason: 'Invalid dollar risk', feeDrag: null };
  }
  if (candidate.market !== 'options' && LEG_RATE[candidate.market] === undefined) {
    return { approved: false, reason: `Unknown market: ${candidate.market}`, feeDrag: null };
  }

  // Options with a real quote: the round-trip spread cost (buy at the ask, sell
  // at the bid; for a spread, the net ask less the net bid) counts against 1R.
  const od = candidate.market === 'options' ? candidate.optionsData : null;
  const spreadCost = od && od.ask > od.bid && od.bid > 0 ? (od.ask - od.bid) * od.multiplier * candidate.positionSize : 0;
  const estimatedFees = (od
    ? estimateRoundTripFees('options', candidate.positionSize, 0, 0, { optionLegs: (od.legs || []).length || 1 })
    : candidate.positionSize * candidate.entryPrice * blendedRoundTripRate(candidate.market, candidate.entryLiquidity)) + spreadCost;
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
  blendedRoundTripRate,
  legRate,
  minStopPct,
  MAX_FEE_DRAG,
  COINBASE_MAKER_FEE,
  COINBASE_TAKER_FEE,
  COINBASE_SPREAD_BUFFER,
  OPTIONS_ROUND_TRIP_PER_CONTRACT,
};
