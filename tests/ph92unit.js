// Phase 92: runtime venue fees (Kraken TradeVolume, OKX account/trade-fee) with provenance + explicit failures, the new
// verified-tier defaults, the waterfall's fee source, and OKX routing against OKX US's real listing (no BTC-USD / ETH-USD
// book). Run: node tests/ph92unit.js. Fake keys, dead URLs, stubbed connectors: no venue is ever called.
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph92-'));
const DEAD = 'http://127.0.0.1:9';
const ENV = { LEDGER_STATE_PATH: path.join(DIR, 'ledger.json'), WATCHLIST_PATH: path.join(DIR, 'w.json'), EXTERNAL_HOLDINGS_PATH: path.join(DIR, 'x.json'),
  CREDENTIALS_PATH: path.join(DIR, 'v.json'), RADAR_CACHE_PATH: path.join(DIR, 'r.json'), CATALYSTS_PATH: path.join(DIR, 'c.json'), PAPER_RUNS_PATH: path.join(DIR, 'runs.json'), MACRO_CALENDAR_URL: DEAD,
  COINBASE_API_KEY: '', COINBASE_API_SECRET: '', COINBASE_API_BASE_URL: DEAD, KRAKEN_API_KEY: 'test-key', KRAKEN_API_SECRET: Buffer.from('test-secret').toString('base64'), KRAKEN_API_BASE_URL: DEAD,
  OKX_API_KEY: 'test-key', OKX_API_SECRET: 'test-secret', OKX_API_PASSPHRASE: 'test-pass', OKX_BASE_URL: DEAD, ALPACA_API_KEY: '', ALPACA_API_SECRET: '', ALPACA_PAPER_API_KEY: 'PKTEST',
  ALPACA_PAPER_API_SECRET: 'test', ALPACA_PAPER_BASE_URL: DEAD, ALPACA_TRADING_BASE_URL: DEAD, ALPACA_DATA_BASE_URL: DEAD, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', ALERT_EMAIL_TO: '',
  OPENAI_API_KEY: '', GEMINI_API_KEY: '', OPENAI_BASE_URL: DEAD, GEMINI_BASE_URL: DEAD };
for (const k of ['KRAKEN_MAKER_FEE', 'KRAKEN_TAKER_FEE', 'OKX_MAKER_FEE', 'OKX_TAKER_FEE']) delete process.env[k];
Object.assign(process.env, ENV);
global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
fs.writeFileSync(ENV.LEDGER_STATE_PATH, JSON.stringify({ version: 3, settings: { bankroll: 10000, cryptoBankroll: 3000 }, pendingOrders: [], activePositions: [], tradeJournal: [] }));
const S = path.join(__dirname, '..', 'server') + '/';
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const near = (a, b) => Math.abs(a - b) < 1e-12;
console.log = ((log) => (...a) => { if (!/^\[(venue-fees|okx)\]/.test(String(a[0]))) log(...a); })(console.log);
console.warn = ((warn) => (...a) => { if (!/^\[(venue-fees|okx|kraken)\]/.test(String(a[0]))) warn(...a); })(console.warn);

(async () => {
  const cost = require(S + 'risk/cost-authority');
  const be = require(S + 'risk/break-even');
  const kraken = require(S + 'connectors/kraken-api');
  const okx = require(S + 'connectors/okx-api');
  const vf = require(S + 'connectors/venue-fees');

  // ---------- 1. Defaults: the verified entry tiers, labelled unverified ----------
  const k0 = cost.feeInfo('kraken'); const o0 = cost.feeInfo('okx');
  check('defaults: Kraken 0.40% / 0.80%, OKX US 0.20% / 0.35% (no .env override)', near(k0.maker, 0.004) && near(k0.taker, 0.008) && near(o0.maker, 0.002) && near(o0.taker, 0.0035), JSON.stringify([k0, o0]));
  check('...labelled unverified, no verification time', !k0.verified && !o0.verified && k0.at === null && /unverified/.test(k0.source) && /unverified/.test(o0.source));
  check('...the cost tables use them (leg rate = taker + spread buffer)', near(cost.legRate('crypto:okx', 'taker'), 0.0035 + cost.COINBASE_SPREAD_BUFFER) && near(be.exactRate('crypto:kraken', 'taker'), 0.008));
  const cb0 = cost.feeInfo('coinbase');
  check('coinbase: the .env / Intro fallback is unverified until its account read', !cb0.verified && cb0.at === null);

  // ---------- 2. OKX: a failed read first (explicit), then a good one ----------
  const calls = [];
  okx.request = async (m, p, o) => { calls.push({ m, p, q: o && o.query }); throw new Error('OKX: Invalid OK-ACCESS-KEY (50111)'); };
  const of1 = await vf.refresh('okx', 1000);
  const s1 = vf.status('okx');
  check('okx failure: status says why, and when', of1.ok === false && /50111/.test(s1.error) && s1.at === 1000, JSON.stringify(s1));
  check('...rates in force unchanged and still unverified', near(s1.inForce.taker, 0.0035) && s1.inForce.verified === false);
  okx.request = async (m, p, o) => { calls.push({ m, p, q: o && o.query }); return [{ level: 'Lv1', maker: '-0.002', taker: '-0.0035', instType: 'SPOT' }]; };
  calls.length = 0;
  const of2 = await vf.refresh('okx', 2000);
  check('okx: reads account/trade-fee for SPOT BTC-USDC and ETH-USDC (OKX US has no -USD book)', calls.length === 2 && calls.every((c) => c.m === 'GET' && c.p === '/api/v5/account/trade-fee' && c.q.instType === 'SPOT')
    && calls.map((c) => c.q.instId).join() === 'BTC-USDC,ETH-USDC', JSON.stringify(calls));
  const o2 = cost.feeInfo('okx');
  check('...sets 0.20% / 0.35% (OKX negative = a charge), verified at the read time with its source', of2.ok && near(o2.maker, 0.002) && near(o2.taker, 0.0035) && o2.verified && o2.at === 2000 && /OKX US account Lv1/.test(o2.source), JSON.stringify(o2));
  okx.request = async () => [{ level: 'Lv5', maker: '0.0001', taker: '-0.0009' }];
  await vf.refresh('okx', 3000);
  check('...a maker REBATE counts as 0 (never a negative cost)', near(cost.feeInfo('okx').maker, 0) && near(cost.feeInfo('okx').taker, 0.0009));
  okx.request = async () => [{ level: 'Lv1', maker: '-0.002', taker: '-0.0035' }];
  await vf.refresh('okx', 4000);

  // ---------- 3. Kraken: highest pair rate, implausible refused, a later failure keeps the verified rates ----------
  let kcall = null;
  kraken.privateCall = async (method, params) => { kcall = { method, params }; return { currency: 'ZUSD', volume: '0', fees: { XXBTZUSD: { fee: '0.8000' }, XETHZUSD: { fee: '0.2600' } }, fees_maker: { XXBTZUSD: { fee: '0.4000' }, XETHZUSD: { fee: '0.1600' } } }; };
  const kr = await vf.refresh('kraken', 5000);
  const k1 = cost.feeInfo('kraken');
  check('kraken: TradeVolume for XBTUSD,ETHUSD; the HIGHER pair rate is used (0.40% / 0.80%), verified', kr.ok && kcall.method === 'TradeVolume' && kcall.params.pair === 'XBTUSD,ETHUSD'
    && near(k1.maker, 0.004) && near(k1.taker, 0.008) && k1.verified && k1.at === 5000, JSON.stringify(k1));
  check('...break-even and the leg rates follow (shared objects updated in place)', near(be.exactRate('crypto:kraken', 'maker'), 0.004) && near(cost.legRate('crypto:kraken', 'maker'), 0.004));
  kraken.privateCall = async () => ({ fees: { XXBTZUSD: { fee: '20' } }, fees_maker: { XXBTZUSD: { fee: '10' } } });
  const kbad = await vf.refresh('kraken', 6000);
  check('kraken: an implausible answer (20%) is refused, the verified rates stay', kbad.ok === false && /implausible/.test(kbad.error) && near(cost.feeInfo('kraken').taker, 0.008) && cost.feeInfo('kraken').at === 5000);
  kraken.privateCall = async () => { throw new Error('Kraken: EAPI:Invalid key'); };
  await vf.refresh('kraken', 7000);
  const ks = vf.status('kraken');
  check('kraken: a later failure is explicit (lookup failed + why) while the last verified rates stay in force', ks.ok === false && /Invalid key/.test(ks.error) && ks.inForce.verified && ks.inForce.at === 5000);

  // ---------- 4. Not configured: no call at all ----------
  const keep = process.env.OKX_API_KEY; process.env.OKX_API_KEY = '';
  let called = false; okx.request = async () => { called = true; return []; };
  const nc = await vf.refresh('okx', 8000);
  check('no keys: no request, status "no API keys configured"', !called && nc.ok === false && /no API keys/.test(nc.error));
  process.env.OKX_API_KEY = keep;
  okx.request = async () => [{ level: 'Lv1', maker: '-0.002', taker: '-0.0035' }];
  await vf.refresh('okx', 9000);

  // ---------- 5. Waterfall rows carry the fee provenance ----------
  const wf = require(S + 'execution/crypto-waterfall');
  const w = await wf.status();
  const row = (id) => w.rows.find((r) => r.id === id);
  check('waterfall: OKX row verified, source + time, lookup ok', row('okx').fee.verified && row('okx').fee.at === 9000 && /OKX US account/.test(row('okx').fee.source) && row('okx').fee.lookupOk && near(row('okx').taker, 0.0035), JSON.stringify(row('okx').fee));
  check('waterfall: Kraken row verified at 5000 but its LATEST lookup failed (shown with the error)', row('kraken').fee.verified && row('kraken').fee.lookupOk === false && /Invalid key/.test(row('kraken').fee.lookupError));
  check('waterfall: Coinbase row unverified and NOT READ YET (never looked up in this test: no "failed" claim)', row('coinbase').fee.verified === false && row('coinbase').fee.lookupOk === null && row('coinbase').fee.lookupError === null);
  check('waterfall: route order still cheapest first at the verified rates (OKX < Kraken < Coinbase taker)', row('okx').taker < row('kraken').taker && row('kraken').taker <= 0.008 && w.rows.map((r) => r.id).join() === 'okx,kraken,coinbase');

  // ---------- 6. OKX routing against OKX US's real listing (public instruments, 2026-10-04) ----------
  const pairs = require(S + 'connectors/okx-pairs');
  const inst = (instId, quoteCcy, list, minSz, tickSz) => ({ instType: 'SPOT', instId, baseCcy: instId.split('-')[0], quoteCcy, state: 'live', minSz, lotSz: '0.00000001', tickSz, tradeQuoteCcyList: list });
  pairs.load([inst('BTC-USDC', 'USDC', ['USDG', 'USD', 'USDC', 'RLUSD'], '0.0001', '0.1'), inst('ETH-USDC', 'USDC', ['USDG', 'USD', 'USDC', 'RLUSD'], '0.001', '0.01'),
    inst('BTC-USDT', 'USDT', ['USDT'], '0.00001', '0.1'), inst('ETH-USDT', 'USDT', ['USDT'], '0.0001', '0.01'), { ...inst('SOL-USD', 'USD', ['USD'], '0.01', '0.01'), state: 'suspend' }]);
  check('listing: no BTC-USD instrument; BTC-USD maps to the BTC-USDC then BTC-USDT books', pairs.get('BTC-USD') === null && pairs.books('BTC-USD').map((e) => e.instId).join() === 'BTC-USDC,BTC-USDT');
  check('listing: a suspended book is not listed', !pairs.lists('SOL-USD'));
  const orders = require(S + 'connectors/okx-orders');
  const pick = (bal) => { const b = orders.bookFor('BTC-USD', 50, bal); return b && `${b.e.instId}/${b.quote}`; };
  check('settlement: USD cash -> BTC-USDC paying USD', pick({ USD: 100 }) === 'BTC-USDC/USD');
  check('settlement: USDC cash -> BTC-USDC paying USDC', pick({ USDC: 100 }) === 'BTC-USDC/USDC');
  check('settlement: only USDT enough -> BTC-USDT paying USDT', pick({ USD: 10, USDT: 100 }) === 'BTC-USDT/USDT');
  const venues = require(S + 'execution/crypto-venues');
  check('spendable: the most in ONE settlement currency; USDG / RLUSD are not counted', venues.VENUES.okx.spendable('BTC-USD', { USD: 30, USDC: 40, USDT: 50 }) === 50
    && venues.VENUES.okx.spendable('BTC-USD', { USDG: 500, RLUSD: 500 }) === 0);
  const sent = [];
  okx.call = async (method, p, o) => { sent.push({ method, p, body: o.body }); return { ok: true, data: [{ ordId: '1', sCode: '0' }] }; };
  const r = await orders.submitOrder({ id: 'T1', asset: 'BTC-USD', direction: 'long', invalidation: 60000, targets: [{ price: 70000 }] }, 0.001, 65000, { balances: { USD: 100 } });
  const body = sent[0] && sent[0].body;
  check('order body: instId BTC-USDC + tradeQuoteCcy USD (the stub broker only; nothing leaves the test)', r.ok && body.instId === 'BTC-USDC' && body.tradeQuoteCcy === 'USD' && r.product === 'BTC-USDC' && r.quoteCcy === 'USD', JSON.stringify(body));
  check('order body: a USDC-paid order sends no tradeQuoteCcy (the book quote itself)', await (async () => { sent.length = 0;
    await orders.submitOrder({ id: 'T2', asset: 'BTC-USD', direction: 'long', invalidation: 60000 }, 0.001, 65000, { balances: { USDC: 100 } });
    return sent[0].body.instId === 'BTC-USDC' && !('tradeQuoteCcy' in sent[0].body); })());

  vf.stop();
  console.log(`\nph92unit: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
