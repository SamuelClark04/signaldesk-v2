// Per-host circuit breaker for MARKET DATA / NEWS requests (Phase 73). Every request already has
// an 8 s timeout, but a scan loop is sequential: with a host unreachable (e.g. a VM whose IPv6
// route is dead) every symbol waited out its own timeout (and the Coinbase path retried it up to
// 4 times), so one pass took ~25 minutes ("previous pass still running" 23 times in a row).
//   after FAILS_TO_OPEN consecutive network failures (timeout / connection error / 5xx) a host
//   is OPEN for OPEN_MS: its requests fail at once ({ ok: false, error: '... unreachable' }) and
//   the pass moves on; then ONE trial request is let through (half-open): success closes it.
// Never used for broker order / exit calls: those always go out.
const FAILS_TO_OPEN = 3;
const OPEN_MS = 30 * 1000;

const hosts = new Map(); // host -> { fails, openUntil, trial, lastError }
const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return String(url); } };
const state = (host) => { let s = hosts.get(host); if (!s) { s = { fails: 0, openUntil: 0, trial: false, lastError: null }; hosts.set(host, s); } return s; };

// null: go ahead; else the fail-fast error text.
function blocked(url, now = Date.now()) {
  const s = state(hostOf(url));
  if (!s.openUntil) return null;
  if (now < s.openUntil) return `${hostOf(url)} unreachable (${s.lastError}); retrying in ${Math.ceil((s.openUntil - now) / 1000)}s`;
  if (s.trial) return `${hostOf(url)} unreachable (${s.lastError}); a trial request is in flight`;
  s.trial = true; // half-open: this request is the trial
  return null;
}

// Record an outcome. networkFailure: a timeout, a connection error or a 5xx (not a 4xx: the host answered).
function record(url, networkFailure, error = null, now = Date.now()) {
  const host = hostOf(url);
  const s = state(host);
  s.trial = false;
  if (!networkFailure) { if (s.openUntil) console.log(`[net] ${host} reachable again`); Object.assign(s, { fails: 0, openUntil: 0, lastError: null }); return; }
  s.fails += 1;
  s.lastError = error;
  if (s.fails >= FAILS_TO_OPEN) {
    if (!s.openUntil || now >= s.openUntil) console.warn(`[net] ${host}: ${s.fails} failures in a row (${error}); failing fast for ${OPEN_MS / 1000}s so scans never wait on it`);
    s.openUntil = now + OPEN_MS;
  }
}

// fetch() behind the breaker (same arguments). Throws like fetch; an open circuit throws at once.
async function guardedFetch(url, opts) {
  const why = blocked(url);
  if (why) throw Object.assign(new Error(why), { name: 'CircuitOpen' });
  try {
    const res = await fetch(url, opts);
    record(url, res.status >= 500, res.status >= 500 ? `HTTP ${res.status}` : null);
    return res;
  } catch (err) {
    record(url, true, err.name === 'TimeoutError' ? 'timed out' : (err.cause && err.cause.code) || err.message);
    throw err;
  }
}

const status = () => Object.fromEntries([...hosts].filter(([, s]) => s.openUntil).map(([h, s]) => [h, { fails: s.fails, openUntil: s.openUntil, lastError: s.lastError }]));
const reset = () => hosts.clear();

module.exports = { guardedFetch, blocked, record, status, reset, FAILS_TO_OPEN, OPEN_MS };
