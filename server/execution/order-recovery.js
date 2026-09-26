// Unrecorded broker orders (Phase 68, P1-5). A LIVE submit marks its pending setup first
// (ledger.markSubmitting, saved before the broker call). If SignalDesk crashed, restarted or
// got no clear answer (timeout / 429 / 5xx) before the ledger recorded the position, the
// setup still carries that mark. recover() (at boot and at the top of every pass, and only
// while such marks exist) lists Coinbase's BUY orders since the oldest mark and matches
// client_order_id (= the setup id, coinbase-orders.submitOrder):
//   found, filled or still working  -> recorded as the LIVE position it should have become
//                                      (the reconciler then syncs the real fill and the bracket)
//   found but ended with nothing filled, or not listed after GRACE_MS -> the mark is cleared
//   Coinbase unreachable            -> tried again next pass
const orders = require('../connectors/coinbase-orders');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000; // a just-sent order may not be listed yet
const baseOf = (asset) => String(asset).replace(/-USDC?$/, '');

async function recover(ledger, now = Date.now()) {
  const cands = ledger.recoverable(now - WINDOW_MS).filter((o) => o.market === 'crypto');
  if (!cands.length) return [];
  const products = [...new Set(cands.flatMap((o) => [`${baseOf(o.asset)}-USD`, `${baseOf(o.asset)}-USDC`]))];
  const r = await orders.listOrders({ sinceMs: Math.min(...cands.map((o) => o.submittingAt)), side: 'BUY', products });
  if (!r.ok) {
    console.warn(`[recover] could not list Coinbase orders (${r.error}); ${cands.length} submitted setup(s) re-checked next pass`);
    return cands.map((o) => ({ id: o.id, action: 'waiting', detail: r.error }));
  }
  const out = [];
  for (const o of cands) {
    const hit = r.orders.find((x) => x.clientOrderId === o.id);
    if (hit && (hit.filledQty > 0 || !hit.terminal)) {
      const filled = hit.filledQty > 0 && hit.avgFillPrice > 0;
      const size = filled ? hit.filledQty : o.positionSize;
      const fill = filled ? hit.avgFillPrice : o.entryPrice;
      ledger.recoverLive(o.id, { broker: 'Coinbase', brokerId: hit.orderId, brokerEnvironment: 'coinbase-live', brokerProduct: hit.product, fillEstimated: true,
        fillPrice: fill, positionSize: size, dollarRisk: Math.abs(fill - o.invalidation) * size, recoveredFrom: o.status || 'pending' });
      console.error(`[recover] CRITICAL ${o.id}: Coinbase order ${hit.orderId} (${hit.status}, ${hit.filledQty} filled) was never recorded; recorded now as a LIVE position`);
      out.push({ id: o.id, action: 'recovered', detail: `order ${hit.orderId} ${hit.status}` });
    } else if (hit || now - o.submittingAt > GRACE_MS) {
      ledger.markSubmitting(o.id, null);
      out.push({ id: o.id, action: 'cleared', detail: hit ? `order ${hit.orderId} ended ${hit.status} with nothing filled` : 'no such order at Coinbase' });
    } else {
      out.push({ id: o.id, action: 'waiting', detail: 'just submitted; not listed yet' });
    }
  }
  return out;
}

module.exports = { recover, WINDOW_MS, GRACE_MS };
