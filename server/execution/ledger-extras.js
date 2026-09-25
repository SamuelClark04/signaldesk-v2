// Part of the single ledger (paper-ledger.js owns the lists and persists them
// through ledger-store): the record-keeping that is not order/position flow.
//   Saved setups (bookmarks): snapshots of pending orders for the Saved tab.
//   Pilot actions: the Portfolio Pilot's defensive SELL / TRIM proposals for
//     open positions, waiting in the Approvals queue. Kept here (persisted) so
//     a dismissed proposal is not re-proposed the same day; executing one goes
//     through the ledger's own close/reduce functions (pilot-handler.js).
//   Paper reset: wipes the PAPER book (see resetPaper) after a backup copy.
// bind() is called once by paper-ledger with its lists, save() and backup().
const MAX_SAVED = 100;
const MAX_ACTIONS = 300;

let L = null; // { pendingOrders, activePositions, tradeJournal, discardedOrders, savedSetups, pilotActions, save, backup }
const need = () => { if (!L) throw new Error('ledger-extras: not bound'); return L; };
const findIndex = (list, id) => list.findIndex((o) => o.id === id);

function bind(ctx) { L = ctx; }

// ---------- Saved setups (bookmarks) ----------
// The snapshot is copied from the ledger's OWN pending order (never from the
// client), so a bookmark always reflects what the risk engine actually approved.
const getSavedSetups = () => need().savedSetups.map((s) => ({ ...s }));

function saveSetup(candidateId) {
  const { pendingOrders, savedSetups, save } = need();
  const order = pendingOrders.find((o) => o.id === candidateId);
  if (!order) throw new Error('SAVE_NOT_PENDING: only setups in the approvals queue can be saved');
  if (savedSetups.some((s) => s.id === candidateId)) return getSavedSetups();
  savedSetups.unshift({ ...order, status: 'saved', savedAt: Date.now() });
  if (savedSetups.length > MAX_SAVED) savedSetups.length = MAX_SAVED; // oldest bookmarks drop off
  save();
  return getSavedSetups();
}

function unsaveSetup(candidateId) {
  const { savedSetups, save } = need();
  const i = findIndex(savedSetups, candidateId);
  if (i === -1) throw new Error(`no saved setup ${candidateId}`);
  savedSetups.splice(i, 1);
  save();
  return getSavedSetups();
}

// ---------- Pilot actions (SELL / TRIM proposals) ----------
const getPilotActions = () => need().pilotActions.filter((a) => a.status === 'pending').map((a) => ({ ...a, levels: { ...a.levels } }));

// Reconcile with this pass's proposals: new ones are added (an id already seen
// today and dismissed / done is not re-added); pending ones whose condition no
// longer holds, or whose position closed, expire. A proposal whose earlier card
// EXPIRED comes back (revived, fresh createdAt): a required TRIM / SELL never
// silently disappears. Positions in `unknown` (no verdict this pass: no price /
// history) keep their pending card. Returns { changed, added: [new or revived] }.
function syncPilotActions(proposals, openIds, unknown = new Set()) {
  const { pilotActions, save } = need();
  const now = Date.now();
  const current = new Set(proposals.map((p) => p.id));
  let changed = false;
  const added = [];
  for (const a of pilotActions) {
    if (a.status === 'pending' && (!openIds.has(a.positionId) || (!current.has(a.id) && !unknown.has(a.positionId)))) {
      Object.assign(a, { status: 'expired', resolvedAt: now });
      changed = true;
    }
  }
  for (const p of proposals) {
    const old = pilotActions.find((x) => x.id === p.id);
    if (old && old.status === 'expired') { Object.assign(old, p, { status: 'pending', createdAt: now, revivedAt: now }); added.push({ ...old }); changed = true; continue; }
    if (old) continue;
    const a = { ...p, status: 'pending', createdAt: now };
    pilotActions.push(a);
    added.push({ ...a });
    changed = true;
  }
  if (pilotActions.length > MAX_ACTIONS) pilotActions.splice(0, pilotActions.length - MAX_ACTIONS);
  if (changed) save();
  return { changed, added };
}

function resolvePilotAction(id, status, extra = {}) {
  const { pilotActions, save } = need();
  const a = pilotActions.find((x) => x.id === id && x.status === 'pending');
  if (!a) throw new Error(`no pending pilot action ${id}`);
  Object.assign(a, { status, resolvedAt: Date.now(), ...extra });
  save();
  return { ...a };
}

const findPilotAction = (id) => {
  const a = need().pilotActions.find((x) => x.id === id && x.status === 'pending');
  return a ? { ...a } : null;
};

// ---------- Paper reset ----------
// Starts the paper account from zero: every PAPER position and PAPER journal
// entry is removed, with all staged setups, discarded setups and Pilot
// proposals. LIVE and adopted positions (real money at a broker) and LIVE
// journal entries are KEPT: they record real trades, not paper P&L. Settings
// (bankroll, risk profile, strictness) and bookmarks stay. The state file is
// copied first (backup path returned), so a reset can be undone by hand.
const isLive = (x) => x.execution === 'LIVE' || x.execution === 'BROKER' || x.execution === 'EXTERNAL' || x.adopted;

function resetPaper() {
  const { pendingOrders, activePositions, tradeJournal, discardedOrders, pilotActions, save, backup } = need();
  const backupPath = backup('pre-reset');
  const keep = (list, pred) => { const kept = list.filter(pred); const removed = list.length - kept.length; list.splice(0, list.length, ...kept); return removed; };
  const removed = {
    positions: keep(activePositions, isLive),
    trades: keep(tradeJournal, isLive),
    pending: keep(pendingOrders, () => false),
    discarded: keep(discardedOrders, () => false),
    pilotActions: keep(pilotActions, (a) => !!a.external), // external holdings are real: their proposals stay
  };
  save();
  return { removed, keptLive: { positions: activePositions.length, trades: tradeJournal.length }, backupPath };
}

module.exports = { bind, resetPaper, saveSetup, unsaveSetup, getSavedSetups, getPilotActions, syncPilotActions, resolvePilotAction, findPilotAction };
