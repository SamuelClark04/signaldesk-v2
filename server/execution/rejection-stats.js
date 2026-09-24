// "Why we passed": today's tally of setups that were dropped, by reason.
//
// Counting rules:
//   - one count per setup per reason: strategies re-propose the same setup every
//     60s tick, so a setup rejected all day counts once, not ~390 times;
//   - raw reasons are bucketed into stable labels (engine messages can contain
//     numbers, e.g. "Bankroll too small: one contract risks $252.00 ...");
//   - duplicates ("already staged") are not rejections and are never recorded;
//   - the tally resets at US/Eastern midnight (it feeds the Today dashboard).
// In memory only: a restart starts the day's tally again.
const { MAX_FEE_DRAG } = require('../risk/cost-authority');

const BUCKETS = [
  [/^Cost ceiling exceeded/i, `Fee drag over ${MAX_FEE_DRAG}R`],
  [/^Bankroll too small/i, 'Bankroll too small for one contract'],
  [/^Position size rounds to zero/i, 'Position too small to size'],
  [/wrong side of entry/i, 'Stop on the wrong side of entry'],
  [/^Unknown market|^Unknown direction|^Missing id|^Invalid /i, 'Malformed candidate'],
  [/^EXPIRED$/, 'Expired before approval (30 min)'],
  [/^PRICE_ESCAPED$/, 'Price escaped entry zone'],
  [/^INVALIDATED$/, 'Price through stop before entry'],
  [/^REJECTED_BY_USER$/, 'Rejected by you'],
];

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

let day = etDate.format(Date.now());
let counts = new Map(); // label -> count
let seen = new Set(); // `${candidateId}|${label}` already counted today
let listener = null;

function bucket(rawReason) {
  const reason = String(rawReason || 'Unknown reason');
  const hit = BUCKETS.find(([re]) => re.test(reason));
  // Unmapped reasons keep their text up to the first detail separator.
  return hit ? hit[1] : reason.split(/[:(]/)[0].trim().slice(0, 60) || 'Unknown reason';
}

function rollDay(now) {
  const today = etDate.format(now);
  if (today === day) return;
  day = today;
  counts = new Map();
  seen = new Set();
}

function snapshot(now = Date.now()) {
  rollDay(now);
  const reasons = [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { date: day, total: reasons.reduce((s, r) => s + r.count, 0), reasons };
}

// Record one dropped setup. Returns true if the tally changed.
function recordRejection(candidateId, rawReason, now = Date.now()) {
  rollDay(now);
  const label = bucket(rawReason);
  const key = `${candidateId || '?'}|${label}`;
  if (seen.has(key)) return false;
  seen.add(key);
  counts.set(label, (counts.get(label) || 0) + 1);
  if (listener) {
    try { listener(snapshot(now)); } catch (err) { console.error('[stats] listener failed:', err.message); }
  }
  return true;
}

// server.js registers a broadcaster here, so producers never touch sockets.
function onChange(fn) {
  listener = fn;
}

module.exports = { recordRejection, snapshot, onChange, bucket };
