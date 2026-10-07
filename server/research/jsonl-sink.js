// A record-only JSONL day-file sink (Phase 94; extracted from the Phase 93 decision recorder so the event recorder shares it).
//   push(entry)   SYNCHRONOUS, no serialization: onto a bounded queue (overflow drops the OLDEST and is counted)
//   flush()       serializes in <= sliceMs slices (setImmediate between them), ONE append per day file, one write in flight.
//                 C2: a failed append re-queues ONLY the entries of the files not yet written (files appended before the failure
//                 are never written twice); onCommitted(state, writtenFiles) runs with the files that were actually written.
//   status()      C2: a write in flight longer than stallMs is a STALL (stalled / stalledForMs, a log warning): the queue keeps
//                 accepting records (bounded), so the trading path never waits on the disk.
//   isCommitted(entry) / drain(maxWaitMs)  whether an entry's append returned; wait for an in-flight write, then flush (bounded)
//   prune(now)    deletes <prefix>-YYYY-MM-DD.jsonl files older than keepDays
const fs = require('fs');
const path = require('path');

const STALL_MS = 30 * 1000;

function createSink({ prefix, dir, dayOf, serialize, onCommitted = () => {}, maxQueue = 5000, sliceMs = 10, keepDays = 180, stallMs = STALL_MS, clock = () => Date.now(), warn = () => {}, warnStall = warn }) {
  let queue = [];
  let writing = false;
  let writingSince = null;
  let stallEpisode = false;
  let fsp = fs.promises;
  const truncCounted = new WeakSet(); // an entry re-serialized after a failed write is not counted as truncated twice
  const committed = new WeakSet();    // fix 3 (review): entries whose append returned (a caller may persist state that depends on them)
  const st = { dropped: 0, serializeErrors: 0, writeErrors: 0, truncated: 0, stalls: 0, lastError: null, lastErrorAt: null, lastWriteAt: null, bytesToday: 0, file: null };
  const fail = (kind, err) => { st[kind] += 1; st.lastError = `${kind}: ${String((err && err.message) || err).slice(0, 200)}`; st.lastErrorAt = clock(); warn(st.lastError); };
  const pfx = () => (typeof prefix === 'function' ? prefix() : prefix); // Phase 95: a function lets a process pick its file identity at start
  const fileOf = (at) => path.join(dir(), `${pfx()}-${dayOf(at)}.jsonl`);
  const stalledFor = () => (writing && writingSince !== null ? clock() - writingSince : 0);

  function push(entry) {
    queue.push(entry);
    if (queue.length > maxQueue) { queue.splice(0, queue.length - maxQueue); st.dropped += 1; warn(`queue full: dropped the oldest record (${st.dropped} dropped)`); }
  }

  function checkStall() {
    const ms = stalledFor();
    if (ms > stallMs) {
      if (!stallEpisode) { stallEpisode = true; st.stalls += 1; }
      warnStall(`write STALLED for ${Math.round(ms / 1000)} s (${queue.length} record(s) queued; recording continues in memory, capped at ${maxQueue})`);
    }
  }

  async function flush() {
    if (writing) { checkStall(); return; }
    if (!queue.length) return;
    writing = true; writingSince = clock(); stallEpisode = false;
    const io = fsp; // one fs for the whole flush
    const batch = queue.splice(0, queue.length);
    const byFile = new Map(); // file -> { lines, entries }
    const state = {};
    const written = new Set();
    let pending = [];
    let reached = 0; // entries the serialize loop got to (the rest go back on the queue if anything throws)
    try {
      let since = Date.now();
      for (const e of batch) {
        if (Date.now() - since > sliceMs) { await new Promise((r) => setImmediate(r)); since = Date.now(); }
        reached += 1;
        try { // review: a bad entry (an unformattable time, an unserializable value) costs only THAT entry
          const file = fileOf(e.at || clock());
          if (!byFile.has(file)) byFile.set(file, { lines: [], entries: [] });
          const out = serialize(e, file, state);
          if (out.truncated && !truncCounted.has(e)) { st.truncated += 1; truncCounted.add(e); }
          byFile.get(file).lines.push(...out.lines); byFile.get(file).entries.push(e);
        } catch (err) { fail('serializeErrors', err); }
      }
      pending = [...byFile.entries()].filter(([, s]) => s.lines.length);
      await io.mkdir(dir(), { recursive: true });
      while (pending.length) {
        const [file, slot] = pending[0];
        const text = `${slot.lines.join('\n')}\n`;
        await io.appendFile(file, text);
        written.add(file); pending.shift();
        for (const e of slot.entries) committed.add(e);
        st.bytesToday += text.length; st.file = file; st.lastWriteAt = clock();
      }
    } catch (err) {
      fail('writeErrors', err);
      // Only the files NOT written go back on the queue (their entries re-serialize next time); written files are never re-sent.
      // every file not written (whether or not its append was attempted) + the entries the loop never reached
      queue = [...byFile.entries()].filter(([file]) => !written.has(file)).flatMap(([, s]) => s.entries).concat(batch.slice(reached), queue);
      if (queue.length > maxQueue) { st.dropped += queue.length - maxQueue; queue.splice(0, queue.length - maxQueue); }
    } finally {
      try { onCommitted(state, written); } catch (err) { fail('serializeErrors', err); }
      writing = false; writingSince = null; stallEpisode = false;
    }
  }

  // Waits (at most maxWaitMs, real time) for a write already in flight, then flushes what is queued. Never throws. Off the trading path:
  // only a record-only caller that must not persist ahead of its lines (news-capture's cursor) awaits it.
  async function drain(maxWaitMs = 5000) {
    try {
      const until = Date.now() + maxWaitMs;
      while (writing && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      if (!writing) await flush();
    } catch { /* flush records its own errors */ }
  }

  function prune(now = clock()) {
    const re = new RegExp(`^${pfx()}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
    try {
      for (const f of fs.readdirSync(dir())) {
        const m = re.exec(f);
        if (m && now - Date.parse(`${m[1]}T12:00:00Z`) > keepDays * 86400000) fs.unlinkSync(path.join(dir(), f));
      }
    } catch { /* no folder yet */ }
  }

  return {
    push, flush, drain, prune,
    isCommitted: (e) => committed.has(e),
    status: () => { const ms = stalledFor(); return { ...st, queued: queue.length, writing, stalled: ms > stallMs, stalledForMs: ms > stallMs ? ms : 0 }; },
    resetDay: () => { st.bytesToday = 0; },
    setFs: (f) => { fsp = f || fs.promises; },
    queue: () => queue,
    reset: () => { queue = []; writing = false; writingSince = null; stallEpisode = false;
      Object.assign(st, { dropped: 0, serializeErrors: 0, writeErrors: 0, truncated: 0, stalls: 0, lastError: null, lastErrorAt: null, lastWriteAt: null, bytesToday: 0, file: null }); },
  };
}

module.exports = { createSink, STALL_MS };
