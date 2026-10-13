// Phase 95 (desktop mode): the post-session research job, started by the collector (server/research/collector/nightly.js) or by hand:
//   node tools/research/shadow/nightly.js [--through YYYY-MM-DD] [--no-fetch] [--data-dir server/data] [--research-dir research-data] [--out reports]
// 1. ingest the collector's research-*.jsonl (option selections + quotes) into the research ledger
// 2. SIP 1-minute bars + daily bars for the pilot symbols on the sessions that have option data (read-only market data)
// 3. the shadow-paper engine (opportunities x exits@1 x books), recomputed in full
// 4. the report: reports/shadow-<through>.html (+ .json); the OPRA entitlement is re-checked (one request) and stated in the report
// Exit code 0 = done; 1 = failed (the collector retries after 30 min).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const a = process.argv.slice(2); const arg = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
for (const line of (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/); } catch { return []; } })()) {
  const m = /^(ALPACA_API_KEY|ALPACA_API_SECRET|ALPACA_PAPER_API_KEY|ALPACA_PAPER_API_SECRET|RESEARCH_OPTIONS_FEED|EVENTS_DIR)=(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
require('dns').setDefaultResultOrder('ipv4first'); // as server/boot.js
const W = require('../db');
const et = require('../../../server/services/et-time');
const { ingest } = require('./ingest');
const { run } = require('./run');
const report = require('./report');

const BASE = 'https://data.alpaca.markets';
async function opraStatus(db, keys) {
  const c = db.prepare('select contract from candidates order by recorded_at desc limit 1').get();
  if (!keys || !c) return 'not checked (no keys or no contract yet)';
  try {
    const res = await fetch(`${BASE}/v1beta1/options/snapshots?feed=opra&symbols=${c.contract}`, { headers: { 'APCA-API-KEY-ID': keys.key, 'APCA-API-SECRET-KEY': keys.secret }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return 'OPRA is now served to this account: set RESEARCH_OPTIONS_FEED=opra to record MARKET_QUOTE books';
    const body = (await res.text()).slice(0, 120);
    return `OPRA blocked for this account (HTTP ${res.status}${body ? `: ${body}` : ''}; checked ${new Date().toISOString().slice(0, 16)}Z)`;
  } catch (e) { return `OPRA check failed: ${e.message}`; }
}

(async () => {
  const t0 = Date.now();
  const dataDir = path.resolve(ROOT, arg('--data-dir', process.env.EVENTS_DIR || 'server/data'));
  const researchDir = path.resolve(ROOT, arg('--research-dir', 'research-data'));
  const through = arg('--through', require('../../../server/research/collector/nightly').lastCompleted(Date.now()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new Error(`--through must be YYYY-MM-DD (got ${through})`);
  const db = W.open(path.join(researchDir, 'research.sqlite'));
  try {
    const ing = ingest(db, { dir: dataDir, quotesDir: researchDir, through });
    console.log(`ingest: ${JSON.stringify(ing)}`);
    const symbols = [...require('../../../server/research/capture-universe').symbols()];
    const days = [...new Set(db.prepare('select recorded_at from candidates').all().map((r) => et.ymd(r.recorded_at)))].filter((d) => d <= through).sort();
    const keys = require('../../../server/research/data-keys').dataKeys();
    if (!a.includes('--no-fetch') && days.length) {
      if (!keys) throw new Error('no Alpaca data keys in .env');
      const bars = require('../bars'); const limiter = require('../../../server/research/collector/budget').createLimiter({ perMin: 60 });
      // + the 20 sessions before the first one: the T4 / T5 baselines (bars already stored are skipped)
      const cal = require('../../../server/research/nyse-calendar'); const pre = []; let d = days[0];
      while (pre.length < 20) { d = new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10); if (cal.isSessionDay(d)) pre.push(d); }
      console.log(`bars: ${JSON.stringify(await bars.fetchDays(db, { symbols, days: [...pre.reverse(), ...days], limiter, keys }))}`);
      const from = new Date(Date.parse(`${days[0]}T12:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
      console.log(`daily: ${JSON.stringify(await bars.fetchDaily(db, { symbols, from, to: through, limiter, keys }))}`);
    }
    const result = run(db, { quotesDir: researchDir, dataDir, symbols, through });
    const collection = days.map((d) => {
      const from = et.toEpoch(d, 0, 0); const to = from + 86400000;
      const c = db.prepare('select count(distinct recorded_at) n, count(distinct underlying) u from candidates where recorded_at >= ? and recorded_at < ?').get(from, to);
      let quotes = 0; try { const q = W.openQuotes(researchDir, d.slice(0, 7)); quotes = q.prepare('select count(*) n from quotes where t_quote >= ? and t_quote < ?').get(from, to).n; q.close(); } catch { quotes = 0; }
      return { day: d, candidates: c.n, quotes, underlyings: c.u };
    });
    const discovery = require('./protocol').step({ result, protocolFile: path.join(ROOT, 'docs', 'research', 'phase95-protocol.md'), dir: path.join(researchDir, 'discovery'), today: through });
    console.log(`protocol: ${discovery.ranNow ? `discovery run ${discovery.ranNow.k}: ${discovery.ranNow.tested} tested, ${discovery.ranNow.promising} promising` : `no run due (pool ${discovery.poolSymbolDays} symbol-days)`}; ${discovery.forward.length} proposal(s)`);
    const file = report.write({ result, through, discovery, outDir: path.resolve(ROOT, arg('--out', 'reports')), collection, opraStatus: a.includes('--no-fetch') ? 'not checked (--no-fetch)' : await opraStatus(db, keys) });
    const filled = result.outcomes.filter((o) => o.status === 'FILLED').length;
    console.log(`shadow: ${result.days.length} session(s), ${result.opportunities.length} opportunities, ${result.outcomes.length} rule outcomes (${filled} filled), ${result.books.length} books`);
    console.log(`report: ${file} (${Math.round((Date.now() - t0) / 1000)} s)`);
  } finally { db.close(); }
})().catch((e) => { console.error(`nightly FAILED: ${String(e && e.stack || e).slice(0, 600)}`); process.exitCode = 1; });
