// P/L maths shared by the ledger (bookings) and the Setups view (previews), so a
// scenario shown before approval is computed exactly like the trade would be
// booked. Pure functions: no state, no I/O.
const { estimateRoundTripFees, getRoundTripRate } = require('./cost-authority');
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

// Price scenarios for a sized order at its worst-case entry: stop, T1, T2.
// Each: { price, gross, fees, net, r }. Missing levels are omitted.
function priceScenarios(order) {
  const entry = order.entryPrice;
  const levels = [
    ['stop', order.invalidation],
    ['t1', order.targets && order.targets[0] && order.targets[0].price],
    ['t2', order.targets && order.targets[1] && order.targets[1].price],
  ];
  const out = {};
  for (const [name, price] of levels) {
    if (!(price > 0) || !(entry > 0) || !(order.positionSize > 0)) continue;
    const gross = grossPnl(order, entry, price);
    const fees = estimateRoundTripFees(order.market, order.positionSize, entry, price);
    const net = gross - fees;
    out[name] = { price, gross, fees, net, r: order.dollarRisk > 0 ? net / order.dollarRisk : null };
  }
  return out;
}

// Cost breakdown for the Setups panel, from the same fee model as the ledger:
// { entry, exitT1, breakEvenPct }. The round-trip rate is split evenly across
// the two legs (k per leg), so a long breaks even at entry*(1+k)/(1-k).
// Options are costed per contract; their break-even depends on the legs: null.
function costBreakdown(order) {
  const q = order.positionSize;
  const e = order.entryPrice;
  const t1 = order.targets && order.targets[0] && order.targets[0].price;
  if (!(q > 0) || !(e > 0)) return null;
  if (order.market === 'options') {
    const perLeg = estimateRoundTripFees('options', q) / 2;
    return { entry: perLeg, exitT1: t1 > 0 ? perLeg : null, breakEvenPct: null };
  }
  const k = getRoundTripRate(order.market) / 2;
  const breakEvenPct = order.direction === 'short' ? 1 - (1 - k) / (1 + k) : (1 + k) / (1 - k) - 1;
  return { entry: k * q * e, exitT1: t1 > 0 ? k * q * t1 : null, breakEvenPct };
}

// The fee model behind estimateRoundTripFees, for client-side marks: fees at an
// exit price x are legRate * size * (fill + x); options pay a flat round trip.
function feeModel(market) {
  if (market === 'options') return { perContractRoundTrip: estimateRoundTripFees('options', 1) };
  return { legRate: getRoundTripRate(market) / 2 };
}

module.exports = { optionsValueAt, optionsSaleValue, grossPnl, priceScenarios, costBreakdown, feeModel };
