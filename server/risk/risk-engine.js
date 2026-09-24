// Risk engine: the only path from a strategy's Candidate to a stageable order.
// Sizes the position from bankroll risk, then runs it through the cost gate.
// Approved results are frozen and registered, so the ledger can refuse anything
// that did not come through here.
//   stocks/crypto: size = risk budget / (entry - stop), capped by bankroll notional
//   options:       size = floor(risk budget / (debit x multiplier)) contracts;
//                  max loss is the debit paid, so dollarRisk = contracts x debit x multiplier
const { evaluateCosts } = require('./cost-authority');

const DEFAULT_RISK_PCT = 0.01; // 1% of bankroll per trade
const DEFAULT_MAX_LEVERAGE = 1; // cash account: notional may not exceed bankroll
const MARKETS = ['crypto', 'stocks', 'options'];
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

// Options (long premium): the most that can be lost is the debit paid.
function sizeOptions(candidate, riskBudget) {
  const { debit, multiplier } = candidate.optionsData;
  const costPerContract = debit * multiplier;
  const positionSize = Math.floor(riskBudget / costPerContract);
  if (positionSize < 1) {
    return { error: `Bankroll too small: one contract risks $${costPerContract.toFixed(2)}, budget is $${riskBudget.toFixed(2)}` };
  }
  const premium = positionSize * costPerContract;
  return { positionSize, dollarRisk: premium, notional: premium, cappedByNotional: false };
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
    ? sizeOptions(candidate, riskBudget)
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

module.exports = { processCandidate, isApproved, DEFAULT_RISK_PCT };
