// Crypto social buzz from free, key-less public sources (System 6 Moonshots):
//   Reddit   r/CryptoCurrency (hot), r/CryptoMarkets (new), r/altcoin (new) via
//            Reddit's public RSS/Atom feeds. (Reddit refuses unauthenticated
//            .json requests (HTTP 403); RSS is its public format for this.)
//            Titles + post text are scanned for a coin's ticker ($ALEO, ALEO) or
//            name, and scored with SignalDesk's headline dictionary. RSS carries
//            no vote counts, so "velocity" is mentions in the last RECENT_H hours.
//   CoinGecko /api/v3/search/trending: the coins retail is searching for now.
// Phase 56: + r/CryptoMoonShots and r/SatoshiStreetBets (new posts, same rotation),
// and every coin is matched against the WHOLE Coinbase catalog (coinbase-discovery.js,
// ~390 coins, by ticker or name), so a trending coin Coinbase lists lights up.
// Reddit allows unauthenticated clients very few requests (x-ratelimit-remaining
// hits 0 after one): feeds are refreshed ONE at a time, at most one per call,
// each every CACHE_MS, and never before Reddit's x-ratelimit-reset / a 429's
// back-off has passed. Every source fails soft: its last good data is kept and
// the gap is reported, never guessed. Honest User-Agent, no auth, no cookies.
const { scoreHeadline } = require('../intelligence/sentiment-nlp');
const { NAMES } = require('../market/universe');
const discovery = require('./coinbase-discovery');

const CACHE_MS = 10 * 60 * 1000;
const RECENT_H = 6;
const TIMEOUT_MS = 8000;
const UA = 'windows:signaldesk:1.0 (personal trading terminal; public RSS)';
const FEEDS = [
  { sub: 'CryptoCurrency', url: 'https://www.reddit.com/r/CryptoCurrency/hot/.rss?limit=50' },
  { sub: 'CryptoMarkets', url: 'https://www.reddit.com/r/CryptoMarkets/new/.rss?limit=50' },
  { sub: 'altcoin', url: 'https://www.reddit.com/r/altcoin/new/.rss?limit=50' },
  { sub: 'CryptoMoonShots', url: 'https://www.reddit.com/r/CryptoMoonShots/new/.rss?limit=50' },
  { sub: 'SatoshiStreetBets', url: 'https://www.reddit.com/r/SatoshiStreetBets/new/.rss?limit=50' },
];
const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
// Tickers that are also everyday words or trading slang (the whole Coinbase catalog is
// matched now): only $TICKER counts, and a coin NAME that is one of these words never does.
const AMBIGUOUS = new Set(['NEAR', 'HYPE', 'LINK', 'USELESS', 'PUMP', 'DASH', 'RAY', 'RENDER', 'NEON', 'LIGHTER', 'UNI', 'AERO', 'ONE', 'TAO',
  'ATH', 'APE', 'APR', 'AUCTION', 'AUDIO', 'AWE', 'BAND', 'BAT', 'BEAM', 'BILL', 'BIO', 'BLEND', 'BLUR', 'CAKE', 'CAP', 'CHECK', 'CHIP', 'COOKIE',
  'COW', 'DEEP', 'DEGEN', 'EDGE', 'ERA', 'FARM', 'FIGHT', 'FLOCK', 'FLOW', 'FORT', 'FORTH', 'FOX', 'GIGA', 'GODS', 'GRASS', 'HIGH', 'HOME', 'HONEY',
  'INDEX', 'KITE', 'LAYER', 'MAGIC', 'MASK', 'MATH', 'MEGA', 'MET', 'META', 'MOVE', 'NOICE', 'NOM', 'OPEN', 'PRIME', 'PRO', 'PROMPT', 'PROVE',
  'RARE', 'RED', 'REQ', 'ROBO', 'ROSE', 'SAFE', 'SAND', 'SENT', 'SIGN', 'SKY', 'SPELL', 'SUP', 'SUPER', 'SWELL', 'TREE', 'TROLL', 'TRUST', 'TRUMP',
  'WELL', 'WET', 'ZEN', 'ACT', 'LIT', 'ALT', 'ALIGN', 'TOWNS', 'HYPER', 'RAD', 'RAVE', 'GAS', 'GAME', 'BOND', 'POND', 'AMP', 'MANA', 'MANTLE', 'OCEAN',
  'CORE', 'BLAST', 'KERNEL', 'PLUME', 'RECALL', 'GROVE', 'ASTER', 'BARD', 'BIRB', 'DOOD', 'BLUECHIP', 'WAL', 'GMT', 'GTC', 'PERP', 'SPX', 'PNG', 'HFT',
  'GWEI', 'ESP', 'SYRUP', 'VET', 'PROS', 'SPA', 'VELO', 'BOBA', 'QUANT', 'TURBO', 'SONIC', 'STORY', 'SPARK', 'ELSA', 'SAPIEN']);
const AMBIGUOUS_NAMES = new Set(['dash', 'render', 'useless coin', 'quant', 'edge', 'prime', 'super', 'magic', 'turbo', 'sonic', 'story', 'mask network']);

const feeds = new Map(); // sub -> { at, posts: [{ sub, title, text, at }] , error }
let trending = { at: 0, coins: [], error: null };
let redditWaitUntil = 0;

const decode = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&#32;/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1] : ''; };

// Atom entries -> posts (Phase 62: + the thread link and author, for the Catalyst Feed).
const href = (e) => { const m = /<link[^>]*href="([^"]+)"/.exec(e); const u = m ? decode(m[1]) : ''; return /^https:\/\/(www\.|old\.)?reddit\.com\//i.test(u) ? u : null; };
function parseAtom(xml, sub) {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({
    sub, title: decode(tag(e, 'title')), text: decode(decode(tag(e, 'content'))).slice(0, 600), at: Date.parse(tag(e, 'updated') || tag(e, 'published')) || null,
    url: href(e), author: decode(tag(tag(e, 'author'), 'name')).replace(/^\/?u\//, '') || null,
  })).filter((p) => p.title);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { res, text: await res.text() };
}

// Refresh the stalest Reddit feed, if one is stale and Reddit's window allows.
async function refreshReddit(now) {
  if (now < redditWaitUntil) return;
  const stale = FEEDS.filter((f) => !feeds.has(f.sub) || now - feeds.get(f.sub).at >= CACHE_MS)
    .sort((a, b) => ((feeds.get(a.sub) || {}).at || 0) - ((feeds.get(b.sub) || {}).at || 0))[0];
  if (!stale) return;
  const prev = feeds.get(stale.sub) || { posts: [] };
  try {
    const { res, text } = await fetchText(stale.url);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number(res.headers.get('x-ratelimit-remaining')) < 1 && reset > 0) redditWaitUntil = now + reset * 1000;
    if (res.status === 429) { redditWaitUntil = now + Math.max(60, reset || 0) * 1000; throw new Error('HTTP 429 (rate limited)'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feeds.set(stale.sub, { at: now, posts: parseAtom(text, stale.sub), error: null });
  } catch (err) {
    feeds.set(stale.sub, { at: now, posts: prev.posts, error: err.name === 'TimeoutError' ? 'timed out' : err.message });
  }
}

async function refreshTrending(now) {
  if (now - trending.at < CACHE_MS) return;
  try {
    const { res, text } = await fetchText(TRENDING_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const coins = (JSON.parse(text).coins || []).map((c, rank) => ({ symbol: String(c.item.symbol || '').toUpperCase(), name: c.item.name, rank, id: c.item.id || null }));
    trending = { at: now, coins, error: null };
  } catch (err) {
    trending = { at: now, coins: trending.coins, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

// Does `text` mention the coin? $TICKER anywhere; the bare TICKER in capitals
// unless it is an everyday word; or the coin's full name as written (a proper
// noun: "Quant trading" is not QNT). Regexes are built once per coin (matcher).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(base, name) {
  const dollar = new RegExp(`\\$${escape(base)}\\b`, 'i');
  const bare = !AMBIGUOUS.has(base) && base.length >= 3 && !/^\d+$/.test(base) ? new RegExp(`(^|[^A-Za-z0-9$])${escape(base)}([^A-Za-z0-9]|$)`) : null;
  const n = String(name || '').trim();
  const named = n.length >= 4 && !AMBIGUOUS_NAMES.has(n.toLowerCase()) && !AMBIGUOUS.has(n.toUpperCase()) ? new RegExp(`\\b${escape(n)}\\b`) : null;
  return (text) => dollar.test(text) || (!!bare && bare.test(text)) || (!!named && named.test(text));
}
const mentions = (text, base, name) => matcher(base, name)(text);
const nameFor = (symbol) => discovery.nameOf(symbol) || NAMES[symbol] || null;
// A CoinGecko trending coin -> its Coinbase product (ticker, else name), or null.
const productOf = (c) => { const coin = discovery.resolve(c.symbol, c.name); return coin ? coin.symbol : null; };

// Social picture for one coin ('ALEO-USD'). Never throws.
// { ok, reddit: { mentions, recent, bullish, bearish, titles, feeds: 'n/3' }, trending: { rank, of } | null, sources, errors }
async function getSocial(symbol, now = Date.now()) {
  await refreshReddit(now);
  await refreshTrending(now);
  const base = symbol.split('-')[0].toUpperCase();
  const hit = matcher(base, nameFor(symbol));
  const posts = [...feeds.values()].flatMap((f) => f.posts);
  const hits = posts.filter((p) => hit(`${p.title} ${p.text}`));
  matched.set(symbol, hits.map((p) => item(p, symbol)));
  const recent = hits.filter((p) => p.at && now - p.at <= RECENT_H * 3600000);
  const tone = hits.map((p) => scoreHeadline(p.title).classification);
  const t = trending.coins.find((c) => c.symbol === base || productOf(c) === symbol);
  const liveFeeds = [...feeds.values()].filter((f) => !f.error).length;
  const errors = [...[...feeds.entries()].filter(([, f]) => f.error).map(([s, f]) => `r/${s}: ${f.error}`), ...(trending.error ? [`CoinGecko: ${trending.error}`] : [])];
  return {
    ok: liveFeeds > 0 || trending.coins.length > 0,
    reddit: { mentions: hits.length, recent: recent.length, bullish: tone.filter((x) => x === 'POSITIVE').length, bearish: tone.filter((x) => x === 'NEGATIVE').length,
      titles: hits.slice(0, 3).map((p) => `r/${p.sub}: ${p.title.slice(0, 120)}`), feeds: `${liveFeeds}/${FEEDS.length}`, posts: posts.length },
    trending: t ? { rank: t.rank + 1, of: trending.coins.length } : null,
    sources: `Reddit RSS (${liveFeeds}/${FEEDS.length} feeds, ${posts.length} posts) + CoinGecko trending (${trending.coins.length} coins)`,
    errors,
  };
}

// A matched post as the Catalyst Feed shows it. RSS carries no vote counts: score null.
const item = (p, symbol) => ({ symbol, title: p.title, subreddit: p.sub, url: p.url || null, createdAt: p.at, score: null, author: p.author || null });
const matched = new Map(); // symbol -> its matched posts (newest scan), for the Catalyst Feed
let recentList = []; // every matched post across the gems, newest first, with all its symbols
const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
// The matched Reddit posts for one coin (from the last scan; matched now if never scanned).
function postsFor(symbol, limit = 20) {
  if (!matched.has(symbol)) {
    const hit = matcher(symbol.split('-')[0].toUpperCase(), nameFor(symbol));
    matched.set(symbol, [...feeds.values()].flatMap((f) => f.posts).filter((p) => hit(`${p.title} ${p.text}`)).map((p) => item(p, symbol)));
  }
  return matched.get(symbol).slice().sort(byNewest).slice(0, limit).map((x) => ({ ...x }));
}
const recentPosts = (limit = 60) => recentList.slice(0, limit).map((x) => ({ ...x, symbols: [...x.symbols] }));
// CoinGecko's trending list, each coin with its Coinbase product (null: not listed).
const trendingList = () => ({ at: trending.at || null, coins: trending.coins.map((c) => ({ ...c, rank: c.rank + 1, product: productOf(c) })) });

// Refresh the sources now (one stale Reddit feed per call, CoinGecko every 10 min).
async function refresh(now = Date.now()) { await refreshReddit(now); await refreshTrending(now); }

// The Buzz strip + the gem watchlist's social input: CoinGecko's trending list
// (each resolved to its Coinbase product, if Coinbase lists it) and the coins
// the cached Reddit posts mention most, across `symbols` (the whole Coinbase
// catalog). Sync, from cache only; memoized until the posts or symbols change.
let memo = { key: null, value: null };
function snapshot(symbols, now = Date.now()) {
  const posts = [...feeds.values()].flatMap((f) => f.posts);
  const key = `${symbols.length}|${[...feeds.values()].map((f) => f.at).join(',')}|${trending.at}|${Math.floor(now / 600000)}`;
  if (memo.key === key) return memo.value;
  const texts = posts.map((p) => `${p.title} ${p.text}`);
  const bySymbol = new Map(); // post index -> the symbols it mentions (the global recent list)
  const reddit = symbols.map((symbol) => {
    const hit = matcher(symbol.split('-')[0].toUpperCase(), nameFor(symbol));
    const idx = texts.map((t, i) => (hit(t) ? i : -1)).filter((i) => i >= 0);
    matched.set(symbol, idx.map((i) => item(posts[i], symbol)));
    for (const i of idx) bySymbol.set(i, [...(bySymbol.get(i) || []), symbol]);
    return { symbol, mentions: idx.length, recent: idx.filter((i) => posts[i].at && now - posts[i].at <= RECENT_H * 3600000).length,
      title: idx.length ? `r/${posts[idx[0]].sub}: ${posts[idx[0]].title.slice(0, 100)}` : null };
  }).filter((r) => r.mentions > 0).sort((a, b) => b.recent - a.recent || b.mentions - a.mentions).slice(0, 25);
  recentList = [...bySymbol].map(([i, syms]) => ({ ...item(posts[i], syms[0]), symbols: syms })).sort(byNewest).slice(0, 120);
  const liveFeeds = [...feeds.values()].filter((f) => !f.error).length;
  const value = {
    // product: its Coinbase book (null: Coinbase does not list it); gem: false for a mega-cap / pegged token (Systems 2 / 4, never the gem radar).
    trending: trending.coins.slice(0, 15).map((c) => { const product = productOf(c); return { ...c, rank: c.rank + 1, product, monitored: !!product, gem: !!product && !discovery.isExcluded(product) }; }),
    trendingAt: trending.at || null,
    reddit, posts: posts.length, feeds: `${liveFeeds}/${FEEDS.length}`, redditAt: Math.max(0, ...[...feeds.values()].map((f) => f.at || 0)) || null,
    errors: [...[...feeds.entries()].filter(([, f]) => f.error).map(([s, f]) => `r/${s}: ${f.error}`), ...(trending.error ? [`CoinGecko: ${trending.error}`] : [])],
  };
  memo = { key, value };
  return value;
}

// Test hook.
function reset() { feeds.clear(); trending = { at: 0, coins: [], error: null }; redditWaitUntil = 0; memo = { key: null, value: null }; matched.clear(); recentList = []; }
// Test hook: cached posts for one subreddit, as if fetched now.
function seed(sub, posts, now = Date.now()) { feeds.set(sub, { at: now, posts, error: null }); memo = { key: null, value: null }; matched.clear(); }

module.exports = { getSocial, refresh, snapshot, mentions, matcher, parseAtom, postsFor, recentPosts, trendingList, nameFor, reset, seed, FEEDS, CACHE_MS };
