// "News & Catalysts" tab of the Setups analysis card: the headlines behind the
// symbol's news sentiment score (server: connectors/news-sentiment.js, cached
// ~90 min; asked for through SD.sentiment, at most every 30 min per symbol).
// Each headline links to the article (http/https only, new tab, no referrer)
// and carries SignalDesk's reading of it (bullish / bearish / neutral), so the
// score can be traced to the actual events. A setup's own catalyst headline
// (equity-day news breakouts) is shown first, then the scheduled catalysts
// (FOMC / CPI / FDA, server/connectors/macro-events.js) for the next 30 days.
// Exposes window.SignalDesk.newsPanel: { render(o, state) }.
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

  // Scheduled events for this symbol: every macro event, its own FDA dates, and
  // FDA committee meetings for healthcare names (server: macro-events.appliesTo).
  function scheduled(o, state) {
    const events = ((state && state.macro) || []).filter((e) => e.daysAway <= 30 && (e.scope === 'macro' || e.symbol === o.asset || (e.symbols || []).includes(o.asset)));
    const tagged = new Set((o.catalysts || []).map((c) => `${c.type}:${c.date}`));
    return el('div', { className: 'news-sched' }, [
      el('h4', { className: 'opp-section', textContent: 'Scheduled catalysts (next 30 days)' }),
      events.length ? el('ul', { className: 'news-sched-list' }, events.map((e) => el('li', { className: `news-sched-item${tagged.has(`${e.type}:${e.date}`) ? ' is-tagged' : ''}` }, [
        el('span', { className: `apv-cat is-${e.type.toLowerCase()}`, textContent: e.type }),
        el('span', { textContent: `${e.title} · ${new Date(`${e.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}`
          + `${e.time ? ` ${e.time}` : ''} · ${e.daysAway === 0 ? 'today' : `in ${e.daysAway} days`}` }),
        el('span', { className: 'news-meta', textContent: tagged.has(`${e.type}:${e.date}`) ? 'inside this setup’s hold' : e.source }),
      ]))) : el('p', { className: 'sa-muted', textContent: 'No FOMC, CPI or FDA events in the next 30 days.' }),
    ]);
  }

  function render(o, state) {
    const d = SD.sentiment.data(o.asset);
    const cat = o.catalyst && o.catalyst.headline
      ? [el('div', { className: 'news-catalyst' }, [el('span', { className: 'sa-muted', textContent: 'Setup catalyst' }),
        el('strong', { textContent: o.catalyst.headline })])] : [];
    const sched = scheduled(o, state);
    if (!d) return [...cat, sched, el('p', { className: 'sa-muted', textContent: 'Loading headlines…' })];
    if (!d.ok) return [...cat, sched, el('p', { className: 'sa-muted', textContent: `News unavailable: ${d.error}` })];
    const list = d.headlines || [];
    return [
      ...cat,
      sched,
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
