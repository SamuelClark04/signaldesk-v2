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
//     (pilot-matrix.js): SELL / TRIM proposals synced to the Approvals queue,
//     each SELL's paired ROTATION buy and every ADD staged as a setup (once per
//     day), and the full HOLD / ADD / TRIM / SELL + ROTATE table (PILOT_MATRIX).
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
const { sendApprovalAlert } = require('./notifier');

const priceOf = (asset) => prices.getLatestPrice(asset);
let matrix = { rows: [], equity: null, at: null };
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

// One candidate through the venue bankroll, the risk engine and the ledger.
// { asset, staged, id?, ...sizing } or { asset, staged:false, reason }.
async function stageCandidate(c, broadcast) {
  c.catalysts = macro.catalystsFor(c);
  const settings = ledger.getSettings();
  const capital = await sizingBankroll(c.market, settings);
  const r = capital.ok ? processCandidate(c, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis }) : { approved: false, reason: capital.reason };
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

async function stageBuys(amount, broadcast) {
  const ranking = await ranker.rankUniverse(priceOf);
  const exiting = new Set(ledger.getPilotActions().map((a) => a.asset));
  const proposal = calculateAllocation(amount, ledger.getActivePositions(), prices.getLatestPrices(), ranking, ledger.getPendingOrders(), exiting);
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

function executeAction(id) {
  const a = ledger.findPilotAction(id);
  if (!a) throw new Error('this Pilot action is no longer pending');
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
  const positions = ledger.getActivePositions();
  const ranking = await ranker.rankUniverse(priceOf, now);
  const equity = paperEquity();
  const r = await matrixRules.review(positions, priceOf, { equity, ranking }, now);
  if (ledger.syncPilotActions(r.actions, new Set(positions.map((p) => p.id)))) broadcast('PILOT_ACTIONS', ledger.getPilotActions());
  const day = new Date(now).toISOString().slice(0, 10);
  const buys = [
    ...r.rotations.map((x) => ({ asset: x.to, price: x.price, amount: x.proceeds, kind: 'ROTATION', why: x.why, idTag: `${day}:from-${x.from}` })),
    ...r.adds.map((x) => ({ asset: x.asset, price: x.price, amount: x.amount, kind: 'ADD', why: x.why, idTag: day })),
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
  const next = { rows: r.matrix, equity, at: now };
  if (JSON.stringify(next.rows) !== JSON.stringify(matrix.rows)) broadcast('PILOT_MATRIX', next);
  matrix = next;
}

// Returns true when the message was a Pilot message (handled here).
function createPilotHandler({ send, broadcast }) {
  const busy = new Set();
  return function handlePilot(ws, msg) {
    if (msg.type === 'CALCULATE_ALLOCATION') {
      stageBuys(msg.amount, broadcast)
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
    try {
      if (msg.type === 'DISMISS_ACTION') ledger.resolvePilotAction(id, 'dismissed');
      else executeAction(id);
      broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
      broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
    } catch (err) {
      console.warn(`[pilot] ${msg.type} ${id} failed: ${err.message}`);
      send(ws, 'ACTION_FAILED', { type: msg.type, id, error: err.message });
    } finally {
      busy.delete(id);
      broadcast('PILOT_ACTIONS', ledger.getPilotActions());
    }
    return true;
  };
}

module.exports = { createPilotHandler, reviewHoldings, stageBuys, getMatrix, paperEquity };
