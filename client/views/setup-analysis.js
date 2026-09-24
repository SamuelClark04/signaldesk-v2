// Setups tab: the analysis card under the chart (Thesis / Price structure /
// Market context / Sources). Everything shown comes from the setup itself, the
// order guard's rules, the loaded chart and DASHBOARD_INTELLIGENCE: no invented text.
// Exposes window.SignalDesk.setupAnalysis.analysis(o, ctx).
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const TABS = [['thesis', 'Thesis'], ['structure', 'Price structure'], ['context', 'Market context'], ['news', 'News & Catalysts'], ['sources', 'Sources']];
  let tab = 'thesis';

  const col = (title, children) => el('div', { className: 'sa-col' }, [el('h4', { className: 'sa-h', textContent: title }), ...children]);
  const list = (items) => el('ul', { className: 'sa-list' }, items.map((t) => el('li', { textContent: t })));
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
  const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // What invalidates it: the order guard's and exit monitor's real rules.
  function invalidators(o) {
    const long = o.direction !== 'short';
    const fmt = (x) => price(x, o);
    return [
      `Price trades ${long ? 'at or below' : 'at or above'} the stop at ${fmt(o.invalidation)}.`,
      `Price runs ${long ? 'above' : 'below'} ${fmt(long ? o.entryZone.max : o.entryZone.min)} before approval (no chasing).`,
      'The setup is not approved within 30 minutes of being proposed.',
    ];
  }

  function thesis(o, watch) {
    if (watch) {
      return [el('div', { className: 'sa-cols' }, [col('Market watch', [el('p', { className: 'sa-text',
        textContent: 'No algorithmic setup for this symbol. Setups appear when a strategy proposes one and the risk engine approves it.' })])])];
    }
    const cat = o.catalyst && o.catalyst.headline;
    return [el('div', { className: 'sa-cols' }, [
      col('Why this setup', [el('p', { className: 'sa-text', textContent: o.thesis || 'No thesis provided.' }),
        ...(cat ? [el('p', { className: 'sa-text sa-muted', textContent: `Catalyst: ${cat} (sentiment ${o.catalyst.sentimentScore > 0 ? '+' : ''}${o.catalyst.sentimentScore})` })] : [])]),
      col('What confirms this', [(o.confirmationCriteria || []).length ? list(o.confirmationCriteria) : el('p', { className: 'sa-muted', textContent: 'No confirmation criteria given.' })]),
      col('What invalidates it', [list(invalidators(o))]),
    ])];
  }

  // Levels vs the last price, plus the loaded chart's range.
  function structure(o, ctx, watch) {
    const last = ctx.livePrice > 0 ? ctx.livePrice : ctx.refPrice && ctx.refPrice.price;
    const t = o.targets || [];
    const rows = watch ? [] : [['T2', t[1] && t[1].price], ['T1', t[0] && t[0].price], ['Entry (max)', o.entryZone.max], ['Entry (min)', o.entryZone.min], ['Stop', o.invalidation]];
    const s = SD.liveChart && SD.liveChart.stats(o.asset);
    if (s) rows.push([`${s.tf} range high (${s.bars} bars)`, s.high], [`${s.tf} range low`, s.low]);
    const body = rows.filter(([, p]) => p > 0).map(([name, p]) => el('tr', {}, [
      el('td', { textContent: name }),
      el('td', { className: 'num', textContent: price(p, o) }),
      el('td', { className: 'num', textContent: last > 0 ? pct(p / last - 1) : '—' }),
    ]));
    return [el('table', { className: 'data-table sa-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { textContent: 'Level' }), el('th', { className: 'num', textContent: 'Price' }), el('th', { className: 'num', textContent: `vs last ${last > 0 ? price(last, o) : ''}` })])),
      el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colSpan: 3, className: 'sa-muted', textContent: 'No levels or chart data yet.' }))]),
    ])];
  }

  function context(state, o) {
    const c = state.intelligence && state.intelligence.context;
    const news = col(`${o.market === 'crypto' ? o.asset.replace('-', '/') : o.asset} news`, [SD.sentiment.badge(o.asset)]);
    if (!c || !c.length) return [el('div', { className: 'sa-cols' }, [news, col('Market', [el('p', { className: 'sa-muted', textContent: 'Waiting for the first market read from the live streams.' })])])];
    return [el('div', { className: 'sa-cols' }, [news, ...c.map((m) => col(m.asset, [
      el('p', { className: `sa-trend is-${m.trend}`, textContent: `${m.trend === 'unknown' ? 'No read' : m.trend[0].toUpperCase() + m.trend.slice(1)}${Number.isFinite(m.changePct) ? ` ${pct(m.changePct)}` : ''}` }),
      el('p', { className: 'sa-muted', textContent: [m.basis, m.breadth].filter(Boolean).join(' · ') }),
    ]))])];
  }

  function sources(o, watch) {
    const feed = o.market === 'crypto' ? 'Coinbase ticker stream' : 'Alpaca IEX bar stream';
    const hist = o.market === 'crypto' ? 'Coinbase candles (REST)' : 'Alpaca IEX bars (REST)';
    const rows = [['Live price', feed], ['Chart history', hist]];
    if (!watch) {
      rows.unshift(['Strategy', `${o.strategyId || '—'} · ${o.setupType || 'Setup'} · ${o.timeframe || '—'}`],
        ['Proposed', o.timestamp ? when(Date.parse(o.timestamp)) : '—'], ['Staged', o.stagedAt ? when(o.stagedAt) : '—']);
      rows.push(['Sizing & costs', `SignalDesk risk engine (${o.riskPct > 0 ? `${(o.riskPct * 100).toFixed(1)}%` : 'profile'} risk when staged; fee model shared with the ledger)`]);
      if (o.catalyst && o.catalyst.headline) rows.push(['Catalyst', `${o.catalyst.type || 'news'}: ${o.catalyst.headline}`]);
    }
    return [el('dl', { className: 'sa-dl' }, rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]))];
  }

  // ctx: { state, livePrice, refPrice, rerender }
  function analysis(o, ctx) {
    const watch = !SD.oppDetail.hasLevels(o);
    const tabs = el('div', { className: 'sa-tabs', role: 'tablist' }, TABS.map(([key, label]) => {
      const b = el('button', { type: 'button', className: `sa-tab${key === tab ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(key === tab));
      b.onclick = () => { tab = key; ctx.rerender(); };
      return b;
    }));
    const asOf = watch ? '' : `As of ${o.stagedAt ? when(o.stagedAt) : '—'} · Source: ${o.strategyId || 'SignalDesk'}`;
    const body = { thesis: () => thesis(o, watch), structure: () => structure(o, ctx, watch), context: () => context(ctx.state, o), news: () => SD.newsPanel.render(o, ctx.state), sources: () => sources(o, watch) }[tab]();
    return el('section', { className: 'opp-analysis', id: 'opp-analysis' }, [
      el('div', { className: 'sa-head' }, [tabs, el('span', { className: 'sa-asof', textContent: asOf })]),
      el('div', { className: 'sa-body' }, body),
    ]);
  }

  SD.setupAnalysis = { analysis };
})();
