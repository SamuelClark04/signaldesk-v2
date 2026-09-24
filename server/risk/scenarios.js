// P/L maths shared by the ledger (bookings) and the Setups view (previews), so a
// scenario shown before approval is computed exactly like the trade would be
// booked. Pure functions: no state, no I/O.
const { estimateRoundTripFees } = require('./cost-authority');

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

// Gross P/L (before fees) of `pos` entered at `entryPrice`, exited at `exitPrice`
// (always the UNDERLYING price for options).
function grossPnl(pos, entryPrice, exitPrice) {
  if (pos.market !== 'options') {
    const sign = pos.direction === 'short' ? -1 : 1;
    return (exitPrice - entryPrice) * pos.positionSize * sign;
  }
  const { debit, multiplier, legs } = pos.optionsData;
  return (optionsValueAt(legs, exitPrice) - debit) * multiplier * pos.positionSize;
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

module.exports = { optionsValueAt, grossPnl, priceScenarios };
