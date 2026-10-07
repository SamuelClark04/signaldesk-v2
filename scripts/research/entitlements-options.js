// Phase 95 Task 0.2: option-data entitlement re-probe (read-only GET requests to data.alpaca.markets with this PC's Alpaca DATA keys,
// read from .env and sent in headers only, never printed; User-Agent = the application identifier). Answers, before the collector is
// built:
//   (a) does the free plan serve REAL OPRA option quotes when they are delayed (feed=opra), or only the indicative feed?
//   (b) are RECENT option trade bars / trades served (for calibrating indicative quotes against real prints)?
//   (c) how many contract symbols one `snapshots?symbols=` request accepts and returns;
//   (d) does the chain endpoint honour expiry / strike / type filters (the collector's re-centring query)?
// Run: node scripts/research/entitlements-options.js [--append docs/research/phase94-entitlements.md]
const fs = require('fs');
const path = require('path');

const WANT = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET'];
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]).filter(([k]) => WANT.includes(k)));
const AK = env.ALPACA_API_KEY || env.ALPACA_PAPER_API_KEY; const AS = env.ALPACA_API_SECRET || env.ALPACA_PAPER_API_SECRET;
const H = { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS, 'User-Agent': 'SignalDesk-research/1.0' };
const D = 'https://data.alpaca.markets';
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const get = async (url) => { const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) }); let body = null; try { body = await res.json(); } catch { body = null; } return { status: res.status, body }; };
const msg = (b) => (b && (b.message || b.msg)) || '';

// Pure helpers (tested in tests/ph95entitlements.js).
const chainSymbols = (body) => Object.keys((body && body.snapshots) || {});
const filterRespected = (symbols, { expFrom, expTo, kMin, kMax, type }) => symbols.every((s) => {
  const m = /^[A-Z.]+(\d{6})([CP])(\d{8})$/.exec(s); if (!m) return false;
  const exp = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`; const k = Number(m[3]) / 1000;
  return exp >= expFrom && exp <= expTo && k >= kMin && k <= kMax && (type ? (type === 'call' ? m[2] === 'C' : m[2] === 'P') : true);
});
const quoteAgeMin = (snap, now) => { const t = snap && snap.latestQuote && Date.parse(snap.latestQuote.t); return Number.isFinite(t) ? Math.round((now - t) / 60000) : null; };

async function run(now = Date.now()) {
  const R = [];
  const add = (name, status, note) => R.push({ name, status, note });
  // (d) chain with filters: SPY calls, 14-60 days out, +/-5% of a spot read from the chain's own underlying price (or a wide band).
  const expFrom = ymd(now + 14 * 864e5); const expTo = ymd(now + 60 * 864e5);
  const bar = await get(`${D}/v2/stocks/SPY/bars/latest?feed=iex`);
  const spot = bar.body && bar.body.bar ? bar.body.bar.c : null;
  const kMin = spot ? Math.floor(spot * 0.95) : 1; const kMax = spot ? Math.ceil(spot * 1.05) : 100000;
  const ch = await get(`${D}/v1beta1/options/snapshots/SPY?feed=indicative&type=call&expiration_date_gte=${expFrom}&expiration_date_lte=${expTo}&strike_price_gte=${kMin}&strike_price_lte=${kMax}&limit=1000`);
  const syms = chainSymbols(ch.body);
  add('(d) Chain endpoint with expiry / strike / type filters (SPY calls)', ch.status, ch.status === 200
    ? `${syms.length} contracts on the first page; filters ${filterRespected(syms, { expFrom, expTo, kMin, kMax, type: 'call' }) ? 'RESPECTED' : 'NOT respected'}; next_page_token ${ch.body.next_page_token ? 'present' : 'none'}`
    : `failed: ${msg(ch.body)}`);
  // (c) symbols per snapshots request: a wider chain (no filters) gives enough symbols to try 50 / 100 / 200 / 250.
  const wide = await get(`${D}/v1beta1/options/snapshots/SPY?feed=indicative&expiration_date_gte=${ymd(now)}&expiration_date_lte=${expTo}&limit=1000`);
  const pool = chainSymbols(wide.body);
  for (const n of [50, 100, 200, 250]) {
    if (pool.length < n) { add(`(c) snapshots?symbols= with ${n} symbols`, 'n/a', `only ${pool.length} symbols available to test`); continue; }
    const r = await get(`${D}/v1beta1/options/snapshots?feed=indicative&symbols=${pool.slice(0, n).join(',')}`);
    add(`(c) snapshots?symbols= with ${n} symbols`, r.status, r.status === 200 ? `${chainSymbols(r.body).length} returned; next_page_token ${r.body.next_page_token ? 'present' : 'none'}` : `refused: ${msg(r.body)}`);
  }
  // (a) OPRA feed: a snapshot of a real contract, and its latest quote endpoint.
  const c = syms[0] || pool[0];
  if (c) {
    const s = await get(`${D}/v1beta1/options/snapshots?feed=opra&symbols=${c}`);
    const snap = s.body && s.body.snapshots && s.body.snapshots[c];
    add('(a) OPRA snapshot (feed=opra)', s.status, s.status === 200 ? `served; latest quote ${quoteAgeMin(snap, now)} min old (a delay of about 15 min = delayed OPRA)` : `refused: ${msg(s.body)}`);
    const q = await get(`${D}/v1beta1/options/quotes/latest?feed=opra&symbols=${c}`);
    add('(a) OPRA latest quote (feed=opra)', q.status, q.status === 200 ? 'served' : `refused: ${msg(q.body)}`);
    const i = await get(`${D}/v1beta1/options/snapshots?feed=indicative&symbols=${c}`);
    const isnap = i.body && i.body.snapshots && i.body.snapshots[c];
    add('(a) indicative snapshot, same contract', i.status, i.status === 200 ? `served; latest quote ${quoteAgeMin(isnap, now)} min old` : `refused: ${msg(i.body)}`);
    // (b) recent trade bars / trades (20 min .. 3 h ago).
    const from = iso(now - 3 * 3600e3); const to = iso(now - 20 * 60e3);
    const b = await get(`${D}/v1beta1/options/bars?symbols=${c}&timeframe=1Min&start=${from}&end=${to}`);
    add('(b) recent option trade bars (3 h .. 20 min ago)', b.status, b.status === 200 ? `${Object.values((b.body && b.body.bars) || {}).flat().length} bars` : `refused: ${msg(b.body)}`);
    const t = await get(`${D}/v1beta1/options/trades?symbols=${c}&start=${from}&end=${to}&limit=100`);
    add('(b) recent option trades (3 h .. 20 min ago)', t.status, t.status === 200 ? `${Object.values((t.body && t.body.trades) || {}).flat().length} trades` : `refused: ${msg(t.body)}`);
  } else add('(a)/(b)', 'n/a', 'no contract symbol obtained from the chain');
  return { R, contract: c, spot };
}

if (require.main === module) {
  (async () => {
    if (!AK || !AS) { console.log('no Alpaca data keys in .env'); process.exit(2); }
    const { R, contract } = await run();
    const md = ['', `## Phase 95 option-data re-probe (${iso(Date.now()).slice(0, 16)}Z; Task 0.2)`, '',
      `Read-only, data keys in headers, application User-Agent. Contract used: \`${contract || 'none'}\`.`, '',
      '| Probe | HTTP | Result |', '|---|---|---|', ...R.map((r) => `| ${r.name} | ${r.status} | ${String(r.note).replace(/\|/g, '/')} |`), ''].join('\n');
    console.log(md);
    const out = process.argv.includes('--append') ? process.argv[process.argv.indexOf('--append') + 1] : null;
    if (out) fs.appendFileSync(out, md);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { chainSymbols, filterRespected, quoteAgeMin };
