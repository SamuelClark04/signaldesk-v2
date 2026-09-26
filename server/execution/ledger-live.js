// Part of the single ledger (paper-ledger.js owns the lists): LIVE positions' broker
// bookkeeping and adopted holdings (Phase 67, out of paper-ledger.js).
//   splitPosition    split a filled part off an open position (partial broker sells / exits).
//                    Phase 67: the unsold REMAINDER drops every manual-sell marker
//                    (brokerManualExitId, marketExitPending, ...) so a later reconcile can
//                    never settle the same fill twice (P0-3); each record keeps its pro-rata
//                    share of the entry order's fee (entryFeeShare, entryFeeActual)
//   syncLiveFill     the broker's real entry fill replaces the estimate
//   voidLivePosition the entry never filled: the record leaves the book, no journal entry
//   setBracketStatus 'ARMED' | 'UNARMORED' (no stop / target working at the broker, P0-1)
//   adoptPosition / releaseAdopted   external holdings put under (or out of) SignalDesk's watch
//   markSubmitting / recoverable / recoverLive   Phase 68 (P1-5): a LIVE submit is marked on its
//                    pending order first (write-ahead); at boot an order Coinbase took but the
//                    ledger never recorded (crash, LIVE_UNRECORDED) becomes its LIVE position
let L = null; // { pendingOrders, activePositions, tradeJournal, discardedOrders, isKnown, findIndex, save }
function bind(ctx) { L = ctx; }

// A sell working (or unconfirmed) for this record: never carried over to an unsold remainder.
const MANUAL_EXIT_FIELDS = ['brokerManualExitId', 'brokerManualExitQty', 'brokerManualExitExpected', 'marketExitPending', 'marketExitClientId', 'marketExitAt', 'marketExitError'];
// The share of the ORIGINAL entry order (and so of its real fee) this record holds.
const entryShare = (p) => (p && p.entryFeeShare > 0 ? p.entryFeeShare : 1);

function findOpen(candidateId) {
  const pos = L.activePositions.find((p) => p.id === candidateId);
  if (!pos) throw new Error(`paper-ledger: no open position ${candidateId}`);
  return pos;
}

// Split `qty` off an open position into its own record "<id>:part:<ms>" (dollar risk and the
// entry fee pro rata), e.g. the filled part of a partially filled broker sell (coinbase-exit.js).
function splitPosition(candidateId, qty) {
  const pos = findOpen(candidateId);
  if (!(qty > 0 && qty < pos.positionSize)) throw new Error('paper-ledger: split quantity must be inside the position');
  const f = qty / pos.positionSize;
  const share = entryShare(pos);
  let id = `${pos.id}:part:${Date.now()}`;
  for (let n = 2; L.isKnown(id); n += 1) id = `${pos.id}:part:${Date.now()}:${n}`;
  const part = { ...pos, id, parentId: pos.id, positionSize: qty, dollarRisk: pos.dollarRisk * f, entryFeeShare: share * f,
    ...(pos.entryFeeActual > 0 ? { entryFeeActual: pos.entryFeeActual * f } : {}) };
  pos.positionSize -= qty;
  pos.dollarRisk -= part.dollarRisk;
  pos.entryFeeShare = share * (1 - f);
  if (pos.entryFeeActual > 0) pos.entryFeeActual -= part.entryFeeActual;
  for (const k of MANUAL_EXIT_FIELDS) delete pos[k]; // P0-3: that sell's fill belongs to the part only
  L.activePositions.push(part);
  L.save();
  return { ...part };
}

function findLive(candidateId) {
  const pos = findOpen(candidateId);
  if (pos.execution !== 'LIVE') throw new Error(`paper-ledger: ${candidateId} is not a LIVE position`);
  return pos;
}

// Replace the estimated entry with the broker's actual fill. A partial fill
// shrinks the position (and its dollar risk) to what was really bought.
function syncLiveFill(candidateId, { fillPrice, filledQty }) {
  const pos = findLive(candidateId);
  if (!(fillPrice > 0) || !(filledQty > 0)) throw new Error('paper-ledger: broker fill needs price and quantity');
  if (filledQty < pos.positionSize) {
    pos.dollarRisk *= filledQty / pos.positionSize;
    pos.positionSize = filledQty;
  }
  Object.assign(pos, { fillPrice, fillEstimated: false, brokerFillSyncedAt: Date.now() });
  L.save();
  return { ...pos };
}

// The broker never filled the entry (rejected / canceled / expired): nothing was
// traded, so the record leaves the book without entering the trade journal.
function voidLivePosition(candidateId, reason) {
  findLive(candidateId);
  const i = L.findIndex(L.activePositions, candidateId);
  const [pos] = L.activePositions.splice(i, 1);
  const voided = { ...pos, status: 'void', voidReason: reason, voidedAt: Date.now() };
  L.discardedOrders.push(voided);
  L.save();
  return { ...voided };
}

// Is a stop / target order working at the broker for this position? Saved only when it
// changes (true); `detail` says why it is UNARMORED (shown on the position card).
function setBracketStatus(candidateId, status, detail = null) {
  const pos = L.activePositions.find((p) => p.id === candidateId);
  if (!pos || (pos.bracketStatus === status && (pos.bracketDetail || null) === detail)) return false;
  Object.assign(pos, { bracketStatus: status, bracketDetail: detail, bracketStatusAt: Date.now() });
  L.save();
  return true;
}

// ---------- Adopted holdings (external LIVE positions) ----------
// A holding bought outside SignalDesk, put under its watch with user-chosen
// levels. Recorded as a LIVE position flagged `adopted`: no broker order exists,
// so the reconciler skips it and monitorPositions (paper exits) skips it too;
// SignalDesk ALERTS on it (attention engine) but never places or sends orders.
// Not a risk-engine order: it records money already invested, so isApproved()
// does not apply. The caller (execution/adoption.js) validates everything.
function adoptPosition(position) {
  if (!position || !position.id || L.isKnown(position.id)) throw new Error('paper-ledger: invalid or duplicate adoption id');
  const pos = { ...position, execution: 'LIVE', adopted: true, status: 'open', openedAt: Date.now() };
  L.activePositions.push(pos);
  L.save();
  return { ...pos };
}

// Stop managing an adopted holding (the coins stay at the broker). It leaves the
// book without a journal entry: SignalDesk never traded it.
function releaseAdopted(candidateId) {
  const i = L.findIndex(L.activePositions, candidateId);
  if (i === -1 || !L.activePositions[i].adopted) throw new Error(`paper-ledger: ${candidateId} is not an adopted position`);
  const [pos] = L.activePositions.splice(i, 1);
  const released = { ...pos, status: 'released', releasedAt: Date.now() };
  L.discardedOrders.push(released);
  L.save();
  return { ...released };
}

// ---------- Unrecorded broker orders (Phase 68, P1-5) ----------
// Mark (at = ms) or clear (at = null) a setup's live submit, saved BEFORE the broker call (a
// setup discarded meanwhile keeps its mark until the recovery scan clears it).
function markSubmitting(id, at) {
  const o = L.pendingOrders.find((x) => x.id === id) || (!at && L.discardedOrders.find((x) => x.id === id));
  if (!o) return false;
  if (at) o.submittingAt = at; else delete o.submittingAt;
  L.save();
  return true;
}

// Setups a live submit may have reached the broker for since `sinceMs` (pending or discarded,
// submit-marked, not already a position or a journal entry).
function recoverable(sinceMs) {
  const taken = new Set([...L.activePositions, ...L.tradeJournal].map((p) => p.id));
  return [...L.pendingOrders, ...L.discardedOrders].filter((o) => o.submittingAt >= sinceMs && !taken.has(o.id) && !o.recoveredAt).map((o) => ({ ...o }));
}

// The broker holds an order for setup `id`: record the LIVE position it should have become.
function recoverLive(id, extra) {
  let list = L.pendingOrders;
  let i = L.findIndex(list, id);
  if (i === -1) { list = L.discardedOrders; i = L.findIndex(list, id); }
  if (i === -1 || L.activePositions.some((p) => p.id === id)) throw new Error(`paper-ledger: nothing to recover for ${id}`);
  const [order] = list.splice(i, 1);
  const { status, discardedAt, submittingAt, ...rest } = order;
  const pos = { ...rest, ...extra, execution: 'LIVE', status: 'open', openedAt: submittingAt || Date.now(), recoveredAt: Date.now() };
  L.activePositions.push(pos);
  L.save();
  return { ...pos };
}

module.exports = { bind, markSubmitting, recoverable, recoverLive, splitPosition, syncLiveFill, voidLivePosition, setBracketStatus, adoptPosition, releaseAdopted, entryShare, MANUAL_EXIT_FIELDS };
