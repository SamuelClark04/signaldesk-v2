// News sentiment gauge (0 = extreme bearish, 100 = extreme bullish) for the
// charted symbol. Asks the server with GET_SENTIMENT (server caches ~90 min) at
// most once per REFRESH_MS per symbol; app.js hands NEWS_SENTIMENT back here.
// Exposes window.SignalDesk.sentiment: { badge(symbol, opts), received(r) }.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;

  const REFRESH_MS = 30 * 60 * 1000;
  const RETRY_MS = 60 * 1000;
  const cache = new Map(); // symbol -> { data, askedAt }

  function get(symbol) {
    const c = cache.get(symbol) || { data: null, askedAt: 0 };
    const stale = !c.data || Date.now() - (c.data.receivedAt || 0) > REFRESH_MS;
    if (stale && Date.now() - c.askedAt > RETRY_MS && SD.app && SD.app.isOnline()) {
      c.askedAt = Date.now();
      cache.set(symbol, c);
      SD.app.send({ type: 'GET_SENTIMENT', symbol });
    }
    return c.data;
  }

  function received(r) {
    if (!r || !r.symbol) return;
    const c = cache.get(r.symbol) || { askedAt: 0 };
    cache.set(r.symbol, { ...c, data: { ...r, receivedAt: Date.now() } }); // app.js re-renders after NEWS_SENTIMENT
  }

  const tone = (s) => (s === null ? 'none' : s < 40 ? 'bear' : s <= 60 ? 'neutral' : 'bull');

  // opts.compact: one line for the risk panel; otherwise with the source line.
  function badge(symbol, opts = {}) {
    const d = get(symbol);
    const head = el('span', { className: 'snt-label', textContent: 'News sentiment' });
    if (!d) return el('div', { className: 'snt is-loading' }, [head, el('span', { className: 'snt-value', textContent: 'Loading…' })]);
    if (!d.ok) return el('div', { className: 'snt is-none', title: d.error }, [head, el('span', { className: 'snt-value', textContent: 'Unavailable' })]);
    const t = tone(d.score);
    const bar = el('div', { className: 'snt-bar' }, el('span', { className: `snt-fill is-${t}` }));
    bar.firstChild.style.width = `${d.score === null ? 0 : d.score}%`;
    return el('div', { className: `snt is-${t}${opts.compact ? ' is-compact' : ''}`, title: d.source }, [
      head,
      el('span', { className: 'snt-value' }, [el('strong', { textContent: d.score === null ? '—' : `${d.score}/100` }), ` ${d.label}`]),
      bar,
      ...(opts.compact ? [] : [el('span', { className: 'snt-source', textContent: d.source })]),
    ]);
  }

  SD.sentiment = { badge, received };
})();
