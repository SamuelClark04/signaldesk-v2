// Portfolio Pilot execution glue: turns the Pilot's proposals into Approvals-queue
// items and carries out the ones the user approves.
//   CALCULATE_ALLOCATION {amount}: the allocator's buy-only split of a deposit,
//     then one fully formed BUY setup per underweight asset (pilot-trades.js),
//     each through the SAME gates as scanned setups (venue bankroll, risk engine,
//     ledger.stageOrder). Earlier Pilot buys still waiting are replaced. The
//     requester gets the proposal plus what was staged or why not.
//   APPROVE_ACTION / DISMISS_ACTION {id}: a Pilot SELL / TRIM proposal. Approving
//     closes (or trims a third of) a PAPER position at the live price, booked by
//     the ledger like any exit. LIVE / adopted holdings are sold at the broker.
//   reviewHoldings(): once per pipeline pass, re-checks open positions against
//     their 200/50-day averages and syncs the pending SELL / TRIM proposals.
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const { calculateAllocation, PILOT_STRATEGY_ID } = require('../strategies/4-portfolio-pilot');
const pilot = require('../strategies/pilot-trades');
const { processCandidate } = require('../risk/risk-engine');
const { sizingBankroll } = require('../risk/venue-capital');
const macro = require('../connectors/macro-events');
const { recordRejection } = require('./rejection-stats');
const scanLog = require('./scan-log');
const { sendApprovalAlert } = require('./notifier');

async function stageBuys(amount, broadcast) {
  const proposal = calculateAllocation(amount, ledger.getActivePositions(), prices.getLatestPrices());
  const replaced = ledger.getPendingOrders().filter((o) => o.strategyId === PILOT_STRATEGY_ID);
  for (const o of replaced) ledger.discardOrder(o.id); // a new deposit plan supersedes the old one
  const { candidates, skipped } = await pilot.buyCandidates(proposal);
  const settings = ledger.getSettings();
  const setups = skipped.map((s) => ({ asset: s.asset, staged: false, reason: s.reason }));
  for (const c of candidates) {
    c.catalysts = macro.catalystsFor(c);
    const capital = await sizingBankroll(c.market, settings);
    const r = capital.ok ? processCandidate(c, capital.bankroll, { riskPct: settings.riskPct, sizingBasis: capital.basis })
      : { approved: false, reason: capital.reason };
    if (!r.approved) {
      recordRejection(c.id, r.reason, c);
      scanLog.rejected(c.id, r.reason, c);
      setups.push({ asset: c.asset, staged: false, reason: r.reason });
      continue;
    }
    const staged = ledger.stageOrder(r);
    scanLog.staged(r);
    broadcast('order:staged', staged);
    Promise.resolve().then(() => sendApprovalAlert(staged)).catch((err) => console.error(`[notifier] ${staged.id}: ${err.message}`));
    setups.push({ asset: c.asset, staged: true, id: r.id, positionSize: r.positionSize, notional: r.notional, entryPrice: r.entryPrice,
      invalidation: r.invalidation, target: null, dollarRisk: r.dollarRisk, cappedByAmount: r.cappedByAmount, capitalCapped: r.capitalCapped });
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

// Pipeline hook: SELL / TRIM proposals for the current open positions.
async function reviewHoldings(broadcast) {
  const positions = ledger.getActivePositions();
  const proposals = await pilot.reviewPositions(positions, (asset) => prices.getLatestPrice(asset));
  if (ledger.syncPilotActions(proposals, new Set(positions.map((p) => p.id)))) broadcast('PILOT_ACTIONS', ledger.getPilotActions());
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

module.exports = { createPilotHandler, reviewHoldings, stageBuys };
