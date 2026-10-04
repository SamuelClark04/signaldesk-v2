// Internal paper FILL prices (Phase 89 audit: paper results were better than any real order could get).
//   crypto   a paper buy fills at once at the BEST ASK (Coinbase's live quote, when fresh and within 2% of the price; else the
//            price + SPREAD_PAD) and pays the TAKER fee. Live entries are post-only limits at the bid that may never fill
//            (canceled after 30 min); the old paper fill took the last price AND the maker fee, which no order gets.
//   options  bought at the NATURAL price from fresh quotes (long legs at the ask, short legs at the bid). The old package
//            model paid the net mid + 0.15 x the legs' bid/ask and sold at mid - 0.15 x: the 18 paper spreads of Sep 25-28
//            booked +$354, about -$198 at natural prices. Without a fresh quote: the plan's net mid + half the legs' bid/ask
//            (the natural estimate); a Quick Flip with no fresh quote is refused (never filled on a stale price), and one whose fresh
//            natural ask is above the ask on its card (od.debit, "your entry limit") by more than $0.005 is refused too (Phase 91).
// Exits: option positions are sold at the natural bid (option-marks.saleValue); crypto at the best bid (exit-quote.js).
// Alpaca Paper fills are the broker's own (alpaca-paper.js); this is only the internal simulator.
const SPREAD_PAD = 0.0005;
const ASK_TOLERANCE = 0.005; // Phase 91: a Quick Flip fills only at or within this of the ask shown on its card
const round2 = (x) => Math.round(x * 100) / 100;

// -> { fillPrice, extra } for the internal paper fill of `order` (never throws, except QUICKFLIPS_STALE_QUOTE / QUICKFLIPS_ASK_ABOVE_LIMIT).
async function price(order, livePrice, now = Date.now()) {
  if (order.market === 'crypto' && order.direction !== 'short') {
    const q = require('../risk/break-even').liveQuote(order.brokerProduct || order.asset, now);
    const ask = q && livePrice > 0 && Math.abs(q.ask / livePrice - 1) <= 0.02 ? q.ask : null;
    const fill = ask || (livePrice > 0 ? livePrice * (1 + SPREAD_PAD) : null);
    return { fillPrice: fill, extra: { entryLiquidity: 'taker', paperFillBasis: ask ? 'best ask (taker)' : `last price + ${SPREAD_PAD * 100}% (taker, no fresh quote)` } };
  }
  if (order.market === 'options' && order.optionsData) {
    const od = order.optionsData;
    const nat = await require('./spread-entry').natural(od, now).catch(() => null);
    if (!(nat > 0) && order.strategyId === 'options-quickflips') throw new Error('QUICKFLIPS_STALE_QUOTE: no fresh option quote to fill the Quick Flip at; nothing was filled');
    if (nat > 0 && order.strategyId === 'options-quickflips' && nat > od.debit + ASK_TOLERANCE) throw new Error(`QUICKFLIPS_ASK_ABOVE_LIMIT: the ask is now ${nat}, above your entry limit ${od.debit}; nothing was filled (the setup stays pending until its deadline)`);
    const est = od.netMid > 0 && od.combinedLegSpread >= 0 ? round2(od.netMid + od.combinedLegSpread / 2) : od.debit;
    const debit = nat > 0 ? nat : est;
    return { fillPrice: livePrice, extra: { optionsData: { ...od, debit, plannedDebit: od.debit, paperFillBasis: nat > 0 ? 'natural (fresh quotes)' : 'natural estimate (no fresh quote)' } } };
  }
  return { fillPrice: livePrice, extra: {} };
}

// Fill `order` in the internal paper ledger at a realistic price.
async function fill(ledger, order, livePrice, resized = null, extra = {}) {
  const p = await price(resized || order, livePrice);
  return ledger.executeOrder(order.id, p.fillPrice, { ...extra, ...p.extra }, resized);
}

module.exports = { price, fill, SPREAD_PAD };
