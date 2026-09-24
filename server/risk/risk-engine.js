// Risk engine: the only path from a strategy's Candidate to a stageable order.
// Sizes the position from bankroll risk, then runs it through the cost gate.
// Approved results are frozen and registered, so the ledger can refuse anything
// that did not come through here (resizeOrder's per-trade overrides included).
//   stocks/crypto: size = min(risk budget / (entry - stop), capital cap x bankroll / entry)
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
// Capital cap ("Max Capital Per Trade", Settings: options.maxCapitalPct, one of
// CAPITAL_CHOICES, default 10%): no single position may tie up more than this
// share of the bankroll (notional for stocks/crypto, premium for options),
// however tight the stop. Risk-based size first, then min(risk size, cap size);
// when the cap binds, the order carries capitalCapped + the risk % it actually takes.
// Speculative Moonshots (System 6, candidate.speculative): "smart" micro-sizing.
// The risk budget is only 10% to 25% of the profile's normal budget, scaled by
// the setup's conviction (0-1: sentiment strength + volume surge), so a failed
// hype trade costs a fraction of a normal loss. Every other gate applies as usual.
const SPECULATIVE_SCALE = { min: 0.10, max: 0.25 };
const speculativeScale = (c) => {
  const k = Number.isFinite(c.conviction) ? Math.max(0, Math.min(1, c.conviction)) : 0;
  return SPECULATIVE_SCALE.min + (SPECULATIVE_SCALE.max - SPECULATIVE_SCALE.min) * k;
};
const CAPITAL_CHOICES = Object.freeze([0.05, 0.10, 0.15, 0.25]);
const DEFAULT_MAX_CAPITAL_PCT = 0.10;
const capPctOf = (options) => (CAPITAL_CHOICES.includes(options.maxCapitalPct) ? options.maxCapitalPct : DEFAULT_MAX_CAPITAL_PCT);
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
function sizeLinear(candidate, bankroll, riskBudget, capPct, entryPrice, stopDistance) {
  const bySize = riskBudget / stopDistance; // risk-based size
  const byCapital = (bankroll * capPct) / entryPrice; // capital cap
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
function sizeOptions(candidate, riskBudget, bankroll, capPct) {
  const { debit, multiplier, riskPerShare } = candidate.optionsData;
  const premiumPerContract = debit * multiplier;
  const riskPerContract = (riskPerShare || debit) * multiplier;
  const byRisk = Math.floor(riskBudget / riskPerContract);
  const byPremium = Math.floor(Math.min(riskBudget * MAX_PREMIUM_R, bankroll * capPct) / premiumPerContract);
  const positionSize = Math.min(byRisk, byPremium);
  if (positionSize < 1 && riskPerContract <= SMALL_ACCOUNT.maxRiskPct * bankroll && premiumPerContract <= SMALL_ACCOUNT.maxDebitPct * bankroll) {
    return { positionSize: 1, dollarRisk: riskPerContract, notional: premiumPerContract, cappedByNotional: false, smallAccountCap: true };
  }
  if (positionSize < 1) {
    return { error: byRisk < 1
      ? `Bankroll too small: one contract risks $${riskPerContract.toFixed(2)} to the stop, budget is $${riskBudget.toFixed(2)} `
        + `(1-contract cap: risk <= ${SMALL_ACCOUNT.maxRiskPct * 100}% and debit <= ${SMALL_ACCOUNT.maxDebitPct * 100}% of the bankroll)`
      : `Bankroll too small: one contract's premium $${premiumPerContract.toFixed(2)} exceeds ${MAX_PREMIUM_R}x the $${riskBudget.toFixed(2)} risk budget or ${capPct * 100}% of the bankroll` };
  }
  return { positionSize, dollarRisk: positionSize * riskPerContract, notional: positionSize * premiumPerContract, cappedByNotional: byPremium < byRisk };
}

function processCandidate(candidate, configuredBankroll, options = {}) {
  const problem = validate(candidate);
  if (problem) return reject(candidate, problem);
  if (!(configuredBankroll > 0)) return reject(candidate, 'Invalid bankroll');

  const riskPct = options.riskPct || DEFAULT_RISK_PCT;
  const capPct = Math.min(options.maxLeverage || DEFAULT_MAX_LEVERAGE, capPctOf(options));
  const { direction } = candidate;
  const entryPrice = worstCaseEntry(candidate);
  const stopDistance = direction === 'long'
    ? entryPrice - candidate.invalidation
    : candidate.invalidation - entryPrice;
  if (!(stopDistance > 0)) return reject(candidate, 'Invalidation is on the wrong side of entry');

  const scale = candidate.speculative ? speculativeScale(candidate) : 1;
  const riskBudget = configuredBankroll * riskPct * scale;
  const sizing = candidate.market === 'options'
    ? sizeOptions(candidate, riskBudget, configuredBankroll, capPct)
    : sizeLinear(candidate, configuredBankroll, riskBudget, capPct, entryPrice, stopDistance);
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
    capitalCapPct: capPct,
    actualRiskPct: dollarRisk / configuredBankroll,
    feeDrag: cost.feeDrag,
    estimatedFees: cost.estimatedFees,
    approvedAt: Date.now(),
  });
  approvedOrders.add(approved);
  return approved;
}

// Per-trade "Trade Amount ($)" override (Setups / Approvals): the user's dollar
// amount for a STAGED order, applied on approval. Entry, stop and targets stay;
// only the quantity changes: amount / entry (stocks to whole shares, or 0.0001
// share when `fractional`; crypto to 8 decimals) or whole option contracts
// (amount / premium). Risk, fees and P&L are all linear in size, so they scale
// with it and the fee drag (R) is unchanged. Down to MIN_TRADE_USD (or one share
// / one contract) freely; ABOVE the risk engine's size (its max safe ceiling:
// risk budget + capital cap) only with `confirmed`, and never above the sizing
// bankroll (cash account). Returns a registered order, or { approved: false }.
const MIN_TRADE_USD = 1;
function resizeOrder(order, amount, { confirmed = false, fractional = false } = {}) {
  const dollars = Number(amount);
  if (!order || !(order.positionSize > 0)) return reject(order, 'INVALID_ORDER');
  if (!Number.isFinite(dollars) || dollars <= 0) return reject(order, 'AMOUNT_INVALID');
  const options = order.market === 'options';
  const perUnit = options ? order.optionsData.debit * order.optionsData.multiplier : order.entryPrice;
  const same = Math.abs(dollars - order.notional) < 0.005; // "Max": the risk engine's own size
  const qty = same ? order.positionSize : options ? Math.floor(dollars / perUnit + 1e-9) : roundSize(dollars / perUnit, order.market, fractional || !!order.fractional);
  const notional = qty * perUnit;
  if (!(qty > 0) || (!options && notional < MIN_TRADE_USD)) return reject(order, `AMOUNT_BELOW_MINIMUM: $${dollars.toFixed(2)} buys less than ${options ? 'one contract' : order.market === 'stocks' && !fractional && !order.fractional ? 'one whole share' : `$${MIN_TRADE_USD}`}`);
  if (qty > order.positionSize && !confirmed) return reject(order, `AMOUNT_ABOVE_MAX: $${notional.toFixed(2)} is above the risk engine's $${order.notional.toFixed(2)} ceiling; confirm to proceed`);
  if (notional > order.sizingBankroll + 0.005) return reject(order, `AMOUNT_ABOVE_BANKROLL: $${notional.toFixed(2)} is more than the $${order.sizingBankroll.toFixed(2)} bankroll it was sized from`);
  const k = qty / order.positionSize;
  const dollarRisk = order.dollarRisk * k;
  const { scenarios, costs, ...base } = order; // previews of the old size: the ledger recomputes them
  const resized = Object.freeze({
    ...base,
    positionSize: qty,
    notional,
    dollarRisk,
    actualRiskPct: dollarRisk / order.sizingBankroll,
    estimatedFees: order.estimatedFees * k,
    capitalCapped: false,
    ...(options && order.smallAccountCap && qty !== order.positionSize ? { smallAccountCap: false } : {}),
    amountOverride: { requested: dollars, recommendedSize: order.positionSize, recommendedNotional: order.notional, aboveMax: qty > order.positionSize },
  });
  approvedOrders.add(resized);
  return resized;
}

function isApproved(order) {
  return approvedOrders.has(order);
}

module.exports = { processCandidate, resizeOrder, isApproved, roundSize, DEFAULT_RISK_PCT, MAX_PREMIUM_R, CAPITAL_CHOICES, DEFAULT_MAX_CAPITAL_PCT, MIN_TRADE_USD, SPECULATIVE_SCALE, SMALL_ACCOUNT };
