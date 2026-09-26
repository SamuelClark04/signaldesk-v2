// [Close at Coinbase] (Phase 60): close a LIVE Coinbase position from SignalDesk.
// A live position's exits sit at Coinbase as ONE trigger-bracket order (take-profit
// limit + stop trigger), attached to the entry (or re-placed on its own:
// pos.brokerBracketId). While it works, the coins are ON HOLD, so a market sell must
// wait until it is gone:
//   1. look up  the entry (its real fees) and the bracket's state. Already FILLED:
//               the broker closed the position; reconcile it and sell nothing
//   2. cancel   the bracket (batch_cancel)
//   3. verify   it reads CANCELED and the coins are released (available >= the
//               quantity), polling up to timing.verifyMs. It FILLED in the race:
//               reconcile, sell nothing. Not released: sell nothing, and re-arm
//               protection if the cancel went through
//   4. sell     a market IOC SELL of the quantity, on the book it was bought on
//   5. book     at the real average fill: closePosition(..., 'MANUAL_CLOSE @ Coinbase'),
//               fees = the entry order's + the sell's (broker truth, pnlSource
//               'broker-fills')
// Never stranded: a refused sell re-places the bracket (coinbase-orders.placeBracket);
// a sell still working after timing.fillWaitMs is recorded (brokerManualExitId) and
// the reconciler books it (settle); a partial fill books the sold part and re-arms
// the rest. Adopted holdings (bought outside SignalDesk) have no bracket: 4-5 only.
// One close per position at a time (isClosing); the reconciler skips it meanwhile.
const api = require('../connectors/coinbase-api');
const orders = require('../connectors/coinbase-orders');
const be = require('../risk/break-even');
const prices = require('../market/latest-prices');
// Phase 63 execution audit: right before the sell, the expected cashout (Coinbase's best
// bid x qty less the exact taker fee; no fresh bid: the last price) is recorded; the
// booked trade carries cashoutAudit { expected, actual (qty x avg fill - real fee), variance }.

const timing = { pollMs: 700, verifyMs: 8000, fillWaitMs: 15000 };
const EXIT_REASON = 'MANUAL_CLOSE @ Coinbase';
const QTY_EPS = 1e-9;
const closing = new Set();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const baseOf = (product) => String(product).replace(/-USDC?$/, '');
const fail = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
const log = (msg) => console.warn(`[LIVE] ${msg}`);

// Poll `read` until `done(result)` or the time runs out; the last result either way.
async function pollUntil(read, done, ms) {
  const until = Date.now() + ms;
  let r = await read();
  while (!done(r) && Date.now() < until) { await sleep(timing.pollMs); r = await read(); }
  return r;
}

// Protection back on for `qty` at the position's own stop / T1 (a stand-alone bracket).
async function rearm(ledger, pos, qty, why) {
  const tp = pos.targets && pos.targets[0] && pos.targets[0].price;
  const r = await orders.placeBracket(pos.brokerProduct || pos.asset, qty, tp, pos.invalidation, `${pos.id}:rearm:${Date.now()}`);
  if (r.ok) {
    ledger.updatePositions((p) => (p.id === pos.id ? Object.assign(p, { brokerBracketId: r.brokerId }) && true : false));
    log(`${pos.id}: bracket RE-ARMED as ${r.brokerId} (${qty} at stop ${pos.invalidation} / T1 ${tp}) after ${why}`);
  } else {
    console.error(`[LIVE] CRITICAL ${pos.id}: ${why}, and re-placing its stop/target FAILED (${r.error}). The position is UNPROTECTED at Coinbase: set a stop there now.`);
  }
  return r;
}

// Book a filled sell: the whole position, or (partial) the sold part split off first.
function book(ledger, pos, fill, entryFees, extra, expected = null) {
  let id = pos.id;
  const partial = fill.filledQty + QTY_EPS < fill.soldQty;
  if (partial) id = ledger.splitPosition(pos.id, fill.filledQty).id;
  const cashoutAudit = expected ? be.cashoutVariance({ ...expected, filledQty: fill.filledQty, avgFillPrice: fill.avgFillPrice, fees: fill.fees || 0 }) : null;
  const trade = ledger.closePosition(id, fill.avgFillPrice, EXIT_REASON, {
    exitLeg: 'manual', pnlSource: 'broker-fills', actualFees: entryFees + fill.fees, brokerExitId: fill.orderId, ...(cashoutAudit ? { cashoutAudit } : {}), ...extra,
  });
  log(`${pos.id}: SOLD ${fill.filledQty} ${pos.asset} @ ${fill.avgFillPrice} (fees ${(entryFees + fill.fees).toFixed(4)}), net ${trade.netPnl.toFixed(2)}${partial ? ' (partial fill)' : ''}`);
  return { trade, partial };
}

// What the sell should deposit, right before it is sent: { expected, expectedQty, expectedBid, basis, at }.
function expectedCashout(pos, product, qty, now = Date.now()) {
  const q = be.liveQuote(product, now) || be.liveQuote(pos.asset, now);
  const px = q ? q.bid : prices.getLatestPrice(pos.asset);
  if (!(px > 0)) return null;
  return { expected: px * qty * (1 - be.exactRate('crypto', 'taker')), expectedQty: qty, expectedBid: px, basis: q ? 'best bid' : 'last price', at: now };
}

// The bracket's state: { entryFees, bracketId, filled } from the entry's order status.
async function bracketOf(pos) {
  if (pos.adopted) return { entryFees: 0, bracketId: null, filled: false }; // bought outside SignalDesk: no bracket, fees unknown
  const s = await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId });
  if (!s.ok) throw fail('BROKER_UNREACHABLE', `could not read ${pos.id}'s orders (${s.error}); nothing was canceled or sold`);
  if (!(s.filledQty > 0)) throw fail('ENTRY_NOT_FILLED', 'the entry has not filled at Coinbase; nothing to sell');
  const x = s.exit;
  return { entryFees: s.fees || 0, bracketId: x && x.status === 'open' ? x.brokerExitId : null, filled: !!(x && x.filledQty > 0), status: s };
}

async function closeLive(ledger, id) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw fail('NO_POSITION', `no open position ${id}`);
  if (pos.execution !== 'LIVE' || pos.broker !== 'Coinbase' || pos.market !== 'crypto') throw fail('NOT_LIVE_COINBASE', `${id} is not a live Coinbase crypto position`);
  if (closing.has(id)) throw fail('ORDER_BUSY', `${id} is already being closed`);
  closing.add(id);
  try {
    const product = pos.brokerProduct || pos.asset;
    const qty = pos.positionSize;
    log(`${id}: MANUAL CLOSE requested: ${qty} ${product}`);
    // 1. Look up the bracket.
    const b = await bracketOf(pos);
    const reconcile = async (why) => {
      closing.delete(id); // the reconciler skips positions mid-close
      const r = await require('./reconciler').reconcileLivePositions([ledger.getActivePositions().find((p) => p.id === id)].filter(Boolean), ledger);
      const closed = r.find((x) => x.action === 'closed');
      log(`${id}: ${why}; ${closed ? `booked the broker's own exit @ ${closed.trade.exitPrice}` : 'reconciler will book it'}`);
      return { alreadyClosed: true, trade: closed ? closed.trade : null, detail: why };
    };
    if (b.filled) return reconcile('its stop/target already filled at Coinbase; nothing sold');
    // 2. Cancel it.
    let canceled = false;
    if (b.bracketId) {
      const c = await api.cancelOrder(b.bracketId);
      canceled = c.ok;
      log(`${id}: cancel bracket ${b.bracketId}: ${c.ok ? 'accepted' : c.error}`);
      // 3. Verify: canceled (or filled in the race) at Coinbase.
      const st = await pollUntil(() => api.getOrderStatus(pos.brokerId, { exitId: b.bracketId }),
        (s) => s.ok && s.exit && (s.exit.filledQty > 0 || s.exit.status === 'canceled'), timing.verifyMs);
      if (st.ok && st.exit && st.exit.filledQty > 0) return reconcile('the bracket filled while canceling; nothing sold');
      if (!(st.ok && st.exit && st.exit.status === 'canceled')) {
        if (canceled) await rearm(ledger, pos, qty, 'an unverified bracket cancel');
        throw fail('BRACKET_NOT_CANCELED', `Coinbase did not confirm the stop/target (${b.bracketId}) canceled${c.ok ? '' : `: ${c.error}`}; nothing was sold`);
      }
    }
    // 3b. The coins must be free (the hold released) before selling.
    const cur = baseOf(product);
    const bal = await pollUntil(() => api.getAvailable(cur), (r) => r.ok && r.available + QTY_EPS >= qty * (1 - 1e-6), timing.verifyMs);
    if (!(bal.ok && bal.available + QTY_EPS >= qty * (1 - 1e-6))) {
      if (b.bracketId) await rearm(ledger, pos, qty, 'the hold was not released');
      throw fail('HOLD_NOT_RELEASED', bal.ok ? `Coinbase shows ${bal.available} ${cur} available (${bal.hold} on hold) for a ${qty} sell; nothing was sold` : bal.error);
    }
    // 4. Sell (the expected cashout recorded first: the execution audit).
    const expected = expectedCashout(pos, product, qty);
    const sell = await orders.sellMarket(product, qty, `${id}:manual-close`);
    if (!sell.ok) {
      if (b.bracketId) await rearm(ledger, pos, qty, `a refused sell (${sell.error})`);
      throw fail('SELL_FAILED', `${sell.error}${b.bracketId ? '; the stop/target was re-placed' : ''}`);
    }
    log(`${id}: market SELL ${sell.qty} ${product} accepted as ${sell.brokerId}`);
    // 5. Book the fill.
    const o = await pollUntil(() => api.getOrder(sell.brokerId), (r) => r.ok && r.terminal, timing.fillWaitMs);
    if (!(o.ok && o.terminal)) {
      ledger.updatePositions((p) => (p.id === id ? Object.assign(p, { brokerManualExitId: sell.brokerId, brokerManualExitQty: sell.qty, brokerManualExitExpected: expected }) && true : false));
      log(`${id}: sell ${sell.brokerId} still working; the reconciler books it when it fills`);
      return { pending: true, brokerExitId: sell.brokerId };
    }
    if (!(o.filledQty > 0 && o.avgFillPrice > 0)) {
      if (b.bracketId) await rearm(ledger, pos, qty, `a sell that ended ${o.status} unfilled`);
      throw fail('SELL_UNFILLED', `the market sell ended ${o.status} with nothing filled`);
    }
    const fill = { orderId: sell.brokerId, filledQty: Math.min(o.filledQty, qty), soldQty: sell.qty, avgFillPrice: o.avgFillPrice, fees: o.fees };
    const done = book(ledger, pos, fill, b.entryFees, { canceledBracketId: b.bracketId }, expected);
    if (done.partial && b.bracketId) await rearm(ledger, pos, qty - fill.filledQty, 'a partial sell');
    return done;
  } finally {
    closing.delete(id);
  }
}

// Reconciler hook: a manual sell that was still working when closeLive returned.
async function settle(pos, ledger) {
  const o = await api.getOrder(pos.brokerManualExitId);
  if (!o.ok || !o.terminal) return { id: pos.id, action: 'waiting', detail: o.ok ? `manual sell ${o.status}` : o.error };
  if (!(o.filledQty > 0 && o.avgFillPrice > 0)) {
    ledger.updatePositions((p) => (p.id === pos.id ? Object.assign(p, { brokerManualExitId: null }) && true : false));
    await rearm(ledger, pos, pos.positionSize, `a manual sell that ended ${o.status} unfilled`);
    return { id: pos.id, action: 'unchanged', detail: `manual sell ${o.status} unfilled` };
  }
  const s = pos.adopted ? { ok: true, fees: 0 } : await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId });
  const fill = { orderId: pos.brokerManualExitId, filledQty: Math.min(o.filledQty, pos.positionSize), soldQty: pos.brokerManualExitQty || pos.positionSize, avgFillPrice: o.avgFillPrice, fees: o.fees };
  const { trade } = book(ledger, pos, fill, s.ok ? s.fees || 0 : 0, {}, pos.brokerManualExitExpected || null);
  return { id: pos.id, action: 'closed', detail: `manual sell filled @ ${o.avgFillPrice}`, trade };
}

module.exports = { closeLive, settle, isClosing: (id) => closing.has(id), timing, EXIT_REASON };
