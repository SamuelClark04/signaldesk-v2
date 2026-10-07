// Phase 95 Task 1.1: the collector's heartbeat (plan 10.2), every 5 minutes into the events file as kind HEARTBEAT: the collector's
// own CPU / RSS, its Alpaca requests and 429s, the contract grid and pinned counts, the bytes written today and the export backlog.
// The PC report flags a missing heartbeat (15 min in session hours) and a backlog over 2 h.
const rec = require('../event-recorder');

const EVERY_MS = 5 * 60 * 1000;
let cpuMark = null; let timer = null;

function cpuPct(now) {
  const usage = process.cpuUsage(); let pct = null;
  if (cpuMark && now > cpuMark.at) pct = Math.round(((usage.user + usage.system - cpuMark.u) / 1000 / (now - cpuMark.at)) * 1000) / 10;
  cpuMark = { at: now, u: usage.user + usage.system };
  return pct;
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
      bytesToday: st.bytesToday ?? null,
      export: exporter ? exporter() : null,
    };
    return rec.recordTracked('HEARTBEAT', data);
  } catch { return null; }
}

function start(sources) {
  if (timer) return;
  timer = setInterval(() => beat(sources), EVERY_MS); if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { beat, start, stop, EVERY_MS };
