// Phase 94 Stage 1 (spec 4.1): which data our EXISTING free entitlements give, BEFORE any purchase. Read-only GET requests to
// data.alpaca.markets and finnhub.io with this PC's data keys (read from .env: ONLY the Alpaca data keys and FINNHUB_API_KEY; sent in
// headers only, never printed; User-Agent = the application identifier, no personal data).
// Run: node scripts/research/entitlements.js [--out docs/research/phase94-entitlements.md]
const fs = require('fs');
const path = require('path');

const WANT = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER_API_KEY', 'ALPACA_PAPER_API_SECRET', 'FINNHUB_API_KEY'];
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]).filter(([k]) => WANT.includes(k)));
const AK = env.ALPACA_API_KEY || env.ALPACA_PAPER_API_KEY; const AS = env.ALPACA_API_SECRET || env.ALPACA_PAPER_API_SECRET;
const UA = 'SignalDesk-research/1.0';
const A = { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS, 'User-Agent': UA };
const F = { 'X-Finnhub-Token': env.FINNHUB_API_KEY || '', 'User-Agent': UA };
const D = 'https://data.alpaca.markets';
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const get = async (url, headers) => { const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); let body = null; try { body = await res.json(); } catch { body = null; } return { status: res.status, body }; };

async function probe(name, url, headers, judge) {
  try { const r = await get(url, headers); return { name, status: r.status, note: judge(r.status, r.body) }; } catch (err) { return { name, status: 'ERR', note: String(err.message).slice(0, 120) }; }
}

// Does the news `start` parameter filter on created_at or updated_at? (the news poll's cursor depends on it)
async function newsStartField() {
  const all = []; let token = null; let pages = 0;
  do { const q = new URLSearchParams({ symbols: 'SPY,QQQ,AAPL,NVDA,MSFT,AMZN', start: iso(now - 30 * 864e5), limit: '50', sort: 'desc' }); if (token) q.set('page_token', token);
    const r = await get(`${D}/v1beta1/news?${q}`, A); all.push(...((r.body && r.body.news) || [])); token = r.body && r.body.next_page_token; pages += 1; } while (token && pages < 20);
  const revised = all.filter((n) => Date.parse(n.updated_at) - Date.parse(n.created_at) > 3600e3).slice(0, 3);
  if (!revised.length) return { name: 'News `start` filters on', status: 'n/a', note: 'no article revised > 1 h after creation in the last 30 days: not determinable' };
  let upd = 0;
  for (const n of revised) {
    const mid = iso((Date.parse(n.created_at) + Date.parse(n.updated_at)) / 2);
    const r = await get(`${D}/v1beta1/news?${new URLSearchParams({ symbols: (n.symbols || [])[0] || 'SPY', start: mid, end: iso(Date.parse(n.updated_at) + 60e3), limit: '50', sort: 'asc' })}`, A);
    if (((r.body && r.body.news) || []).some((x) => x.id === n.id)) upd += 1;
  }
  return { name: 'News `start` filters on', status: 200, note: upd === revised.length ? `updated_at (${upd} of ${revised.length} revised articles returned for a start between their created_at and updated_at)` : `created_at for ${revised.length - upd} of ${revised.length} probes: CHECK the news cursor design` };
}

(async () => {
  if (!AK || !AS) { console.log('no Alpaca data keys in .env'); process.exit(2); }
  const R = [];
  R.push(await probe('Stock SIP 1-min bars, last 10 min', `${D}/v2/stocks/AAPL/bars?timeframe=1Min&start=${iso(now - 10 * 60000)}&feed=sip`, A, (s) => (s === 403 ? 'recent SIP blocked (free plan): history only after 15 min' : `status ${s}`)));
  R.push(await probe('Stock SIP 1-min bars, 3 h .. 1 h ago', `${D}/v2/stocks/AAPL/bars?timeframe=1Min&start=${iso(now - 3 * 3600000)}&end=${iso(now - 3600000)}&feed=sip`, A, (s, b) => (s === 200 ? `ok (${((b && b.bars) || []).length} bars)` : `status ${s}`)));
  R.push(await probe('Option snapshot, indicative feed', `${D}/v1beta1/options/snapshots/AAPL?feed=indicative&limit=1`, A, (s) => (s === 200 ? 'ok: indicative quotes + Greeks' : `status ${s}`)));
  R.push(await probe('Option snapshot, OPRA feed', `${D}/v1beta1/options/snapshots/AAPL?feed=opra&limit=1`, A, (s, b) => (s === 200 ? 'OPRA available' : s === 403 ? `OPRA NOT available (${(b && b.message) || '403'})` : `status ${s}`)));
  R.push(await probe('Option historical QUOTES', `${D}/v1beta1/options/quotes?symbols=SPY240315C00500000&start=2024-03-01`, A, (s) => (s === 404 ? 'no historical option quotes endpoint' : `status ${s}`)));
  R.push(await probe('Option trade bars, January 2024', `${D}/v1beta1/options/bars?symbols=SPY240315C00500000&timeframe=1Day&start=2024-01-02&end=2024-01-31`, A, (s, b) => `status ${s}, ${Object.values((b && b.bars) || {}).flat().length} bars`));
  R.push(await probe('Option trade bars, Feb-Mar 2024', `${D}/v1beta1/options/bars?symbols=SPY240315C00500000&timeframe=1Day&start=2024-02-01&end=2024-03-15`, A, (s, b) => `status ${s}, ${Object.values((b && b.bars) || {}).flat().length} bars`));
  R.push(await probe('News, earliest available', `${D}/v1beta1/news?symbols=AAPL&start=2015-01-01T00:00:00Z&sort=asc&limit=1`, A, (s, b) => (s === 200 && b && b.news && b.news[0] ? `earliest ${b.news[0].created_at}` : `status ${s}`)));
  R.push(await newsStartField());
  if (env.FINNHUB_API_KEY) {
    const d0 = iso(now).slice(0, 10); const d1 = iso(now + 30 * 864e5).slice(0, 10);
    R.push(await probe('Finnhub earnings calendar (all US, 30 days)', `https://finnhub.io/api/v1/calendar/earnings?from=${d0}&to=${d1}`, F, (s, b) => (s === 200 ? `ok (${((b && b.earningsCalendar) || []).length} rows)` : `status ${s}`)));
    R.push(await probe('Finnhub upgrades / downgrades', 'https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=AAPL', F, (s) => (s === 403 ? 'premium only (not in the free plan)' : `status ${s}`)));
  } else R.push({ name: 'Finnhub', status: 'n/a', note: 'FINNHUB_API_KEY not set on this PC' });
  const md = [`# Phase 94: data entitlements check (${iso(now).slice(0, 10)})`, '', 'Read-only probes with the EXISTING keys (no purchase; spec 4.1). Keys in headers only; User-Agent = the application identifier.', '',
    '| Probe | HTTP | Result |', '|---|---|---|', ...R.map((r) => `| ${r.name} | ${r.status} | ${r.note} |`), '',
    'ThetaData / Massive / Databento: not probed (no account; creating one is the user\'s action). Their published tiers are in the spec, section 4.'].join('\n');
  console.log(md);
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  if (out) fs.writeFileSync(out, `${md}\n`);
})();
