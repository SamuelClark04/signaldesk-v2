// Phase 94 Stage 1, Task 12 (required by tests/ph94capture.js): macro + earnings snapshots and option marks (record-only taps), source
// failures recorded for the pilot health check (C4), the capture start, and the server/tools boundary.
const path = require('path');

module.exports = async ({ S, DEAD, check, readEvents, wipeEvents, ev }) => {
  ev._test.reset(); wipeEvents();
  const om = require(S + 'research/option-marks'); om._test.reset();
  const c = { symbol: 'AMZN261023C00255000', underlying: 'AMZN', type: 'call', strike: 255, expiration: '2026-10-23', dte: 17, bid: 3.1, ask: 3.3, quoteTime: Date.parse('2026-10-06T13:59:58Z'), iv: 0.31, delta: 0.42, gamma: 0.03, theta: -0.09, vega: 0.21, greeksSource: 'alpaca' };
  const T0 = Date.parse('2026-10-06T14:00:00Z');
  check('option marks: once per contract per 60 s', om.observe(c.symbol, c, T0) === true && om.observe(c.symbol, c, T0 + 30000) === false && om.observe(c.symbol, c, T0 + 61000) === true);
  // The tap inside options-data.refreshQuotes: a fake snapshot reply records a mark (no extra request).
  const od = require(S + 'connectors/options-data'); od.reset(); om._test.reset();
  process.env.ALPACA_API_KEY = 'AKTEST'; process.env.ALPACA_API_SECRET = 'sec'; process.env.ALPACA_DATA_BASE_URL = 'http://data.test';
  let quoteCalls = 0;
  const snapBody = { snapshots: { SPY261016P00600000: { latestQuote: { bp: 1.2, ap: 1.3, t: '2026-10-06T13:59:59Z' }, greeks: { delta: -0.4, gamma: 0.02, theta: -0.1, vega: 0.2 }, impliedVolatility: 0.2 } } };
  global.fetch = async () => { quoteCalls += 1; return { ok: true, status: 200, json: async () => snapBody, text: async () => JSON.stringify(snapBody) }; };
  await od.refreshQuotes(['SPY261016P00600000'], T0);
  check('option marks: the refreshQuotes tap records the quote it already fetched (one request, no extra)', quoteCalls === 1);
  const mc = require(S + 'services/macro-calendar');
  await mc.refresh({ now: T0, fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify([{ title: 'CPI m/m', country: 'USD', date: '2026-10-07T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.2%' },
    { title: 'GDP', country: 'EUR', date: '2026-10-07T05:00:00-04:00', impact: 'High', forecast: '', previous: '' }]) }) });
  await mc.refresh({ now: T0, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
  const es = require(S + 'research/earnings-snapshot'); es._test.reset();
  // Finnhub caps an all-US calendar answer (1,500 rows seen 2026-10-06): the snapshot queries EACH capture symbol.
  const earnCalls = [];
  global.fetch = async (u, o) => { const q = new URL(String(u)).searchParams; earnCalls.push(q.get('symbol'));
    if (!/calendar\/earnings/.test(String(u)) || o.headers['X-Finnhub-Token'] !== 'fk') return { ok: false, status: 401, json: async () => ({}) };
    if (q.get('symbol') === 'TSLA' && process.env.PH94_FAIL_TSLA) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ earningsCalendar: q.get('symbol') === 'AMZN' ? [{ symbol: 'AMZN', date: '2026-10-29', hour: 'amc', epsEstimate: 1.6, revenueEstimate: 1.8e11, quarter: 3, year: 2026 }] : [] }) }; };
  process.env.FINNHUB_API_KEY = 'fk'; process.env.FINNHUB_BASE_URL = 'http://finnhub.test';
  const snap = await es.take({ now: T0 });
  const callsPerSnapshot = earnCalls.length;
  process.env.PH94_FAIL_TSLA = '1'; es._test.reset(); earnCalls.length = 0; const partial = await es.take({ now: T0 });
  const retryCalls0 = earnCalls.length; const partial2 = await es.take({ now: T0 + 600000 }); const retry1 = earnCalls.slice(retryCalls0);
  delete process.env.PH94_FAIL_TSLA; const healed = await es.take({ now: T0 + 1200000 }); es._test.reset();
  process.env.FINNHUB_API_KEY = ''; const nokey = await es.take({ now: T0 }); const nokey2 = await es.take({ now: T0 + 600000 });
  global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
  process.env.FINNHUB_BASE_URL = DEAD; process.env.ALPACA_API_KEY = ''; process.env.ALPACA_API_SECRET = ''; process.env.ALPACA_DATA_BASE_URL = DEAD;
  await ev.flush();
  const X = readEvents();
  const marks = X.filter((x) => x.kind === 'OPTION_MARK'); const mark = marks.find((x) => x.contract === c.symbol); const tapMark = marks.find((x) => x.contract === 'SPY261016P00600000');
  const macro = X.find((x) => x.kind === 'MACRO_SNAPSHOT'); const earn = X.filter((x) => x.kind === 'EARNINGS_SNAPSHOT');
  const fails = X.filter((x) => x.kind === 'POLL_STATUS' && x.ok === false);
  check('OPTION_MARK: bid / ask, quote age, IV, Greeks + their source, DTE, feed', mark && mark.bid === 3.1 && mark.quoteAgeMs === 2000 && mark.theta === -0.09 && mark.greeksSource === 'alpaca' && mark.feed);
  check('OPTION_MARK from the refreshQuotes tap: the fetched quote, labelled with the feed', tapMark && tapMark.bid === 1.2 && tapMark.ask === 1.3 && tapMark.feed);
  check('MACRO_SNAPSHOT: every USD row with forecast / previous (not only high impact), t_recv', macro && macro.rows.length === 1 && macro.rows[0].forecast === '0.3%' && Number.isFinite(macro.t_recv));
  check('C4: a failed macro feed refresh is recorded (POLL_STATUS macro-feed ok:false)', fails.some((x) => x.source === 'macro-feed' && /503/.test(x.error)));
  check('EARNINGS_SNAPSHOT: one query per capture symbol (no all-US cap), estimates kept, t_recv, complete', snap.ok && callsPerSnapshot === 24 && earn[0].rows.length === 1
    && earn[0].rows[0].symbol === 'AMZN' && earn[0].rows[0].epsEstimate === 1.6 && earn[0].queried === 24 && earn[0].complete === true, `${callsPerSnapshot} ${JSON.stringify(earn[0] && { q: earn[0].queried, c: earn[0].complete })}`);
  check('EARNINGS_SNAPSHOT: a symbol that failed makes the snapshot INCOMPLETE (named), never silently short', partial.ok === false && earn[1] && earn[1].complete === false
    && earn[1].errors.some((e) => e.symbol === 'TSLA' && /502/.test(e.error)), JSON.stringify(earn[1] && earn[1].errors));
  check('review: a retry queries ONLY the failed symbols, and an unchanged error set is not recorded again', retry1.join() === 'TSLA' && partial2.ok === false && earn.length === 3, `${retry1.join()} ${earn.length}`);
  check('review: once the failed symbol answers, a COMPLETE snapshot (the day\'s good rows + the retried ones) is recorded', healed.ok === true && earn[2] && earn[2].complete === true && earn[2].rows.some((r) => r.symbol === 'AMZN'));
  check('C4: an earnings snapshot without a key is recorded as a failed source, once per day + error (no throw)', nokey.ok === false && nokey2.ok === false
    && fails.filter((x) => x.source === 'finnhub-earnings' && /not set/.test(x.error)).length === 1);
  // The capture start: idempotent; EVENTS_RECORDER=off starts nothing.
  const cap = require(S + 'research/event-capture');
  require(S + 'research/news-capture')._test.reset(); process.env.EVENTS_RECORDER = 'off'; cap.start(); const offStarted = require(S + 'research/news-capture').status().cursor !== null; delete process.env.EVENTS_RECORDER;
  check('event capture: EVENTS_RECORDER=off starts nothing', offStarted === false);
  // server/research/ is reached with ONE "../" from server/connectors etc.; two or more "../" would leave server/ for tools/ or research/.
  const hits = (() => { try { return require('child_process').execFileSync('git', ['grep', '-n', '-E', "require\\(['\"](\\.\\./){2,}(tools|research)/", '--', 'server'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' }); } catch { return ''; } })(); // git grep exits 1 when nothing matches
  check('server/ never requires the repo-root tools/ or research/ folders', hits === '', hits.slice(0, 200));
  const srv = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  check('server.js starts the event capture (one line) and the news subscription is still STREAMED_STOCKS', /research\/event-capture'\)\.start\(\)/.test(srv) && /alpacaNews\.init\(\{ symbols: STREAMED_STOCKS \}\)/.test(srv));
};
