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
function stackingConflict(order, positions) {
  if (!order || String(order.id).startsWith('manual:')) return null;
  const held = (positions || []).find((p) => p.asset === order.asset && p.execution === 'LIVE' && p.id !== order.id);
  return held ? `ALREADY_HOLDING: ${order.asset} already has an open ${held.adopted ? 'adopted' : 'LIVE'} position (${held.id}); an automated setup would stack a second one on the same coin` : null;
}

module.exports = { validateApproval, stackingConflict, MAX_CANDIDATE_AGE_MS };
