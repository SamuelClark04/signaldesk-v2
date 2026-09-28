// Live News, Social & Catalyst Feed (Phase 62): the headlines, Reddit threads and
// trending catalysts behind every move, for the card under the Live Chart
// (Opportunities → Moonshots and Setups). Sources, all read-only and cached so no
// rate limit is ever hit:
//   Alpaca News   /v1beta1/news?symbols=...&limit=25 (Benzinga; stocks as AAPL,
//                 crypto as BTCUSD), the last WINDOW_H hours only (a small coin's
//                 "latest" articles can be years old), per symbol set, cached CACHE_MS (2.5 min)
//   Crypto RSS    CoinDesk, Cointelegraph, Decrypt public RSS, each cached RSS_MS
//                 (3 min); an article counts for a coin when its title / summary
//                 names it (crypto-social.js's matcher: $TICKER, TICKER, or name), last WINDOW_H hours only
//                 (CryptoCompare's news endpoint now requires an API key: not used)
//   Reddit        the posts System 6's social scanner already matched per coin
//                 (crypto-social.js: 5 subreddits' RSS; no extra Reddit requests)
//   Trending      CoinGecko's trending list (crypto-social.js cache)
// Phase 66: every source covers the last WINDOW_H (48) hours only, and a symbol is tagged only
// when it is the article's SUBJECT: named in the headline or its first sentence, or (Alpaca)
// one of at most PRIMARY_TAGS tagged symbols. The symbol's news sentiment (score, counts,
// headlines) is computed from exactly the news items this feed shows (sentimentOf), stored
// as the symbol's NEWS_SENTIMENT and sent with the reply, so the gauge, the News & Catalysts
// tab and the feed always count the same headlines.
// Every item: { id, kind: news|reddit|trending, source, outlet, title, url, at, symbols }.
// Links are https/http only. Sources fail soft: the last good data is kept, the gap
// reported in `errors`. GET_CATALYST_FEED { symbol } -> the coin's items + its
// catalystSummary (and top movers as `fallback` when it has none);
// GET_CATALYST_FEED { scope: 'movers' } -> the All Movers feed: news on the leaderboard
// top 20, CoinGecko trending coins, open positions and staged setups, every Reddit post
// the gem scan matched to a Coinbase coin, and the trending list. Reply: CATALYST_FEED.
// Phase 73 (never "Loading headlines..."): stale-while-revalidate. The FIRST reply is built from the
// cache alone (< 50 ms: the breakdown is local, headlines are whatever is cached, stale or not) and
// kicks the refresh of every stale source; when those land, a SECOND reply carries the fresh items.
const social = require('../connectors/crypto-social');
const guard = require('../connectors/net-guard'); // Phase 73: an unreachable news host fails fast
const radar = require('../intelligence/moonshot-radar');
const summary = require('../intelligence/catalyst-summary');
const sentiment = require('../connectors/news-sentiment');

const CACHE_MS = 150 * 1000;
const RSS_MS = 180 * 1000;
const TIMEOUT_MS = 8000;
const MAX_ITEMS = 80;
const WINDOW_H = 48;
const PRIMARY_TAGS = 3;
const { scoreHeadline } = require('../intelligence/sentiment-nlp');
const UA = 'signaldesk/1.0 (personal trading terminal; public RSS)';
const RSS = [
  { outlet: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { outlet: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { outlet: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const cache = new Map(); // key -> { at, value, error, pending }
const safeUrl = (u) => { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&#8217;/g, '’').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1] : ''; };
const validSymbol = (s) => /^[A-Z0-9.]{1,12}(-USD)?$/.test(s);

// Cached fetch, stale-while-revalidate (Phase 73): a fresh value as is; a STALE one at once while it is
// refetched in the background; nothing cached yet: quick -> [] now (refetch kicked), else wait for it.
// A failure keeps the last good value. `waiting`: the refreshes in flight (handle() re-replies after them).
const waiting = new Set();
function cached(key, ttl, fn, now = Date.now(), quick = false) {
  const hit = cache.get(key);
  if (hit && hit.at && (now - hit.at < ttl)) return Promise.resolve(hit);
  let pending = hit && hit.pending;
  if (!pending) {
    pending = fn().then((value) => ({ at: Date.now(), value, error: null }))
      .catch((err) => ({ at: Date.now(), value: hit ? hit.value : [], error: err.name === 'TimeoutError' ? 'timed out' : err.message }))
      .then((r) => { cache.set(key, r); return r; })
      .finally(() => waiting.delete(pending));
    waiting.add(pending);
    cache.set(key, { ...(hit || { at: 0, value: [] }), pending });
  }
  if (hit && hit.at) return Promise.resolve(hit); // stale: served now, refreshed behind it
  return quick ? Promise.resolve({ at: 0, value: [], error: null, cold: true }) : pending;
}

// ---------- Alpaca News ----------
const tagOf = (symbol) => symbol.replace('-', ''); // BTC-USD -> BTCUSD
// Is `symbol` the subject of `text` (its headline + first sentence)? $TICKER, TICKER or its name.
const subjectOf = (symbol, text) => social.matcher(symbol.split('-')[0].toUpperCase(), social.nameFor(symbol))(text);
function normAlpaca(n, wanted) {
  const byTag = new Map(wanted.map((s) => [tagOf(s), s]));
  const tags = n.symbols || [];
  const title = decode(n.headline).slice(0, 300);
  const lead = `${title} ${social.firstSentence(decode(n.summary))}`;
  return { id: `alpaca:${n.id}`, kind: 'news', source: 'ALPACA NEWS', outlet: n.source || n.author || 'Benzinga', title,
    url: safeUrl(n.url), at: Date.parse(n.created_at || n.updated_at) || null,
    symbols: tags.map((t) => byTag.get(t)).filter((s) => s && (tags.length <= PRIMARY_TAGS || subjectOf(s, lead))) };
}
async function alpacaNews(symbols, limit = 25, quick = false) {
  const list = [...new Set(symbols)].filter(validSymbol).sort();
  if (!list.length) return { at: Date.now(), value: [], error: null };
  const k = require('../connectors/alpaca-api').dataKeys(); // Phase 73: live keys, else the Alpaca Paper keys
  if (!k) return { at: Date.now(), value: [], error: 'Alpaca news: no Alpaca keys (Settings > Accounts & Connections)' };
  const { key, secret } = k;
  return cached(`alpaca|${list.join(',')}|${limit}`, CACHE_MS, async () => {
    const base = (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
    const start = new Date(Date.now() - WINDOW_H * 3600000).toISOString();
    const res = await guard.guardedFetch(`${base}/v1beta1/news?symbols=${encodeURIComponent(list.map(tagOf).join(','))}&limit=${limit}&sort=desc&start=${encodeURIComponent(start)}`,
      { headers: { Accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Alpaca news HTTP ${res.status}`);
    const json = await res.json();
    return (json.news || []).map((n) => normAlpaca(n, list)).filter((x) => x.title && x.symbols.length);
  }, Date.now(), quick);
}

// ---------- Crypto RSS ----------
function parseRss(xml, outlet) {
  return (String(xml).match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
    const url = safeUrl(decode(tag(it, 'link')) || decode(tag(it, 'guid')));
    return { outlet, title: decode(tag(it, 'title')).slice(0, 300), text: decode(decode(tag(it, 'description'))).slice(0, 500), url, at: Date.parse(decode(tag(it, 'pubDate'))) || null };
  }).filter((x) => x.title && x.url);
}
async function rssItems(quick = false) {
  const results = await Promise.all(RSS.map((f) => cached(`rss|${f.outlet}`, RSS_MS, async () => {
    const res = await guard.guardedFetch(f.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseRss(await res.text(), f.outlet);
  }, Date.now(), quick).then((r) => ({ ...r, outlet: f.outlet }))));
  return { items: results.flatMap((r) => r.value), errors: results.filter((r) => r.error).map((r) => `${r.outlet}: ${r.error}`) };
}
// RSS articles -> feed items tagged with the crypto symbols they name (untagged: dropped).
// Only articles from the last WINDOW_H hours, like Alpaca's (a feed's old podcast entries never
// show as news; an undated article is dropped: its age cannot be told).
function matchRss(items, symbols, now = Date.now()) {
  const matchers = symbols.filter((s) => s.includes('-')).map((s) => [s, social.matcher(s.split('-')[0].toUpperCase(), social.nameFor(s))]);
  return items.filter((a) => a.at && now - a.at <= WINDOW_H * 3600000).map((a) => {
    const text = `${a.title} ${social.firstSentence(a.text)}`; // the subject only (Phase 66), never a passing mention
    return { id: `rss:${a.url}`, kind: 'news', source: `NEWS · ${a.outlet}`, outlet: a.outlet, title: a.title, url: a.url, at: a.at, symbols: matchers.filter(([, hit]) => hit(text)).map(([s]) => s) };
  }).filter((x) => x.symbols.length);
}

// ---------- Reddit + trending (from the social scanner's cache) ----------
const redditItem = (p) => ({ id: `reddit:${p.url || `${p.subreddit}:${p.title}`}`, kind: 'reddit', source: `REDDIT · r/${p.subreddit}`, outlet: `r/${p.subreddit}`,
  title: p.title, url: safeUrl(p.url), at: p.createdAt, symbols: p.symbols || [p.symbol], score: p.score, author: p.author });
function trendingItems(only) {
  const t = social.trendingList();
  return t.coins.filter((c) => c.product && (!only || only.includes(c.product))).map((c) => ({
    id: `trending:${c.symbol}`, kind: 'trending', source: `TRENDING · CoinGecko #${c.rank}`, outlet: 'CoinGecko', title: `${c.name} (${c.symbol}) is #${c.rank} on CoinGecko's trending searches`,
    url: c.id ? safeUrl(`https://www.coingecko.com/en/coins/${encodeURIComponent(c.id)}`) : null, at: t.at, symbols: [c.product] }));
}

// Newest first, one copy per link / id.
function merge(lists) {
  const seen = new Set();
  return lists.flat().filter((x) => { const k = x.url || x.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_ITEMS);
}
const counts = (items) => ({ news: items.filter((x) => x.kind === 'news').length, reddit: items.filter((x) => x.kind === 'reddit').length, trending: items.filter((x) => x.kind === 'trending').length });

// The All Movers symbols: leaderboard top 20, trending Coinbase coins, positions + staged setups.
function moverSymbols(ctx) {
  const r = radar.getRadar();
  return [...new Set([...r.rows.slice(0, r.top || 20).map((x) => x.symbol), ...social.trendingList().coins.map((c) => c.product).filter(Boolean),
    ...ctx.positions.map((p) => p.asset), ...ctx.pending.map((o) => o.asset)])].filter(validSymbol);
}

async function movers(ctx = summary.context(), quick = false) {
  const symbols = moverSymbols(ctx);
  const [alp, rss] = await Promise.all([alpacaNews(symbols, 50, quick), symbols.some((x) => x.includes('-')) ? rssItems(quick) : { items: [], errors: [] }]);
  const reddit = social.recentPosts(120).map(redditItem); // every post the gem scan matched to a Coinbase coin
  const items = merge([alp.value, matchRss(rss.items, symbols), reddit, trendingItems(null)]);
  return { ok: true, scope: 'movers', symbols, items, counts: counts(items), errors: [...(alp.error ? [alp.error] : []), ...rss.errors], at: Date.now() };
}

// The symbol's news items (the feed's own, 48 h, subject-filtered): { items, errors }.
async function newsFor(symbol, quick = false) {
  const crypto = symbol.includes('-');
  const [alp, rss] = await Promise.all([alpacaNews([symbol], 25, quick), crypto ? rssItems(quick) : { items: [], errors: [] }]);
  return { items: merge([alp.value, crypto ? matchRss(rss.items, [symbol]) : []]), errors: [...(alp.error ? [alp.error] : []), ...rss.errors] };
}

// NEWS_SENTIMENT from news items (news-sentiment.js's scoring): 50 + 50 x (bullish - bearish) / (bullish + bearish + 2).
function sentimentOf(symbol, items, errors = []) {
  const news = items.filter((x) => x.kind === 'news');
  if (!news.length && errors.length) return { ok: false, error: errors.join('; '), symbol, at: Date.now() };
  let bullish = 0; let bearish = 0;
  const headlines = news.map((x) => { const s = scoreHeadline(x.title).score; if (s > 0) bullish += 1; else if (s < 0) bearish += 1;
    return { title: x.title, url: x.url, at: x.at ? new Date(x.at).toISOString() : null, source: x.outlet, tone: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral' }; });
  const total = news.length;
  const score = total ? Math.round(50 + (50 * (bullish - bearish)) / (bullish + bearish + 2)) : null;
  return { ok: true, symbol, score, label: sentiment.label(score), bullish, bearish, neutral: total - bullish - bearish, total, headlines: headlines.slice(0, 5), at: Date.now(),
    source: `${total} headline${total === 1 ? '' : 's'} in ${WINDOW_H}h (the Catalyst Feed's news: Alpaca${symbol.includes('-') ? ' + CoinDesk / Cointelegraph / Decrypt' : ''}, SignalDesk scoring)` };
}

async function forSymbol(symbol, ctx = summary.context(), quick = false) {
  const crypto = symbol.includes('-');
  const [news, rssErr] = await newsFor(symbol, quick).then((n) => [n, n.errors]);
  const reddit = crypto ? social.postsFor(symbol, 40).map(redditItem) : [];
  const items = merge([news.items, reddit, crypto ? trendingItems([symbol]) : []]);
  const row = radar.rowOf(symbol);
  // One count everywhere (Phase 66): the feed's own news is the symbol's sentiment (a Finnhub score is kept).
  // quick: never wait on Finnhub, and never overwrite a stored score with a cold (empty) read.
  const snt = sentiment.usesFinnhub(symbol) ? (quick ? sentiment.peek(symbol) : await sentiment.getSentiment(symbol).catch(() => null))
    : quick && !news.items.length ? sentiment.peek(symbol) : sentiment.store(sentimentOf(symbol, news.items, news.errors));
  const catalystSummary = row && row.catalystSummary ? row.catalystSummary : summary.forSymbol(symbol, ctx);
  const out = { ok: true, scope: 'symbol', symbol, items, counts: counts(items), catalystSummary, sentiment: snt, errors: rssErr, at: Date.now() };
  if (!items.some((x) => x.kind !== 'trending')) { const m = await movers(ctx, quick); out.fallback = m.items.slice(0, 25); }
  return out;
}

// Message hook for message-handler.js: true when it handled the frame.
function handle(ws, msg, send) {
  if (!msg || msg.type !== 'GET_CATALYST_FEED') return false;
  const symbol = String(msg.symbol || '').toUpperCase();
  const reply = (r) => send(ws, 'CATALYST_FEED', { ...r, requestId: msg.requestId || null });
  const run = (quick) => (msg.scope === 'movers' ? movers(undefined, quick) : validSymbol(symbol) ? forSymbol(symbol, undefined, quick) : Promise.resolve({ ok: false, error: 'invalid symbol' }));
  const fail = (err) => reply({ ok: false, scope: msg.scope || 'symbol', symbol, error: err.message });
  // Phase 73: from the cache at once (refreshing: stale sources are being refetched), then fresh.
  run(true).then((r) => {
    const refreshing = waiting.size > 0;
    reply({ ...r, refreshing });
    if (refreshing) return Promise.allSettled([...waiting]).then(() => run(false)).then((x) => reply({ ...x, refreshing: false }));
    return null;
  }).catch(fail);
  return true;
}

const reset = () => cache.clear(); // test hook

module.exports = { forSymbol, movers, newsFor, sentimentOf, handle, parseRss, matchRss, normAlpaca, redditItem, trendingItems, merge, safeUrl, reset, RSS, CACHE_MS, RSS_MS, WINDOW_H, PRIMARY_TAGS };
