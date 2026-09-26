// Coinbase bracket operations shared by [Close at Coinbase] (coinbase-exit.js) and the profit
// ratchet (ratchet.js), Phase 68 (out of coinbase-exit.js). A live position's exits are ONE
// trigger-bracket order (take-profit limit + stop trigger) holding its coins:
//   cancelBracket  cancel it and poll until Coinbase reads it CANCELED (or FILLED in the race)
//   freeCoins      poll until the coins are released (available >= qty)
//   rearm          a stand-alone bracket back on at the position's own stop / T1, reported
//                  truthfully (ARMED, or UNARMORED + a CRITICAL log when Coinbase refuses)
//   rearmThenFail  re-arm, then throw what the user must know
//   replaceStop    Phase 68 ratchet: cancel -> verify -> coins free -> a new bracket at a HIGHER
//                  stop (same T1). A refused new bracket re-arms the OLD stop; both refused:
//                  CRITICAL, UNARMORED. Never lowers a long's stop.
// One operation per position at a time (claim / release; the reconciler skips claimed ones).
const api = require('../connectors/coinbase-api');
const orders = require('../connectors/coinbase-orders');

const timing = { pollMs: 700, verifyMs: 8000, fillWaitMs: 15000, settleMs: 2000, pendingGiveUpMs: 60000 };
const QTY_EPS = 1e-9;
const busy = new Set(); // position ids with a close / stop move in progress
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const baseOf = (product) => String(product).replace(/-USDC?$/, '');
const fail = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
const log = (msg) => console.warn(`[LIVE] ${msg}`);
const patch = (ledger, id, fields) => ledger.updatePositions((p) => (p.id === id ? Object.assign(p, fields) && true : false));
const coinsFree = (bal, qty) => bal.ok && bal.available + QTY_EPS >= qty * (1 - 1e-6);

function claim(id) {
  if (busy.has(id)) throw fail('ORDER_BUSY', `${id} already has a close or stop move in progress`);
  busy.add(id);
}
const release = (id) => busy.delete(id);

// Poll `read` until `done(result)` or the time runs out; the last result either way.
async function pollUntil(read, done, ms) {
  const until = Date.now() + ms;
  let r = await read();
  while (!done(r) && Date.now() < until) { await sleep(timing.pollMs); r = await read(); }
  return r;
}

// Cancel the bracket and wait for Coinbase's word: { filled } (it filled in the race: the
// reconciler books it), { canceled }, or neither (cancelOk: the request was accepted).
async function cancelBracket(pos, bracketId) {
  const c = await api.cancelOrder(bracketId);
  log(`${pos.id}: cancel bracket ${bracketId}: ${c.ok ? 'accepted' : c.error}`);
  const st = await pollUntil(() => api.getOrderStatus(pos.brokerId, { exitId: bracketId }),
    (s) => s.ok && s.exit && (s.exit.filledQty > 0 || s.exit.status === 'canceled'), timing.verifyMs);
  if (st.ok && st.exit && st.exit.filledQty > 0) return { filled: true };
  return { canceled: !!(st.ok && st.exit && st.exit.status === 'canceled'), cancelOk: c.ok, error: c.error };
}

const freeCoins = (product, qty) => pollUntil(() => api.getAvailable(baseOf(product)), (r) => coinsFree(r, qty), timing.verifyMs);

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

// Phase 68: move a LIVE Coinbase position's stop UP to `stop` (the bracket's T1 unchanged).
// { moved: true, bracketId } | { alreadyClosed: true } | throws (nothing sold either way).
async function replaceStop(ledger, pos, stop, label) {
  const qty = pos.positionSize;
  const product = pos.brokerProduct || pos.asset;
  const tp = pos.targets && pos.targets[0] && pos.targets[0].price;
  if (!(stop > pos.invalidation)) throw fail('RATCHET_DOWN_REFUSED', `the new stop ${stop} is not above the current ${pos.invalidation}: a stop only moves up`);
  const s = await api.getOrderStatus(pos.brokerId, { exitId: pos.brokerBracketId });
  if (!s.ok) throw fail('BROKER_UNREACHABLE', `could not read ${pos.id}'s orders (${s.error}); the stop was not changed`);
  if (s.exit && s.exit.filledQty > 0) return { alreadyClosed: true };
  if (s.exit && s.exit.status === 'open') {
    const c = await cancelBracket(pos, s.exit.brokerExitId);
    if (c.filled) return { alreadyClosed: true };
    if (!c.canceled) {
      const msg = `Coinbase did not confirm the stop/target (${s.exit.brokerExitId}) canceled${c.cancelOk ? '' : `: ${c.error}`}; the stop was not changed`;
      if (c.cancelOk) await rearmThenFail(ledger, pos, qty, 'an unverified bracket cancel', 'BRACKET_NOT_CANCELED', msg, 'The bracket cancel was not confirmed');
      throw fail('BRACKET_NOT_CANCELED', msg);
    }
  }
  const bal = await freeCoins(product, qty);
  if (!coinsFree(bal, qty)) {
    const msg = bal.ok ? `Coinbase shows ${bal.available} available (${bal.hold} on hold) for ${qty}` : bal.error;
    await rearmThenFail(ledger, pos, qty, 'the hold was not released', 'HOLD_NOT_RELEASED', `${msg}; the stop was not changed`, 'The coins were not released');
  }
  const r = await orders.placeBracket(product, qty, tp, stop, `${pos.id}:${label}:${Date.now()}`);
  if (!r.ok) {
    await rearmThenFail(ledger, pos, qty, `a refused ${label} bracket (${r.error})`, 'RATCHET_REFUSED',
      `Coinbase refused the new stop ${stop} (${r.error}); the ORIGINAL stop ${pos.invalidation} is back`, `The new stop ${stop} was refused`);
  }
  patch(ledger, pos.id, { brokerBracketId: r.brokerId });
  ledger.setBracketStatus(pos.id, 'ARMED', null);
  log(`${pos.id}: stop RAISED ${pos.invalidation} -> ${stop} (${label}) as bracket ${r.brokerId} (${qty}, T1 ${tp})`);
  return { moved: true, bracketId: r.brokerId };
}

module.exports = { timing, claim, release, isBusy: (id) => busy.has(id), pollUntil, cancelBracket, freeCoins, rearm, rearmThenFail, replaceStop, patch, coinsFree, baseOf, fail, log, sleep, QTY_EPS };
