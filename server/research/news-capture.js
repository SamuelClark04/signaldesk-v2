// News capture (Phase 94 Stage 1, RECORD-ONLY; spec 5.1 / 7). Every news document VERSION our system receives, with OUR receive time.
//   fromStream(m)  a message the app's news socket ALREADY received (its subscription is unchanged: equity-day reads that stream)
//   poll()         REST /v1beta1/news for the capture symbols, OLDEST first (sort=asc) from a cursor, <= MAX_PAGES pages per poll
// LIMITS (kept on every line): a poll sees only the versions that exist when it runs: a revision replaced between two polls is never
// seen (versionCoverage OBSERVED_ONLY); t_recv is when OUR system received it (receipt POLL_RECEIPT / STREAM_RECEIPT), not when the
// headline appeared.
// C3: pagination is never skipped. A page limit carries the query (its start + page token) to the next poll, which continues it
// before starting a new one, so a crowd of articles inside the overlap can never stall the poll; the cursor advances only to the
// newest article actually READ, and never past now. Alpaca's `start` filters on updated_at (checked against the live data API
// 2026-10-06), so a revised older article is returned by the poll after its revision. The cursor persists in <EVENTS_DIR>/news-cursor.json. At start, the gap since the saved cursor is recorded (NEWS_GAP) and
// caught up (at most MAX_CATCHUP_MS back; older = an explicit uncovered gap); articles read in catch-up carry catchUp: true. A version
// is cached as seen ONLY after the recorder accepted it (a refused record is offered again while it is still inside the 5-minute overlap).
// Pre-merge fix 3: a restart gap is recorded PENDING (never "covered" in advance) and stays pending, persisted with the cursor across
// restarts, until a query that started at or before it has read EVERY page: only then a NEWS_RECOVERY COMPLETE line names it. A gap
// that can no longer be read (older than the catch-up limit) is UNRECOVERABLE, and a pending gap overtaken by that limit gets a
// NEWS_RECOVERY INCOMPLETE. HTTP-ok polls alone never establish coverage. Unread pages carried > BACKLOG_WARN_MS = one NEWS_BACKLOG
// PERSISTENT line (then CLEARED with its length); every POLL_STATUS carries the backlog age and the pending recovery count.
// Timers are unref'd and never run inside a pipeline pass; fetches go through net-guard (a slow host fails fast).
const fs = require('fs');
const path = require('path');
const rec = require('./event-recorder');
const universe = require('./capture-universe');

const POLL_OPEN_MS = 2 * 60 * 1000;
const POLL_CLOSED_MS = 10 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_PAGES = 2;
const MAX_VERSIONS = 50000;
const MAX_CATCHUP_MS = 24 * 3600 * 1000;
const FIRST_LOOKBACK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const BACKLOG_WARN_MS = 10 * 60 * 1000;

let versions = new Map(); // `${id}|${updated_at}` -> true (insertion-ordered: oldest evicted)
let cursor = null;        // ms: the newest article time READ so far (polls continue from here)
let carried = null;       // { since, token }: a query whose later pages are still unread (continued by the next poll)
let pending = [];         // [{ gapId, from, to }]: restart gaps whose catch-up has not read every page yet (fix 3)
let backlog = null;       // { since, polls, warned }: unread pages carried since `since`
let gapSeq = 0;
let startedAt = Date.now();
let polling = false; let timer = null;
const st = { polls: 0, pollErrors: 0, lastPollAt: null, lastNew: 0, lastPollError: null, streamSeen: 0, refused: 0, truncatedPolls: 0 };

const base = () => (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/$/, '');
const evDir = () => process.env.EVENTS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json'));
const cursorFile = () => path.join(evDir(), 'news-cursor.json');
const marketOpen = () => { try { return require('../market/market-session').isEquityMarketOpen(); } catch { return false; } };
const everyMs = () => (marketOpen() ? POLL_OPEN_MS : POLL_CLOSED_MS);
const tOf = (n) => { const t = Date.parse(n.updated_at || n.created_at || ''); return Number.isFinite(t) ? t : null; };

function observe(n, seenVia, tRecv = Date.now()) {
  try {
    if (!n || n.id === undefined || n.id === null) return false;
    const version = n.updated_at || n.created_at || null;
    const k = `${n.id}|${version}`;
    if (versions.has(k)) return false;
    const t = tOf(n);
    const ok = rec.record('NEWS', { docId: `alpaca:${n.id}`, providerId: n.id, version, created_at: n.created_at || null, updated_at: n.updated_at || null,
      headline: rec.text(n.headline), summary: rec.text(n.summary), content: rec.text(n.content), author: n.author || null, url: n.url || null, source: n.source || null,
      symbols: Array.isArray(n.symbols) ? n.symbols.slice(0, 50) : [], t_recv: tRecv, seenVia, versionCoverage: 'OBSERVED_ONLY',
      receipt: seenVia === 'poll' ? 'POLL_RECEIPT' : 'STREAM_RECEIPT', ...(seenVia === 'poll' ? { pollEveryMs: everyMs() } : {}),
      ...(t !== null && t < startedAt ? { catchUp: true } : {}) });
    if (!ok) { st.refused += 1; return false; } // C3: not cached: the next poll offers it again
    versions.set(k, true);
    if (versions.size > MAX_VERSIONS) versions.delete(versions.keys().next().value);
    return true;
  } catch { return false; }
}

function fromStream(m, now = Date.now()) { try { st.streamSeen += 1; observe(m, 'stream', now); } catch { /* record-only */ } }

const cursorBody = (now) => JSON.stringify({ cursor, savedAt: now, pending });
async function saveCursor(now) {
  try {
    await fs.promises.mkdir(evDir(), { recursive: true });
    const tmp = `${cursorFile()}.tmp`;
    await fs.promises.writeFile(tmp, cursorBody(now));
    await fs.promises.rename(tmp, cursorFile());
  } catch { /* the next poll retries; a lost cursor shows up as a NEWS_GAP at the next start */ }
}
// At start only (never inside a pass): the new pending gap is saved at once, so a second restart before any poll still carries it.
function saveCursorNow(now) {
  try { fs.mkdirSync(evDir(), { recursive: true }); const tmp = `${cursorFile()}.tmp`; fs.writeFileSync(tmp, cursorBody(now)); fs.renameSync(tmp, cursorFile()); } catch { /* as above */ }
}
// A NEWS_GAP line never claims coverage (covered: false): recovery is PENDING until a NEWS_RECOVERY line, or UNRECOVERABLE.
function gap(now, data) {
  const g = { gapId: `${new Date(now).toISOString()}#${(gapSeq += 1)}`, ...data, covered: false };
  rec.record('NEWS_GAP', g);
  return { gapId: g.gapId, from: g.from, to: g.to };
}

// C3 / fix 3: at start, resume from the saved cursor and record the gap explicitly, as PENDING until its catch-up has read every page.
function resume(now = Date.now()) {
  startedAt = now; backlog = null; pending = [];
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(cursorFile(), 'utf8')); } catch { saved = null; }
  const earlier = saved && Array.isArray(saved.pending) ? saved.pending.filter((g) => g && g.gapId) : []; // gaps a previous run never finished
  if (!saved || !Number.isFinite(saved.cursor)) {
    cursor = now - FIRST_LOOKBACK_MS;
    gap(now, { reason: 'no saved cursor (first start, or the file was lost): nothing before the first-hour catch-up can be read', from: null, to: cursor, recovery: 'UNRECOVERABLE' });
    pending.push(gap(now, { reason: 'start: catching up the last hour', from: cursor, to: now, recovery: 'PENDING' }));
    saveCursorNow(now);
    return;
  }
  const oldest = now - MAX_CATCHUP_MS;
  if (saved.cursor < oldest) {
    gap(now, { reason: 'restart: gap longer than the catch-up limit', from: saved.cursor, to: oldest, recovery: 'UNRECOVERABLE' });
    // every earlier pending gap starts at or before the saved cursor, so part of it is now beyond the limit
    if (earlier.length) rec.record('NEWS_RECOVERY', { status: 'INCOMPLETE', gapIds: earlier.map((g) => g.gapId), reason: 'the server was down past the 24 h catch-up limit: part of these gaps can no longer be read' });
    cursor = oldest;
  } else { cursor = Math.min(saved.cursor, now); pending = earlier; } // a saved cursor in the future never blanks the polls
  pending.push(gap(now, { reason: 'restart: catching up from the saved cursor', from: cursor, to: now, recovery: 'PENDING', lastSavedAt: saved.savedAt || null }));
  saveCursorNow(now);
}

// Fix 3: after each poll. Coverage is established only by a COMPLETED query (no unread page), never by HTTP success alone.
function afterPoll(now, since, done) {
  if (done && pending.length) {
    const ok = rec.record('NEWS_RECOVERY', { status: 'COMPLETE', gapIds: pending.map((g) => g.gapId), from: Math.min(...pending.map((g) => (g.from === null ? Infinity : g.from))),
      to: Math.max(...pending.map((g) => g.to)), since, readThrough: Date.now(), note: 'every page of a query that started at or before these gaps was read' });
    if (ok) pending = []; // a refused line keeps them pending: the next completed query records the recovery
  }
  if (!done) {
    backlog = backlog || { since: now, polls: 0, warned: false };
    backlog.polls += 1;
    if (!backlog.warned && now - backlog.since > BACKLOG_WARN_MS) {
      backlog.warned = rec.record('NEWS_BACKLOG', { state: 'PERSISTENT', since: backlog.since, polls: backlog.polls, minutes: Math.round((now - backlog.since) / 60000),
        note: 'unread pages carried for more than 10 minutes: news is read late until this clears' });
    }
  } else if (backlog) {
    if (backlog.warned) rec.record('NEWS_BACKLOG', { state: 'CLEARED', since: backlog.since, polls: backlog.polls, minutes: Math.round((now - backlog.since) / 60000) });
    backlog = null;
  }
}
const backlogOf = (now) => (backlog ? { since: backlog.since, polls: backlog.polls, minutes: Math.round((now - backlog.since) / 60000) } : null);

async function poll({ now = Date.now() } = {}) {
  if (polling) return { skipped: true };
  polling = true;
  try {
    if (cursor === null) resume(now);
    const keys = require('../connectors/alpaca-api').dataKeys();
    if (!keys) throw new Error('no Alpaca data keys');
    const since = carried ? carried.since : new Date(cursor - OVERLAP_MS).toISOString();
    let token = carried ? carried.token : null; let pages = 0; let fresh = 0; let newest = cursor;
    do {
      const q = new URLSearchParams({ symbols: universe.symbols().join(','), start: since, sort: 'asc', limit: '50', include_content: 'true' });
      if (token) q.set('page_token', token);
      const res = await require('../connectors/net-guard').guardedFetch(`${base()}/v1beta1/news?${q}`,
        { headers: { 'APCA-API-KEY-ID': keys.key, 'APCA-API-SECRET-KEY': keys.secret }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { if (carried && [400, 422].includes(res.status)) carried = null; throw new Error(`HTTP ${res.status}`); } // an expired page token: restart from the cursor
      const body = await res.json(); const tRecv = Date.now();
      for (const n of body.news || []) { if (observe(n, 'poll', tRecv)) fresh += 1; const t = tOf(n); if (t !== null && t > newest) newest = t; }
      token = body.next_page_token || null; pages += 1;
    } while (token && pages < MAX_PAGES);
    // C3: the cursor moves only to the newest article READ (never past now); unread pages are carried to the next poll.
    cursor = Math.min(newest, Date.now());
    carried = token ? { since, token } : null;
    if (token) st.truncatedPolls += 1;
    st.polls += 1; st.lastPollAt = now; st.lastNew = fresh;
    afterPoll(now, since, !token);
    rec.record('POLL_STATUS', { source: 'alpaca-news', ok: true, new: fresh, pages, unreadPagesLeft: !!token, since, cursor, marketOpen: marketOpen(), symbols: universe.VERSION,
      backlog: backlogOf(now), recoveryPending: pending.length });
    await saveCursor(now);
    return { ok: true, new: fresh, pages, unreadPagesLeft: !!token };
  } catch (err) {
    st.pollErrors += 1; st.lastPollError = String(err.message || err).slice(0, 200);
    rec.record('POLL_STATUS', { source: 'alpaca-news', ok: false, error: st.lastPollError, cursor, marketOpen: marketOpen(), symbols: universe.VERSION,
      backlog: backlogOf(now), recoveryPending: pending.length });
    return { ok: false, error: st.lastPollError };
  } finally { polling = false; }
}

function start() {
  if (timer) return;
  resume(Date.now());
  const tick = () => { poll().catch(() => {}); timer = setTimeout(tick, everyMs()); if (timer.unref) timer.unref(); };
  timer = setTimeout(tick, 30 * 1000); if (timer.unref) timer.unref();
}
function stop() { if (timer) clearTimeout(timer); timer = null; }
const status = () => ({ ...st, cursor, versionsKnown: versions.size, recoveryPending: pending.length, pendingGaps: pending.slice(0, 10), backlog: backlogOf(Date.now()) });
const _test = { reset: () => { versions = new Map(); cursor = null; carried = null; startedAt = Date.now(); polling = false; pending = []; backlog = null;
  Object.assign(st, { polls: 0, pollErrors: 0, lastPollAt: null, lastNew: 0, lastPollError: null, streamSeen: 0, refused: 0, truncatedPolls: 0 }); },
  resume: (now) => resume(now), cursor: () => cursor, setStartedAt: (t) => { startedAt = t; } };

module.exports = { observe, fromStream, poll, start, stop, status, _test, MAX_PAGES, MAX_CATCHUP_MS };
