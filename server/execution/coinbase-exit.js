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
//   4. sell     a market IOC SELL of the quantity, on the book it was bought on, with a
//               client_order_id unique per attempt (Phase 67: "<id>:manual-close:<ms>";
//               Coinbase answers a repeated id with the OLD order instead of selling)
//   5. book     at the real average fill: closePosition(..., 'MANUAL_CLOSE @ Coinbase'),
//               fees = this record's share of the entry order's + the sell's (broker
//               truth, pnlSource 'broker-fills')
// Never stranded: a refused sell re-places the bracket (coinbase-orders.placeBracket);
// a sell still working after timing.fillWaitMs is recorded (brokerManualExitId) and
// the reconciler books it (settle); a partial fill books the sold part and re-arms
// the rest. Adopted holdings (bought outside SignalDesk) have no bracket: 4-5 only.
// Phase 67:
//   - a sell that errs WITHOUT a clear answer (timeout, 429, 5xx: `uncertain`) is not
//     assumed failed: the position is marked marketExitPending (+ UNARMORED) and Coinbase is
//     asked (the order by its client_order_id, and the coins' balance). Found: booked like
//     any sell. Clearly not placed (not listed AND the coins still free): re-armed. Still
//     unknown: left pending; the reconciler asks again every pass (resolvePending)
//   - every re-arm outcome is reported truthfully; a failed re-arm is a CRITICAL error that
//     says the position is UNARMORED at Coinbase, and the position carries bracketStatus
// One close per position at a time (isClosing); the reconciler skips it meanwhile.
const api = require('../connectors/coinbase-api');
const orders = require('../connectors/coinbase-orders');
const be = require('../risk/break-even');
const prices = require('../market/latest-prices');
const { entryShare } = require('./ledger-live');
// Phase 63 execution audit: right before the sell, the expected cashout (Coinbase's best
// bid x qty less the exact taker fee; no fresh bid: the last price) is recorded; the
// booked trade carries cashoutAudit { expected, actual (qty x avg fill - real fee), variance }.

const timing = { pollMs: 700, verifyMs: 8000, fillWaitMs: 15000, settleMs: 2000, pendingGiveUpMs: 60000 };
const EXIT_REASON = 'MANUAL_CLOSE @ Coinbase';
const QTY_EPS = 1e-9;
const closing = new Set();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const baseOf = (product) => String(product).replace(/-USDC?$/, '');
const fail = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
const log = (msg) => console.warn(`[LIVE] ${msg}`);
const PENDING_FIELDS = { marketExitPending: undefined, marketExitClientId: undefined, marketExitAt: undefined, marketExitError: undefined };
const patch = (ledger, id, fields) => ledger.updatePositions((p) => (p.id === id ? Object.assign(p, fields) && true : false));
const coinsFree = (bal, qty) => bal.ok && bal.available + QTY_EPS >= qty * (1 - 1e-6);

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
    patch(ledger, pos.id, { brokerBracketId: r.brokerId });
    ledger.setBracketStatus(pos.id, 'ARMED', null);
    log(`${pos.id}: bracket RE-ARMED as ${r.brokerId} (${qty} at stop ${pos.invalidation} / T1 ${tp}) after ${why}`);
  } else {
    ledger.setBracketStatus(pos.id, 'UNARMORED', `re-placing the stop/target after ${why} failed: ${r.error}`);
    console.error(`[LIVE] CRITICAL ${pos.id}: ${why}, and re-placing its stop/target FAILED (${r.error}). The position is UNARMORED at Coinbase: set a stop there now.`);
  }
  return r;
}

// Re-arm after `lead` went wrong, then throw what the user must know: a plain `code` error
// when protection is back, or a CRITICAL "UNARMORED" error when the re-arm failed too.
async function rearmThenFail(ledger, pos, qty, why, code, msg, lead) {
  const r = await rearm(ledger, pos, qty, why);
  if (r.ok) throw fail(code, `${msg}; the stop/target was re-placed at Coinbase`);
  throw fail('UNARMORED', `CRITICAL: ${lead} AND re-arm failed. Position is UNARMORED at Coinbase: set a stop there now (${msg}; re-arm: ${r.error})`);
}

// Book a filled sell: the whole position, or (partial) the sold part split off first. The
// booked record's fees: its share of the entry order's fee + the sell's.
function book(ledger, pos, fill, entryFees, extra, expected = null) {
  let rec = pos;
  const partial = fill.filledQty + QTY_EPS < fill.soldQty && fill.filledQty + QTY_EPS < pos.positionSize;
  if (partial) rec = ledger.splitPosition(pos.id, fill.filledQty);
  const fees = entryFees * entryShare(rec) + (fill.fees || 0);
  const cashoutAudit = expected ? be.cashoutVariance({ ...expected, filledQty: fill.filledQty, avgFillPrice: fill.avgFillPrice, fees: fill.fees || 0 }) : null;
  const trade = ledger.closePosition(rec.id, fill.avgFillPrice, EXIT_REASON, {
    exitLeg: 'manual', pnlSource: 'broker-fills', actualFees: fees, brokerExitId: fill.orderId, ...(cashoutAudit ? { cashoutAudit } : {}), ...extra,
  });
  log(`${pos.id}: SOLD ${fill.filledQty} ${pos.asset} @ ${fill.avgFillPrice} (fees ${fees.toFixed(4)}), net ${trade.netPnl.toFixed(2)}${partial ? ' (partial fill)' : ''}`);
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

// P0-2: did the uncertain sell `clientId` reach Coinbase? { order } found, { notPlaced } (not
// listed and the coins still free, twice, settleMs apart), else { unknown }.
async function verifySell(product, clientId, qty, since, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let clear = 0;
  let firstClear = 0;
  for (;;) {
    const f = await orders.findOrderByClientId(product, clientId, since);
    if (f.ok && f.order) return { order: f.order };
    const bal = f.ok ? await api.getAvailable(baseOf(product)) : { ok: false };
    if (f.ok && coinsFree(bal, qty)) {
      clear += 1;
      if (!firstClear) firstClear = Date.now();
      if (clear >= 2 && Date.now() - firstClear >= timing.settleMs) return { notPlaced: true };
    } else clear = 0;
    if (Date.now() >= until) return { unknown: true, error: f.ok ? 'the coins are not free and no order is listed yet' : f.error };
    await sleep(timing.pollMs);
  }
}

async function closeLive(ledger, id) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw fail('NO_POSITION', `no open position ${id}`);
  if (pos.execution !== 'LIVE' || pos.broker !== 'Coinbase' || pos.market !== 'crypto') throw fail('NOT_LIVE_COINBASE', `${id} is not a live Coinbase crypto position`);
  if (pos.marketExitPending) throw fail('SELL_UNCONFIRMED', 'an earlier sell of this position is still being checked at Coinbase; SignalDesk re-checks every pass');
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
    if (b.bracketId) {
      const c = await api.cancelOrder(b.bracketId);
      log(`${id}: cancel bracket ${b.bracketId}: ${c.ok ? 'accepted' : c.error}`);
      // 3. Verify: canceled (or filled in the race) at Coinbase.
      const st = await pollUntil(() => api.getOrderStatus(pos.brokerId, { exitId: b.bracketId }),
        (s) => s.ok && s.exit && (s.exit.filledQty > 0 || s.exit.status === 'canceled'), timing.verifyMs);
      if (st.ok && st.exit && st.exit.filledQty > 0) return reconcile('the bracket filled while canceling; nothing sold');
      if (!(st.ok && st.exit && st.exit.status === 'canceled')) {
        const msg = `Coinbase did not confirm the stop/target (${b.bracketId}) canceled${c.ok ? '' : `: ${c.error}`}; nothing was sold`;
        if (c.ok) await rearmThenFail(ledger, pos, qty, 'an unverified bracket cancel', 'BRACKET_NOT_CANCELED', msg, 'The bracket cancel was not confirmed');
        throw fail('BRACKET_NOT_CANCELED', msg);
      }
    }
    // 3b. The coins must be free (the hold released) before selling.
    const cur = baseOf(product);
    const bal = await pollUntil(() => api.getAvailable(cur), (r) => coinsFree(r, qty), timing.verifyMs);
    if (!coinsFree(bal, qty)) {
      const msg = bal.ok ? `Coinbase shows ${bal.available} ${cur} available (${bal.hold} on hold) for a ${qty} sell; nothing was sold` : bal.error;
      if (b.bracketId) await rearmThenFail(ledger, pos, qty, 'the hold was not released', 'HOLD_NOT_RELEASED', msg, 'The coins were not released');
      throw fail('HOLD_NOT_RELEASED', msg);
    }
    // 4. Sell (the expected cashout recorded first: the execution audit).
    const expected = expectedCashout(pos, product, qty);
    const clientId = `${id}:manual-close:${Date.now()}`; // P1-6: unique per attempt
    const sentAt = Date.now();
    let sell = await orders.sellMarket(product, qty, clientId);
    if (!sell.ok && sell.uncertain) sell = await confirmUncertain(ledger, pos, { product, qty, clientId, sentAt, expected, error: sell.error, bracketId: b.bracketId });
    if (!sell.ok) {
      if (b.bracketId) await rearmThenFail(ledger, pos, qty, `a refused sell (${sell.error})`, 'SELL_FAILED', sell.error, 'Market sell failed');
      throw fail('SELL_FAILED', sell.error);
    }
    log(`${id}: market SELL ${sell.qty} ${product} accepted as ${sell.brokerId}`);
    // 5. Book the fill.
    const o = await pollUntil(() => api.getOrder(sell.brokerId), (r) => r.ok && r.terminal, timing.fillWaitMs);
    if (!(o.ok && o.terminal)) {
      patch(ledger, id, { brokerManualExitId: sell.brokerId, brokerManualExitQty: sell.qty, brokerManualExitExpected: expected });
      log(`${id}: sell ${sell.brokerId} still working; the reconciler books it when it fills`);
      return { pending: true, brokerExitId: sell.brokerId };
    }
    if (!(o.filledQty > 0 && o.avgFillPrice > 0)) {
      const msg = `the market sell ended ${o.status} with nothing filled`;
      if (b.bracketId) await rearmThenFail(ledger, pos, qty, `a sell that ended ${o.status} unfilled`, 'SELL_UNFILLED', msg, 'Market sell did not fill');
      throw fail('SELL_UNFILLED', msg);
    }
    const fill = { orderId: sell.brokerId, filledQty: Math.min(o.filledQty, qty), soldQty: sell.qty, avgFillPrice: o.avgFillPrice, fees: o.fees };
    const done = book(ledger, pos, fill, b.entryFees, { canceledBracketId: b.bracketId }, expected);
    if (done.partial && b.bracketId) {
      const r = await rearm(ledger, pos, qty - fill.filledQty, 'a partial sell');
      if (!r.ok) done.detail = `CRITICAL: only ${fill.filledQty} of ${qty} sold AND re-arm failed. The rest is UNARMORED at Coinbase: set a stop there now (${r.error})`;
    }
    return done;
  } finally {
    closing.delete(id);
  }
}

// P0-2: the sell errored without a clear answer. Mark the position (marketExitPending, and
// UNARMORED when its bracket was canceled for this sell), then ask Coinbase what happened.
// Returns a sell result ({ ok: true, brokerId, qty } found / { ok: false } not placed), or
// throws SELL_UNCONFIRMED (the reconciler keeps asking every pass).
async function confirmUncertain(ledger, pos, { product, qty, clientId, sentAt, expected, error, bracketId }) {
  patch(ledger, pos.id, { marketExitPending: true, marketExitClientId: clientId, marketExitAt: sentAt, marketExitError: error, brokerManualExitQty: qty, brokerManualExitExpected: expected });
  if (bracketId) ledger.setBracketStatus(pos.id, 'UNARMORED', 'its stop/target was canceled for a market sell whose outcome is not confirmed yet');
  log(`${pos.id}: market SELL outcome UNKNOWN (${error}); checking Coinbase for ${clientId}`);
  const v = await verifySell(product, clientId, qty, sentAt, timing.verifyMs);
  if (v.order) {
    patch(ledger, pos.id, PENDING_FIELDS);
    return { ok: true, brokerId: v.order.orderId, qty };
  }
  if (v.notPlaced) {
    patch(ledger, pos.id, PENDING_FIELDS);
    return { ok: false, error: `${error} (confirmed: Coinbase has no such order and the coins are still free)` };
  }
  throw fail('SELL_UNCONFIRMED', `Coinbase did not answer the sell (${error}) and it cannot be confirmed yet (${v.error}). It may have gone through. `
    + 'The position is flagged UNARMORED; SignalDesk checks Coinbase every pass and books the sale or re-places the stop/target. Check Coinbase.');
}

// Reconciler hook: a sell whose outcome was unknown (marketExitPending). Found at Coinbase:
// settled like any manual sell. Clearly never placed (after pendingGiveUpMs): the marker is
// cleared and the bracket re-armed. Otherwise: still waiting.
async function resolvePending(pos, ledger) {
  const product = pos.brokerProduct || pos.asset;
  const qty = pos.brokerManualExitQty || pos.positionSize;
  const since = pos.marketExitAt || Date.now();
  const f = await orders.findOrderByClientId(product, pos.marketExitClientId, since);
  if (!f.ok) return { id: pos.id, action: 'waiting', detail: `sell outcome unknown: ${f.error}` };
  if (f.order) {
    patch(ledger, pos.id, { ...PENDING_FIELDS, brokerManualExitId: f.order.orderId });
    log(`${pos.id}: the unconfirmed sell ${pos.marketExitClientId} is at Coinbase as ${f.order.orderId}`);
    return settle({ ...pos, ...PENDING_FIELDS, brokerManualExitId: f.order.orderId }, ledger);
  }
  const bal = await api.getAvailable(baseOf(product));
  if (!coinsFree(bal, qty) || Date.now() - since < timing.pendingGiveUpMs) return { id: pos.id, action: 'waiting', detail: 'sell outcome still unknown' };
  patch(ledger, pos.id, PENDING_FIELDS);
  log(`${pos.id}: the unconfirmed sell ${pos.marketExitClientId} never reached Coinbase (not listed, coins still free)`);
  if (!pos.adopted) await rearm(ledger, pos, pos.positionSize, 'a market sell that never reached Coinbase');
  return { id: pos.id, action: 'flagged', detail: 'unconfirmed sell never placed' };
}

// Reconciler hook: a manual sell that was still working when closeLive returned.
async function settle(pos, ledger) {
  const o = await api.getOrder(pos.brokerManualExitId);
  if (!o.ok || !o.terminal) return { id: pos.id, action: 'waiting', detail: o.ok ? `manual sell ${o.status}` : o.error };
  if (!(o.filledQty > 0 && o.avgFillPrice > 0)) {
    patch(ledger, pos.id, { brokerManualExitId: null });
    if (!pos.adopted) await rearm(ledger, pos, pos.positionSize, `a manual sell that ended ${o.status} unfilled`);
    return { id: pos.id, action: 'flagged', detail: `manual sell ${o.status} unfilled` };
  }
  const s = pos.adopted ? { ok: true, fees: 0 } : await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId });
  const fill = { orderId: pos.brokerManualExitId, filledQty: Math.min(o.filledQty, pos.positionSize), soldQty: pos.brokerManualExitQty || pos.positionSize, avgFillPrice: o.avgFillPrice, fees: o.fees };
  // P0-3: a partial fill books the sold part; splitPosition strips the sell's markers from the
  // unsold remainder, so the next pass never books this fill again. The remainder is re-armed.
  const { trade, partial } = book(ledger, pos, fill, s.ok ? s.fees || 0 : 0, {}, pos.brokerManualExitExpected || null);
  if (partial && !pos.adopted) await rearm(ledger, pos, pos.positionSize - fill.filledQty, 'a partially filled manual sell');
  return { id: pos.id, action: 'closed', detail: `manual sell filled @ ${o.avgFillPrice}${partial ? ' (partial)' : ''}`, trade };
}

module.exports = { closeLive, settle, resolvePending, isClosing: (id) => closing.has(id), timing, EXIT_REASON };
