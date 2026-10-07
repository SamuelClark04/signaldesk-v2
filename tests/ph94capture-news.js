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
  check('C3: the next poll CONTINUES the unfinished query (same start, the carried page token) and reads the article it had not reached (14)',
    p2.ok && p2.new === 1 && second.get('page_token') === 'p3' && second.get('start') === new Date(Date.parse('2026-10-06T13:50:00Z') - 5 * 60000).toISOString(), JSON.stringify(p2));
  const p3 = await nc.poll({ now: NOW + 180000 }); const third = new URL(calls[calls.length - 1].u).searchParams;
  check('C3: once the carried query is finished, the next poll starts from the cursor minus the overlap', p3.ok && !third.get('page_token')
    && third.get('start') === new Date(Date.parse('2026-10-06T13:54:00Z') - 5 * 60000).toISOString(), third.get('start'));
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
  check('POLL_STATUS lines: one per poll, ok and error, with the cursor and marketOpen', PS.length === 4 && PS.some((x) => x.ok === false) && PS.every((x) => 'cursor' in x && 'marketOpen' in x));

  // C3 (review): more than 2 pages inside the overlap must not stall the cursor: the unread page token is carried to the next poll.
  await ev.flush(); nc._test.reset(); wipeEvents();
  fs.writeFileSync(path.join(process.env.EVENTS_DIR, 'news-cursor.json'), JSON.stringify({ cursor: Date.parse('2026-10-06T14:00:00Z'), savedAt: Date.parse('2026-10-06T14:00:00Z') }));
  const crowd = [...Array.from({ length: 120 }, (_, i) => art(1000 + i, '2026-10-06T13:58:00Z')), ...Array.from({ length: 10 }, (_, i) => art(2000 + i, `2026-10-06T14:0${i}:30Z`))];
  global.fetch = async (u) => { const q = new URL(String(u)).searchParams; const from = Number(q.get('page_token') || 0);
    const list = crowd.filter((n) => Date.parse(n.updated_at) >= Date.parse(q.get('start'))); const page = list.slice(from, from + 50);
    return { ok: true, status: 200, json: async () => ({ news: page, next_page_token: from + 50 < list.length ? String(from + 50) : null }) }; };
  process.env.ALPACA_API_KEY = 'AKTEST'; process.env.ALPACA_API_SECRET = 'sec'; process.env.ALPACA_DATA_BASE_URL = 'http://data.test';
  let got = 0; for (let k = 0; k < 4; k += 1) { const r = await nc.poll({ now: Date.parse('2026-10-06T14:20:00Z') + k * 120000 }); got += r.new || 0; }
  check('C3 (review): 120 articles in the overlap + 10 newer: every one is read within 4 polls (the page token is carried, no stall)', got === 130 && nc._test.cursor() === Date.parse('2026-10-06T14:09:30Z'), `${got} ${new Date(nc._test.cursor()).toISOString()}`);
  // C3 (review): a future time never pushes the cursor ahead of now.
  nc._test.reset();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ news: [art(3001, '2030-01-01T00:00:00Z')], next_page_token: null }) });
  await nc.poll({ now: Date.parse('2026-10-06T14:30:00Z') });
  check('C3 (review): an article stamped in the future does not move the cursor past now', nc._test.cursor() <= Date.now() + 1000);
  fs.writeFileSync(path.join(process.env.EVENTS_DIR, 'news-cursor.json'), JSON.stringify({ cursor: Date.parse('2030-01-01T00:00:00Z'), savedAt: Date.now() }));
  nc._test.reset(); nc._test.resume(Date.parse('2026-10-06T14:30:00Z'));
  check('C3 (review): a saved cursor in the future is clamped to the start time', nc._test.cursor() === Date.parse('2026-10-06T14:30:00Z'));
  global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };

  // C3 restart gaps + pre-merge fix 3: a gap is PENDING until a catch-up query has read every page; only then a NEWS_RECOVERY COMPLETE.
  await ev.flush(); wipeEvents(); nc._test.reset();
  const cf = path.join(process.env.EVENTS_DIR, 'news-cursor.json');
  const kinds = async (k) => { await ev.flush(); return readEvents().filter((x) => x.kind === k); };
  fs.mkdirSync(process.env.EVENTS_DIR, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 2 * 3600000, savedAt: NOW - 2 * 3600000 }));
  nc._test.resume(NOW);
  let G = await kinds('NEWS_GAP');
  check('fix 3: restart within 24 h -> a NEWS_GAP PENDING (never "covered" before the catch-up ran)', G.length === 1 && G[0].recovery === 'PENDING' && G[0].covered === false
    && G[0].from === NOW - 2 * 3600000 && G[0].to === NOW && G[0].gapId && nc.status().recoveryPending === 1, JSON.stringify(G));
  check('fix 3: the pending gap is persisted with the cursor at once (a second restart keeps it)', (JSON.parse(fs.readFileSync(cf, 'utf8')).pending || []).some((g) => g.gapId === G[0].gapId));
  // 3 pages; MAX_PAGES 2: the first poll leaves unread pages, the second fails, the third finishes the query.
  const gp = { '': { news: [art(31, '2026-10-06T12:10:00Z'), art(32, '2026-10-06T12:20:00Z')], next_page_token: 'g2' }, g2: { news: [art(33, '2026-10-06T12:30:00Z')], next_page_token: 'g3' },
    g3: { news: [art(34, '2026-10-06T12:40:00Z')], next_page_token: null } };
  let failNext = false;
  global.fetch = async (u) => { if (failNext) { failNext = false; return { ok: false, status: 503, json: async () => ({}) }; } const tok = new URL(String(u)).searchParams.get('page_token') || ''; return { ok: true, status: 200, json: async () => gp[tok] }; };
  process.env.ALPACA_API_KEY = 'AKTEST'; process.env.ALPACA_API_SECRET = 'sec'; process.env.ALPACA_DATA_BASE_URL = 'http://data.test';
  await nc.poll({ now: NOW + 60000 });
  check('fix 3: an HTTP-ok poll that leaves unread pages does NOT recover the gap', (await kinds('NEWS_RECOVERY')).length === 0 && nc.status().recoveryPending === 1);
  failNext = true; await nc.poll({ now: NOW + 180000 });
  check('fix 3: a failed poll leaves the recovery pending', (await kinds('NEWS_RECOVERY')).length === 0 && nc.status().recoveryPending === 1);
  await nc.poll({ now: NOW + 300000 });
  let RC = await kinds('NEWS_RECOVERY');
  check('fix 3: the poll that reads the LAST page records NEWS_RECOVERY COMPLETE for the gap (its query started at or before the gap)', RC.length === 1 && RC[0].status === 'COMPLETE'
    && RC[0].gapIds.join() === G[0].gapId && Date.parse(RC[0].since) <= G[0].from && nc.status().recoveryPending === 0
    && (JSON.parse(fs.readFileSync(cf, 'utf8')).pending || []).length === 0, JSON.stringify(RC));
  // A second restart before the catch-up finished: the first gap stays pending and is closed by the same recovery as the new one.
  await ev.flush(); wipeEvents(); nc._test.reset();
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 3600000, savedAt: NOW - 3600000 }));
  nc._test.resume(NOW); const firstGap = (await kinds('NEWS_GAP'))[0];
  nc._test.reset(); nc._test.resume(NOW + 600000);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ news: [], next_page_token: null }) });
  await nc.poll({ now: NOW + 660000 });
  RC = await kinds('NEWS_RECOVERY');
  check('fix 3: a restart before recovery carries the earlier pending gap; one completed catch-up recovers both', RC.length === 1 && RC[0].gapIds.length === 2 && RC[0].gapIds.includes(firstGap.gapId), JSON.stringify(RC));
  // Restart after 30 h with a pending gap saved: the part older than 24 h is lost -> UNRECOVERABLE + that pending gap INCOMPLETE.
  await ev.flush(); wipeEvents(); nc._test.reset();
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 30 * 3600000, savedAt: NOW - 30 * 3600000, pending: [{ gapId: 'old-gap', from: NOW - 31 * 3600000, to: NOW - 29 * 3600000 }, { gapId: 'read-gap', from: NOW - 33 * 3600000, to: NOW - 32 * 3600000 }] }));
  nc._test.resume(NOW);
  G = await kinds('NEWS_GAP'); RC = await kinds('NEWS_RECOVERY');
  check('fix 3: restart after 30 h -> an UNRECOVERABLE gap (saved cursor .. now-24h) + a PENDING catch-up from now-24h', G.length === 2 && G[0].recovery === 'UNRECOVERABLE' && G[0].covered === false
    && G[0].from === NOW - 30 * 3600000 && G[0].to === NOW - 24 * 3600000 && G[1].recovery === 'PENDING' && G[1].from === NOW - 24 * 3600000, JSON.stringify(G));
  check('fix 3: ... an earlier pending gap the saved cursor had not passed is closed INCOMPLETE; one it had passed (read before the restart) COMPLETE (review)',
    RC.length === 2 && RC.find((r) => r.status === 'INCOMPLETE').gapIds.join() === 'old-gap' && RC.find((r) => r.status === 'COMPLETE').gapIds.join() === 'read-gap', JSON.stringify(RC));
  await ev.flush(); wipeEvents(); nc._test.reset(); fs.rmSync(cf, { force: true }); nc._test.resume(NOW);
  G = await kinds('NEWS_GAP');
  check('fix 3: no saved cursor -> an UNRECOVERABLE gap (first start / lost file) + the first-hour catch-up PENDING', G.length === 2 && G[0].recovery === 'UNRECOVERABLE' && G[0].from === null
    && /no saved cursor/.test(G[0].reason) && G[1].recovery === 'PENDING' && G[1].from === NOW - 3600000, JSON.stringify(G));
  // Review: the cursor / pending gaps are saved only after the lines they skip past are on disk. A failing disk, then a crash (the queue
  // lost), then a restart: the gap is still pending in the cursor file, the articles are read again, and only then is it COMPLETE.
  await ev.flush(); wipeEvents(); nc._test.reset(); ev._test.reset();
  fs.writeFileSync(cf, JSON.stringify({ cursor: NOW - 2 * 3600000, savedAt: NOW - 2 * 3600000 }));
  nc._test.resume(NOW); await ev.flush();
  const crashGap = (await kinds('NEWS_GAP'))[0];
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ news: [art(41, '2026-10-06T12:10:00Z'), art(42, '2026-10-06T12:20:00Z')], next_page_token: null }) });
  ev._test.setFs({ mkdir: async () => {}, appendFile: async () => { throw new Error('EIO: test disk failure'); } });
  const cp = await nc.poll({ now: NOW + 60000 });
  let saved2 = JSON.parse(fs.readFileSync(cf, 'utf8'));
  check('review: lines not on disk -> the cursor file keeps the OLD cursor and the gap still pending (no COMPLETE claimed ahead of the lines)',
    cp.ok && saved2.cursor === NOW - 2 * 3600000 && saved2.pending.some((g) => g.gapId === crashGap.gapId) && nc.status().persistDeferred >= 1 && nc.status().unconfirmedLines >= 3, JSON.stringify(saved2));
  ev._test.setFs(null); ev._test.reset(); nc._test.reset(); // the crash: the recorder's queue and the in-memory state are gone
  nc._test.resume(NOW + 600000);
  await nc.poll({ now: NOW + 660000 });
  RC = await kinds('NEWS_RECOVERY'); const reread = readEvents().filter((x) => x.kind === 'NEWS' && [41, 42].includes(x.providerId));
  saved2 = JSON.parse(fs.readFileSync(cf, 'utf8'));
  check('review: after the restart the articles are read again and recorded, then ONE recovery names the gap; the file is saved only now',
    reread.length === 2 && RC.length === 1 && RC[0].gapIds.includes(crashGap.gapId) && saved2.pending.length === 0 && saved2.cursor === Date.parse('2026-10-06T12:20:00Z'), JSON.stringify({ RC, n: reread.length, saved2 }));
  // Persistent unread-page backlog: pages carried for more than 10 minutes -> one NEWS_BACKLOG PERSISTENT line, then CLEARED.
  await ev.flush(); wipeEvents(); nc._test.reset(); nc._test.resume(NOW);
  let tk = 0; global.fetch = async (u) => { const tok = new URL(String(u)).searchParams.get('page_token'); tk += 1;
    return { ok: true, status: 200, json: async () => ({ news: [art(5000 + tk, '2026-10-06T13:00:00Z')], next_page_token: tk < 18 ? `b${tk}` : null }) }; };
  for (let k = 0; k < 8; k += 1) await nc.poll({ now: NOW + k * 120000 });
  const BL = await kinds('NEWS_BACKLOG'); const lastPs = (await kinds('POLL_STATUS')).slice(-1)[0];
  check('fix 3: unread pages carried > 10 min -> ONE NEWS_BACKLOG PERSISTENT line; POLL_STATUS carries the backlog age', BL.length === 1 && BL[0].state === 'PERSISTENT'
    && BL[0].since === NOW && lastPs.backlog && lastPs.backlog.polls === 8 && nc.status().backlog && nc.status().backlog.since === NOW, JSON.stringify(BL) + JSON.stringify(lastPs.backlog));
  await nc.poll({ now: NOW + 8 * 120000 });
  const BL2 = await kinds('NEWS_BACKLOG');
  check('fix 3: when the last page is read the backlog is recorded CLEARED with its length', BL2.length === 2 && BL2[1].state === 'CLEARED' && BL2[1].minutes === 16 && nc.status().backlog === null, JSON.stringify(BL2));
  nc._test.reset(); nc._test.setStartedAt(NOW);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ news: [art(21, '2026-10-06T13:40:00Z')], next_page_token: null }) });
  wipeEvents(); await nc.poll({ now: NOW }); await ev.flush();
  const cu1 = readEvents().find((x) => x.kind === 'NEWS' && x.providerId === 21);
  check('C3: an article from before this process started, read in catch-up, is labelled catchUp: true', cu1 && cu1.catchUp === true);
  global.fetch = async (u) => { throw new Error(`test: no network (${String(u).slice(0, 40)})`); };
  process.env.ALPACA_API_KEY = ''; process.env.ALPACA_API_SECRET = ''; process.env.ALPACA_DATA_BASE_URL = DEAD;
};
