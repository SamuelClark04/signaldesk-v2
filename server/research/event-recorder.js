// Event capture (Phase 94 Stage 1): RECORD-ONLY market-event evidence for the offline research layer (spec section 7). Nothing in
// trading reads it. record(kind, data) is SYNCHRONOUS, never throws and never serializes: { v, kind, at, ...data } goes onto the shared
// sink's bounded queue; the 5 s unref'd flush writes <EVENTS_DIR>/events-YYYY-MM-DD.jsonl (New York date), default next to the ledger,
// kept KEEP_DAYS (the PC archive is the system of record).
// C4: a STATUS line every 10 min carries the counters AND the process health the pilot criteria check: CPU % of one core since the last
// STATUS, RSS / heap MB and the event-loop delay p99 (perf_hooks). These describe the WHOLE server process, not the capture alone.
const path = require('path');
const { createSink } = require('./jsonl-sink');

const KINDS = new Set(['NEWS', 'NEWS_GAP', 'MACRO_SNAPSHOT', 'EARNINGS_SNAPSHOT', 'OPTION_MARK', 'POLL_STATUS', 'STATUS']);
const FLUSH_MS = 5000;
const KEEP_DAYS = 60;
const MAX_TEXT = 64 * 1024;
const STATUS_EVERY_MS = 10 * 60 * 1000;
const LOOP_RESOLUTION_MS = 20; // the event-loop monitor's sampling interval: an idle loop reads about this much
const BOOT_ID = new Date(Date.now() - process.uptime() * 1000).toISOString(); // this process's start: counters restart with it

let clock = () => Date.now();
let timer = null;
let lastWarn = 0;
let lastStatusAt = 0;
let loopHist = null;
let cpuMark = null; // { at, usage } of the last STATUS
const st = { recordedToday: 0, byKind: {}, recordErrors: 0, lastError: null, lastErrorAt: null, day: null };

const enabled = () => String(process.env.EVENTS_RECORDER || '').toLowerCase() !== 'off';
const dir = () => process.env.EVENTS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json'));
const nyDay = (ms) => { try { return require('../services/et-time').ymd(ms); } catch { return new Date(ms).toISOString().slice(0, 10); } };
const warn = (msg) => { const n = clock(); if (n - lastWarn >= 5 * 60 * 1000) { lastWarn = n; console.warn(`[event-recorder] ${msg}`); } };
let lastStallWarn = 0; // its own limiter: another warning never hides a STALL
const warnStall = (msg) => { const n = clock(); if (n - lastStallWarn >= 5 * 60 * 1000) { lastStallWarn = n; console.warn(`[event-recorder] ${msg}`); } };
const sink = createSink({ prefix: 'events', dir, dayOf: nyDay, serialize: (e) => ({ lines: [JSON.stringify(e)] }), keepDays: KEEP_DAYS, clock: () => clock(), warn, warnStall });
const text = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : null);

function record(kind, data) {
  try {
    if (!enabled() || !KINDS.has(kind)) return false;
    const now = clock(); const d = nyDay(now);
    if (st.day !== d) { st.day = d; st.recordedToday = 0; st.byKind = {}; sink.resetDay(); }
    // review: the recorder's own v / kind / at always win (data cannot re-file a line under another kind or day); a source time
    // belongs in its own field (t_recv, created_at, ...).
    sink.push({ ...(data && typeof data === 'object' ? data : {}), v: 1, kind, at: now });
    st.recordedToday += 1; st.byKind[kind] = (st.byKind[kind] || 0) + 1;
    return true;
  } catch (err) { st.recordErrors += 1; st.lastError = `recordErrors: ${String((err && err.message) || err).slice(0, 200)}`; st.lastErrorAt = clock(); warn(st.lastError); return false; }
}

function status() {
  const s = sink.status();
  const mineNewer = (st.lastErrorAt || 0) > (s.lastErrorAt || 0);
  return { enabled: enabled(), ...s, recordedToday: st.recordedToday, byKind: { ...st.byKind }, recordErrors: st.recordErrors,
    lastError: mineNewer ? st.lastError : s.lastError, lastErrorAt: mineNewer ? st.lastErrorAt : s.lastErrorAt, dir: dir() };
}

// C4: process health since the previous STATUS line (whole process).
function health() {
  const now = Date.now(); const usage = process.cpuUsage(); const mem = process.memoryUsage();
  let cpuPct = null;
  if (cpuMark && now > cpuMark.at) cpuPct = Math.round(((usage.user - cpuMark.usage.user + usage.system - cpuMark.usage.system) / 1000 / (now - cpuMark.at)) * 1000) / 10;
  cpuMark = { at: now, usage };
  let loopP99Ms = null; let loopMaxMs = null;
  // review: reported as delay BEYOND the sampling interval (an idle loop reads ~LOOP_RESOLUTION_MS), floored at 0
  const excess = (ns) => Math.max(0, Math.round(ns / 1e4 - LOOP_RESOLUTION_MS * 100) / 100); // rounded after the subtraction
  if (loopHist) { loopP99Ms = excess(loopHist.percentile(99)); loopMaxMs = excess(loopHist.max); loopHist.reset(); }
  return { scope: 'whole server process', cpuPct, rssMb: Math.round(mem.rss / 1e5) / 10, heapMb: Math.round(mem.heapUsed / 1e5) / 10, loopP99Ms, loopMaxMs,
    loopNote: `event-loop delay beyond the ${LOOP_RESOLUTION_MS} ms sampling interval; the first moments after each STATUS line are not sampled` };
}

async function flush() {
  if (enabled() && clock() - lastStatusAt >= STATUS_EVERY_MS) { // review: no STATUS line while recording is off
    lastStatusAt = clock(); sink.push({ v: 1, kind: 'STATUS', at: lastStatusAt, bootId: BOOT_ID, ...status(), health: health() }); }
  return sink.flush();
}
function start() {
  if (timer || !enabled()) return;
  sink.prune();
  try { loopHist = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 }); loopHist.enable(); } catch { loopHist = null; }
  cpuMark = { at: Date.now(), usage: process.cpuUsage() };
  timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; if (loopHist) { loopHist.disable(); loopHist = null; } }

const _test = { setClock: (fn) => { clock = fn || (() => Date.now()); }, setFs: (f) => sink.setFs(f), statusDue: () => { lastStatusAt = 0; }, reset: () => {
  sink.reset(); lastWarn = 0; lastStallWarn = 0; cpuMark = null; lastStatusAt = Infinity; Object.assign(st, { recordedToday: 0, byKind: {}, recordErrors: 0, lastError: null, lastErrorAt: null, day: null }); } };

module.exports = { record, flush, start, stop, status, health, text, KINDS, KEEP_DAYS, _test };
