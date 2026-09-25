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
//   optionMark: { value, basis: 'bid'|'mid'|'model', bid, ask, underlying, at, delta, iv, fill, mid, stats }
//   (bid/ask/delta/iv: a single contract's live quote; null for spreads or the model)
// Phase 58: a PACKAGE spread is marked at its NET MID (value, basis 'mid': what the
// spread is worth, the "Premium now"); `fill` is what closing it would fetch (mid -
// 0.15 x combined bid/ask), and the ledger books exits at the fill. `stats`: live net
// Greeks, expiry breakeven, POP, max value / profit (risk/spread-stats.js), at the live
// underlying (or the last close while the market is closed).
const { freshQuote } = require('../connectors/options-data');
const { getLatestPrice } = require('../market/latest-prices');
const { optionsSaleValue } = require('../risk/scenarios');
const { packageQuote } = require('../risk/cost-authority');
const { modelMid } = require('../risk/option-pricing');
const spreadStats = require('../risk/spread-stats');
const { getMarkPrice } = require('../market/latest-prices');

// Contract symbol of each leg (single-leg positions keep theirs on optionsData.contract).
const legSymbols = (od) => {
  const legs = od.legs || [];
  return legs.map((l) => l.contract || (legs.length === 1 ? od.contract : null));
};

const isPackage = (od) => od.fill === 'package' && (od.legs || []).length > 1;

// Between chain quotes (about one a minute) the underlying keeps moving: the quoted
// values move by net delta x (S now - S when quoted) until the next quote (Phase 59).
function deltaShift(od, quotes, S, at) {
  const anchor = quotes[0] && quotes[0].spot;
  if (!(S > 0 && anchor > 0) || S === anchor || !od.expiration || !(od.legs || []).length) return 0;
  const g = spreadStats.netGreeks(od, anchor, at);
  return g ? g.delta * (S - anchor) : 0;
}

// { value (the sale fill), mid (package spreads), basis, quotes, interpolated } for position p at underlying price S, or null.
function saleValue(p, S, at = Date.now()) {
  const od = p.optionsData;
  const symbols = legSymbols(od);
  if (symbols.length && symbols.every(Boolean)) {
    const quotes = symbols.map((s) => freshQuote(s));
    if (quotes.every(Boolean)) {
      const shift = deltaShift(od, quotes, S, at);
      const interpolated = shift !== 0;
      if (isPackage(od)) {
        const q = packageQuote(od.legs.map((leg, i) => ({ side: leg.side, ratio: leg.ratio, bid: quotes[i].bid, ask: quotes[i].ask })));
        return { value: Math.max(0, q.exit + shift), mid: Math.max(0, q.mid + shift), basis: 'bid', quotes, interpolated };
      }
      const value = od.legs.reduce((v, leg, i) => v + (leg.side === 'sell' ? -quotes[i].ask : quotes[i].bid) * (leg.ratio || 1), 0);
      return { value: Math.max(0, value + shift), basis: 'bid', quotes, interpolated };
    }
  }
  if (!(S > 0)) return null;
  const value = optionsSaleValue(od, S, at);
  return { value, ...(isPackage(od) && od.expiration ? { mid: modelMid(od, S, at) } : {}), basis: od.contract ? 'model' : 'intrinsic', quotes: null };
}

function optionMark(p) {
  const od = p.market === 'options' ? p.optionsData : null;
  if (!od || !od.contract) return null;
  const underlying = getLatestPrice(p.asset);
  const m = saleValue(p, underlying);
  if (!m) return null;
  const q = m.quotes && m.quotes.length === 1 ? m.quotes[0] : null;
  const mid = Number.isFinite(m.mid);
  const S = underlying > 0 ? underlying : getMarkPrice(p.asset);
  return { value: mid ? m.mid : m.value, basis: mid && m.basis === 'bid' ? 'mid' : m.basis === 'bid' ? 'bid' : 'model', fill: m.value, mid: mid ? m.mid : null,
    bid: q ? q.bid : null, ask: q ? q.ask : null, underlying, at: q ? q.quoteTime : Date.now(), delta: q ? q.delta ?? null : null, iv: q ? q.iv ?? null : null,
    stats: od.expiration && od.legs && od.legs.length && S > 0 ? spreadStats.stats(od, S, Date.now()) : null };
}

module.exports = { optionMark, saleValue, legSymbols };
