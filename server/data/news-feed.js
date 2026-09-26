// Live News, Social & Catalyst Feed (Phase 62): the headlines, Reddit threads and
// trending catalysts behind every move, for the card under the Live Chart
// (Opportunities → Moonshots and Setups). Sources, all read-only and cached so no
// rate limit is ever hit:
//   Alpaca News   /v1beta1/news?symbols=...&limit=25 (Benzinga; stocks as AAPL,
//                 crypto as BTCUSD), the last WINDOW_H hours only (a small coin's
//                 "latest" articles can be years old), per symbol set, cached CACHE_MS (2.5 min)
//   Crypto RSS    CoinDesk, Cointelegraph, Decrypt public RSS, each cached RSS_MS
//                 (3 min); an article counts for a coin when its title / summary
//                 names it (crypto-social.js's matcher: $TICKER, TICKER, or name)
//                 (CryptoCompare's news endpoint now requires an API key: not used)
//   Reddit        the posts System 6's social scanner already matched per coin
//                 (crypto-social.js: 5 subreddits' RSS; no extra Reddit requests)
//   Trending      CoinGecko's trending list (crypto-social.js cache)
// Every item: { id, kind: news|reddit|trending, source, outlet, title, url, at, symbols }.
// Links are https/http only. Sources fail soft: the last good data is kept, the gap
// reported in `errors`. GET_CATALYST_FEED { symbol } -> the coin's items + its
// catalystSummary (and top movers as `fallback` when it has none);
// GET_CATALYST_FEED { scope: 'movers' } -> the All Movers feed: news on the leaderboard
// top 20, CoinGecko trending coins, open positions and staged setups, every Reddit post
// the gem scan matched to a Coinbase coin, and the trending list. Reply: CATALYST_FEED.
const social = require('../connectors/crypto-social');
const radar = require('../intelligence/moonshot-radar');
const summary = require('../intelligence/catalyst-summary');
const sentiment = require('../connectors/news-sentiment');

const CACHE_MS = 150 * 1000;
const RSS_MS = 180 * 1000;
const TIMEOUT_MS = 8000;
const MAX_ITEMS = 80;
const WINDOW_H = 72;
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

// Cached fetch: fresh value, else refetch; a failure keeps the last good value.
async function cached(key, ttl, fn, now = Date.now()) {
  const hit = cache.get(key);
  if (hit && (now - hit.at < ttl)) return hit;
  if (hit && hit.pending) return hit.pending;
  const pending = fn().then((value) => ({ at: Date.now(), value, error: null }))
    .catch((err) => ({ at: Date.now(), value: hit ? hit.value : [], error: err.name === 'TimeoutError' ? 'timed out' : err.message }))
    .then((r) => { cache.set(key, r); return r; });
  cache.set(key, { ...(hit || { at: 0, value: [] }), pending });
  return pending;
}

// ---------- Alpaca News ----------
const tagOf = (symbol) => symbol.replace('-', ''); // BTC-USD -> BTCUSD
function normAlpaca(n, wanted) {
  const byTag = new Map(wanted.map((s) => [tagOf(s), s]));
  return { id: `alpaca:${n.id}`, kind: 'news', source: 'ALPACA NEWS', outlet: n.source || n.author || 'Benzinga', title: decode(n.headline).slice(0, 300),
    url: safeUrl(n.url), at: Date.parse(n.created_at || n.updated_at) || null, symbols: (n.symbols || []).map((t) => byTag.get(t)).filter(Boolean) };
}
async function alpacaNews(symbols, limit = 25) {
  const list = [...new Set(symbols)].filter(validSymbol).sort();
  if (!list.length) return { at: Date.now(), value: [], error: null };
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return { at: Date.now(), value: [], error: 'Alpaca news: ALPACA_API_KEY / ALPACA_API_SECRET not set' };
  return cached(`alpaca|${list.join(',')}|${limit}`, CACHE_MS, async () => {
    const base = (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
    const start = new Date(Date.now() - WINDOW_H * 3600000).toISOString();
    const res = await fetch(`${base}/v1beta1/news?symbols=${encodeURIComponent(list.map(tagOf).join(','))}&limit=${limit}&sort=desc&start=${encodeURIComponent(start)}`,
      { headers: { Accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Alpaca news HTTP ${res.status}`);
    const json = await res.json();
    return (json.news || []).map((n) => normAlpaca(n, list)).filter((x) => x.title && x.symbols.length);
  });
}

// ---------- Crypto RSS ----------
function parseRss(xml, outlet) {
  return (String(xml).match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
    const url = safeUrl(decode(tag(it, 'link')) || decode(tag(it, 'guid')));
    return { outlet, title: decode(tag(it, 'title')).slice(0, 300), text: decode(decode(tag(it, 'description'))).slice(0, 500), url, at: Date.parse(decode(tag(it, 'pubDate'))) || null };
  }).filter((x) => x.title && x.url);
}
async function rssItems() {
  const results = await Promise.all(RSS.map((f) => cached(`rss|${f.outlet}`, RSS_MS, async () => {
    const res = await fetch(f.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseRss(await res.text(), f.outlet);
  }).then((r) => ({ ...r, outlet: f.outlet }))));
  return { items: results.flatMap((r) => r.value), errors: results.filter((r) => r.error).map((r) => `${r.outlet}: ${r.error}`) };
}
// RSS articles -> feed items tagged with the crypto symbols they name (untagged: dropped).
function matchRss(items, symbols) {
  const matchers = symbols.filter((s) => s.includes('-')).map((s) => [s, social.matcher(s.split('-')[0].toUpperCase(), social.nameFor(s))]);
  return items.map((a) => {
    const text = `${a.title} ${a.text}`;
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

async function movers(ctx = summary.context()) {
  const symbols = moverSymbols(ctx);
  const [alp, rss] = await Promise.all([alpacaNews(symbols, 50), symbols.some((x) => x.includes('-')) ? rssItems() : { items: [], errors: [] }]);
  const reddit = social.recentPosts(120).map(redditItem); // every post the gem scan matched to a Coinbase coin
  const items = merge([alp.value, matchRss(rss.items, symbols), reddit, trendingItems(null)]);
  return { ok: true, scope: 'movers', symbols, items, counts: counts(items), errors: [...(alp.error ? [alp.error] : []), ...rss.errors], at: Date.now() };
}

async function forSymbol(symbol, ctx = summary.context()) {
  const crypto = symbol.includes('-');
  const [alp, rss] = await Promise.all([alpacaNews([symbol]), crypto ? rssItems() : { items: [], errors: [] }]);
  const reddit = crypto ? social.postsFor(symbol, 40).map(redditItem) : [];
  const items = merge([alp.value, crypto ? matchRss(rss.items, [symbol]) : [], reddit, crypto ? trendingItems([symbol]) : []]);
  const row = radar.rowOf(symbol);
  if (!row || !row.catalystSummary) await sentiment.getSentiment(symbol).catch(() => null); // the score the Setups badge shows (cached ~90 min)
  const catalystSummary = row && row.catalystSummary ? row.catalystSummary : summary.forSymbol(symbol, ctx);
  const out = { ok: true, scope: 'symbol', symbol, items, counts: counts(items), catalystSummary, errors: [...(alp.error ? [alp.error] : []), ...rss.errors], at: Date.now() };
  if (!items.some((x) => x.kind !== 'trending')) { const m = await movers(ctx); out.fallback = m.items.slice(0, 25); }
  return out;
}

// Message hook for message-handler.js: true when it handled the frame.
function handle(ws, msg, send) {
  if (!msg || msg.type !== 'GET_CATALYST_FEED') return false;
  const symbol = String(msg.symbol || '').toUpperCase();
  const reply = (r) => send(ws, 'CATALYST_FEED', { ...r, requestId: msg.requestId || null });
  const job = msg.scope === 'movers' ? movers() : validSymbol(symbol) ? forSymbol(symbol) : Promise.resolve({ ok: false, error: 'invalid symbol' });
  job.then(reply).catch((err) => reply({ ok: false, scope: msg.scope || 'symbol', symbol, error: err.message }));
  return true;
}

const reset = () => cache.clear(); // test hook

module.exports = { forSymbol, movers, handle, parseRss, matchRss, normAlpaca, redditItem, trendingItems, merge, safeUrl, reset, RSS, CACHE_MS, RSS_MS, WINDOW_H };
