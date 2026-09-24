// Risk engine: the only path from a strategy's Candidate to a stageable order.
// Sizes the position from bankroll risk, then runs it through the cost gate.
// Approved results are frozen and registered, so the ledger can refuse anything
// that did not come through here.
//   stocks/crypto: size = min(risk budget / (entry - stop), MAX_CAPITAL_ALLOCATION x bankroll / entry)
//   options:       real contracts carry riskPerShare = ask paid - the bid the
//                  option is modelled to fetch at the underlying stop, so
//                  size = floor(risk budget / (riskPerShare x multiplier)) contracts,
//                  also capped so the WHOLE premium (the loss if the stop is gapped
//                  or the option decays to zero) is at most MAX_PREMIUM_R x budget.
//                  Without riskPerShare, the whole debit is the risk (old setups).
//                  1-Contract Small-Account Cap: contracts are whole, so when the
//                  budget rounds to 0 contracts, ONE is allowed if its risk to the
//                  stop is at most SMALL_ACCOUNT.maxRiskPct (5.5%) of the bankroll
//                  and its whole debit at most SMALL_ACCOUNT.maxDebitPct (12%);
//                  tagged smallAccountCap so the user sees the real dollar risk.
const { evaluateCosts } = require('./cost-authority');

const DEFAULT_RISK_PCT = 0.01; // 1% of bankroll per trade
const DEFAULT_MAX_LEVERAGE = 1; // cash account: notional may not exceed bankroll
const MARKETS = ['crypto', 'stocks', 'options'];
const MAX_PREMIUM_R = 3; // full-premium loss capped at 3x the per-trade risk budget
const SMALL_ACCOUNT = Object.freeze({ maxRiskPct: 0.055, maxDebitPct: 0.12, label: '1-Contract Small-Account Cap' });
// Capital cap: no single position may tie up more than this share of the
// bankroll (notional for stocks/crypto, premium for options), however tight the
// stop. Risk-based size first, then min(risk size, cap size); when the cap
// binds, the order carries capitalCapped + the risk % it actually takes.
// Speculative Moonshots (System 6, candidate.speculative): "smart" micro-sizing.
// The risk budget is only 10% to 25% of the profile's normal budget, scaled by
// the setup's conviction (0-1: sentiment strength + volume surge), so a failed
// hype trade costs a fraction of a normal loss. Every other gate applies as usual.
const SPECULATIVE_SCALE = { min: 0.10, max: 0.25 };
const speculativeScale = (c) => {
  const k = Number.isFinite(c.conviction) ? Math.max(0, Math.min(1, c.conviction)) : 0;
  return SPECULATIVE_SCALE.min + (SPECULATIVE_SCALE.max - SPECULATIVE_SCALE.min) * k;
};
const MAX_CAPITAL_ALLOCATION = (() => {
  const v = Number(process.env.MAX_CAPITAL_ALLOCATION);
  return v > 0 && v <= 1 ? v : 0.25;
})();
const approvedOrders = new WeakSet();

function reject(candidate, reason, extra = {}) {
  return { approved: false, candidateId: candidate && candidate.id, reason, ...extra };
}

function validate(c) {
  if (!c || !c.id || !c.asset) return 'Missing id or asset';
  if (!MARKETS.includes(c.market)) return `Unknown market: ${c.market}`;
  if (!['long', 'short'].includes(c.direction)) return `Unknown direction: ${c.direction}`;
  if (!c.entryZone || !(c.entryZone.min > 0) || !(c.entryZone.max >= c.entryZone.min)) {
    return 'Invalid entryZone';
  }
  if (!(c.invalidation > 0)) return 'Invalid invalidation price';
  if (c.market === 'options') {
    const o = c.optionsData;
    if (!o || !(o.debit > 0) || !(o.multiplier > 0)) return 'Options candidate needs optionsData.debit and multiplier';
    if (o.riskPerShare !== undefined && !(o.riskPerShare > 0 && o.riskPerShare <= o.debit)) return 'Options riskPerShare must be > 0 and at most the debit';
  }
  return null;
}

// Worst-case fill inside the entry zone: top of zone for longs, bottom for shorts.
function worstCaseEntry(c) {
  return c.direction === 'short' ? c.entryZone.min : c.entryZone.max;
}

// Stocks trade in whole shares, or to 0.0001 share for fractional candidates
// (Portfolio Pilot buys: a $150 slice of SPY); crypto to 8 decimals. Always
// round down so actual risk never exceeds the budget.
function roundSize(size, market, fractional = false) {
  if (market === 'stocks') return fractional ? Math.floor(size * 1e4 + 1e-9) / 1e4 : Math.floor(size);
  return Math.floor(size * 1e8) / 1e8;
}

// Linear instruments: risk is the distance from entry to the invalidation level.
// candidate.maxNotional (optional, e.g. a Portfolio Pilot buy of a set dollar
// amount) is a third ceiling: it only ever makes a position smaller.
function sizeLinear(candidate, bankroll, riskBudget, maxLeverage, entryPrice, stopDistance) {
  const bySize = riskBudget / stopDistance; // risk-based size
  const byCapital = (bankroll * Math.min(maxLeverage, MAX_CAPITAL_ALLOCATION)) / entryPrice; // capital cap
  const byAmount = candidate.maxNotional > 0 ? candidate.maxNotional / entryPrice : Infinity;
  const positionSize = roundSize(Math.min(bySize, byCapital, byAmount), candidate.market, !!candidate.fractional);
  if (!(positionSize > 0)) return { error: 'Position size rounds to zero' };
  return {
    positionSize,
    dollarRisk: positionSize * stopDistance, // actual risk after rounding and the caps
    notional: positionSize * entryPrice,
    cappedByNotional: byCapital < bySize && byCapital <= byAmount,
    cappedByAmount: byAmount < Math.min(bySize, byCapital),
  };
}

// Options (long premium), sized on the real premium: risk to the stop per
// contract, and the whole premium capped at MAX_PREMIUM_R budgets and the bankroll.
function sizeOptions(candidate, riskBudget, bankroll, maxLeverage) {
  const { debit, multiplier, riskPerShare } = candidate.optionsData;
  const premiumPerContract = debit * multiplier;
  const riskPerContract = (riskPerShare || debit) * multiplier;
  const byRisk = Math.floor(riskBudget / riskPerContract);
  const byPremium = Math.floor(Math.min(riskBudget * MAX_PREMIUM_R, bankroll * Math.min(maxLeverage, MAX_CAPITAL_ALLOCATION)) / premiumPerContract);
  const positionSize = Math.min(byRisk, byPremium);
  if (positionSize < 1 && riskPerContract <= SMALL_ACCOUNT.maxRiskPct * bankroll && premiumPerContract <= SMALL_ACCOUNT.maxDebitPct * bankroll) {
    return { positionSize: 1, dollarRisk: riskPerContract, notional: premiumPerContract, cappedByNotional: false, smallAccountCap: true };
  }
  if (positionSize < 1) {
    return { error: byRisk < 1
      ? `Bankroll too small: one contract risks $${riskPerContract.toFixed(2)} to the stop, budget is $${riskBudget.toFixed(2)} `
        + `(1-contract cap: risk <= ${SMALL_ACCOUNT.maxRiskPct * 100}% and debit <= ${SMALL_ACCOUNT.maxDebitPct * 100}% of the bankroll)`
      : `Bankroll too small: one contract's premium $${premiumPerContract.toFixed(2)} exceeds ${MAX_PREMIUM_R}x the $${riskBudget.toFixed(2)} risk budget or ${MAX_CAPITAL_ALLOCATION * 100}% of the bankroll` };
  }
  return { positionSize, dollarRisk: positionSize * riskPerContract, notional: positionSize * premiumPerContract, cappedByNotional: byPremium < byRisk };
}

function processCandidate(candidate, configuredBankroll, options = {}) {
  const problem = validate(candidate);
  if (problem) return reject(candidate, problem);
  if (!(configuredBankroll > 0)) return reject(candidate, 'Invalid bankroll');

  const riskPct = options.riskPct || DEFAULT_RISK_PCT;
  const maxLeverage = options.maxLeverage || DEFAULT_MAX_LEVERAGE;
  const { direction } = candidate;
  const entryPrice = worstCaseEntry(candidate);
  const stopDistance = direction === 'long'
    ? entryPrice - candidate.invalidation
    : candidate.invalidation - entryPrice;
  if (!(stopDistance > 0)) return reject(candidate, 'Invalidation is on the wrong side of entry');

  const scale = candidate.speculative ? speculativeScale(candidate) : 1;
  const riskBudget = configuredBankroll * riskPct * scale;
  const sizing = candidate.market === 'options'
    ? sizeOptions(candidate, riskBudget, configuredBankroll, maxLeverage)
    : sizeLinear(candidate, configuredBankroll, riskBudget, maxLeverage, entryPrice, stopDistance);
  if (sizing.error) return reject(candidate, sizing.error);

  const { positionSize, dollarRisk } = sizing;
  // Entry leg liquidity (cost-authority.js): a strategy's resting limit inside
  // its zone is maker on PAPER and on live Coinbase (a post-only limit entry,
  // coinbase-api.js); anything else (e.g. live Alpaca market entries) is taker.
  const basis = options.sizingBasis || 'paper';
  const entryLiquidity = candidate.entryLiquidity === 'maker' && (basis === 'paper' || basis === 'coinbase-live') ? 'maker' : 'taker';
  const sized = { ...candidate, entryPrice, positionSize, dollarRisk, entryLiquidity };

  const cost = evaluateCosts(sized, dollarRisk);
  if (!cost.approved) return reject(candidate, cost.reason, { feeDrag: cost.feeDrag });

  const approved = Object.freeze({
    ...sized,
    approved: true,
    stopDistance,
    notional: sizing.notional,
    riskPct,
    ...(candidate.speculative ? { speculativeScale: scale, speculativeRiskPct: riskPct * scale } : {}),
    // One contract above the profile budget (options on a small account): shown to the user as such.
    ...(sizing.smallAccountCap ? { smallAccountCap: true, smallAccountLabel: SMALL_ACCOUNT.label, budgetRisk: riskBudget } : {}),
    // What it was sized against: the approval step refuses a LIVE execution of
    // an order that was not sized from that live account (venue-capital.js).
    sizingBankroll: configuredBankroll,
    sizingBasis: options.sizingBasis || 'paper',
    cappedByNotional: sizing.cappedByNotional,
    cappedByAmount: !!sizing.cappedByAmount, // sized to the requested dollar amount (Pilot buys)
    // Capital cap bound: the trade risks less than the profile's target %.
    capitalCapped: sizing.cappedByNotional,
    capitalCapPct: MAX_CAPITAL_ALLOCATION,
    actualRiskPct: dollarRisk / configuredBankroll,
    feeDrag: cost.feeDrag,
    estimatedFees: cost.estimatedFees,
    approvedAt: Date.now(),
  });
  approvedOrders.add(approved);
  return approved;
}

function isApproved(order) {
  return approvedOrders.has(order);
}

module.exports = { processCandidate, isApproved, DEFAULT_RISK_PCT, MAX_PREMIUM_R, MAX_CAPITAL_ALLOCATION, SPECULATIVE_SCALE, SMALL_ACCOUNT };
