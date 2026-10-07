// Phase 95: the VM research collector (RECORD-ONLY; plan sections 3 and 10.1). It runs as its OWN pm2 app at low priority, so a crash
// or a load spike never touches the trading server:
//   pm2 start "nice -n 10 node server/research/collector/main.js" --name signaldesk-research --max-memory-restart 200M
// It records what cannot be fetched later (news with our receipt time, the earnings snapshot; the option grid and the exporter
// join in Tasks 1.2-2.1) and writes a heartbeat every 5 min. It never imports trading code, broker connectors or the server
// (tests/ph95collector.js import guard), never sends an order and never messages the trading server.
// Environment: ONLY the keys below are read from .env (never the broker keys); a variable already set wins.
const fs = require('fs');
const path = require('path');
const rec = require('../event-recorder');
const news = require('../news-capture');
const earnings = require('../earnings-snapshot');
const cal = require('../nyse-calendar');
const heartbeat = require('./heartbeat');
const { createLimiter } = require('./budget');

const ROOT = path.join(__dirname, '..', '..', '..');
const ALLOWED = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET', 'ALPACA_DATA_BASE_URL', 'FINNHUB_API_KEY', 'FINNHUB_BASE_URL',
  'EVENTS_DIR', 'EVENTS_RECORDER', 'LEDGER_STATE_PATH', 'RESEARCH_GCS_BUCKET', 'RESEARCH_COLLECTOR_PER_MIN'];

function loadEnv(file = path.join(ROOT, '.env')) {
  let n = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && ALLOWED.includes(m[1]) && process.env[m[1]] === undefined) { process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); n += 1; }
    }
  } catch { /* no .env: the environment alone */ }
  return n;
}

const limiter = createLimiter({ perMin: Number(process.env.RESEARCH_COLLECTOR_PER_MIN) || 40 });
const sources = { limiter, grid: () => null, exporter: () => null }; // the grid and the exporter register here in Tasks 1.2 / 2.1
let started = false;
let keepAlive = null; // every reused timer is unref'd (built for life inside the trading server): this one keeps THIS process running

function start() {
  if (started) return; started = true;
  loadEnv();
  if (String(process.env.EVENTS_RECORDER || '').toLowerCase() === 'off') { console.log('[research] EVENTS_RECORDER=off: nothing started'); return; }
  rec.start();
  news.useMarketOpen(() => cal.isOpen(Date.now())); // the NYSE calendar (no broker clock in this process)
  news.start();
  earnings.start();
  heartbeat.start(sources); heartbeat.beat(sources);
  keepAlive = setInterval(() => {}, 60 * 1000);
  const onSignal = (sig) => { shutdown({ reason: sig }).then(() => process.exit(0)); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  console.log(`[research] collector started (pid ${process.pid}); limiter ${limiter.stats().perMin} req/min`);
}

// Stops every timer and flushes the recorder; resolves within 5 s even if the disk hangs.
async function shutdown({ reason = 'stop' } = {}) {
  heartbeat.stop(); news.stop(); earnings.stop();
  if (keepAlive) clearInterval(keepAlive); keepAlive = null;
  const flushed = await Promise.race([rec.flush().then(() => true).catch(() => false), new Promise((r) => { const t = setTimeout(() => r(false), 4000); if (t.unref) t.unref(); })]);
  rec.stop();
  return { ok: true, flushed, reason };
}

if (require.main === module) start();
module.exports = { start, shutdown, loadEnv, limiter, sources, ALLOWED, _test: { keptAlive: () => !!(keepAlive && keepAlive.hasRef()) } };
