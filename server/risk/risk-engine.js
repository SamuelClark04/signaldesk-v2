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
//                  Phase 83 (strict): 1R per contract is measured at the EXPECTED EXIT FILL (stop value
//                  minus half the spread's bid / ask gap, option-spread-width.js), and ONE contract over
//                  the budget is allowed only within OPTIONS_CAP.riskMultiple (1.25x) of it; a contract
//                  risking more, or whose whole debit is over OPTIONS_CAP.maxDebitPct (6%) of the
//                  bankroll, is refused OPTIONS_RISK_EXCEEDS_CAP (the old 5.5% / 12% override is gone).
//   T1 reality gate (Phase 54): live brackets exit 100% at T1, so the NET
//   reward : risk of T1 ALONE (after fees, the ledger's own scenarios) must be
//   >= minT1NetRR (1.25 : 1; crypto 1.5 : 1, Moonshots 1.35 : 1) for every trade, whatever T2 would add.
//   Live cash cap: options.cashCap (the LIVE venue's spendable cash, e.g.
//   Coinbase USD + USDC) is a ceiling on notional / premium: a live buy is never
//   sized above the money actually there.
const { evaluateCosts, feesOf } = require('./cost-authority');
const { priceScenarios } = require('./scenarios');
const { t1NetRR, minT1NetRR } = require('./reality-gate');

const DEFAULT_RISK_PCT = 0.01; // 1% of bankroll per trade
const DEFAULT_MAX_LEVERAGE = 1; // cash account: notional may not exceed bankroll
const MARKETS = ['crypto', 'stocks', 'options'];
const MAX_PREMIUM_R = 3; // full-premium loss capped at 3x the per-trade risk budget
const OPTIONS_CAP = Object.freeze({ riskMultiple: 1.25, maxDebitPct: 0.06, label: '1 contract within 1.25x the risk budget' }); // Phase 83
// Phase 83: a Trade Amount ABOVE the risk engine's size may never pass these (no confirmation bypasses them).
const OVERRIDE_CEILING = Object.freeze({ riskPct: 0.03, capitalPct: 0.08 });
const { expectedExitRisk } = require('./option-spread-width');
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
function sizeLinear(candidate, bankroll, riskBudget, capPct, entryPrice, stopDistance, cashCap = Infinity) {
  const bySize = riskBudget / stopDistance; // risk-based size
  const byCapital = (bankroll * capPct) / entryPrice; // capital cap
  const byAmount = Math.min(candidate.maxNotional > 0 ? candidate.maxNotional : Infinity, cashCap) / entryPrice;
  const positionSize = roundSize(Math.min(bySize, byCapital, byAmount), candidate.market, !!candidate.fractional);
  if (!(positionSize > 0)) return { error: cashCap < Infinity && cashCap / entryPrice < bySize ? `Not enough live cash: $${cashCap.toFixed(2)} spendable` : 'Position size rounds to zero' };
  return {
    positionSize,
    dollarRisk: positionSize * stopDistance, // actual risk after rounding and the caps
    notional: positionSize * entryPrice,
    cappedByNotional: byCapital < bySize && byCapital <= byAmount,
    cappedByAmount: byAmount < Math.min(bySize, byCapital),
  };
}

// Phase 66: a crypto position under MIN_CRYPTO_NOTIONAL ($20) loses too much to fees and the
// spread on a retail tier. It is sized UP to $20 only if the risk at the stop stays within the
// user's per-trade cap (bankroll x risk %, before any Moonshot scale-down) and the capital /
// cash / allocation caps allow $20; otherwise the setup is rejected (MIN_NOTIONAL_TOO_SMALL).
const MIN_CRYPTO_NOTIONAL = 20;
// Phase 70B: crypto cash pays the notional AND the entry fee, so a live / paper crypto cash cap is
// fee-inclusive: cash / (1 + the venue's taker rate) - CASH_FEE_BUFFER (lot / price rounding).
// An account holding about exactly $20 (fee-inclusive cap under $20) may trade down to
// CASH_BOUND_MIN_NOTIONAL ($19.80) instead of being refused for being a few cents short.
const CASH_FEE_BUFFER = 0.02;
const CASH_BOUND_MIN_NOTIONAL = 19.8;
const CASH_TRIM = 0.02; // a Trade Amount up to 2% over the cash cap buys what the cash allows
const feeInclusiveCash = (cash, rate) => Math.max(0, cash / (1 + (rate || 0)) - CASH_FEE_BUFFER);
const cryptoFloor = (cashCap) => (cashCap < MIN_CRYPTO_NOTIONAL ? CASH_BOUND_MIN_NOTIONAL : MIN_CRYPTO_NOTIONAL);
function sizeUpToMin(candidate, riskCap, capitalCap, cashCap, entryPrice, stopDistance) {
  const target = Math.min(MIN_CRYPTO_NOTIONAL, cashCap); // cash-bound: what the cash buys, >= $19.80
  if (target < CASH_BOUND_MIN_NOTIONAL - 1e-9) return null;
  const qty = (target < MIN_CRYPTO_NOTIONAL ? Math.floor : Math.ceil)((target / entryPrice) * 1e8) / 1e8;
  const notional = qty * entryPrice;
  const allocation = candidate.maxNotional > 0 ? candidate.maxNotional : Infinity;
  if (qty * stopDistance > riskCap + 1e-9 || notional > Math.min(capitalCap, cashCap, allocation) + 1e-9) return null;
  return { positionSize: qty, dollarRisk: qty * stopDistance, notional, cappedByNotional: false, cappedByAmount: false, sizedUpToMin: true };
}

// Options (long premium), sized on the real premium: risk to the stop per
// contract, and the whole premium capped at MAX_PREMIUM_R budgets and the bankroll.
function sizeOptions(candidate, riskBudget, bankroll, capPct, cashCap = Infinity) {
  const od = candidate.optionsData;
  const premiumPerContract = od.debit * od.multiplier;
  const riskPerContract = expectedExitRisk(od) * od.multiplier; // Phase 83: to the expected exit fill, not the mid
  const maxRisk = riskBudget * OPTIONS_CAP.riskMultiple;
  const maxDebit = OPTIONS_CAP.maxDebitPct * bankroll;
  const usd = (x) => `$${x.toFixed(2)}`;
  if (riskPerContract > maxRisk + 1e-9 || premiumPerContract > maxDebit + 1e-9) {
    return { error: `OPTIONS_RISK_EXCEEDS_CAP: one contract risks ${usd(riskPerContract)} to the stop's expected fill (max ${usd(maxRisk)} = ${OPTIONS_CAP.riskMultiple}x the `
      + `${usd(riskBudget)} risk budget) and costs ${usd(premiumPerContract)} (max ${usd(maxDebit)} = ${OPTIONS_CAP.maxDebitPct * 100}% of the bankroll, the most it can lose)` };
  }
  const byRisk = Math.floor(riskBudget / riskPerContract + 1e-9) || 1; // one contract within the 1.25x tolerance
  const byPremium = Math.floor(Math.min(riskBudget * MAX_PREMIUM_R, maxDebit, bankroll * capPct, cashCap) / premiumPerContract + 1e-9);
  const positionSize = Math.min(byRisk, byPremium);
  if (positionSize < 1) return { error: `Bankroll too small: one contract's premium ${usd(premiumPerContract)} exceeds ${capPct * 100}% of the bankroll or the cash available` };
  return { positionSize, dollarRisk: positionSize * riskPerContract, notional: positionSize * premiumPerContract, cappedByNotional: byPremium < byRisk,
    ...(riskPerContract > riskBudget + 1e-9 ? { smallAccountCap: true } : {}) };
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
  const rawCash = options.cashCap >= 0 ? options.cashCap : Infinity;
  const cashCap = candidate.market === 'crypto' && rawCash < Infinity ? feeInclusiveCash(rawCash, feesOf(candidate).taker) : rawCash; // Phase 70B
  let sizing = candidate.market === 'options'
    ? sizeOptions(candidate, riskBudget, configuredBankroll, capPct, cashCap)
    : sizeLinear(candidate, configuredBankroll, riskBudget, capPct, entryPrice, stopDistance, cashCap);
  if (sizing.error) return reject(candidate, sizing.error);
  if (candidate.market === 'crypto' && sizing.notional < cryptoFloor(cashCap) - 0.005) { // half a cent: 8-decimal rounding ($19.9999999) is $20
    const up = sizeUpToMin(candidate, configuredBankroll * riskPct, configuredBankroll * capPct, cashCap, entryPrice, stopDistance);
    if (!up) return reject(candidate, `MIN_NOTIONAL_TOO_SMALL: $${sizing.notional.toFixed(2)} position is under the $${cryptoFloor(cashCap).toFixed(2)} minimum efficient size`
      + `${cashCap < MIN_CRYPTO_NOTIONAL ? ` ($${cashCap.toFixed(2)} spendable after the entry fee)` : ''}`);
    sizing = up;
  }

  const { positionSize, dollarRisk } = sizing;
  // Entry leg liquidity (cost-authority.js): a strategy's resting limit inside
  // its zone is maker on PAPER and on live Coinbase (a post-only limit entry,
  // coinbase-api.js); anything else (e.g. live Alpaca market entries) is taker.
  const basis = options.sizingBasis || 'paper';
  const entryLiquidity = candidate.entryLiquidity === 'maker' && (basis === 'paper' || basis === 'coinbase-live' || basis === 'kraken-live' || basis === 'okx-live') ? 'maker' : 'taker'; // Kraken / OKX: post-only too (69A / 69B)
  const sized = { ...candidate, entryPrice, positionSize, dollarRisk, entryLiquidity };

  const cost = evaluateCosts(sized, dollarRisk);
  if (!cost.approved) return reject(candidate, cost.reason, { feeDrag: cost.feeDrag });
  const rr = t1NetRR(priceScenarios(sized));
  const needRR = minT1NetRR(candidate.market, !!candidate.speculative); // crypto 1.5 : 1, Moonshots 1.35 : 1 (Phase 65B), else 1.25 : 1
  if (rr !== null && rr < needRR) {
    return reject(candidate, `T1_NET_RR_TOO_LOW: T1 alone pays ${rr.toFixed(2)} : 1 after fees (needs ${needRR} : 1; live brackets exit 100% at T1)`, { t1NetRR: rr });
  }

  const approved = Object.freeze({
    ...sized,
    approved: true,
    stopDistance,
    notional: sizing.notional,
    riskPct,
    ...(candidate.speculative ? { speculativeScale: scale, speculativeRiskPct: riskPct * scale } : {}),
    ...(sizing.sizedUpToMin ? { sizedUpToMin: true } : {}), // raised to the $20 crypto minimum (Phase 66)
    // One contract above the profile budget, within the 1.25x tolerance (Phase 83): shown to the user as such.
    ...(sizing.smallAccountCap ? { smallAccountCap: true, smallAccountLabel: OPTIONS_CAP.label, budgetRisk: riskBudget } : {}),
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
    t1NetRR: rr,
    ...(cashCap < Infinity ? { cashCap } : {}),
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
  let dollars = Number(amount);
  // Phase 70B: $20 asked of a $20 account: the fee-inclusive cash cap ($19.90-19.96) is what it buys.
  if (order && order.market === 'crypto' && order.cashCap >= 0 && dollars > order.cashCap && dollars <= order.cashCap * (1 + CASH_TRIM)) dollars = order.cashCap;
  if (!order || !(order.positionSize > 0)) return reject(order, 'INVALID_ORDER');
  if (!Number.isFinite(dollars) || dollars <= 0) return reject(order, 'AMOUNT_INVALID');
  const options = order.market === 'options';
  const perUnit = options ? order.optionsData.debit * order.optionsData.multiplier : order.entryPrice;
  const same = Math.abs(dollars - order.notional) < 0.005; // "Max": the risk engine's own size
  const qty = same ? order.positionSize : options ? Math.floor(dollars / perUnit + 1e-9) : roundSize(dollars / perUnit, order.market, fractional || !!order.fractional);
  const notional = qty * perUnit;
  if (!(qty > 0) || (!options && notional < MIN_TRADE_USD)) return reject(order, `AMOUNT_BELOW_MINIMUM: $${dollars.toFixed(2)} buys less than ${options ? 'one contract' : order.market === 'stocks' && !fractional && !order.fractional ? 'one whole share' : `$${MIN_TRADE_USD}`}`);
  if (order.market === 'crypto' && notional < cryptoFloor(order.cashCap >= 0 ? order.cashCap : Infinity) - 0.005) return reject(order, `AMOUNT_BELOW_MINIMUM: $${notional.toFixed(2)} is under the $${cryptoFloor(order.cashCap >= 0 ? order.cashCap : Infinity).toFixed(2)} crypto minimum efficient size`);
  if (qty > order.positionSize && !confirmed) return reject(order, `AMOUNT_ABOVE_MAX: $${notional.toFixed(2)} is above the risk engine's $${order.notional.toFixed(2)} ceiling; confirm to proceed`);
  if (order.cashCap >= 0 && notional > order.cashCap + 0.005) return reject(order, `AMOUNT_ABOVE_CASH: $${notional.toFixed(2)} is more than the $${order.cashCap.toFixed(2)} of live cash it was sized against`);
  if (notional > order.sizingBankroll + 0.005) return reject(order, `AMOUNT_ABOVE_BANKROLL: $${notional.toFixed(2)} is more than the $${order.sizingBankroll.toFixed(2)} bankroll it was sized from`);
  const k = qty / order.positionSize;
  const dollarRisk = order.dollarRisk * k;
  if (qty > order.positionSize) { // Phase 83: a bigger amount never passes the hard ceiling, confirmed or not
    const bank = order.sizingBankroll;
    const riskCap = Math.min(OVERRIDE_CEILING.riskPct, options ? OPTIONS_CAP.riskMultiple * (order.riskPct || DEFAULT_RISK_PCT) : Infinity) * bank;
    const capCap = (options ? Math.min(OVERRIDE_CEILING.capitalPct, OPTIONS_CAP.maxDebitPct) : OVERRIDE_CEILING.capitalPct) * bank;
    if (dollarRisk > riskCap + 0.005 || notional > capCap + 0.005) {
      return reject(order, `AMOUNT_ABOVE_HARD_CAP: $${notional.toFixed(2)} risks $${dollarRisk.toFixed(2)}; the most any trade may take is $${riskCap.toFixed(2)} of risk and $${capCap.toFixed(2)} `
        + `of capital (${(riskCap / bank * 100).toFixed(1)}% / ${(capCap / bank * 100).toFixed(1)}% of the $${bank.toFixed(2)} bankroll)`);
    }
  }
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

module.exports = { processCandidate, resizeOrder, isApproved, roundSize, DEFAULT_RISK_PCT, MAX_PREMIUM_R, CAPITAL_CHOICES, DEFAULT_MAX_CAPITAL_PCT, MIN_TRADE_USD, MIN_CRYPTO_NOTIONAL, SPECULATIVE_SCALE, OPTIONS_CAP, OVERRIDE_CEILING,
  CASH_BOUND_MIN_NOTIONAL, CASH_FEE_BUFFER, CASH_TRIM, feeInclusiveCash };
