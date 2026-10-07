// Phase 95 Task 1.1: the collector's heartbeat (plan 10.2), every 5 minutes into its own file as kind HEARTBEAT:
// - its own CPU / RSS, its Alpaca requests and 429s;
// - the contract grid and pinned counts;
// - its recorder's counters (written today, dropped, write errors, queued, stalled);
// - the export backlog;
// - the trading server's LAST STATUS line, read from the server's own events file (scope, health, drops / errors).
// The PC report flags a missing heartbeat (15 min in session hours) and a backlog over 2 h.
const fs = require('fs');
const path = require('path');
const rec = require('../event-recorder');

const EVERY_MS = 5 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;
let cpuMark = null; let timer = null;

function cpuPct(now) {
  const usage = process.cpuUsage(); let pct = null;
  if (cpuMark) pct = Math.round(((usage.user + usage.system - cpuMark.u) / 1000 / Math.max(1, now - cpuMark.at)) * 1000) / 10;
  cpuMark = { at: now, u: usage.user + usage.system };
  return pct;
}
const seedCpu = (now = Date.now()) => { const u = process.cpuUsage(); cpuMark = { at: now - 1000, u: u.user + u.system }; };

// The last STATUS line of the trading server's events-<day>.jsonl in the same folder (the last 64 KB only), or null.
function serverStatus(now) {
  try {
    const dir = process.env.EVENTS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', '..', 'data', 'ledger-state.json'));
    const day = require('../../services/et-time').ymd(now);
    const f = path.join(dir, `events-${day}.jsonl`); const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r'); const len = Math.min(size, TAIL_BYTES); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('"kind":"STATUS"'));
    if (!lines.length) return null;
    const s = JSON.parse(lines[lines.length - 1]);
    return { at: s.at, bootId: s.bootId, scope: s.health && s.health.scope, cpuPct: s.health && s.health.cpuPct, rssMb: s.health && s.health.rssMb,
      loopP99Ms: s.health && s.health.loopP99Ms, dropped: s.dropped, writeErrors: s.writeErrors, stalled: s.stalled };
  } catch { return null; }
}

// sources: { limiter, grid(): { contracts, pinned }, exporter(): { backlogFiles, uploadedToday }, now? } -> the recorded line (or null)
function beat({ limiter, grid, exporter, now = Date.now() } = {}) {
  try {
    const s = limiter ? limiter.stats() : {};
    const st = rec.status ? rec.status() : {};
    const data = {
      collector: { pid: process.pid, cpuPct: cpuPct(now), rssMb: Math.round(process.memoryUsage().rss / 1e5) / 10, uptimeS: Math.round(process.uptime()) },
      requests: { perMin: s.perMin ?? null, lastMin: s.usedLastMin ?? null, total: s.total ?? null, r429: s.r429 ?? null, pausedUntil: s.pausedUntil ?? null },
      grid: grid ? grid() : null,
      recorder: { recordedToday: st.recordedToday ?? null, dropped: st.dropped ?? null, writeErrors: st.writeErrors ?? null, queued: st.queued ?? null, stalled: st.stalled ?? null },
      bytesToday: st.bytesToday ?? null,
      export: exporter ? exporter() : null,
      server: serverStatus(now),
    };
    return rec.recordTracked('HEARTBEAT', data);
  } catch { return null; }
}

function start(sources) {
  if (timer) return;
  seedCpu();
  timer = setInterval(() => beat(sources), EVERY_MS); if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { beat, start, stop, serverStatus, EVERY_MS };
