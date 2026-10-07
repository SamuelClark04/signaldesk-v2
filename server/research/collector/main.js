// Phase 95: the VM research collector (RECORD-ONLY; plan sections 3 and 10.1). It runs as its OWN pm2 app at low priority, so a crash
// or a load spike never touches the trading server:
//   pm2 start "nice -n 10 node server/research/collector/main.js" --name signaldesk-research --max-memory-restart 200M --kill-timeout 6000
// It never imports trading code, broker connectors or the server (tests/ph95collector.js: an exact allowlist of its module graph),
// never sends an order and never messages the trading server.
// Its own identity, so it never shares a file with the trading server: research-YYYY-MM-DD.jsonl, research-news-cursor.json, STATUS
// lines labelled "research collector process".
// RESEARCH_COLLECTOR=on in the shared .env is the ONE switch: the trading server then stops its own news poll and earnings snapshot
// (event-capture.js) and the collector runs them. Without it the collector never polls (no double polling), and records only its
// heartbeat. Every Alpaca request of the collector goes through its limiter (40 / min default, clamped 1-150, 2-min stand-back on 429).
// Environment: ONLY the keys below are taken from .env (parsed like the server's dotenv; never the broker keys); a set variable wins.
// The collector does not read the credentials vault: its Alpaca data keys must be in .env (the runbook checks the first poll).
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
  'EVENTS_DIR', 'EVENTS_RECORDER', 'LEDGER_STATE_PATH', 'RESEARCH_GCS_BUCKET', 'RESEARCH_COLLECTOR', 'RESEARCH_COLLECTOR_PER_MIN'];
const IDENTITY = { prefix: 'research', scope: 'research collector process' };
const CURSOR = 'research-news-cursor.json';

function loadEnv(file = path.join(ROOT, '.env')) {
  let parsed = {};
  try { parsed = require('dotenv').parse(fs.readFileSync(file)); } catch { return 0; } // no .env: the environment alone
  let n = 0;
  for (const k of ALLOWED) if (parsed[k] !== undefined && process.env[k] === undefined) { process.env[k] = parsed[k]; n += 1; }
  return n;
}
const perMinOf = (v) => Math.min(150, Math.max(1, Math.floor(Number(v)) || 40));

let limiter = null; let keepAlive = null; let started = false;
const sources = { get limiter() { return limiter; }, grid: () => null, exporter: () => null }; // the grid and the exporter register here (Tasks 1.2 / 2.1)

// Alpaca requests of this process: through the limiter, then net-guard (fails fast on a dead host).
const limitedFetch = async (url, opts) => {
  await limiter.acquire();
  const res = await require('../../connectors/net-guard').guardedFetch(url, opts);
  limiter.report(res.status); return res;
};

function start({ envFile } = {}) {
  if (started) return; started = true;
  loadEnv(envFile);
  limiter = createLimiter({ perMin: perMinOf(process.env.RESEARCH_COLLECTOR_PER_MIN) });
  keepAlive = setInterval(() => {}, 60 * 1000); // every reused timer is unref'd (built for the trading server): this one keeps THIS process up
  const onSignal = (sig) => { shutdown({ reason: sig }).then(() => process.exit(0)); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  if (String(process.env.EVENTS_RECORDER || '').toLowerCase() === 'off') { console.log('[research] EVENTS_RECORDER=off: idle (nothing recorded)'); return; } // idle, not exiting: pm2 would restart-loop
  if (!cal.CALENDAR_YEARS.includes(new Date().getUTCFullYear())) console.warn('[research] the NYSE calendar has no holidays for this year: extend server/research/nyse-calendar.js');
  rec.useIdentity(IDENTITY);
  rec.start();
  heartbeat.start(sources); heartbeat.beat(sources);
  if (String(process.env.RESEARCH_COLLECTOR || '').toLowerCase() === 'on') {
    news.useCursorFile(CURSOR); news.useFetch(limitedFetch); news.useMarketOpen(() => cal.isOpen(Date.now()));
    news.start(); earnings.start();
    console.log(`[research] collector started (pid ${process.pid}): news poll + earnings snapshot; limiter ${limiter.stats().perMin} req/min`);
  } else console.log(`[research] collector started (pid ${process.pid}) WITHOUT polling: RESEARCH_COLLECTOR is not on, so the trading server still polls`);
}

// Stops every timer, waits for a write in flight, then flushes what is queued. Resolves within 5 s even if the disk hangs; `flushed`
// says whether anything was left unwritten.
async function shutdown({ reason = 'stop' } = {}) {
  heartbeat.stop(); news.stop(); earnings.stop();
  if (keepAlive) clearInterval(keepAlive); keepAlive = null;
  await Promise.race([rec.drain(4000), new Promise((r) => { const t = setTimeout(r, 4500); if (t.unref) t.unref(); })]);
  rec.stop();
  const left = rec.status().queued || 0;
  return { ok: true, flushed: left === 0, unwritten: left, reason };
}

if (require.main === module) start();
module.exports = { start, shutdown, loadEnv, perMinOf, sources, ALLOWED, IDENTITY, CURSOR, _test: { keptAlive: () => !!(keepAlive && keepAlive.hasRef()), limiter: () => limiter } };
