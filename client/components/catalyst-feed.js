// Catalyst & News Feed (Phase 62): the card under the Live Chart on Opportunities →
// Moonshots and Setups, so the move on the chart comes with its reasons.
//   [This Coin: SYMBOL]   A: "What SignalDesk is basing this move on": the radar
//                         row's catalystSummary (technical & volume, social /
//                         trending, trigger & risk-gate verdict), then B: that
//                         symbol's news + Reddit threads. No articles or posts on it:
//                         the top movers' stream instead (said so).
//   [All Movers Feed]     every matched headline, Reddit post and CoinGecko
//                         trending catalyst across the leaderboard, trending coins,
//                         open positions and staged setups
//   [Reddit (X)] [News (Y)]  kind filters (click again to clear)
// Each row: source badge, clickable ticker pills (chart that symbol), the title as a
// link (new tab, noopener; http/https only) and its age. Data: GET_CATALYST_FEED
// (server/data/news-feed.js, cached 2-3 min server-side), asked at most every
// REFRESH_MS per symbol; app.js hands CATALYST_FEED back to received().
// Exposes window.SignalDesk.catalystFeed: { render(symbol, opts), received(r) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age } = SD.ui;

  const REFRESH_MS = 2 * 60 * 1000;
  const RETRY_MS = 20 * 1000;
  const cache = new Map(); // 'movers' | 'sym:<SYMBOL>' -> { data, askedAt }
  let scope = 'coin'; // 'coin' | 'movers'
  let kind = null; // null | 'reddit' | 'news'
  let scrollKey = ''; // the list keeps its place across re-renders (opportunities.js SCROLLERS) until this changes

  const short = (s) => s.replace(/-USD$/, '');
  const display = (s) => s.replace('-', '/');
  const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

  function get(key, msg) {
    const c = cache.get(key) || { data: null, askedAt: 0 };
    const stale = !c.data || Date.now() - c.data.receivedAt > REFRESH_MS;
    if (stale && Date.now() - c.askedAt > RETRY_MS && SD.app && SD.app.isOnline()) {
      c.askedAt = Date.now();
      cache.set(key, c);
      SD.app.send({ type: 'GET_CATALYST_FEED', ...msg });
    }
    return c.data;
  }

  function received(r) {
    if (!r) return;
    const key = r.scope === 'movers' ? 'movers' : `sym:${r.symbol}`;
    const c = cache.get(key) || { askedAt: 0 };
    cache.set(key, { ...c, data: { ...r, receivedAt: Date.now() } });
  }

  const radarRow = (symbol) => { const r = SD.app && SD.app.state.moonshotRadar; return ((r && r.rows) || []).find((x) => x.symbol === symbol) || null; };

  // ---------- Section A: the decision breakdown ----------
  const STATUS = { STAGED: 'is-go', HELD: 'is-go', QUALIFIES: 'is-go', FILTERED: 'is-stop', COOLDOWN: 'is-warn', LOW_SCORE: 'is-warn', WAITING: 'is-warn', WATCHING: 'is-idle' };
  function basis(symbol, s) {
    const head = el('div', { className: 'cfeed-basis-head' }, [el('strong', { textContent: 'What SignalDesk is basing this move on' }),
      ...(s ? [el('span', { className: `cfeed-status ${STATUS[s.verdict.status] || ''}`, textContent: s.verdict.status.replace('_', ' ') })] : [])]);
    if (!s) return el('div', { className: 'cfeed-basis' }, [head, el('p', { className: 'opp-muted', textContent: `Loading the breakdown for ${display(symbol)}…` })]);
    return el('div', { className: 'cfeed-basis' }, [head,
      el('p', { className: 'cfeed-headline', textContent: s.headline }),
      ...s.drivers.map((d) => el('div', { className: `cfeed-driver is-${d.key}` }, [
        el('div', { className: 'cfeed-driver-head' }, [el('span', { textContent: d.title }), ...(d.points ? [el('span', { className: 'cfeed-points', textContent: d.points })] : [])]),
        el('ul', {}, d.lines.map((l) => el('li', { textContent: l }))),
      ])),
    ]);
  }

  // ---------- Section B: the stream ----------
  function row(x, onPick, current) {
    const url = safeUrl(x.url);
    const title = url ? el('a', { className: 'cfeed-title', href: url, target: '_blank', rel: 'noopener noreferrer', textContent: x.title })
      : el('span', { className: 'cfeed-title', textContent: x.title });
    const pills = (x.symbols || []).slice(0, 4).map((s) => {
      const b = el('button', { type: 'button', className: `cfeed-ticker${s === current ? ' is-current' : ''}`, textContent: short(s), title: `Chart ${display(s)}` });
      b.onclick = (e) => { e.preventDefault(); scope = 'coin'; kind = null; if (onPick) onPick(s); }; // chart it + show why it scored
      return b;
    });
    const meta = [x.at ? `${age(x.at)} ago` : null, x.kind === 'news' && x.source === 'ALPACA NEWS' ? x.outlet : null, x.author ? `u/${x.author}` : null].filter(Boolean).join(' · ');
    return el('li', { className: `cfeed-item is-${x.kind}` }, [
      el('div', { className: 'cfeed-meta' }, [el('span', { className: `cfeed-src is-${x.kind}`, textContent: x.source }), ...pills, el('span', { className: 'cfeed-age', textContent: meta })]),
      title,
    ]);
  }

  function list(items, onPick, current, key) {
    const ul = el('ul', { className: 'cfeed-list' }, items.map((x) => row(x, onPick, current)));
    if (key !== scrollKey) { scrollKey = key; ul.dataset.fresh = '1'; } // another symbol / tab / filter: start at the top
    return ul;
  }

  // opts: { onPick(symbol) } (load that symbol onto the chart).
  function render(symbol, opts = {}) {
    const coin = symbol ? get(`sym:${symbol}`, { symbol }) : null;
    const isCoin = scope === 'coin' && !!symbol;
    const movers = isCoin ? null : get('movers', { scope: 'movers' });
    const own = isCoin && coin ? coin.items : [];
    const fallback = isCoin && coin && !own.some((x) => x.kind !== 'trending') ? (coin.fallback || []) : null;
    const base = isCoin ? (fallback ? [...own, ...fallback] : own) : ((movers && movers.items) || []);
    const count = (k) => base.filter((x) => x.kind === k).length;
    const items = kind ? base.filter((x) => x.kind === kind) : base;
    const tab = (id, label) => {
      const b = el('button', { type: 'button', className: `cfeed-tab${scope === id ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(scope === id));
      b.onclick = () => { scope = id; SD.app.refresh(); };
      return b;
    };
    const pill = (id, label) => {
      const b = el('button', { type: 'button', className: `cfeed-pill${kind === id ? ' is-active' : ''}`, textContent: `${label} (${count(id)})` });
      b.setAttribute('aria-pressed', String(kind === id));
      b.onclick = () => { kind = kind === id ? null : id; SD.app.refresh(); };
      return b;
    };
    const coinLabel = symbol ? `This ${symbol.includes('-') ? 'Coin' : 'Symbol'}: ${display(symbol)}` : 'This Coin';
    const src = isCoin ? coin : movers;
    const summary = isCoin ? ((radarRow(symbol) || {}).catalystSummary || (coin && coin.catalystSummary) || null) : null;
    const notes = [
      fallback ? `No news or Reddit posts on ${display(symbol)} in the last 72 h: showing the top movers' feed.` : null,
      src && src.errors && src.errors.length ? `Unavailable: ${src.errors.join('; ')} (last good data kept)` : null,
    ].filter(Boolean);
    return el('section', { className: 'cfeed', id: 'catalyst-feed' }, [
      el('div', { className: 'cfeed-head' }, [
        el('h3', { className: 'opp-section', textContent: 'Catalyst & News Feed' }),
        el('div', { className: 'cfeed-tabs' }, [...(symbol ? [tab('coin', coinLabel)] : []), tab('movers', 'All Movers Feed'), el('span', { className: 'cfeed-sep' }), pill('reddit', 'Reddit'), pill('news', 'News')]),
      ]),
      ...(isCoin ? [basis(symbol, summary)] : []),
      ...notes.map((n) => el('p', { className: 'slog-muted cfeed-note', textContent: n })),
      !src ? el('p', { className: 'opp-muted', textContent: 'Loading headlines and Reddit threads…' })
        : items.length ? list(items, opts.onPick, symbol, `${scope}|${kind}|${symbol}`)
          : el('p', { className: 'opp-muted', textContent: kind ? `No ${kind === 'news' ? 'news headlines' : 'Reddit posts'} here right now.` : 'Nothing in the feed right now.' }),
      el('p', { className: 'slog-muted cfeed-foot', textContent: 'Alpaca News (72 h) · CoinDesk · Cointelegraph · Decrypt · Reddit (5 crypto subreddits, RSS: no vote counts) · CoinGecko trending · refreshed every 2 min' }),
    ]);
  }

  SD.catalystFeed = { render, received };
})();
