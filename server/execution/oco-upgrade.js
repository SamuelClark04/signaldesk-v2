// OKX stop-only brackets -> OCO (Phase 70E). Positions opened before OKX brackets carried T1 (or
// whose OCO was refused and placed as the stop alone) rest only a stop at OKX, so T1 fires only
// while SignalDesk runs (ratchet.watch). The reconciler calls maybe() for each ARMED OKX position
// whose working exit has no take-profit: when it has a T1 still above the bid, the stop is
// replaced by an OCO holding BOTH (bracket-ops.replaceStop at the same stop: cancel -> verify ->
// coins free -> OCO; refused -> okx-orders places the stop alone again, nothing left unprotected).
// At most one attempt per position per RETRY_MS; never while a close / stop move is in progress.
const ops = require('./bracket-ops');
const { bidOf } = require('./ratchet');

const RETRY_MS = 10 * 60 * 1000;
const tried = new Map(); // position id -> last attempt (ms)

async function maybe(ledger, pos, status, now = Date.now()) {
  const x = status && status.exit;
  const t1 = pos.targets && pos.targets[0] && pos.targets[0].price;
  if (pos.broker !== 'OKX' || pos.adopted || pos.direction === 'short' || !x || x.status !== 'open' || x.tp || !(t1 > 0)) return null;
  if (pos.marketExitPending || pos.brokerManualExitId || ops.isBusy(pos.id) || now - (tried.get(pos.id) || 0) < RETRY_MS) return null;
  const bid = bidOf(pos);
  if (!(bid > 0) || !(t1 > bid * 1.001) || !(pos.invalidation < bid)) return null; // T1 already hit: the T1 watcher sells
  tried.set(pos.id, now);
  ops.claim(pos.id);
  try {
    const r = await ops.replaceStop(ledger, pos, pos.invalidation, 'oco-upgrade', { allowSame: true });
    const after = ledger.getActivePositions().find((p) => p.id === pos.id);
    console.warn(`[oco] ${pos.id}: ${r.alreadyClosed ? 'its stop filled meanwhile' : after && after.brokerOco ? `OKX now holds T1 ${t1} + stop ${pos.invalidation} (OCO)` : 'OKX refused the OCO; the stop alone was re-placed'}`);
    return r;
  } catch (err) {
    console.error(`[oco] ${pos.id}: upgrade to an OCO failed (${err.message})`);
    return null;
  } finally { ops.release(pos.id); }
}

module.exports = { maybe, RETRY_MS, _tried: tried };
