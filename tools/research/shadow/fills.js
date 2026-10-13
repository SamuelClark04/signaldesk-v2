// Phase 95 Task 5.2 (plan 6.3 / 6.5): research entries.
// - The contract comes ONLY from the selection recorded at or before the decision (the latest CANDIDATES row with recorded_at <= tAvail
//   for that underlying / bucket / side). A later refresh is never substituted: NO_SELECTION instead.
// - D / W rules need the expiry >= 5 sessions after the planned exit (INSUFFICIENT_EXPIRY otherwise).
// - Entry: the first ELIGIBLE observed quote with provider time >= tAvail + L (bid > 0, ask > bid, spread <= 50% of the mid), filled
//   at its ASK; none within the wait (2 min Q / H, 15 min D / W) = UNFILLED, counted.
const cal = require('../../../server/research/nyse-calendar');

const eligible = (q) => q && q.bid > 0 && q.ask > q.bid && (q.ask - q.bid) <= 0.5 * ((q.ask + q.bid) / 2);

function selectContract(cands, { underlying, bucket, side, tAvail }) {
  let best = null;
  for (const c of cands) {
    if (c.underlying !== underlying || c.bucket !== bucket || c.side !== side || c.recorded_at > tAvail) continue;
    if (!best || c.recorded_at > best.recorded_at) best = c;
  }
  if (!best) return { reason: 'NO_SELECTION' };
  return { contract: best.contract, selectedAt: best.recorded_at, expiry: best.expiry,
    eligibility: { bucket: best.bucket, side: best.side, dte: best.dte, delta: best.delta, strike: best.strike, rule: best.rule } };
}

// Sessions strictly after `fromDay` up to and including `toDay`.
function sessionsBetween(fromDay, toDay) {
  let n = 0; let d = fromDay;
  while (d < toDay) { d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10); if (cal.isSessionDay(d)) n += 1; }
  return n;
}
function expiryOk({ expiry, plannedExitDay, minSessions = 5 }) {
  const n = sessionsBetween(plannedExitDay, expiry);
  return n >= minSessions ? { ok: true, sessionsAfterExit: n } : { ok: false, reason: 'INSUFFICIENT_EXPIRY', sessionsAfterExit: n };
}

// quotes: ascending by t_quote; -> { status: FILLED, quote, price, latencyMs, feed } | { status: UNFILLED, waitedMs } | { status: PENDING }
function entryFill(quotes, { tAvail, latencyMs = 5000, maxWaitMs, dataThrough = Infinity }) {
  const from = tAvail + latencyMs; const until = tAvail + maxWaitMs;
  for (const q of quotes) {
    if (q.t_quote < from) continue;
    if (q.t_quote > until) break;
    if (eligible(q)) return { status: 'FILLED', quote: q, price: q.ask, latencyMs: q.t_quote - tAvail, feed: q.feed };
  }
  if (dataThrough < until) return { status: 'PENDING' };
  return { status: 'UNFILLED', waitedMs: maxWaitMs };
}

module.exports = { selectContract, expiryOk, entryFill, eligible, sessionsBetween };
