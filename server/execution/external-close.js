// Positions sold OUTSIDE SignalDesk (Phase 71): a LIVE crypto position whose coins were sold in
// the venue's own app (e.g. after SignalDesk's sell was refused) stays open in the ledger,
// UNARMORED, forever. closeExternally() books it:
//   1. the venue balance of the coin (less what other open positions there hold) must be gone
//      (<= DUST_SHARE of the position; more only with force: dust written off)
//   2. a SignalDesk stop / bracket still working for it is canceled (it guards coins that are gone)
//   3. the venue's own SELL fills since the entry (not booked by SignalDesk) give the real exit
//      price, fees and time; none found: the last price, marked 'estimated'
//   -> journal: CLOSED_EXTERNALLY (exitLeg manual)
// autoCheck() (reconciler, UNARMORED positions only): the coin gone (<= GONE_SHARE) on two passes
// CONFIRM_MS apart -> closeExternally({ auto }). CLOSE_EXTERNALLY { id, force, requestId } ->
// EXTERNAL_CLOSE_RESULT to the asker; POSITIONS_UPDATED / JOURNAL_UPDATED to all.
const venues = require('./crypto-venues');
const ops = require('./bracket-ops');
const prices = require('../market/latest-prices');

const GONE_SHARE = 0.02;
const DUST_SHARE = 0.05;
const CONFIRM_MS = 45 * 1000;
const seen = new Map(); // position id -> first time the venue showed its coins gone
const fail = ops.fail;
const productOf = (p) => p.brokerProduct || p.asset;
const baseOfPos = (p) => ops.baseOf(productOf(p));

// This position's share of the venue balance: the coins held there less other open positions' there.
async function heldFor(ledger, pos) {
  const bal = await venues.api(pos).getAvailable(baseOfPos(pos));
  if (!bal || !bal.ok) return { ok: false, error: bal ? bal.error : 'no answer' };
  const total = (bal.available || 0) + (bal.hold || 0);
  const others = ledger.getActivePositions().filter((p) => p.id !== pos.id && p.broker === pos.broker && baseOfPos(p) === baseOfPos(pos)).reduce((s, p) => s + (p.positionSize || 0), 0);
  const held = Math.max(0, total - others);
  return { ok: true, held, total, share: pos.positionSize > 0 ? held / pos.positionSize : 0 };
}

// The venue's SELL fills of the coin since the entry that SignalDesk has not booked.
async function externalSells(ledger, pos) {
  const base = baseOfPos(pos);
  const since = (pos.openedAt || Date.now()) - 5000; // after the entry (a sell before it is not this position's)
  const r = await venues.orders(pos).listOrders({ sinceMs: since, side: 'SELL', products: [`${base}-USD`, `${base}-USDC`, `${base}-USDT`] }).catch((err) => ({ ok: false, error: err.message }));
  if (!r || !r.ok) return [];
  const known = new Set([...ledger.getTradeJournal().flatMap((t) => [t.brokerExitId, ...((t.externalClose && t.externalClose.sellIds) || [])]), // already booked (incl. an earlier external close)
    ...ledger.getActivePositions().map((p) => p.brokerManualExitId)].filter(Boolean));
  return r.orders.filter((o) => o.filledQty > 0 && o.avgFillPrice > 0 && !known.has(o.orderId) && !(o.filledAt && o.filledAt < since)).sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0));
}

async function closeExternally(ledger, id, { force = false, auto = false } = {}) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw fail('NO_POSITION', `no open position ${id}`);
  if (!venues.isLiveCrypto(pos)) throw fail('NOT_LIVE_CRYPTO', `${id} is not a live crypto position at a broker`);
  ops.claim(id);
  try {
    const h = await heldFor(ledger, pos);
    if (!h.ok) throw fail('BROKER_UNREACHABLE', `could not read the ${pos.broker} balance (${h.error}); nothing changed`);
    if (h.share > (auto ? GONE_SHARE : DUST_SHARE) && !force) {
      throw fail('STILL_HELD', `${pos.broker} still holds ${h.held} ${baseOfPos(pos)} (${(h.share * 100).toFixed(1)}% of this position): sell them there first, or confirm writing them off`);
    }
    const api = venues.api(pos);
    const s = pos.brokerId ? await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId }).catch(() => null) : null;
    if (s && s.ok && s.exit && s.exit.status === 'open' && s.exit.brokerExitId) {
      const c = await api.cancelOrder(s.exit.brokerExitId);
      ops.log(`${id}: canceled its ${pos.broker} stop ${s.exit.brokerExitId} (the coins were sold outside SignalDesk): ${c.ok ? 'ok' : c.error}`);
    }
    let sold = 0; let value = 0; let fees = 0; let at = 0; const used = [];
    const sells = await externalSells(ledger, pos);
    for (const o of sells) {
      if (sold >= pos.positionSize * 0.999) break;
      const q = Math.min(o.filledQty, pos.positionSize - sold);
      sold += q; value += q * o.avgFillPrice; fees += (o.fees || 0) * (q / o.filledQty); at = Math.max(at, o.filledAt || 0); used.push(o.orderId);
    }
    const real = sold >= pos.positionSize * 0.5;
    const px = real ? value / sold : prices.getLatestPrice(pos.asset) || prices.getMarkPrice(pos.asset) || pos.fillPrice;
    const basis = real ? `${used.length} sell(s) found at ${pos.broker}` : `the last price (no sell found at ${pos.broker})`;
    const trade = ledger.closePosition(id, px, 'CLOSED_EXTERNALLY', {
      exitLeg: 'manual', pnlSource: real ? 'broker-fills' : 'estimated', ...(real ? { actualFees: (Number(pos.entryFeeActual) || 0) + fees, ...(at ? { closedAt: at } : {}) } : {}),
      ...(real ? { brokerExitId: used[0] } : {}), externalClose: { auto, force, leftAtVenue: h.held, basis, sellIds: real ? used : [] },
    });
    seen.delete(id);
    console.warn(`[external] ${id}: CLOSED_EXTERNALLY @ ${px} (${basis}${h.held > 0 ? `; ${h.held} left at ${pos.broker}` : ''})${auto ? ' [auto: the venue shows it gone]' : ''}`);
    return { id, trade, basis, leftAtVenue: h.held };
  } finally { ops.release(id); }
}

async function autoCheck(ledger, pos, now = Date.now()) {
  if (!venues.isLiveCrypto(pos) || pos.adopted || ops.isBusy(pos.id) || pos.marketExitPending || pos.brokerManualExitId) return null;
  const h = await heldFor(ledger, pos).catch(() => null);
  if (!h || !h.ok) return null;
  if (h.share > GONE_SHARE) { seen.delete(pos.id); return null; }
  const first = seen.get(pos.id);
  if (!first) { seen.set(pos.id, now); console.warn(`[external] ${pos.id}: ${pos.broker} shows no ${baseOfPos(pos)} left for it; booking it as closed externally if the next pass agrees`); return null; }
  if (now - first < CONFIRM_MS) return null;
  return closeExternally(ledger, pos.id, { auto: true });
}

function handle(ws, msg, send, broadcast, ledger) {
  if (msg.type !== 'CLOSE_EXTERNALLY') return false;
  const id = String(msg.id || '');
  closeExternally(ledger, id, { force: msg.force === true })
    .then((r) => send(ws, 'EXTERNAL_CLOSE_RESULT', { requestId: msg.requestId, ok: true, id, exitPrice: r.trade.exitPrice, netPnl: r.trade.netPnl, basis: r.basis, leftAtVenue: r.leftAtVenue }))
    .catch((err) => send(ws, 'EXTERNAL_CLOSE_RESULT', { requestId: msg.requestId, ok: false, id, code: err.code || null, error: err.message }))
    .finally(() => { broadcast('POSITIONS_UPDATED', ledger.getActivePositions()); broadcast('JOURNAL_UPDATED', ledger.getTradeJournal()); });
  return true;
}

module.exports = { closeExternally, autoCheck, handle, externalSells, GONE_SHARE, DUST_SHARE, CONFIRM_MS, _seen: seen };
