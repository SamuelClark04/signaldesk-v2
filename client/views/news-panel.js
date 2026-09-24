// "News & Catalysts" tab of the Setups analysis card: the headlines behind the
// symbol's news sentiment score (server: connectors/news-sentiment.js, cached
// ~90 min; asked for through SD.sentiment, at most every 30 min per symbol).
// Each headline links to the article (http/https only, new tab, no referrer)
// and carries SignalDesk's reading of it (bullish / bearish / neutral), so the
// score can be traced to the actual events. A setup's own catalyst headline
// (equity-day news breakouts) is shown first.
// Exposes window.SignalDesk.newsPanel: { render(o) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age } = SD.ui;

  // Only absolute http(s) URLs become links (defence in depth; the server filters too).
  function safeUrl(u) {
    try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
  }

  function headline(h) {
    const url = safeUrl(h.url);
    const title = url
      ? el('a', { className: 'news-title', href: url, target: '_blank', rel: 'noopener noreferrer', textContent: h.title })
      : el('span', { className: 'news-title', textContent: h.title });
    const at = h.at ? Date.parse(h.at) : null;
    const meta = [h.source, at ? `${age(at)} ago · ${new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : null]
      .filter(Boolean).join(' · ');
    return el('li', { className: 'news-item' }, [
      el('span', { className: `news-tone is-${h.tone}`, textContent: h.tone }),
      el('div', { className: 'news-body' }, [title, el('span', { className: 'news-meta', textContent: meta })]),
    ]);
  }

  function counts(d) {
    if (!Number.isFinite(d.total)) return d.headlineSource || '';
    return `${d.total} focused headline${d.total === 1 ? '' : 's'} in the last 48h: ${d.bullish} bullish, ${d.bearish} bearish, ${d.neutral} neutral`
      + `${d.headlines && d.headlines.length ? ` · the ${d.headlines.length} most recent below` : ''}`;
  }

  function render(o) {
    const d = SD.sentiment.data(o.asset);
    const cat = o.catalyst && o.catalyst.headline
      ? [el('div', { className: 'news-catalyst' }, [el('span', { className: 'sa-muted', textContent: 'Setup catalyst' }),
        el('strong', { textContent: o.catalyst.headline })])] : [];
    if (!d) return [...cat, el('p', { className: 'sa-muted', textContent: 'Loading headlines…' })];
    if (!d.ok) return [...cat, el('p', { className: 'sa-muted', textContent: `News unavailable: ${d.error}` })];
    const list = d.headlines || [];
    return [
      ...cat,
      el('div', { className: 'news-head' }, [SD.sentiment.badge(o.asset, { compact: true }), el('p', { className: 'sa-muted', textContent: counts(d) })]),
      list.length
        ? el('ol', { className: 'news-list' }, list.map(headline))
        : el('p', { className: 'sa-muted', textContent: `No focused headlines for ${o.asset} in the last 48 hours: nothing is moving the score.` }),
      el('p', { className: 'sa-muted news-note', textContent: 'Tone is SignalDesk’s keyword reading of each headline (the same scoring as the sentiment gauge). '
        + `Score source: ${d.source}. Articles open on the publisher’s site.` }),
    ];
  }

  SD.newsPanel = { render };
})();
