// P/L maths shared by the ledger (bookings) and the Setups view (previews), so a
// scenario shown before approval is computed exactly like the trade would be
// booked. Pure functions: no state, no I/O.
const { estimateRoundTripFees, legRate } = require('./cost-authority');
const { exitValue, modelled } = require('./option-pricing');

// Options value per share of underlying: each leg's intrinsic value at the
// underlying price (buy legs +, sell legs -). Intrinsic ignores remaining time
// value, i.e. it values the position as if at expiry: a spread is worth at most
// its strike width and a call below its strike is worth 0.
function optionsValueAt(legs, underlyingPrice) {
  return (legs || []).reduce((v, leg) => {
    const intrinsic = leg.type === 'put'
      ? Math.max(0, leg.strike - underlyingPrice)
      : Math.max(0, underlyingPrice - leg.strike);
    return v + (leg.side === 'sell' ? -1 : 1) * (leg.ratio || 1) * intrinsic;
  }, 0);
}

// Per-share value an option position would sell for at underlying price S:
// real-contract positions (IV + expiration) via option-pricing.js at time `at`;
// older positions at intrinsic value.
const optionsSaleValue = (od, S, at) => (modelled(od) ? exitValue(od, S, at) : optionsValueAt(od.legs, S));

// Gross P/L (before fees) of `pos` entered at `entryPrice`, exited at `exitPrice`
// (always the UNDERLYING price for options; the premium paid is the debit).
function grossPnl(pos, entryPrice, exitPrice, at = Date.now()) {
  if (pos.market !== 'options') {
    const sign = pos.direction === 'short' ? -1 : 1;
    return (exitPrice - entryPrice) * pos.positionSize * sign;
  }
  const { debit, multiplier } = pos.optionsData;
  return (optionsSaleValue(pos.optionsData, exitPrice, at) - debit) * multiplier * pos.positionSize;
}

// Fee legs of an exit: a target is a resting limit (maker), anything else
// (stop, manual close) crosses the spread (taker). Entry: as the order was sized.
const feeLegs = (order, exitKind) => ({ entry: order.entryLiquidity, exit: exitKind === 'target' ? 'maker' : 'taker',
  optionLegs: order.optionsData && order.optionsData.legs ? order.optionsData.legs.length : 1 });

// Price scenarios for a sized order at its worst-case entry: stop, T1, T2, and
// `plan`: the blended result of the target plan (T1's allocation exits at T1,
// the rest at T2). Each: { price, gross, fees, net, r }. Missing levels are omitted.
function priceScenarios(order) {
  const entry = order.entryPrice;
  const targets = order.targets || [];
  const levels = [
    ['stop', order.invalidation, 'stop'],
    ['t1', targets[0] && targets[0].price, 'target'],
    ['t2', targets[1] && targets[1].price, 'target'],
  ];
  const out = {};
  // Options that exit on their own value (optionsData.exitRule, System 5): the
  // planned stop / T1 values ARE the exits, whatever the underlying does meanwhile.
  const od = order.market === 'options' ? order.optionsData : null;
  const rule = od && od.exitRule;
  const ruleValue = rule ? { stop: rule.stopValue, t1: rule.targetValue, t2: rule.t2Value } : {}; // t2Value: the planned stretch value (Phase 57)
  for (const [name, price, kind] of levels) {
    if (!(price > 0) || !(entry > 0) || !(order.positionSize > 0)) continue;
    const gross = ruleValue[name] > 0 ? (ruleValue[name] - od.debit) * od.multiplier * order.positionSize : grossPnl(order, entry, price);
    const fees = estimateRoundTripFees(order.market, order.positionSize, entry, price, feeLegs(order, kind));
    const net = gross - fees;
    out[name] = { price, gross, fees, net, r: order.dollarRisk > 0 ? net / order.dollarRisk : null };
  }
  const a1 = targets[0] && targets[0].allocation;
  if (out.t1 && out.t2 && a1 > 0 && a1 < 1) {
    const mix = (k) => a1 * out.t1[k] + (1 - a1) * out.t2[k];
    out.plan = { allocation: a1, gross: mix('gross'), fees: mix('fees'), net: mix('net'), r: order.dollarRisk > 0 ? mix('net') / order.dollarRisk : null };
  }
  return out;
}

// Cost breakdown for the Setups panel, from the same fee model as the ledger:
// { entry, exitT1, breakEvenPct }. A long exiting at a target (maker) breaks
// even at entry*(1+kIn)/(1-kOut).
// Options are costed per contract; their break-even depends on the legs: null.
function costBreakdown(order) {
  const q = order.positionSize;
  const e = order.entryPrice;
  const t1 = order.targets && order.targets[0] && order.targets[0].price;
  if (!(q > 0) || !(e > 0)) return null;
  if (order.market === 'options') {
    const perLeg = estimateRoundTripFees('options', q, 0, 0, feeLegs(order, 'target')) / 2;
    return { entry: perLeg, exitT1: t1 > 0 ? perLeg : null, breakEvenPct: null };
  }
  const kIn = legRate(order.market, order.entryLiquidity);
  const kOut = legRate(order.market, 'maker');
  const breakEvenPct = order.direction === 'short' ? 1 - (1 - kOut) / (1 + kIn) : (1 + kIn) / (1 - kOut) - 1;
  return { entry: kIn * q * e, exitT1: t1 > 0 ? kOut * q * t1 : null, breakEvenPct };
}

// The fee model behind estimateRoundTripFees, for client-side marks: fees at an
// exit price x are entryRate * size * fill + exitRate * size * x, where the exit
// is a market close (taker). legRate: the all-taker per-leg rate (older clients).
// Options pay a flat round trip per contract and leg.
function feeModel(market, entryLiquidity, optionLegs = 1) {
  if (market === 'options') return { perContractRoundTrip: estimateRoundTripFees('options', 1, 0, 0, { optionLegs }) };
  return { entryRate: legRate(market, entryLiquidity), exitRate: legRate(market, 'taker'), legRate: legRate(market, 'taker') };
}

module.exports = { optionsValueAt, optionsSaleValue, grossPnl, priceScenarios, costBreakdown, feeModel, feeLegs };
