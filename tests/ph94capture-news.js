// Phase 94 Stage 1, Task 11 (required by tests/ph94capture.js): news capture: the stream tap leaves the app's handling unchanged; the REST
// poll for pilot P1; C3 (pagination never skipped, restart gaps explicit, a version cached only once the recorder accepted it).
const fs = require('fs'); const path = require('path');

module.exports = async ({ S, DEAD, check, readEvents, wipeEvents, ev }) => {
  const cu = require(S + 'research/capture-universe');
  check('pilot P1: CORE_WATCHLIST stocks + IWM, DIA, the 11 SPDR sectors and SMH (24 symbols, a rule fixed before data)', cu.PILOT_P1.length === 24
    && ['SPY', 'AMZN', 'XLY', 'SMH', 'DIA'].every((s) => cu.PILOT_P1.includes(s)) && !cu.PILOT_P1.some((s) => s.includes('-')));
  const nc = require(S + 'research/news-capture'); nc._test.reset(); ev._test.reset(); wipeEvents();
  const art = (id, upd, extra = {}) => ({ id, headline: `h${id}`, summary: 's', content: 'c', author: 'a', created_at: upd, updated_at: upd, url: 'https://x', symbols: ['AMZN'], source: 'benzinga', ...extra });
  check('news: a version is recorded once (stream, then the same version by poll)', nc.observe(art(1, '2026-10-06T13:00:00Z'), 'stream', 1) === true && nc.observe(art(1, '2026-10-06T13:00:00Z'), 'poll', 2) === false);
  check('news: a new updated_at = a new version', nc.observe(art(1, '2026-10-06T13:20:00Z'), 'poll', 3) === true);
  process.env.EVENTS_RECORDER = 'off';
  const refused = nc.observe(art(9, '2026-10-06T13:25:00Z'), 'poll', 4);
  delete process.env.EVENTS_RECORDER;
  check('C3: a version the recorder REFUSED is not cached: offered again, it is recorded', refused === false && nc.observe(art(9, '2026-10-06T13:25:00Z'), 'poll', 5) === true && nc.status().refused === 1);

  // The app's own handler input is unchanged by the tap (subscription unchanged): identical items with capture on and off.
  const sock = require(S + 'connectors/alpaca-news-socket');
  const seenByApp = []; sock._test.setHandler((item) => seenByApp.push(JSON.stringify(item)), ['AAPL']);
  const msg = { T: 'n', ...art(7, '2026-10-06T13:30:00Z', { symbols: ['AAPL', 'AMZN'] }) };
  sock._test.handle(msg); process.env.EVENTS_RECORDER = 'off'; sock._test.handle({ ...msg, id: 8 }); delete process.env.EVENTS_RECORDER;
  check('news tap: the app handler sees the same items with capture on and off (subscription unchanged)', seenByApp.length === 2 && seenByApp[0].replace('"id":7', '"id":8') === seenByApp[1]);
  check('news tap: the streamed message is recorded as a STREAM_RECEIPT', nc.status().streamSeen >= 1);

  // C3 pagination: 3 pages available, MAX_PAGES 2 -> stop with unread pages left; the cursor is the newest article READ, not "now".
  nc._test.reset(); wipeEvents();
  const NOW = Date.parse('2026-10-06T14:00:00Z');
  fs.mkdirSync(process.env.EVENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVENTS_DIR, 'news-cursor.json'), JSON.stringify({ cursor: Date.parse('2026-10-06T13:50:00Z'), savedAt: Date.parse('2026-10-06T13:50:00Z') }));
  const calls = [];
  const pages = { '': { news: [art(11, '2026-10-06T13:51:00Z'), art(12, '2026-10-06T13:52:00Z')], next_page_token: 'p2' }, p2: { news: [art(13, '2026-10-06T13:53:00Z')], next_page_token: 'p3' },
    p3: { news: [art(14, '2026-10-06T13:54:00Z')], next_page_token: null } };
  global.fetch = async (u, o) => { calls.push({ u: String(u), h: o && o.headers }); const tok = new URL(String(u)).searchParams.get('page_token') || '';
    const start = new URL(String(u)).searchParams.get('start');
    if (!tok && Date.parse(start) > Date.parse('2026-10-06T13:46:00Z')) return { ok: true, status: 200, json: async () => ({ news: [art(13, '2026-10-06T13:53:00Z'), art(14, '2026-10-06T13:54:00Z')], next_page_token: null }) };
    return { ok: true, status: 200, json: async () => pages[tok] }; };
  process.env.ALPACA_API_KEY = 'AKTEST'; process.env.ALPACA_API_SECRET = 'sec'; process.env.ALPACA_DATA_BASE_URL = 'http://data.test';
  const p1 = await nc.poll({ now: NOW });
  check('C3: a page limit leaves unread pages (unreadPagesLeft) and the cursor at the newest article READ (13:53), not now',
    p1.ok && p1.pages === 2 && p1.unreadPagesLeft === true && nc._test.cursor() === Date.parse('2026-10-06T13:53:00Z'), JSON.stringify(p1));
  const p2 = await nc.poll({ now: NOW + 120000 });
  const second = new URL(calls[calls.length - 1].u).searchParams;
  check('C3: the next poll continues from that cursor (minus the overlap) and reads the article it had not reached (14)',
    p2.ok && p2.new === 1 && second.get('start') === new Date(Date.parse('2026-10-06T13:53:00Z') - 5 * 60000).toISOString(), JSON.stringify(p2));
  check('news poll: oldest first (sort=asc), the pilot symbols in one request, content included; keys in headers, not the URL', /symbols=SPY%2CQQQ/.test(calls[0].u) && /sort=asc/.test(calls[0].u)
    && /include_content=true/.test(calls[0].u) && !/AKTEST|sec\b/.test(calls[0].u) && calls[0].h['APCA-API-KEY-ID'] === 'AKTEST');
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.EVENTS_DIR, 'news-cursor.json'), 'utf8'));
  check('C3: the cursor is persisted after each successful poll', saved.cursor === Date.parse('2026-10-06T13:54:00Z'));
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const bad = await nc.poll({ now: NOW + 240000 });
  check('news poll: HTTP 429 -> { ok: false }, a POLL_STATUS error line, never a throw; the cursor does not move', bad.ok === false && /429/.test(bad.error) && nc._test.cursor() === Date.parse('2026-10-06T13:54:00Z'));
  await ev.flush();
  const NE = readEvents().filter((x) => x.kind === 'NEWS');
  check('news lines: docId, version, t_recv, seenVia (+ pollEveryMs for polls), the provider times kept', NE.length >= 4 && NE.every((x) => x.docId && x.version && Number.isFinite(x.t_recv) && x.created_at)
    && NE.some((x) => x.seenVia === 'poll' && x.pollEveryMs > 0));
  check('news lines carry their limits: versionCoverage OBSERVED_ONLY; receipt POLL_RECEIPT / STREAM_RECEIPT (our receipt, not immediate awareness)',
    NE.every((x) => x.versionCoverage === 'OBSERVED_ONLY' && x.receipt === (x.seenVia === 'poll' ? 'POLL_RECEIPT' : 'STREAM_RECEIPT')));
  const PS = readEvents().filter((x) => x.kind === 'POLL_STATUS');
  check('POLL_STATUS lines: one per poll, ok and error, with the cursor and marketOpen', PS.length === 3 && PS.some((x) => x.ok === false) && PS.every((x) => 'cursor' in x && 'marketOpen' in x));

  // C3 restart gaps.
  wipeEvents(); nc._test.reset();
  const cf = path.join(process.env.EVENTS_DIR, 'news-cursor.json');
  fs.mkdirSync(process.env.EVENTS_DIR, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 2 * 3600000, savedAt: NOW - 2 * 3600000 }));
  nc._test.resume(NOW);
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 30 * 3600000, savedAt: NOW - 30 * 3600000 }));
  nc._test.resume(NOW);
  fs.unlinkSync(cf); nc._test.resume(NOW);
  await ev.flush();
  const G = readEvents().filter((x) => x.kind === 'NEWS_GAP');
  check('C3: restart within 24 h -> one NEWS_GAP covered (catch-up from the saved cursor)', G[0] && G[0].covered === true && G[0].from === NOW - 2 * 3600000 && G[0].to === NOW);
  check('C3: restart after 30 h -> an UNCOVERED gap (saved cursor .. now-24h) + a covered catch-up from now-24h', G[1] && G[1].covered === false && G[1].from === NOW - 30 * 3600000
    && G[1].to === NOW - 24 * 3600000 && G[2] && G[2].covered === true && G[2].from === NOW - 24 * 3600000);
  check('C3: no saved cursor -> an explicit uncovered gap (first start / lost file)', G[3] && G[3].covered === false && /no saved cursor/.test(G[3].reason));
  nc._test.reset(); nc._test.setStartedAt(NOW);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ news: [art(21, '2026-10-06T13:40:00Z')], next_page_token: null }) });
  wipeEvents(); await nc.poll({ now: NOW }); await ev.flush();
  const cu1 = readEvents().find((x) => x.kind === 'NEWS' && x.providerId === 21);
  check('C3: an article from before this process started, read in catch-up, is labelled catchUp: true', cu1 && cu1.catchUp === true);
  global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
  process.env.ALPACA_API_KEY = ''; process.env.ALPACA_API_SECRET = ''; process.env.ALPACA_DATA_BASE_URL = DEAD;
};
