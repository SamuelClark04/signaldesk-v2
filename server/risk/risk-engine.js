// Risk engine: the only path from a strategy's Candidate to a stageable order.
// Sizes the position from bankroll risk, then runs it through the cost gate.
// Approved results are frozen and registered, so the ledger can refuse anything
// that did not come through here.
//   stocks/crypto: size = risk budget / (entry - stop), capped by bankroll notional
//   options:       real contracts carry riskPerShare = ask paid - the bid the
//                  option is modelled to fetch at the underlying stop, so
//                  size = floor(risk budget / (riskPerShare x multiplier)) contracts,
//                  also capped so the WHOLE premium (the loss if the stop is gapped
//                  or the option decays to zero) is at most MAX_PREMIUM_R x budget.
//                  Without riskPerShare, the whole debit is the risk (old setups).
const { evaluateCosts } = require('./cost-authority');

const DEFAULT_RISK_PCT = 0.01; // 1% of bankroll per trade
const DEFAULT_MAX_LEVERAGE = 1; // cash account: notional may not exceed bankroll
const MARKETS = ['crypto', 'stocks', 'options'];
const MAX_PREMIUM_R = 3; // full-premium loss capped at 3x the per-trade risk budget
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

// Stocks trade in whole shares; crypto to 8 decimals. Always round down so
// actual risk never exceeds the budget.
function roundSize(size, market) {
  return market === 'stocks' ? Math.floor(size) : Math.floor(size * 1e8) / 1e8;
}

// Linear instruments: risk is the distance from entry to the invalidation level.
function sizeLinear(candidate, bankroll, riskBudget, maxLeverage, entryPrice, stopDistance) {
  const maxSizeByNotional = (bankroll * maxLeverage) / entryPrice;
  const rawSize = Math.min(riskBudget / stopDistance, maxSizeByNotional);
  const positionSize = roundSize(rawSize, candidate.market);
  if (!(positionSize > 0)) return { error: 'Position size rounds to zero' };
  return {
    positionSize,
    dollarRisk: positionSize * stopDistance, // actual risk after rounding and the notional cap
    notional: positionSize * entryPrice,
    cappedByNotional: rawSize < riskBudget / stopDistance,
  };
}

// Options (long premium), sized on the real premium: risk to the stop per
// contract, and the whole premium capped at MAX_PREMIUM_R budgets and the bankroll.
function sizeOptions(candidate, riskBudget, bankroll, maxLeverage) {
  const { debit, multiplier, riskPerShare } = candidate.optionsData;
  const premiumPerContract = debit * multiplier;
  const riskPerContract = (riskPerShare || debit) * multiplier;
  const byRisk = Math.floor(riskBudget / riskPerContract);
  const byPremium = Math.floor(Math.min(riskBudget * MAX_PREMIUM_R, bankroll * maxLeverage) / premiumPerContract);
  const positionSize = Math.min(byRisk, byPremium);
  if (positionSize < 1) {
    return { error: byRisk < 1
      ? `Bankroll too small: one contract risks $${riskPerContract.toFixed(2)} to the stop, budget is $${riskBudget.toFixed(2)}`
      : `Bankroll too small: one contract's premium $${premiumPerContract.toFixed(2)} exceeds ${MAX_PREMIUM_R}x the $${riskBudget.toFixed(2)} risk budget` };
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

  const riskBudget = configuredBankroll * riskPct;
  const sizing = candidate.market === 'options'
    ? sizeOptions(candidate, riskBudget, configuredBankroll, maxLeverage)
    : sizeLinear(candidate, configuredBankroll, riskBudget, maxLeverage, entryPrice, stopDistance);
  if (sizing.error) return reject(candidate, sizing.error);

  const { positionSize, dollarRisk } = sizing;
  const sized = { ...candidate, entryPrice, positionSize, dollarRisk };

  const cost = evaluateCosts(sized, dollarRisk);
  if (!cost.approved) return reject(candidate, cost.reason, { feeDrag: cost.feeDrag });

  const approved = Object.freeze({
    ...sized,
    approved: true,
    stopDistance,
    notional: sizing.notional,
    riskPct,
    // What it was sized against: the approval step refuses a LIVE execution of
    // an order that was not sized from that live account (venue-capital.js).
    sizingBankroll: configuredBankroll,
    sizingBasis: options.sizingBasis || 'paper',
    cappedByNotional: sizing.cappedByNotional,
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

module.exports = { processCandidate, isApproved, DEFAULT_RISK_PCT, MAX_PREMIUM_R };
