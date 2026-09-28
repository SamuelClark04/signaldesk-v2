// Approval guards: the last check between a human "Approve" and a fill.
// Pure function, no state. Rejects stale setups and setups the price has left.
const MAX_CANDIDATE_AGE_MS = 30 * 60 * 1000;
const { ttlOf } = require('./setup-ttl'); // Phase 66: 8 min Ignition / 15 min Coil + Intraday / 30 min

function toMs(ts) {
  return typeof ts === 'number' ? ts : Date.parse(ts);
}

function validateApproval(candidate, currentLivePrice, now = Date.now()) {
  // Staleness: the setup was read off the tape longer ago than its window (setup-ttl.js).
  const createdAt = toMs(candidate.timestamp);
  if (!Number.isFinite(createdAt) || now - createdAt > Math.min(MAX_CANDIDATE_AGE_MS, ttlOf(candidate))) {
    return { valid: false, reason: 'EXPIRED' };
  }

  // Never approve blind: no fresh price means we cannot judge the fill.
  if (!(currentLivePrice > 0)) return { valid: false, reason: 'NO_LIVE_PRICE' };

  const { entryZone, invalidation, direction } = candidate;
  const isLong = direction === 'long';

  // Anti-chase: price has run past the worst acceptable entry.
  if (isLong ? currentLivePrice > entryZone.max : currentLivePrice < entryZone.min) {
    return { valid: false, reason: 'PRICE_ESCAPED' };
  }

  // Price is already through the stop: the thesis is dead before entry.
  if (isLong ? currentLivePrice <= invalidation : currentLivePrice >= invalidation) {
    return { valid: false, reason: 'INVALIDATED' };
  }

  return { valid: true };
}

// Phase 68: an AUTOMATED setup (a strategy or the Portfolio Pilot) on a coin / stock that already
// has an open LIVE position (bracketed or adopted) would stack a second record on the same
// broker balance. Manual Trade Ticket orders ("manual:" ids) are the user's explicit choice.
// Phase 76 (audit): ONE automated trade per symbol per market, paper included. The paper book held three
// SOFI put spreads at once, and a BAC call spread next to a BAC put spread (paying twice to bet both ways).
// A strategy setup is refused while the same symbol has an open position (or, at staging, another staged
// setup) in the same market. Portfolio Pilot buys / holdings are long-term allocations with their own 30%
// cap: they neither block nor are blocked by this rule (the LIVE rule above still applies to them).
const PILOT = 'portfolio-pilot';
const sameBook = (order, x) => x.asset === order.asset && x.market === order.market && x.id !== order.id && x.strategyId !== PILOT;
function stackingConflict(order, positions, pending = []) {
  if (!order || String(order.id).startsWith('manual:')) return null;
  const held = (positions || []).find((p) => p.asset === order.asset && p.execution === 'LIVE' && p.id !== order.id);
  if (held) return `ALREADY_HOLDING: ${order.asset} already has an open ${held.adopted ? 'adopted' : 'LIVE'} position (${held.id}); an automated setup would stack a second one on the same coin`;
  if (order.strategyId === PILOT) return null;
  const open = (positions || []).find((p) => sameBook(order, p));
  if (open) return `ALREADY_IN_TRADE: ${order.asset} already has an open ${order.market} trade (${open.id}${open.direction !== order.direction ? ', the OPPOSITE direction' : ''}); one automated trade per symbol`;
  const staged = (pending || []).find((o) => sameBook(order, o) && !String(o.id).startsWith('manual:'));
  if (staged) return `ALREADY_STAGED: ${order.asset} already has a ${order.market} setup waiting in Approvals (${staged.id}${staged.direction !== order.direction ? ', the OPPOSITE direction' : ''})`;
  return null;
}

module.exports = { validateApproval, stackingConflict, MAX_CANDIDATE_AGE_MS };
