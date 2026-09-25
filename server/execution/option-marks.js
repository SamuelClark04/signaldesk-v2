// Option marks: what a held option position would sell for right now, per share
// of the whole position (every leg). Real quotes first: with a fresh quote for
// EVERY leg (options-data.js; the pipeline re-quotes held contracts every pass),
// long legs sell at their BID and short legs are bought back at their ASK; a
// Phase 57 PACKAGE spread (optionsData.fill 'package') sells as one net-limit
// order: net mid - 0.15 x the combined leg bid/ask (cost-authority.js). Else
// the Black-Scholes value at the live underlying price (option-pricing.js,
// anchored to the entry quote, sold at the bid side), else null (no quote and no
// live underlying price: nothing honest to show).
// Read-only; the ledger attaches optionMark to open positions it hands out and
// values exits with saleValue (paper-ledger.js, exit-monitor.js).
//   optionMark: { value, basis: 'bid'|'model', bid, ask, underlying, at, delta, iv }
//   (bid/ask/delta/iv: a single contract's live quote; null for spreads or the model)
const { freshQuote } = require('../connectors/options-data');
const { getLatestPrice } = require('../market/latest-prices');
const { optionsSaleValue } = require('../risk/scenarios');
const { packageQuote } = require('../risk/cost-authority');

// Contract symbol of each leg (single-leg positions keep theirs on optionsData.contract).
const legSymbols = (od) => {
  const legs = od.legs || [];
  return legs.map((l) => l.contract || (legs.length === 1 ? od.contract : null));
};

// { value, basis, quotes } for position p at underlying price S, or null.
function saleValue(p, S, at = Date.now()) {
  const od = p.optionsData;
  const symbols = legSymbols(od);
  if (symbols.length && symbols.every(Boolean)) {
    const quotes = symbols.map((s) => freshQuote(s));
    if (quotes.every(Boolean)) {
      const value = od.fill === 'package' && od.legs.length > 1
        ? packageQuote(od.legs.map((leg, i) => ({ side: leg.side, ratio: leg.ratio, bid: quotes[i].bid, ask: quotes[i].ask }))).exit
        : od.legs.reduce((v, leg, i) => v + (leg.side === 'sell' ? -quotes[i].ask : quotes[i].bid) * (leg.ratio || 1), 0);
      return { value: Math.max(0, value), basis: 'bid', quotes };
    }
  }
  if (!(S > 0)) return null;
  return { value: optionsSaleValue(od, S, at), basis: od.contract ? 'model' : 'intrinsic', quotes: null };
}

function optionMark(p) {
  const od = p.market === 'options' ? p.optionsData : null;
  if (!od || !od.contract) return null;
  const underlying = getLatestPrice(p.asset);
  const m = saleValue(p, underlying);
  if (!m) return null;
  const q = m.quotes && m.quotes.length === 1 ? m.quotes[0] : null;
  return { value: m.value, basis: m.basis === 'bid' ? 'bid' : 'model', bid: q ? q.bid : null, ask: q ? q.ask : null, underlying,
    at: q ? q.quoteTime : Date.now(), delta: q ? q.delta ?? null : null, iv: q ? q.iv ?? null : null };
}

module.exports = { optionMark, saleValue, legSymbols };
