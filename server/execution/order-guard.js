// Approval guards: the last check between a human "Approve" and a fill.
// Pure function, no state. Rejects stale setups and setups the price has left.
const MAX_CANDIDATE_AGE_MS = 30 * 60 * 1000;

function toMs(ts) {
  return typeof ts === 'number' ? ts : Date.parse(ts);
}

function validateApproval(candidate, currentLivePrice, now = Date.now()) {
  // Staleness: the setup was read off the tape more than 30 minutes ago.
  const createdAt = toMs(candidate.timestamp);
  if (!Number.isFinite(createdAt) || now - createdAt > MAX_CANDIDATE_AGE_MS) {
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

module.exports = { validateApproval, MAX_CANDIDATE_AGE_MS };
