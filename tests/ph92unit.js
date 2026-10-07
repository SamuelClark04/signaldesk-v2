// Phase 92: runtime venue fees (Kraken TradeVolume, OKX account/trade-fee) with provenance + explicit failures, the new
// verified-tier defaults, the waterfall's fee source, and OKX routing against OKX US's real listing (no BTC-USD / ETH-USD
// book), OKX fee GROUPS, Kraken coverage, the use-time 24 h expiry. Run: node tests/ph92unit.js. Fake keys, dead URLs, stubbed connectors: no venue is ever called.
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
console.warn = ((warn) => (...a) => { if (!/^\[(venue-fees|okx|kraken|coinbase-fees)\]/.test(String(a[0]))) warn(...a); })(console.warn);
const H = 3600 * 1000;

(async () => {
  const cost = require(S + 'risk/cost-authority');
  const be = require(S + 'risk/break-even');
  const kraken = require(S + 'connectors/kraken-api');
  const okx = require(S + 'connectors/okx-api');
  const pairs = require(S + 'connectors/okx-pairs');
  const vf = require(S + 'connectors/venue-fees');
  let NOW = 1.8e12; // one fake clock for the reads AND the use-time expiry
  cost.setClock(() => NOW);

  // OKX US instruments as the public list reports them on 2026-10-04 (fee group 12 for the BTC / ETH books), + an alt in group 1.
  const inst = (instId, quoteCcy, list, minSz, tickSz, groupId = '12') => ({ instType: 'SPOT', instId, baseCcy: instId.split('-')[0], quoteCcy, state: 'live', minSz,
    lotSz: '0.00000001', tickSz, tradeQuoteCcyList: list, groupId });
  const LIST = [inst('BTC-USDC', 'USDC', ['USDG', 'USD', 'USDC', 'RLUSD'], '0.0001', '0.1'), inst('ETH-USDC', 'USDC', ['USDG', 'USD', 'USDC', 'RLUSD'], '0.001', '0.01'),
    inst('BTC-USDT', 'USDT', ['USDT'], '0.00001', '0.1'), inst('ETH-USDT', 'USDT', ['USDT'], '0.0001', '0.01'), inst('SOL-USDC', 'USDC', ['USD', 'USDC'], '0.01', '0.01', '1'),
    { ...inst('DOGE-USD', 'USD', ['USD'], '1', '0.00001'), state: 'suspend' }];
  pairs.load(LIST);
  // The account's trade-fee answer: generic top-level fields belong to group 1 only; per-group rates in feeGroup[].
  const fg = (id, maker, taker) => ({ groupId: String(id), maker: String(-maker), taker: String(-taker), elpMaker: String(-maker), rpiMaker: String(-maker) });
  const feeAnswer = (groups, top = { maker: '-0.0014', taker: '-0.0023' }) => [{ instType: 'SPOT', level: 'Lv1', ...top, feeGroup: groups }];
  const REAL = [fg(1, 0.0014, 0.0023), fg(12, 0.002, 0.0035), fg(11, 0, 0), fg(17, 0, 0.0005)];

  // ---------- 1. Defaults: the verified entry tiers, labelled unverified ----------
  const k0 = cost.feeInfo('kraken'); const o0 = cost.feeInfo('okx');
  check('defaults: Kraken 0.40% / 0.80%, OKX US 0.20% / 0.35% (no .env override)', near(k0.maker, 0.004) && near(k0.taker, 0.008) && near(o0.maker, 0.002) && near(o0.taker, 0.0035), JSON.stringify([k0, o0]));
  check('...labelled unverified, no verification time', !k0.verified && !o0.verified && k0.at === null && /unverified/.test(k0.source) && /unverified/.test(o0.source));
  check('...the cost tables use them (leg rate = taker + spread buffer)', near(cost.legRate('crypto:okx', 'taker'), 0.0035 + cost.COINBASE_SPREAD_BUFFER) && near(be.exactRate('crypto:kraken', 'taker'), 0.008));
  check('coinbase: the .env / Intro fallback is unverified until its account read', !cost.feeInfo('coinbase').verified && cost.feeInfo('coinbase').at === null);

  // ---------- 2. OKX: fee GROUPS, not the generic fields ----------
  const calls = [];
  okx.request = async (m, p, o) => { calls.push({ m, p, q: o && o.query }); throw new Error('OKX: Invalid OK-ACCESS-KEY (50111)'); };
  const of1 = await vf.refresh('okx', NOW);
  check('okx failure: status says why and when; rates unchanged, unverified', of1.ok === false && /50111/.test(vf.status('okx').error) && vf.status('okx').at === NOW
    && near(cost.feeInfo('okx').taker, 0.0035) && !cost.feeInfo('okx').verified);
  calls.length = 0;
  okx.request = async (m, p, o) => { calls.push({ m, p, q: o && o.query }); return feeAnswer(REAL); };
  const of2 = await vf.refresh('okx', NOW);
  const o2 = cost.feeInfo('okx');
  check('okx: ONE trade-fee read for instType SPOT (all groups), not per instId', calls.length === 1 && calls[0].p === '/api/v5/account/trade-fee' && calls[0].q.instType === 'SPOT' && !calls[0].q.instId, JSON.stringify(calls));
  check('okx: the generic top-level 0.14% / 0.23% (group 1 only) is NOT the BTC / ETH rate: group 12 0.20% / 0.35% is used', of2.ok && near(o2.maker, 0.002) && near(o2.taker, 0.0035) && o2.verified, JSON.stringify(o2));
  check('okx: coverage = every routable book (USDC + USDT) and the groups covered (1, 12), per-book BTC / ETH detail', /all 5 routable/.test(o2.coverage) && /fee groups 1, 12/.test(o2.coverage)
    && /BTC-USDC g12 0\.20\/0\.35%/.test(o2.coverage) && /BTC-USDT g12/.test(o2.coverage) && !/group 17|17,/.test(o2.coverage), o2.coverage);
  // Differing group rates: BTC / ETH USDC books in group 12, the USDT books in a DEARER group 5; an alt in a cheaper group 1.
  pairs.load(LIST.map((x) => (/USDT$/.test(x.instId) ? { ...x, groupId: '5' } : x)));
  okx.request = async () => feeAnswer([fg(1, 0.0014, 0.0023), fg(12, 0.002, 0.0035), fg(5, 0.0025, 0.004)]);
  await vf.refresh('okx', NOW);
  const o3 = cost.feeInfo('okx'); const d3 = vf.status('okx').detail || [];
  check('okx: differing USDC / USDT group rates -> the venue rate is the HIGHEST routable group (0.25% / 0.40%, the USDT books)', near(o3.maker, 0.0025) && near(o3.taker, 0.004), JSON.stringify(o3));
  check('...per-book detail keeps each book on its own group (BTC-USDC g12 0.35%, BTC-USDT g5 0.40%)', d3.find((x) => x.book === 'BTC-USDC').group === '12' && near(d3.find((x) => x.book === 'BTC-USDC').taker, 0.0035)
    && d3.find((x) => x.book === 'BTC-USDT').group === '5' && near(d3.find((x) => x.book === 'BTC-USDT').taker, 0.004), JSON.stringify(d3));
  // A routable book whose group is missing from the answer: the read fails and claims nothing.
  okx.request = async () => feeAnswer([fg(1, 0.0014, 0.0023), fg(12, 0.002, 0.0035)]); // group 5 (USDT books) absent
  const of4 = await vf.refresh('okx', NOW + 1);
  check('okx: a routable group missing from the answer -> failed read (named), rates and verification time unchanged', of4.ok === false && /fee group\(s\) 5 missing/.test(of4.error)
    && near(cost.feeInfo('okx').taker, 0.004) && cost.feeInfo('okx').at === NOW, of4.error);
  pairs.load(LIST.map((x) => (x.instId === 'ETH-USDT' ? { ...x, groupId: '' } : x)));
  const of5 = await vf.refresh('okx', NOW + 2);
  check('okx: a routable book with no fee group -> failed read, nothing claimed', of5.ok === false && /without a fee group \(ETH-USDT\)/.test(of5.error), of5.error);
  pairs.load(LIST);
  okx.request = async () => feeAnswer([fg(1, 0.0014, 0.0023), { groupId: '12', maker: '0.0001', taker: '-0.0035' }]);
  await vf.refresh('okx', NOW);
  check('okx: a maker REBATE counts as 0 (never a negative cost)', near(cost.feeInfo('okx').maker, 0.0014) && near(vf.status('okx').detail[0].maker, 0));
  okx.request = async () => feeAnswer(REAL);
  await vf.refresh('okx', NOW);

  // ---------- 3. Kraken: complete coverage of the requested BTC / ETH pairs, or nothing ----------
  const KR = { XXBTZUSD: '0.8000', XETHZUSD: '0.8000', XBTUSDC: '0.8000', ETHUSDC: '0.8000' };
  const krAnswer = (t, m) => ({ currency: 'ZUSD', volume: '0', fees: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { fee: v }])), fees_maker: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { fee: v }])) });
  let kcall = null;
  kraken.privateCall = async (method, params) => { kcall = { method, params }; return krAnswer(KR, { XXBTZUSD: '0.4000', XETHZUSD: '0.4000', XBTUSDC: '0.4000', ETHUSDC: '0.4000' }); };
  const kr = await vf.refresh('kraken', NOW);
  const k1 = cost.feeInfo('kraken');
  check('kraken: TradeVolume for the BTC / ETH USD + USDC books; 0.40% / 0.80% verified with that coverage only', kr.ok && kcall.method === 'TradeVolume' && kcall.params.pair === 'XBTUSD,ETHUSD,XBTUSDC,ETHUSDC'
    && near(k1.maker, 0.004) && near(k1.taker, 0.008) && k1.verified && /verified for XXBTZUSD, XETHZUSD, XBTUSDC, ETHUSDC; other Kraken pairs assumed the same \(unverified\)/.test(k1.coverage), JSON.stringify(k1));
  check('...break-even and the leg rates follow', near(be.exactRate('crypto:kraken', 'maker'), 0.004) && near(cost.legRate('crypto:kraken', 'maker'), 0.004));
  // A missing pair with a CHEAPER rate on the rest must not replace the rates in force.
  kraken.privateCall = async () => krAnswer({ XXBTZUSD: '0.2600', XBTUSDC: '0.2600', ETHUSDC: '0.2600' }, { XXBTZUSD: '0.1600', XBTUSDC: '0.1600', ETHUSDC: '0.1600' });
  const kmiss = await vf.refresh('kraken', NOW + 5);
  check('kraken: a MISSING pair (ETHUSD) -> failed read naming it; the cheaper 0.26% never replaces 0.80%', kmiss.ok === false && /no valid maker \/ taker fee for ETHUSD/.test(kmiss.error)
    && near(cost.feeInfo('kraken').taker, 0.008) && cost.feeInfo('kraken').at === NOW, kmiss.error);
  kraken.privateCall = async () => krAnswer(KR, { XXBTZUSD: '0.4000', XETHZUSD: '', XBTUSDC: '0.4000', ETHUSDC: '0.4000' });
  const kinv = await vf.refresh('kraken', NOW + 6);
  check('kraken: an invalid (blank) maker fee -> failed read, nothing replaced', kinv.ok === false && /ETHUSD/.test(kinv.error) && cost.feeInfo('kraken').at === NOW);
  kraken.privateCall = async () => krAnswer({ XXBTZUSD: '20', XETHZUSD: '20', XBTUSDC: '20', ETHUSDC: '20' }, { XXBTZUSD: '10', XETHZUSD: '10', XBTUSDC: '10', ETHUSDC: '10' });
  const kbad = await vf.refresh('kraken', NOW + 7);
  check('kraken: an implausible answer (20%) is refused, the verified rates stay', kbad.ok === false && /implausible/.test(kbad.error) && near(cost.feeInfo('kraken').taker, 0.008));
  kraken.privateCall = async () => { throw new Error('Kraken: EAPI:Invalid key'); };
  await vf.refresh('kraken', NOW + 8);
  const ks = vf.status('kraken');
  check('kraken: a later failure is explicit while the last verified rates stay in force (< 24 h)', ks.ok === false && /Invalid key/.test(ks.error) && ks.inForce.verified && ks.inForce.at === NOW);

  // ---------- 4. Not configured: no call at all ----------
  const keep = process.env.OKX_API_KEY; process.env.OKX_API_KEY = '';
  let called = false; okx.request = async () => { called = true; return []; };
  const nc = await vf.refresh('okx', NOW);
  check('no keys: no request, status "no API keys configured"', !called && nc.ok === false && /no API keys/.test(nc.error));
  process.env.OKX_API_KEY = keep;
  okx.request = async () => feeAnswer(REAL);
  await vf.refresh('okx', NOW);

  // ---------- 5. Waterfall rows carry the fee provenance ----------
  const wf = require(S + 'execution/crypto-waterfall');
  const w = await wf.status();
  const row = (id) => w.rows.find((r) => r.id === id);
  check('waterfall: OKX row verified, source names its coverage, lookup ok', row('okx').fee.verified && row('okx').fee.at === NOW && /routable/.test(row('okx').fee.source) && row('okx').fee.lookupOk && near(row('okx').taker, 0.0035), JSON.stringify(row('okx').fee));
  check('waterfall: Kraken row verified but its LATEST lookup failed (shown with the error)', row('kraken').fee.verified && row('kraken').fee.lookupOk === false && /Invalid key/.test(row('kraken').fee.lookupError));
  check('waterfall: Coinbase row unverified and NOT READ YET (no "failed" claim)', row('coinbase').fee.verified === false && row('coinbase').fee.lookupOk === null && row('coinbase').fee.lookupError === null);
  check('waterfall: route order still cheapest first (OKX < Kraken < Coinbase taker)', row('okx').taker < row('kraken').taker && w.rows.map((r) => r.id).join() === 'okx,kraken,coinbase');

  // ---------- 6. OKX routing against OKX US's real listing ----------
  pairs.load(LIST);
  check('listing: no BTC-USD instrument; BTC-USD maps to the BTC-USDC then BTC-USDT books', pairs.get('BTC-USD') === null && pairs.books('BTC-USD').map((e) => e.instId).join() === 'BTC-USDC,BTC-USDT');
  check('listing: a coin whose only book is suspended is not listed (SOL-USD lists via SOL-USDC); the fee group is kept per book', !pairs.lists('DOGE-USD') && pairs.lists('SOL-USD') && pairs.get('BTC-USDC').groupId === '12' && pairs.get('SOL-USDC').groupId === '1');
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
  check('order body: instId BTC-USDC + tradeQuoteCcy USD (the stub broker only)', r.ok && body.instId === 'BTC-USDC' && body.tradeQuoteCcy === 'USD' && r.product === 'BTC-USDC' && r.quoteCcy === 'USD', JSON.stringify(body));
  check('order body: a USDC-paid order sends no tradeQuoteCcy', await (async () => { sent.length = 0;
    await orders.submitOrder({ id: 'T2', asset: 'BTC-USD', direction: 'long', invalidation: 60000 }, 0.001, 65000, { balances: { USDC: 100 } });
    return sent[0].body.instId === 'BTC-USDC' && !('tradeQuoteCcy' in sent[0].body); })());

  // ---------- 7. Fee-failure policy: expiry is enforced AT USE TIME, without another lookup ----------
  okx.request = async () => feeAnswer([fg(1, 0.001, 0.002), fg(12, 0.001, 0.002)]); // a cheaper tier than the fallback
  const T0 = NOW; await vf.refresh('okx', T0);
  check('policy: a verified LOWER tier (0.10% / 0.20%) is used while fresh', near(cost.feeInfo('okx').taker, 0.002) && cost.feeInfo('okx').verified);
  let lookups = 0; okx.request = async () => { lookups += 1; throw new Error('should not be called'); };
  NOW = T0 + 23 * H;
  check('policy: at 23 h, no lookup, the verified rate is still in force', near(cost.legRate('crypto:okx', 'taker'), 0.002 + cost.COINBASE_SPREAD_BUFFER) && cost.feeInfo('okx').verified);
  NOW = T0 + 24 * H + 1;
  const cand = { market: 'crypto', venue: 'okx', positionSize: 1, entryPrice: 100, entryLiquidity: 'taker' };
  const gate = cost.evaluateCosts(cand, 10); // the new-entry cost gate is the FIRST fee read past 24 h
  check('policy: past 24 h WITHOUT any lookup, the new-entry cost gate uses the higher fallback (0.35% taker), not the stale 0.20%',
    lookups === 0 && near(gate.estimatedFees, 100 * cost.blendedRoundTripRate('crypto:okx', 'taker')) && near(cost.legRate('crypto:okx', 'taker'), 0.0035 + cost.COINBASE_SPREAD_BUFFER), JSON.stringify(gate));
  const st = cost.feeInfo('okx');
  check('...labelled stale + unverified with the last verification time', !st.verified && /^stale: last verified/.test(st.source) && near(st.maker, 0.002) && near(st.taker, 0.0035), st.source);
  check('...stop floors and break-even read the raised rate too (minStopPct, break-even exactRate)', near(be.exactRate('crypto:okx', 'taker'), 0.0035)
    && cost.minStopPct('crypto:okx', 'taker') >= Math.ceil(((0.0035 + cost.COINBASE_SPREAD_BUFFER) + (0.002 + 0.0035 + cost.COINBASE_SPREAD_BUFFER) / 2) / 0.29 * 1000 - 1e-9) / 1000);
  okx.request = async () => feeAnswer([fg(1, 0.001, 0.002), fg(12, 0.001, 0.002)]);
  await vf.refresh('okx', NOW);
  check('policy: a later good read restores the verified rates', near(cost.feeInfo('okx').taker, 0.002) && cost.feeInfo('okx').verified);
  // Kraken expires the same way at use time (its last verified read was at T0 - set in section 3 - and failed since).
  NOW = T0 + 30 * H;
  check('policy (kraken): verified at T0, failing since: past 24 h its leg rate is the fallback, labelled stale', near(cost.legRate('crypto:kraken', 'taker'), 0.008 + cost.COINBASE_SPREAD_BUFFER)
    && /^stale/.test(cost.feeInfo('kraken').source) && !cost.feeInfo('kraken').verified);
  // Coinbase: the same rule; its fallback (.env / Intro 0.60% / 1.20% here) is higher than a 0.50% / 0.90% tier.
  cost.setCoinbaseFees({ maker: 0.005, taker: 0.009, source: 'Coinbase account tier Intro', at: NOW });
  NOW += 24 * H + 1;
  const cs = cost.feeInfo('coinbase');
  check('policy (coinbase): past 24 h with no read at all -> the higher fallback, labelled stale', !cs.verified && near(cs.taker, 0.012) && /^stale/.test(cs.source)
    && near(cost.legRate('crypto', 'taker'), 0.012 + cost.COINBASE_SPREAD_BUFFER), JSON.stringify(cs));
  // Exits never gate on fee verification: no exit / close / reconcile module reads the verification state.
  const exitMods = ['execution/exit-pass.js', 'execution/exit-monitor.js', 'execution/ratchet.js', 'execution/coinbase-exit.js', 'execution/bracket-ops.js',
    'execution/reconciler.js', 'execution/external-close.js', 'execution/spread-exit.js', 'execution/time-exits.js'].filter((f) => fs.existsSync(S + f));
  const reads = exitMods.filter((f) => /feeInfo|expireStaleFees|\.verified\b|venue-fees|coinbase-fees/.test(fs.readFileSync(S + f, 'utf8')));
  check(`policy: exits continue: none of ${exitMods.length} exit modules reads fee verification`, exitMods.length >= 6 && reads.length === 0, reads.join(', '));

  vf.stop(); cost.setClock(null);
  console.log(`\nph92unit: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
