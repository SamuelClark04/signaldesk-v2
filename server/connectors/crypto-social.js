// Crypto social buzz from free, key-less public sources (System 6 Moonshots):
//   Reddit   r/CryptoCurrency (hot), r/CryptoMarkets (new), r/altcoin (new) via
//            Reddit's public RSS/Atom feeds. (Reddit refuses unauthenticated
//            .json requests (HTTP 403); RSS is its public format for this.)
//            Titles + post text are scanned for a coin's ticker ($ALEO, ALEO) or
//            name, and scored with SignalDesk's headline dictionary. RSS carries
//            no vote counts, so "velocity" is mentions in the last RECENT_H hours.
//   CoinGecko /api/v3/search/trending: the coins retail is searching for now.
// Reddit allows unauthenticated clients very few requests (x-ratelimit-remaining
// hits 0 after one): feeds are refreshed ONE at a time, at most one per call,
// each every CACHE_MS, and never before Reddit's x-ratelimit-reset / a 429's
// back-off has passed. Every source fails soft: its last good data is kept and
// the gap is reported, never guessed. Honest User-Agent, no auth, no cookies.
const { scoreHeadline } = require('../intelligence/sentiment-nlp');
const { NAMES } = require('../market/universe');

const CACHE_MS = 10 * 60 * 1000;
const RECENT_H = 6;
const TIMEOUT_MS = 8000;
const UA = 'windows:signaldesk:1.0 (personal trading terminal; public RSS)';
const FEEDS = [
  { sub: 'CryptoCurrency', url: 'https://www.reddit.com/r/CryptoCurrency/hot/.rss?limit=50' },
  { sub: 'CryptoMarkets', url: 'https://www.reddit.com/r/CryptoMarkets/new/.rss?limit=50' },
  { sub: 'altcoin', url: 'https://www.reddit.com/r/altcoin/new/.rss?limit=50' },
];
const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
// Tickers that are also everyday words: only $TICKER or the coin's full name counts.
const AMBIGUOUS = new Set(['NEAR', 'HYPE', 'LINK', 'USELESS', 'PUMP', 'DASH', 'RAY', 'RENDER', 'NEON', 'LIGHTER', 'UNI', 'AERO', 'ONE', 'TAO']);
const AMBIGUOUS_NAMES = new Set(['Dash', 'Render', 'Useless Coin']);

const feeds = new Map(); // sub -> { at, posts: [{ sub, title, text, at }] , error }
let trending = { at: 0, coins: [], error: null };
let redditWaitUntil = 0;

const decode = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&#32;/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1] : ''; };

// Atom entries -> posts.
function parseAtom(xml, sub) {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({
    sub, title: decode(tag(e, 'title')), text: decode(decode(tag(e, 'content'))).slice(0, 600), at: Date.parse(tag(e, 'updated') || tag(e, 'published')) || null,
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
    const coins = (JSON.parse(text).coins || []).map((c, rank) => ({ symbol: String(c.item.symbol || '').toUpperCase(), name: c.item.name, rank }));
    trending = { at: now, coins, error: null };
  } catch (err) {
    trending = { at: now, coins: trending.coins, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

// Does `text` mention the coin? $TICKER anywhere; the bare TICKER in capitals
// unless it is an everyday word; or the coin's full name.
function mentions(text, base, name) {
  if (new RegExp(`\\$${base}\\b`, 'i').test(text)) return true;
  if (!AMBIGUOUS.has(base) && base.length >= 3 && new RegExp(`(^|[^A-Za-z0-9$])${base}([^A-Za-z0-9]|$)`).test(text)) return true;
  return !!name && !AMBIGUOUS_NAMES.has(name) && name.length >= 4 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

// Social picture for one coin ('ALEO-USD'). Never throws.
// { ok, reddit: { mentions, recent, bullish, bearish, titles, feeds: 'n/3' }, trending: { rank, of } | null, sources, errors }
async function getSocial(symbol, now = Date.now()) {
  await refreshReddit(now);
  await refreshTrending(now);
  const base = symbol.split('-')[0].toUpperCase();
  const name = NAMES[symbol] || null;
  const posts = [...feeds.values()].flatMap((f) => f.posts);
  const hits = posts.filter((p) => mentions(`${p.title} ${p.text}`, base, name));
  const recent = hits.filter((p) => p.at && now - p.at <= RECENT_H * 3600000);
  const tone = hits.map((p) => scoreHeadline(p.title).classification);
  const t = trending.coins.find((c) => c.symbol === base);
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

// The Buzz strip (Moonshot Radar): CoinGecko's trending list and the monitored
// coins the cached Reddit posts mention most. Sync, from cache only (getSocial refreshes).
function snapshot(symbols, now = Date.now()) {
  const posts = [...feeds.values()].flatMap((f) => f.posts);
  const reddit = symbols.map((symbol) => {
    const base = symbol.split('-')[0].toUpperCase();
    const hits = posts.filter((p) => mentions(`${p.title} ${p.text}`, base, NAMES[symbol] || null));
    return { symbol, mentions: hits.length, recent: hits.filter((p) => p.at && now - p.at <= RECENT_H * 3600000).length, title: hits[0] ? `r/${hits[0].sub}: ${hits[0].title.slice(0, 100)}` : null };
  }).filter((r) => r.mentions > 0).sort((a, b) => b.recent - a.recent || b.mentions - a.mentions).slice(0, 10);
  const listed = new Set(symbols.map((s) => s.split('-')[0].toUpperCase()));
  const liveFeeds = [...feeds.values()].filter((f) => !f.error).length;
  return {
    trending: trending.coins.slice(0, 15).map((c) => ({ ...c, rank: c.rank + 1, monitored: listed.has(c.symbol) })), trendingAt: trending.at || null,
    reddit, posts: posts.length, feeds: `${liveFeeds}/${FEEDS.length}`, redditAt: Math.max(0, ...[...feeds.values()].map((f) => f.at || 0)) || null,
    errors: [...[...feeds.entries()].filter(([, f]) => f.error).map(([s, f]) => `r/${s}: ${f.error}`), ...(trending.error ? [`CoinGecko: ${trending.error}`] : [])],
  };
}

// Test hook.
function reset() { feeds.clear(); trending = { at: 0, coins: [], error: null }; redditWaitUntil = 0; }

module.exports = { getSocial, snapshot, mentions, parseAtom, reset, FEEDS, CACHE_MS };
