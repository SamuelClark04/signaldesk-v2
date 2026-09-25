// Portfolio Pilot execution glue: turns the Pilot's proposals into Approvals-queue
// items and carries out the ones the user approves.
//   CALCULATE_ALLOCATION {amount}: the Trend Ranker (pilot-ranker.js) ranks the
//     universe, the allocator splits the deposit over the top leaders (30% cap,
//     a reserve for swing setups already in Approvals), and each buy becomes a
//     fully formed setup (pilot-trades.js: 8-18% stop, T1 2.5R / T2 4.5R,
//     fractional units) through the SAME gates as scanned setups (venue
//     bankroll, risk engine, ledger.stageOrder). Earlier Pilot allocation buys
//     still waiting are replaced. The requester gets the proposal + outcomes.
//   APPROVE_ACTION / DISMISS_ACTION {id}: a Pilot SELL / TRIM proposal. Approving
//     closes (or trims a third of) a PAPER position at the live price, booked by
//     the ledger like any exit. LIVE / adopted holdings are sold at the broker.
//   reviewHoldings(): once per pipeline pass, the 4-action matrix
//     (pilot-matrix.js) over ALL holdings: paper, SignalDesk's LIVE trades and the
//     EXTERNAL ones (external-holdings.js: manual Robinhood / other + broker-synced
//     balances bought outside SignalDesk), weighted against the combined equity.
//     SELL / TRIM proposals (and external stop / T1 / T2 alerts, which win) are
//     synced to the Approvals queue; each SELL's paired ROTATION buy and every ADD
//     are staged as setups (once per day), except a MANUAL holding's ADD, which is
//     an instruction card (SignalDesk cannot buy at Robinhood). New external
//     actions are emailed. The full table goes out as PILOT_MATRIX.
//   Allocation scope (CALCULATE_ALLOCATION {scope}): 'paper' counts the Pilot's
//     paper holdings, 'external' the real ones, 'combined' both, so an existing
//     $600 of NVDA at Robinhood counts toward NVDA's 30% cap.
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const { calculateAllocation, PILOT_STRATEGY_ID } = require('../strategies/4-portfolio-pilot');
const pilot = require('../strategies/pilot-trades');
const ranker = require('../strategies/pilot-ranker');
const matrixRules = require('../strategies/pilot-matrix');
const { processCandidate } = require('../risk/risk-engine');
const { sizingBankroll } = require('../risk/venue-capital');
const macro = require('../connectors/macro-events');
const { recordRejection } = require('./rejection-stats');
const scanLog = require('./scan-log');
const { sendApprovalAlert, sendExternalActionAlert } = require('./notifier');
const external = require('./external-holdings');
const externalActions = require('./external-actions');
const externalApi = require('./external-api');
const brokerSync = require('../connectors/broker-sync');

const priceOf = (asset) => prices.getLatestPrice(asset); // live only: the ranker's "can be bought now"
const markOf = (asset) => prices.getMarkPrice(asset); // live, else the last session close: valuation + matrix
let matrix = { rows: [], paperEquity: null, realEquity: null, at: null };
const tried = new Set(); // ADD / ROTATION ids already sent through the gates (once per day each)
const getMatrix = () => ({ ...matrix, rows: matrix.rows.map((r) => ({ ...r })) });

// Paper account equity: bankroll + realized paper P&L + open paper unrealized P&L.
function paperEquity() {
  const isPaper = (x) => x.execution !== 'LIVE' && x.execution !== 'BROKER' && !x.adopted;
  const realized = ledger.getTradeJournal().filter(isPaper).reduce((s, t) => s + (t.netPnl || 0), 0);
  const open = ledger.getActivePositions().filter(isPaper).reduce((s, p) => {
    const px = priceOf(p.asset);
    return s + (px > 0 && p.market !== 'options' ? ledger.unrealizedPnl(p, px) : 0);
  }, 0);
  return ledger.getSettings().bankroll + realized + open;
}

// Real money SignalDesk tracks: its LIVE trades (not options) + external holdings.
const isReal = (p) => (p.execution === 'LIVE' || p.execution === 'EXTERNAL') && p.market !== 'options' && p.direction !== 'short';
const inRealBook = (p) => p.execution === 'LIVE' || p.execution === 'EXTERNAL' || !!p.adopted;
const valueOf = (p) => p.positionSize * (markOf(p.asset) > 0 ? markOf(p.asset) : p.fillPrice || 0);
function realHoldings() { return [...ledger.getActivePositions().filter(isReal), ...external.positions()]; }

// REAL equity (Phase 54): real holdings at mark + synced broker cash. The paper
// bankroll is never part of it (it has its own book: paperEquity()).
function realEquity(real) {
  const snap = brokerSync.getSnapshot();
  const cash = ['coinbase', 'alpaca'].reduce((s, v) => s + (snap[v] && snap[v].ok && snap[v].cash > 0 ? snap[v].cash : 0), 0);
  return real.reduce((s, p) => s + valueOf(p), 0) + cash;
}

// The real book is complete once a configured Coinbase account has synced (startup
// sync, Sync Broker). Before that its coins and cash are missing from real equity.
function realBookKnown() {
  if (!process.env.COINBASE_API_KEY || !process.env.COINBASE_API_SECRET) return true;
  const cb = brokerSync.getSnapshot().coinbase;
  return !!(cb && cb.ok);
}

// Holdings the allocator counts, by the client's venue filter.
function holdingsFor(scope) {
  const paper = ledger.getActivePositions().filter((p) => p.execution !== 'LIVE' && !p.adopted);
  const real = realHoldings().map((p) => ({ ...p, countsAsHolding: true }));
  return scope === 'paper' ? paper : scope === 'external' ? real : [...paper, ...real];
}

// One candidate through the venue bankroll, the risk engine and the ledger.
// { asset, staged, id?, ...sizing } or { asset, staged:false, reason }.
async function stageCandidate(c, broadcast) {
  c.catalysts = macro.catalystsFor(c);
  const settings = ledger.getSettings();
  const capital = await sizingBankroll(c.market, settings);
  const r = capital.ok ? processCandidate(c, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash }) : { approved: false, reason: capital.reason };
  if (!r.approved) {
    recordRejection(c.id, r.reason, c);
    scanLog.rejected(c.id, r.reason, c);
    return { asset: c.asset, staged: false, reason: r.reason };
  }
  const staged = ledger.stageOrder(r);
  scanLog.staged(r);
  broadcast('order:staged', staged);
  Promise.resolve().then(() => sendApprovalAlert(staged)).catch((err) => console.error(`[notifier] ${staged.id}: ${err.message}`));
  return { asset: c.asset, staged: true, id: r.id, positionSize: r.positionSize, notional: r.notional, entryPrice: r.entryPrice, invalidation: r.invalidation,
    targets: r.targets.map((t) => t.price), dollarRisk: r.dollarRisk, cappedByAmount: r.cappedByAmount, capitalCapped: r.capitalCapped };
}

async function stageBuys(amount, broadcast, scope = 'combined') {
  const ranking = await ranker.rankUniverse(priceOf);
  const exiting = new Set(ledger.getPilotActions().filter((a) => a.action !== 'ADD').map((a) => a.asset));
  const proposal = { ...calculateAllocation(amount, holdingsFor(scope), prices.getMarkPrices(), ranking, ledger.getPendingOrders(), exiting), scope };
  const replaced = ledger.getPendingOrders().filter((o) => o.strategyId === PILOT_STRATEGY_ID && (o.pilotKind || 'ALLOCATION') === 'ALLOCATION');
  for (const o of replaced) ledger.discardOrder(o.id); // a new deposit plan supersedes the old one
  const { candidates, skipped } = await pilot.buyCandidates(proposal);
  const setups = skipped.map((s) => ({ asset: s.asset, staged: false, reason: s.reason }));
  for (const c of candidates) {
    try { setups.push(await stageCandidate(c, broadcast)); } catch (err) { setups.push({ asset: c.asset, staged: false, reason: err.message }); } // one failure never drops the rest
  }
  broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
  console.log(`[pilot] deposit $${proposal.deposit}: staged ${setups.filter((s) => s.staged).length} buy(s)${replaced.length ? `, replaced ${replaced.length}` : ''}`);
  return { ...proposal, setups, replaced: replaced.length };
}

async function executeAction(id) {
  const a = ledger.findPilotAction(id);
  if (!a) throw new Error('this Pilot action is no longer pending');
  if (a.external) { // manual confirmation, or a LIVE broker sell (external-actions.js)
    const p = external.positions().find((x) => x.id === a.positionId);
    if (!p) { ledger.resolvePilotAction(id, 'expired'); throw new Error('the holding is no longer there (removed, sold or re-synced)'); }
    const r = await externalActions.execute(a, p, ledger.getSettings());
    ledger.resolvePilotAction(id, 'done', { exitPrice: r.exitPrice, executedQty: r.quantity, brokerId: r.brokerId || null });
    console.log(`[pilot] ${a.action} ${p.asset} (${p.broker}): ${r.summary}`);
    externalApi.publish();
    return r;
  }
  const pos = ledger.getActivePositions().find((p) => p.id === a.positionId);
  if (!pos) { ledger.resolvePilotAction(id, 'expired'); throw new Error('the position is already closed'); }
  if (pos.execution === 'LIVE') throw new Error('LIVE_CLOSE_UNSUPPORTED');
  const live = prices.getLatestPrice(pos.asset);
  if (!(live > 0)) throw new Error('NO_LIVE_PRICE');
  const trade = a.action === 'SELL' ? ledger.closePosition(pos.id, live, 'PILOT_SELL')
    : ledger.reducePosition(pos.id, a.fraction, live, 'PILOT_TRIM');
  ledger.resolvePilotAction(id, 'done', { exitPrice: live, tradeId: trade.id });
  console.log(`[pilot] ${a.action} ${pos.asset} @ ${live}: net ${trade.netPnl.toFixed(2)}`);
  return trade;
}

// Pipeline hook: the 4-action matrix for the current open positions.
async function reviewHoldings(broadcast, now = Date.now()) {
  if (await external.refreshLevels(now)) externalApi.publish();
  const ext = external.positions();
  const positions = [...ledger.getActivePositions(), ...ext];
  const ranking = await ranker.rankUniverse(priceOf, now);
  const books = { paper: paperEquity(), real: realEquity([...ledger.getActivePositions().filter(isReal), ...ext]), realComplete: realBookKnown() };
  // Real weights only once the Coinbase account is known (no weight TRIM / ADD on half a book).
  const r = await matrixRules.review(positions, markOf, { ranking, equityOf: (p) => (inRealBook(p) ? (books.realComplete ? books.real : null) : books.paper) }, now);
  const day = new Date(now).toISOString().slice(0, 10);
  const extById = new Map(ext.map((p) => [p.id, p]));
  // External holdings: stop / T1 / T2 alerts win over the matrix; every card gets its instruction.
  const alerts = externalActions.levelAlerts(ext, markOf, day);
  const alerted = new Set(alerts.map((a) => a.positionId));
  const manualAdds = r.adds.filter((x) => extById.has(x.positionId) && extById.get(x.positionId).external === 'manual');
  const actions = [...r.actions.filter((a) => !alerted.has(a.positionId)), ...alerts]
    .map((a) => (extById.has(a.positionId) ? externalActions.decorate(a, extById.get(a.positionId)) : a))
    .concat(manualAdds.filter((x) => !alerted.has(x.positionId)).map((x) => externalActions.manualAdd(x, extById.get(x.positionId), day)));
  // A holding the matrix could not judge this pass (no price / history: WAIT) keeps its pending card.
  const unknown = new Set(r.matrix.filter((x) => x.action === 'WAIT').map((x) => x.positionId));
  const sync = ledger.syncPilotActions(actions, new Set(positions.map((p) => p.id)), unknown);
  if (sync.changed) broadcast('PILOT_ACTIONS', ledger.getPilotActions());
  for (const a of sync.added.filter((x) => x.external)) {
    Promise.resolve().then(() => sendExternalActionAlert(a)).catch((err) => console.error(`[notifier] ${a.id}: ${err.message}`));
  }
  const buys = [
    ...r.rotations.filter((x) => !alerted.has(x.positionId)).map((x) => ({ asset: x.to, price: x.price, amount: x.proceeds, kind: 'ROTATION', why: x.why, idTag: `${day}:from-${x.from}` })),
    ...r.adds.filter((x) => !manualAdds.includes(x)).map((x) => ({ asset: x.asset, price: x.price, amount: x.amount, kind: 'ADD', why: x.why, idTag: day })),
  ];
  let staged = false;
  for (const spec of buys) {
    const key = `${spec.kind}:${spec.asset}:${spec.idTag}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const b = await pilot.buildBuy(spec, now);
    if (b.skip) { console.log(`[pilot] ${spec.kind} ${spec.asset} not staged: ${b.skip}`); continue; }
    try {
      const out = await stageCandidate(b.candidate, broadcast);
      staged = staged || out.staged;
      console.log(`[pilot] ${spec.kind} ${spec.asset}: ${out.staged ? `staged ${out.positionSize} ($${out.notional.toFixed(2)})` : `not staged (${out.reason})`}`);
    } catch (err) {
      console.log(`[pilot] ${spec.kind} ${spec.asset} not staged: ${err.message}`); // e.g. already staged today
    }
  }
  if (staged) broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
  const next = { rows: r.matrix, paperEquity: books.paper, realEquity: books.realComplete ? books.real : null, realPending: !books.realComplete, at: now };
  if (JSON.stringify(next.rows) !== JSON.stringify(matrix.rows)) broadcast('PILOT_MATRIX', next);
  matrix = next;
}

// Returns true when the message was a Pilot message (handled here).
function createPilotHandler({ send, broadcast }) {
  const busy = new Set();
  return function handlePilot(ws, msg) {
    if (msg.type === 'CALCULATE_ALLOCATION') {
      stageBuys(msg.amount, broadcast, ['paper', 'external', 'combined'].includes(msg.scope) ? msg.scope : 'combined')
        .then((r) => send(ws, 'ALLOCATION_PROPOSAL', r))
        .catch((err) => send(ws, 'ALLOCATION_PROPOSAL', { error: err.message }));
      return true;
    }
    if (msg.type !== 'APPROVE_ACTION' && msg.type !== 'DISMISS_ACTION') return false;
    const { id } = msg;
    if (typeof id !== 'string' || !id || busy.has(id)) {
      send(ws, 'ACTION_FAILED', { type: msg.type, id, error: busy.has(id) ? 'ORDER_BUSY' : 'missing action id' });
      return true;
    }
    busy.add(id);
    (async () => {
      if (msg.type === 'DISMISS_ACTION') ledger.resolvePilotAction(id, 'dismissed');
      else await executeAction(id);
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
    })().catch((err) => {
      console.warn(`[pilot] ${msg.type} ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type: msg.type, id, error: err.message });
    }).finally(() => {
      busy.delete(id);
      broadcast('PILOT_ACTIONS', ledger.getPilotActions());
    });
    return true;
  };
}

module.exports = { createPilotHandler, reviewHoldings, stageBuys, getMatrix, paperEquity };
