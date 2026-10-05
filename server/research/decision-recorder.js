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
//   flush (every 5 s, unref) serializes in <= SLICE_MS slices (setImmediate between them), each distinct bar series ONCE per day
//                            (decision lines reference it by key), one appendFile in flight; a failed write re-queues the batch.
// Files: <DECISIONS_DIR>/decisions-YYYY-MM-DD.jsonl (New York date), default next to the ledger; pruned after KEEP_DAYS.
// status(): counters for /api/version, Settings and vm-audit (drops, errors, truncations, records missing their inputs).
const fs = require('fs');
const path = require('path');
const ser = require('./decision-serialize');

const MAX_QUEUE = 5000;
const FLUSH_MS = 5000;
const SLICE_MS = 10;
const REPEAT_EVERY_MS = 15 * 60 * 1000;
const MAX_SEEN = 20000;
const KEEP_DAYS = 180;
const LIFECYCLE = new Set(['STAGED', 'APPROVAL_HOLD', 'APPROVAL_REJECT', 'APPROVED', 'USER_REJECT', 'EXPIRED', 'OPENED', 'ROUTE_FAILED', 'FILLED', 'VOIDED', 'CLOSED']);
const OBSERVED = new Set(['STRATEGY_BLOCK', 'PIPELINE_REJECT']);
const RADAR = new Set(['equity-day', 'equity-swing', 'options-system', 'options-quickflips']);

let clock = () => Date.now();
let fsp = fs.promises; // tests swap in a hanging / failing fs
let queue = [];
let seen = new Map(); // key -> { id, path, bucket, count, emitted, firstAt, lastAt, lastPrice, lastEmitAt }
let day = null;
let timer = null;
let writing = false;
let seq = 0;
const st = { recordedToday: 0, byPath: {}, dropped: 0, serializeErrors: 0, writeErrors: 0, truncated: 0, missingContext: 0, recordErrors: 0,
  lastError: null, lastErrorAt: null, lastWriteAt: null, bytesToday: 0, file: null };
let lastWarn = 0;

const enabled = () => String(process.env.DECISIONS_RECORDER || '').toLowerCase() !== 'off';
const dir = () => process.env.DECISIONS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json'));
const nyDay = (ms) => { try { return require('../services/et-time').ymd(ms); } catch { return new Date(ms).toISOString().slice(0, 10); } };
const bucketOf = (reason) => { try { return reason ? require('../execution/rejection-stats').bucket(String(reason)) : null; } catch { return null; } };
const warn = (msg) => { const n = clock(); if (n - lastWarn >= 5 * 60 * 1000) { lastWarn = n; console.warn(`[decision-recorder] ${msg}`); } };
function fail(kind, err) { st[kind] += 1; st.lastError = `${kind}: ${String((err && err.message) || err).slice(0, 200)}`; st.lastErrorAt = clock(); warn(st.lastError); }

function push(entry) {
  queue.push(entry);
  if (queue.length > MAX_QUEUE) { queue.splice(0, queue.length - MAX_QUEUE); st.dropped += 1; warn(`queue full: dropped the oldest record (${st.dropped} dropped)`); }
}

// The New York day changed: flush every pending repeat count, start a fresh dedupe map.
function rollover(now) {
  const d = nyDay(now);
  if (day === d) return;
  if (day !== null) { for (const s of seen.values()) emitRepeats(s, now); seen = new Map(); st.recordedToday = 0; st.byPath = {}; st.bytesToday = 0; }
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
  } catch (err) { fail('recordErrors', err); return false; }
}
let code = null;
const codeVersion = () => { if (code === null) { try { code = require('../version').BOOT.commit || ''; } catch { code = ''; } } return code || null; };

// Serialize the batch in time slices (never one long synchronous loop), then ONE append per day file.
async function flush() {
  if (writing || !queue.length) return;
  writing = true;
  const io = fsp; // one fs for the whole flush (a swap mid-flush never mixes writers)
  const batch = queue.splice(0, queue.length);
  const lines = new Map(); // file -> [lines]
  const newSeries = new Set();
  try {
    let t = clock(); let since = Date.now();
    for (const e of batch) {
      if (Date.now() - since > SLICE_MS) { await new Promise((r) => setImmediate(r)); since = Date.now(); }
      const file = path.join(dir(), `decisions-${nyDay(e.at || t)}.jsonl`);
      if (!lines.has(file)) lines.set(file, []);
      try {
        const out = ser.lines(e, (k) => ser.writtenSeries.has(`${file}|${k}`) || newSeries.has(`${file}|${k}`), (k) => newSeries.add(`${file}|${k}`)); // series once per day file
        if (out.truncated) st.truncated += 1;
        lines.get(file).push(...out.lines);
      } catch (err) { fail('serializeErrors', err); }
    }
    await io.mkdir(dir(), { recursive: true });
    for (const [file, list] of lines) {
      if (!list.length) continue;
      const text = `${list.join('\n')}\n`;
      await io.appendFile(file, text);
      st.bytesToday += text.length; st.file = file; st.lastWriteAt = clock(); t = st.lastWriteAt;
    }
    for (const k of newSeries) ser.markWritten(k);
  } catch (err) {
    fail('writeErrors', err);
    queue = batch.concat(queue); // retry next flush; the cap still applies
    if (queue.length > MAX_QUEUE) { st.dropped += queue.length - MAX_QUEUE; queue.splice(0, queue.length - MAX_QUEUE); }
  } finally { writing = false; }
}

function prune(now = clock()) {
  try {
    for (const f of fs.readdirSync(dir())) {
      const m = /^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && now - Date.parse(`${m[1]}T12:00:00Z`) > KEEP_DAYS * 86400000) fs.unlinkSync(path.join(dir(), f));
    }
  } catch { /* no folder yet */ }
}

function start() {
  if (timer || !enabled()) return;
  prune();
  timer = setInterval(() => { flush().catch((err) => fail('writeErrors', err)); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
const status = () => ({ enabled: enabled(), ...st, byPath: { ...st.byPath }, queued: queue.length, writing, dir: dir() });

// Tests only.
const _test = { setClock: (fn) => { clock = fn || (() => Date.now()); }, setFs: (f) => { fsp = f || fs.promises; }, reset: () => {
  queue = []; seen = new Map(); day = null; seq = 0; writing = false; lastWarn = 0; ser.writtenSeries.clear();
  Object.assign(st, { recordedToday: 0, byPath: {}, dropped: 0, serializeErrors: 0, writeErrors: 0, truncated: 0, missingContext: 0, recordErrors: 0, lastError: null, lastErrorAt: null, lastWriteAt: null, bytesToday: 0, file: null }); },
  queue: () => queue };

module.exports = { record, flush, start, stop, status, prune, LIFECYCLE, OBSERVED, MAX_QUEUE, REPEAT_EVERY_MS, _test };
