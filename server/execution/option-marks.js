// Option marks: what a held real option contract would sell for right now, per
// share. The real BID from a fresh quote (options-data.js; the pipeline re-quotes
// held contracts every pass), else the Black-Scholes value at the live underlying
// price (option-pricing.js, anchored to the entry quote, sold at the bid side),
// else null (no quote and no live underlying price: nothing honest to show).
// Read-only; the ledger attaches it to open positions it hands out.
//   { value, basis: 'bid'|'model', bid, ask, underlying, at, delta, iv }  (delta/iv:
//   from the live quote's greeks; null on the model path, which uses the entry IV)
const { freshQuote } = require('../connectors/options-data');
const { getLatestPrice } = require('../market/latest-prices');
const { optionsSaleValue } = require('../risk/scenarios');

function optionMark(p) {
  const od = p.market === 'options' ? p.optionsData : null;
  if (!od || !od.contract) return null;
  const q = freshQuote(od.contract);
  const underlying = getLatestPrice(p.asset);
  if (q) return { value: q.bid, basis: 'bid', bid: q.bid, ask: q.ask, underlying, at: q.quoteTime, delta: q.delta ?? null, iv: q.iv ?? null };
  if (!(underlying > 0)) return null;
  return { value: optionsSaleValue(od, underlying, Date.now()), basis: 'model', bid: null, ask: null, underlying, at: Date.now(), delta: null, iv: null };
}

module.exports = { optionMark };
