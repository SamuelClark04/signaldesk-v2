// After-hours options plans (Phase 57). With the market closed, System 5 still
// builds its CALL / PUT spreads on the last close and the chain's last quotes.
// Nothing priced that way is ever staged (approval needs a live price and fresh
// quotes; a staged setup expires in 30 minutes), so the pipeline sends each one
// through the SAME venue bankroll + risk engine here instead and keeps the ones it
// approves as reviewable plans: OPTIONS_PLANS (the Approvals tab shows them,
// "stages at the open"). At the open the same setup is re-proposed on live quotes
// and staged like any other. The list is rebuilt every pass; plans older than
// MAX_AGE_MS drop out.
const { processCandidate } = require('../risk/risk-engine');
const { sizingBankroll } = require('../risk/venue-capital');

const MAX_AGE_MS = 18 * 60 * 60 * 1000;
let plans = new Map(); // id -> plan
let pass = new Set(); // ids seen this pass
let lastKey = '';

const begin = () => { pass = new Set(); };

// Candidate (options, no live price) -> { reason } for the rejection log; kept as a plan when approved.
async function review(candidate, settings) {
  const capital = await sizingBankroll(candidate.market, settings);
  if (!capital.ok) return { reason: `MARKET_CLOSED: ${capital.reason}` };
  const r = processCandidate(candidate, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash });
  if (!r.approved) return { reason: `MARKET_CLOSED: after-hours plan fails the risk engine: ${r.reason}` };
  const od = r.optionsData;
  pass.add(r.id);
  plans.set(r.id, {
    id: r.id, asset: r.asset, setupType: r.setupType, direction: r.direction, timeframe: r.timeframe, label: od.label, type: od.type, structure: od.structure,
    expiration: od.expiration, dte: od.dte, debit: od.debit, width: od.width || null, legs: od.legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, delta: l.delta, bid: l.bid, ask: l.ask })),
    stopValue: od.exitRule.stopValue, t1Value: od.exitRule.targetValue, t2Value: od.exitRule.t2Value || null, netRR: r.t1NetRR, feeDrag: r.feeDrag,
    positionSize: r.positionSize, dollarRisk: r.dollarRisk, premium: r.notional, smallAccountCap: !!r.smallAccountCap, sizingBankroll: r.sizingBankroll,
    invalidation: r.invalidation, t1: r.targets[0].price, t2: r.targets[1] ? r.targets[1].price : null, refSpot: od.refSpot, level: od.level, levelAnchored: od.levelAnchored,
    stats: od.stats || null, midHoldAt: od.midHoldAt || null, thesis: r.thesis, plannedAt: Date.now(),
  });
  return { reason: `MARKET_CLOSED: options plan cleared the risk engine (${r.positionSize} x ${od.label}, $${r.dollarRisk.toFixed(2)} risk${r.smallAccountCap ? ', 1-contract cap' : ''}); `
    + 'shown in Approvals, stages on live quotes at the open' };
}

// End of pass: drop plans the strategy no longer proposes (or too old); broadcast on change.
function publish(broadcast, now = Date.now()) {
  for (const [id, p] of plans) if (!pass.has(id) || now - p.plannedAt > MAX_AGE_MS) plans.delete(id);
  const list = snapshot();
  const key = JSON.stringify(list.map((p) => [p.id, p.debit, p.t1Value]));
  if (key !== lastKey) { lastKey = key; broadcast('OPTIONS_PLANS', list); }
}

const snapshot = () => [...plans.values()].sort((a, b) => b.plannedAt - a.plannedAt).map((p) => ({ ...p, legs: p.legs.map((l) => ({ ...l })) }));
function reset() { plans = new Map(); pass = new Set(); lastKey = ''; }

module.exports = { begin, review, publish, snapshot, reset, MAX_AGE_MS };
