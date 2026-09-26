// How long a staged setup may wait for approval (Phase 66). A fast setup is only worth
// taking while its candle is fresh:
//   Momentum Ignition (System 6)                 8 minutes
//   Accumulation Coil (System 6), Crypto Intraday 15 minutes
//   everything else                              30 minutes (the order guard's window)
// A fast setup also leaves the queue at once when the live price has already run more
// than CHASE_PCT (1.5%) past its entry trigger, or is through its stop. Used by the
// expiry sweeper (which records the reason), the order guard (approval) and the ledger
// (each pending order's expiresAt, for the countdown on its card). Pure functions.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const IGNITION_TTL_MS = 8 * 60 * 1000;
const COIL_TTL_MS = 15 * 60 * 1000;
const CHASE_PCT = 0.015;

function ttlOf(o) {
  if (o && o.gemTrigger === 'IGNITION') return IGNITION_TTL_MS;
  if (o && (o.gemTrigger === 'COIL' || o.strategyId === 'crypto-intraday')) return COIL_TTL_MS;
  return DEFAULT_TTL_MS;
}
const createdAtOf = (o) => { const t = typeof o.timestamp === 'number' ? o.timestamp : Date.parse(o.timestamp); return Number.isFinite(t) ? t : o.stagedAt; };
const expiresAt = (o) => { const t = createdAtOf(o); return Number.isFinite(t) ? t + ttlOf(o) : null; };

// Why `o` must leave the queue now (null: it may stay). livePrice: the asset's live price or null.
function staleness(o, livePrice, now = Date.now()) {
  const ttl = ttlOf(o);
  const t = createdAtOf(o);
  if (!Number.isFinite(t) || now - t > ttl) return `EXPIRED: unapproved after ${Math.round(ttl / 60000)}m`;
  if (ttl >= DEFAULT_TTL_MS || !(livePrice > 0) || !o.entryZone) return null;
  const long = o.direction !== 'short';
  const trigger = long ? o.entryZone.max : o.entryZone.min;
  const run = long ? livePrice / trigger - 1 : 1 - livePrice / trigger;
  if (run > CHASE_PCT) return `PRICE_ESCAPED: ${long ? '+' : '−'}${(run * 100).toFixed(1)}% past the entry trigger ${trigger} before approval`;
  if (long ? livePrice <= o.invalidation : livePrice >= o.invalidation) return `INVALIDATED: price ${livePrice} through the stop ${o.invalidation} before approval`;
  return null;
}

module.exports = { ttlOf, expiresAt, staleness, createdAtOf, DEFAULT_TTL_MS, IGNITION_TTL_MS, COIL_TTL_MS, CHASE_PCT };
