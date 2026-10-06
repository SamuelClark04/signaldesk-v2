// Decision recorder (Phase 93): every decision the app makes about a setup, for the offline Decision Review
// (tools/decision-review). RECORD-ONLY: nothing in trading reads it, and it can neither throw into nor stall a decision.
//   record(path, id, info)   SYNCHRONOUS, try/catch, no await, no JSON / hashing in the call: a shallow copy of the setup's
//                            levels / option fields / reason, the live price (sync cache read) and the decision inputs the
//                            strategy left in decision-context (by id), pushed onto a bounded queue (MAX_QUEUE; overflow drops
//                            the OLDEST and is counted).
//   paths                    lifecycle (never deduplicated): STAGED APPROVAL_HOLD APPROVAL_REJECT APPROVED USER_REJECT EXPIRED
//                            OPENED ROUTE_FAILED FILLED VOIDED CLOSED; repeated observations (deduplicated per id + path + reason bucket): STRATEGY_BLOCK
//                            PIPELINE_REJECT. A repeat only bumps a counter, written as a REPEATS line at most every 15 min per
//                            key, before any lifecycle event of that id, and at the New York day rollover.
//   flush (every 5 s, unref) the shared sink (jsonl-sink.js, Phase 94): time-sliced serialization, each distinct bar series ONCE per
//                            day file, one append per file in flight; a failed append re-queues ONLY the files not written (C2: no
//                            duplicates); a write in flight > 30 s is a visible STALL (status().stalled) while recording continues.
// Files: <DECISIONS_DIR>/decisions-YYYY-MM-DD.jsonl (New York date), default next to the ledger; pruned after KEEP_DAYS.
// status(): counters for /api/version, Settings and vm-audit (drops, errors, truncations, records missing their inputs).
const path = require('path');
const ser = require('./decision-serialize');
const { createSink } = require('./jsonl-sink');

const MAX_QUEUE = 5000;
const FLUSH_MS = 5000;
const REPEAT_EVERY_MS = 15 * 60 * 1000;
const STATUS_EVERY_MS = 10 * 60 * 1000; // a { type: 'status' } line in the day file: drops / errors reach the audit archive
const MAX_SEEN = 20000;
const KEEP_DAYS = 180;
const LIFECYCLE = new Set(['STAGED', 'APPROVAL_HOLD', 'APPROVAL_REJECT', 'APPROVED', 'USER_REJECT', 'EXPIRED', 'OPENED', 'ROUTE_FAILED', 'FILLED', 'VOIDED', 'CLOSED']);
const OBSERVED = new Set(['STRATEGY_BLOCK', 'PIPELINE_REJECT']);
const RADAR = new Set(['equity-day', 'equity-swing', 'options-system', 'options-quickflips']);

let clock = () => Date.now();
let seen = new Map(); // key -> { id, path, bucket, count, emitted, firstAt, lastAt, lastPrice, lastEmitAt }
let day = null;
let timer = null;
let seq = 0;
const st = { recordedToday: 0, byPath: {}, missingContext: 0, recordErrors: 0, flushErrors: 0, lastError: null, lastErrorAt: null };
let lastWarn = 0;
let lastStatusAt = 0;

const enabled = () => String(process.env.DECISIONS_RECORDER || '').toLowerCase() !== 'off';
const dir = () => process.env.DECISIONS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json'));
const nyDay = (ms) => { try { return require('../services/et-time').ymd(ms); } catch { return new Date(ms).toISOString().slice(0, 10); } };
const bucketOf = (reason) => { try { return reason ? require('../execution/rejection-stats').bucket(String(reason)) : null; } catch { return null; } };
const warn = (msg) => { const n = clock(); if (n - lastWarn >= 5 * 60 * 1000) { lastWarn = n; console.warn(`[decision-recorder] ${msg}`); } };
let lastStallWarn = 0; // its own limiter: a queue-full or write-error warning never hides a STALL
const warnStall = (msg) => { const n = clock(); if (n - lastStallWarn >= 5 * 60 * 1000) { lastStallWarn = n; console.warn(`[decision-recorder] ${msg}`); } };
function fail(err) { st.recordErrors += 1; st.lastError = `recordErrors: ${String((err && err.message) || err).slice(0, 200)}`; st.lastErrorAt = clock(); warn(st.lastError); }

// Each distinct bar series ONCE per day file: the keys are committed only for the files actually written (C2).
const sink = createSink({ prefix: 'decisions', dir, dayOf: nyDay, maxQueue: MAX_QUEUE, keepDays: KEEP_DAYS, clock: () => clock(), warn, warnStall,
  serialize: (e, file, state) => {
    state.byFile = state.byFile || new Map(); if (!state.byFile.has(file)) state.byFile.set(file, new Set());
    const fresh = state.byFile.get(file);
    // review: keys are marked written only once the WHOLE entry serialized (a decision line that throws leaves no dangling key)
    const added = []; const out = ser.lines(e, (k) => ser.writtenSeries.has(`${file}|${k}`) || fresh.has(k) || added.includes(k), (k) => added.push(k));
    for (const k of added) fresh.add(k);
    return out; },
  onCommitted: (state, written) => { for (const [file, keys] of state.byFile || []) if (written.has(file)) for (const k of keys) ser.markWritten(`${file}|${k}`); } });
function push(entry) { sink.push(entry); }

// The New York day changed: flush every pending repeat count, start a fresh dedupe map.
function rollover(now) {
  const d = nyDay(now);
  if (day === d) return;
  if (day !== null) { for (const s of seen.values()) emitRepeats(s, now); seen = new Map(); st.recordedToday = 0; st.byPath = {}; sink.resetDay(); }
  day = d;
}
function emitRepeats(s, now) {
  if (s.count <= s.emitted) return;
  push({ type: 'repeats', at: now, id: s.id, path: s.path, reasonBucket: s.bucket, count: s.count, firstAt: s.firstAt, lastAt: s.lastAt, lastPrice: s.lastPrice });
  s.emitted = s.count; s.lastEmitAt = now;
}

const livePrice = (asset) => { try { const p = require('../market/latest-prices').getLatestPrice(asset); return p > 0 ? p : null; } catch { return null; } };

// info: { reason?, candidate? (setup / order / position), guard?, extra? }. Never throws.
function record(pathName, id, info = {}) {
  try {
    if (!enabled() || !pathName || !id) return false;
    const now = clock();
    rollover(now);
    const c = info.candidate || {};
    const bucket = bucketOf(info.reason);
    const price = livePrice(c.asset);
    if (OBSERVED.has(pathName)) {
      const key = `${id}|${pathName}|${bucket || info.reason || ''}`;
      const s = seen.get(key);
      if (s) {
        s.count += 1; s.lastAt = now; s.lastPrice = price;
        if (now - s.lastEmitAt >= REPEAT_EVERY_MS) emitRepeats(s, now);
        return true;
      }
      if (seen.size >= MAX_SEEN) seen.delete(seen.keys().next().value);
      seen.set(key, { id, path: pathName, bucket, count: 1, emitted: 1, firstAt: now, lastAt: now, lastPrice: price, lastEmitAt: now });
    } else if (LIFECYCLE.has(pathName)) {
      for (const s of seen.values()) if (s.id === id) emitRepeats(s, now); // the observations before this event come first
    }
    // The decision inputs ride on the first observation and on STAGED only: a strategy re-captures every pass, so a later
    // lifecycle event (approval, close) would otherwise carry newer bars than the decision used.
    const withCtx = OBSERVED.has(pathName) || pathName === 'STAGED';
    const ctx = withCtx ? require('./decision-context').get(id) : null;
    if (withCtx && !ctx && RADAR.has(c.strategyId)) st.missingContext += 1;
    push({ type: 'decision', v: 1, at: now, seq: (seq += 1), path: pathName, id, reason: info.reason ? String(info.reason) : null, reasonBucket: bucket,
      setup: ser.pick(c), price: { last: price, at: now }, guard: info.guard || null, extra: info.extra || null, context: ctx || null, code: codeVersion() });
    st.recordedToday += 1; st.byPath[pathName] = (st.byPath[pathName] || 0) + 1;
    return true;
  } catch (err) { fail(err); return false; }
}
let code = null;
const codeVersion = () => { if (code === null) { try { code = require('../version').BOOT.commit || ''; } catch { code = ''; } } return code || null; };

async function flush() {
  const s = sink.status();
  if (!s.writing && clock() - lastStatusAt >= STATUS_EVERY_MS && (s.queued || s.dropped || s.writeErrors || st.recordedToday)) {
    lastStatusAt = clock(); push({ type: 'status', at: lastStatusAt, ...status() });
  }
  return sink.flush();
}

const prune = (now = clock()) => sink.prune(now);

function start() {
  if (timer || !enabled()) return;
  prune();
  timer = setInterval(() => { flush().catch((err) => { st.flushErrors += 1; warn(`flush failed: ${String(err && err.message).slice(0, 200)}`); }); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function status() {
  const s = sink.status();
  const mineNewer = (st.lastErrorAt || 0) > (s.lastErrorAt || 0);
  return { enabled: enabled(), ...s, ...st, writeErrors: s.writeErrors + st.flushErrors, byPath: { ...st.byPath }, lastError: mineNewer ? st.lastError : s.lastError, lastErrorAt: mineNewer ? st.lastErrorAt : s.lastErrorAt, dir: dir() };
}

// Tests only.
const _test = { setClock: (fn) => { clock = fn || (() => Date.now()); }, setFs: (f) => sink.setFs(f), reset: () => {
  sink.reset(); seen = new Map(); day = null; seq = 0; lastWarn = 0; lastStatusAt = Infinity; ser.writtenSeries.clear();
  lastStallWarn = 0; Object.assign(st, { recordedToday: 0, byPath: {}, missingContext: 0, recordErrors: 0, flushErrors: 0, lastError: null, lastErrorAt: null }); },
  queue: () => sink.queue(), statusDue: () => { lastStatusAt = 0; } };

module.exports = { record, flush, start, stop, status, prune, LIFECYCLE, OBSERVED, MAX_QUEUE, REPEAT_EVERY_MS, _test };
