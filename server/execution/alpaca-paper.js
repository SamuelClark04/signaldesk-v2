// Alpaca PAPER as SignalDesk's paper broker for stocks and options (Phase 71). With Settings'
// "Paper broker: Alpaca Paper" (paperStockBroker 'alpaca', the default) and Alpaca paper keys,
// an approved PAPER stock / options order executes in the Alpaca Paper account instead of the
// internal simulator:
//   stocks   a bracket order (market entry + T1 limit + stop at Alpaca: whole shares with a T1;
//            otherwise, e.g. a fractional Pilot buy, it fills in the internal paper ledger)
//   options  one multi-leg limit order at the plan's net debit (alpaca-options.openSpread);
//            SignalDesk decides the exit (premium stop / target) and sends a closing market order
// The position stays execution 'PAPER' (paperBroker 'alpaca', broker 'Alpaca Paper'): it counts in
// the stocks / options PAPER pool only, never in live cash, live equity or Pilot's real book.
// The reconciler books Alpaca's real fills (entry, bracket exits, closing orders).
const alpaca = require('../connectors/alpaca-api').paper;
const spreads = require('../connectors/alpaca-options');
const spreadEntry = require('./spread-entry'); // Phase 74: marketable limits (paper fills only at the NBBO), re-price, give up
const spreadExit = require('./spread-exit'); // Phase 83: mid-pegged limit exits + resting targets (never a market order)
const optionsData = require('../connectors/options-data');
const prices = require('../market/latest-prices');

const BROKER = 'Alpaca Paper';
const FILL_WAIT_MS = 8000;
const isAtAlpaca = (p) => !!p && p.paperBroker === 'alpaca';
const enabled = (settings) => settings.stockMode !== 'live' && settings.paperStockBroker !== 'internal' && alpaca.configured();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const closing = new Set(); // position ids whose close is being sent (the reconciler leaves them alone)

// null when the order can go to Alpaca Paper, else why it fills in the internal paper ledger.
function whyInternal(o, livePrice) {
  if (o.market === 'stocks') return alpaca.validateOrder(o, o.positionSize, livePrice);
  if (o.market === 'options') return spreads.legsOf(o.optionsData).length ? null : 'no option contract on this plan';
  return 'crypto paper trades are simulated';
}

async function open(ledger, order, livePrice, resized = null) {
  const o = resized || order;
  const why = whyInternal(o, livePrice);
  if (why) {
    console.log(`[paper] ${o.id}: filled in the internal paper ledger (${why})`);
    return ledger.executeOrder(order.id, livePrice, { paperBrokerNote: `simulated: ${why}` }, resized);
  }
  const px = o.market === 'options' ? await spreadEntry.limitFor(o.optionsData) : null;
  const r = px ? await spreads.openSpread(o, o.positionSize, px.limit) : await alpaca.submitOrder(o, o.positionSize, livePrice);
  if (!r.ok) throw new Error(`PAPER_ORDER_FAILED: ${r.error}`);
  console.log(`[paper] ${o.id}: sent to ${BROKER} as ${r.brokerId}${px ? ` at ${px.limit} net (plan ${o.optionsData.debit}, ${px.basis})` : ''}`);
  const now = Date.now();
  const work = px ? { entryWork: { placedAt: now, repricedAt: now, reprices: 0, limit: px.limit, natural: px.natural, cap: px.cap } } : {};
  return ledger.executeOrder(order.id, livePrice, { execution: 'PAPER', paperBroker: 'alpaca', broker: BROKER, brokerId: r.brokerId, brokerEnvironment: 'alpaca-paper',
    fillEstimated: true, brokerEntryType: r.entryType || 'market', ...(r.limitPrice ? { limitPrice: r.limitPrice } : {}), ...work }, resized);
}

const patch = (ledger, id, f) => ledger.updatePositions((p) => (p.id === id ? Object.assign(p, f) && true : false));

// Book an Alpaca fill that closed the position.
function book(ledger, pos, o, reason, leg) {
  const extra = { exitLeg: leg, pnlSource: 'broker-fills', brokerExitId: o.orderId, ...(o.filledAt ? { closedAt: o.filledAt } : {}) };
  if (pos.market !== 'options') return ledger.closePosition(pos.id, o.avgFillPrice, reason, { ...extra, actualFees: 0 }); // commission-free
  const od = pos.optionsData;
  const v = Math.abs(o.avgFillPrice);
  const underlying = prices.getLatestPrice(pos.asset) || prices.getMarkPrice(pos.asset) || pos.fillPrice;
  const q = require('./exit-quote').quote(pos, underlying, /^TAKE_PROFIT/.test(reason) ? 'target' : 'stop');
  const gross = (v - od.debit) * od.multiplier * pos.positionSize;
  const fees = q && Number.isFinite(q.fees) ? q.fees : 0;
  return ledger.closePosition(pos.id, underlying, reason, extra, { exitValue: v, gross, fees, net: gross - fees, basis: `${BROKER} fill` });
}

// Positions whose Alpaca orders the generic reconciler cannot read: options (a spread's legs are not
// exits; the fill price is a net debit, not the underlying) and any closing order in flight.
async function reconcileOwn(pos, ledger) {
  if (pos.paperExitOrderId && pos.market === 'options') { // Phase 83: a limit exit / resting target (spread-exit.js)
    const m = await spreadExit.manage(ledger, pos, exitDeps());
    return m && m.trade ? { id: pos.id, action: 'closed', trade: m.trade } : { id: pos.id, action: 'waiting', detail: m && m.cleared ? 'closing order ended unfilled' : 'closing order working' };
  }
  if (pos.paperExitOrderId) {
    const o = await alpaca.getOrder(pos.paperExitOrderId);
    if (!o.ok) return { id: pos.id, action: 'error', detail: o.error };
    if (o.filledQty > 0 && o.terminal) return { id: pos.id, action: 'closed', trade: book(ledger, pos, o, pos.paperExitReason || `MANUAL_CLOSE @ ${BROKER}`, pos.paperExitLeg || 'manual') };
    if (o.terminal) patch(ledger, pos.id, { paperExitOrderId: null, paperExitReason: null }); // ended unfilled: tried again
    return { id: pos.id, action: 'waiting', detail: `closing order ${o.status}` };
  }
  const s = await alpaca.getOrderStatus(pos.brokerId);
  if (!s.ok) return { id: pos.id, action: 'error', detail: s.error };
  if (s.terminal && !(s.filledQty > 0)) { ledger.voidLivePosition(pos.id, `ENTRY_${String(s.status).toUpperCase()}`); return { id: pos.id, action: 'voided' }; }
  if (!(s.filledQty > 0) && pos.fillEstimated) { // Phase 74: still working: re-price toward the natural price, or give up
    const w = await spreadEntry.work(pos, s, { api: alpaca, place: (limit, n) => spreads.openSpread(pos, pos.positionSize, limit, `:r${n}`) });
    if (!w) return { id: pos.id, action: 'unchanged' };
    if (w.patch) patch(ledger, pos.id, w.patch);
    if (w.void) { ledger.voidLivePosition(pos.id, w.void); console.warn(`[paper] ${pos.id}: ${w.detail}`); } else if (w.action === 'repriced') console.log(`[paper] ${pos.id}: ${w.detail}`);
    return { id: pos.id, action: w.action, detail: w.detail };
  }
  if (s.filledQty > 0 && pos.fillEstimated) {
    patch(ledger, pos.id, { fillEstimated: false, brokerFillSyncedAt: Date.now(), optionsData: { ...pos.optionsData, debit: Math.abs(s.avgFillPrice) || pos.optionsData.debit, plannedDebit: pos.optionsData.debit } });
    return { id: pos.id, action: 'synced' };
  }
  return { id: pos.id, action: 'unchanged' };
}

// Send the closing order for `pos`; book it when it fills within FILL_WAIT_MS, else leave it pending.
async function sendClose(ledger, pos, reason, leg) {
  closing.add(pos.id);
  try { return await sendCloseNow(ledger, pos, reason, leg); } finally { closing.delete(pos.id); }
}
// Phase 72: an entry Alpaca has not filled (status new, filled_qty 0) is a WORKING order, not a
// position: [Close] cancels it (never a closing trade: sell_to_close / a market sell of contracts or
// shares not held would open the opposite side). Voided once Alpaca confirms nothing filled; filled
// in the race: synced, then closed like any position.
async function cancelEntry(ledger, pos) {
  const c = await alpaca.cancelOrder(pos.brokerId);
  if (!c.ok) throw new Error(`PAPER_CANCEL_FAILED: ${BROKER} did not cancel the working order ${pos.brokerId} (${c.error})`);
  const until = Date.now() + FILL_WAIT_MS;
  for (;;) {
    const s = await alpaca.getOrderStatus(pos.brokerId);
    if (s.ok && s.filledQty > 0) return { filled: true };
    if (s.ok && s.terminal) { ledger.voidLivePosition(pos.id, 'ENTRY_CANCELED'); console.log(`[paper] ${pos.id}: working order ${pos.brokerId} canceled at ${BROKER} (nothing filled)`); return { canceled: true }; }
    if (Date.now() >= until) return { pending: true, brokerExitId: pos.brokerId, cancelPending: true };
    await sleep(700);
  }
}

async function sendCloseNow(ledger, pos0, reason, leg) {
  let pos = pos0;
  if (pos.fillEstimated) {
    const e = await alpaca.getOrderStatus(pos.brokerId);
    if (!e.ok) throw new Error(`PAPER_CLOSE_FAILED: could not read the entry order (${e.error})`);
    if (!(e.filledQty > 0)) { const x = await cancelEntry(ledger, pos); if (!x.filled) return x; }
    const f = e.filledQty > 0 ? e : await alpaca.getOrderStatus(pos.brokerId); // record the real fill first
    if (pos.market === 'options') await reconcileOwn(pos, ledger);
    else if (f.ok && f.avgFillPrice > 0) ledger.syncLiveFill(pos.id, { fillPrice: f.avgFillPrice, filledQty: Math.min(f.filledQty, pos.positionSize) });
    pos = ledger.getActivePositions().find((p) => p.id === pos.id);
    if (!pos) return { alreadyClosed: true };
  }
  let r;
  if (pos.market === 'options') { // Phase 83: never a market order
    const x = await spreadExit.startExit(ledger, pos, reason, leg, exitDeps());
    if (x.trade || x.alreadyClosed) return x;
    if (x.error) throw new Error(`PAPER_CLOSE_FAILED: ${x.error}`);
    if (x.pending && !x.limit) return { pending: true, brokerExitId: x.brokerExitId }; // the old order's cancel is not confirmed yet
    r = { ok: true, brokerId: x.brokerExitId, placed: true };
  } else {
    const s = await alpaca.getOrderStatus(pos.brokerId);
    if (s.ok && s.exit && s.exit.filledQty > 0) return { alreadyClosed: true }; // its bracket filled first: the reconciler books it
    for (const leg1 of (s.ok && s.legIds) || []) await alpaca.cancelOrder(leg1);
    await sleep(500);
    r = pos.direction === 'short'
      ? await alpaca.request('/v2/orders', { method: 'POST', body: { symbol: pos.asset, qty: String(pos.positionSize), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: `${pos.id}:close:${Date.now()}`.slice(0, 128) } })
        .then((x) => (x.ok ? { ok: true, brokerId: x.body.id } : x))
      : await alpaca.sellMarket(pos.asset, pos.positionSize, `${pos.id}:close:${Date.now()}`);
  }
  if (!r.ok) throw new Error(`PAPER_CLOSE_FAILED: ${r.error}`);
  if (!r.placed) patch(ledger, pos.id, { paperExitOrderId: r.brokerId, paperExitReason: reason, paperExitLeg: leg });
  const until = Date.now() + FILL_WAIT_MS;
  while (Date.now() < until) {
    const o = await alpaca.getOrder(r.brokerId);
    const still = ledger.getActivePositions().find((p) => p.id === pos.id);
    if (!still) return { alreadyClosed: true };
    if (o.ok && o.terminal && o.filledQty > 0) return { trade: book(ledger, still, o, reason, leg) };
    await sleep(700);
  }
  return { pending: true, brokerExitId: r.brokerId };
}

// Options at Alpaca (Phase 83, every 5 s from exit-pass.fastOptions + the reconcile pass):
//   a working close   stepped / booked / cleared (spread-exit.manage)
//   stop (premiumExit, inside the 9:35-3:45 window)  -> a mid-pegged limit exit (the resting target is canceled first)
//   no working order, window open  -> the take-profit rests at the broker as a limit at the target value
// Phase 85: ONE run at a time (the fast loop, the pipeline's exit pass and the reconciler share it: two runs could each
// rest a take-profit, the second orphaning the first), positions handled side by side (Promise.allSettled: one slow
// Alpaca reply never holds the others); every Alpaca call has its own 8 s timeout (alpaca-api TIMEOUT_MS).
// An exit step re-quotes its legs when their quotes are older than EXIT_QUOTE_MAX_AGE_MS.
const EXIT_QUOTE_MAX_AGE_MS = 10 * 1000;
const exitDeps = () => ({ api: alpaca, place: (pos, limit, id) => spreads.closeSpread(pos, id, limit), book, fresh: optionsData.freshQuote,
  refresh: (symbols, now) => optionsData.refreshQuotes(symbols, now, (u) => prices.getLatestPrice(u), EXIT_QUOTE_MAX_AGE_MS) });
let exitsRun = null;
function exits(ledger, now = Date.now()) {
  if (!exitsRun) exitsRun = exitsOnce(ledger, now).finally(() => { exitsRun = null; });
  return exitsRun;
}
async function exitsOnce(ledger, now) {
  const out = [];
  const { premiumExit } = require('./exit-monitor');
  const win = require('./options-exit-window');
  const mine = () => ledger.getActivePositions().filter((p) => isAtAlpaca(p) && p.market === 'options' && !p.fillEstimated && p.optionsData && p.optionsData.exitRule && !closing.has(p.id));
  await Promise.allSettled(mine().map(async (pos0) => {
    try {
      let pos = pos0;
      if (pos.paperExitOrderId) {
        const m = await spreadExit.manage(ledger, pos, exitDeps(), now);
        if (m && m.trade) { out.push({ id: pos.id, reason: pos.paperExitReason, trade: m.trade }); return; }
        pos = ledger.getActivePositions().find((p) => p.id === pos0.id);
        if (!pos || (pos.paperExitOrderId && !(pos.exitWork && pos.exitWork.kind === 'target'))) return; // an exit is working
      }
      const px = prices.getLatestPrice(pos.asset);
      const reason = px > 0 ? premiumExit(pos, px, now) : null;
      if (reason === 'STOP_LOSS') { out.push({ id: pos.id, reason, ...(await sendClose(ledger, pos, reason, 'stop_loss')) }); return; }
      if (!pos.paperExitOrderId && win.inWindow(now) && !closing.has(pos.id)) { // never next to a [Close] being sent
        const t = await spreadExit.placeTarget(ledger, pos, exitDeps(), now);
        if (t && t.error) console.error(`[paper] ${pos.id}: resting target at ${BROKER} refused: ${t.error}`);
      }
    } catch (err) { console.error(`[paper] ${pos0.id}: option exit at ${BROKER} failed: ${err.message}`); }
  }));
  return out;
}

// [Close] on a paper position held at Alpaca Paper.
function handleClose(ws, id, { send, broadcast, ledger, inFlight, publish }) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  inFlight.add(id);
  sendClose(ledger, pos, `MANUAL_CLOSE @ ${BROKER}`, 'manual')
    .then((r) => {
      if (r.cancelPending) send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: `${BROKER} has not confirmed the cancel of the working order ${r.brokerExitId} yet; it is removed once Alpaca reports it canceled` });
      else if (r.pending || r.alreadyClosed) send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: r.pending ? `${BROKER} is still filling the close (${r.brokerExitId}); it is booked when it fills` : 'its bracket already filled at Alpaca Paper; the reconciler books it' });
    })
    .catch((err) => send(ws, 'ACTION_FAILED', { type: 'CLOSE_POSITION', id, error: err.message }))
    .finally(() => { inFlight.delete(id); broadcast('POSITIONS_UPDATED', ledger.getActivePositions()); broadcast('JOURNAL_UPDATED', ledger.getTradeJournal()); if (publish) publish(); });
}

module.exports = { isClosing: (id) => closing.has(id), BROKER, enabled, isAtAlpaca, whyInternal, open, reconcileOwn, exits, exitDeps, sendClose, handleClose, book };
