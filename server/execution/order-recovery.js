// Unrecorded broker orders (Phase 68, P1-5). A LIVE submit marks its pending setup first
// (ledger.markSubmitting, saved before the broker call). If SignalDesk crashed, restarted or
// got no clear answer (timeout / 429 / 5xx) before the ledger recorded the position, the
// setup still carries that mark. recover() (at boot and at the top of every pass, and only
// while such marks exist) lists each routed venue's BUY orders (Phase 69A: Coinbase / Kraken)
// since the oldest mark and matches the client order id (Coinbase: the setup id; OKX: its hash; Kraken: its userref, 70F):
//   found, filled or still working  -> recorded as the LIVE position it should have become
//                                      (the reconciler then syncs the real fill and the bracket)
//   found but ended with nothing filled, or not listed after GRACE_MS -> the mark is cleared
//   venue unreachable               -> tried again next pass
const venues = require('./crypto-venues'); // Phase 69A: each setup's routed venue (Coinbase / Kraken)

const WINDOW_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000; // a just-sent order may not be listed yet
const baseOf = (asset) => String(asset).replace(/-USDC?$/, '');

async function recover(ledger, now = Date.now()) {
  const all = ledger.recoverable(now - WINDOW_MS).filter((o) => o.market === 'crypto');
  const out = [];
  for (const id of [...new Set(all.map((o) => venues.idOf(o)))]) out.push(...await recoverAt(ledger, id, all.filter((o) => venues.idOf(o) === id), now));
  return out;
}

async function recoverAt(ledger, venueId, cands, now) {
  const v = venues.VENUES[venueId];
  const orders = v.orders();
  if (!orders) return cands.map((o) => ({ id: o.id, action: 'waiting', detail: `${v.label}: no connector yet` }));
  const products = [...new Set(cands.flatMap((o) => [`${baseOf(o.asset)}-USD`, `${baseOf(o.asset)}-USDC`]))];
  const r = await orders.listOrders({ sinceMs: Math.min(...cands.map((o) => o.submittingAt)), side: 'BUY', products });
  if (!r.ok) {
    console.warn(`[recover] could not list ${v.label} orders (${r.error}); ${cands.length} submitted setup(s) re-checked next pass`);
    return cands.map((o) => ({ id: o.id, action: 'waiting', detail: r.error }));
  }
  const out = [];
  for (const o of cands) {
    const hit = r.orders.find((x) => (orders.isEntryOf ? orders.isEntryOf(x, o.id) : x.clientOrderId === orders.clientIdOf(o.id))); // Kraken: its userref (70F)
    if (hit && (hit.filledQty > 0 || !hit.terminal)) {
      const filled = hit.filledQty > 0 && hit.avgFillPrice > 0;
      const size = filled ? hit.filledQty : o.positionSize;
      const fill = filled ? hit.avgFillPrice : o.entryPrice;
      ledger.recoverLive(o.id, { broker: v.broker, venue: venueId, brokerId: hit.orderId, brokerEnvironment: `${venueId}-live`, brokerProduct: hit.product, fillEstimated: true,
        fillPrice: fill, positionSize: size, dollarRisk: Math.abs(fill - o.invalidation) * size, recoveredFrom: o.status || 'pending' });
      console.error(`[recover] CRITICAL ${o.id}: ${v.label} order ${hit.orderId} (${hit.status}, ${hit.filledQty} filled) was never recorded; recorded now as a LIVE position`);
      out.push({ id: o.id, action: 'recovered', detail: `order ${hit.orderId} ${hit.status}` });
    } else if (hit || now - o.submittingAt > GRACE_MS) {
      ledger.markSubmitting(o.id, null);
      out.push({ id: o.id, action: 'cleared', detail: hit ? `order ${hit.orderId} ended ${hit.status} with nothing filled` : `no such order at ${v.label}` });
    } else {
      out.push({ id: o.id, action: 'waiting', detail: 'just submitted; not listed yet' });
    }
  }
  return out;
}

module.exports = { recover, WINDOW_MS, GRACE_MS };
