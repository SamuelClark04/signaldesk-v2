// Setups workspace, left rail: search + asset toggle, Active Positions (open
// trades, so an executed setup never disappears from view), the setup Queue and
// Market Watch ("heating up"). Pure rendering: selection and filter state live
// in opportunities.js, which passes them in `view` with the click handlers.
// Exposes window.SignalDesk.oppRail: { rail, watchList, segmented }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, price, money, signed, pnlClass } = SD.ui;

  const RAIL_TOGGLE = [['all', 'All'], ['stocks', 'Stocks'], ['crypto', 'Crypto'], ['options', 'Options'], ['moonshots', 'Moonshots']];
  const marketOf = (symbol) => (symbol.includes('-') ? 'crypto' : 'stocks');

  function segmented(options, current, className, onPick) {
    const group = el('div', { className }, options.map(([value, label]) => {
      const b = el('button', { type: 'button', className: `opp-seg${value === current ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(value === current));
      b.onclick = () => onPick(value);
      return b;
    }));
    group.setAttribute('role', 'group');
    return group;
  }

  function searchBox(view) {
    const input = el('input', { type: 'search', className: 'opp-search', placeholder: 'Search setups...', value: view.searchRaw, id: 'opp-search' });
    input.setAttribute('aria-label', 'Search setups and symbols');
    input.addEventListener('input', () => view.onSearch(input.value));
    return el('label', { className: 'opp-search-wrap' }, input);
  }

  // ---------- Active Positions: open trades (paper, live, adopted) ----------
  // Filtered by the asset toggle only (never by search), and a filter that hides
  // positions says so, so a trade is never silently out of sight. Clicking one
  // charts its symbol with the Active Trade HUD.
  function positionRow(p, state, view) {
    const live = state.prices && state.prices[p.asset];
    const m = SD.portfolioMetrics.mark(p, live);
    const venue = p.adopted ? 'Adopted' : p.execution === 'LIVE' ? 'Live' : 'Paper';
    const pnl = m.gross === null || m.gross === undefined
      ? el('span', { className: 'opp-pos-pnl hud-muted', textContent: p.market === 'options' && !(p.optionsData && p.optionsData.contract) ? 'Simulated'
        : m.live && p.market !== 'options' ? '—' : 'No price' })
      : el('span', { className: `opp-pos-pnl ${pnlClass(m.gross)}`, textContent: signed(m.gross, money) });
    const active = view.isWatch && view.watchSymbol === p.asset;
    const btn = el('button', { type: 'button', className: `opp-watch opp-pos${active ? ' is-active' : ''}` }, [
      el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol(p) }),
      el('span', { className: `opp-heat is-position${p.execution === 'LIVE' ? ' is-live' : ''}`, textContent: `${p.direction === 'short' ? 'Short · ' : ''}${venue}` }),
      pnl,
    ]);
    btn.title = m.optionBasis
      ? `${venue} ${p.optionsData.label || p.optionsData.contract}: premium ${m.optionValue.toFixed(2)} (${m.optionBasis === 'bid' ? 'live bid' : m.optionBasis === 'mid' ? 'live net mid' : 'modelled'}) vs ${p.optionsData.debit} paid · P/L before fees`
      : `${venue} ${p.direction} ${p.asset} @ ${price(p.fillPrice, p)} · stop ${price(p.invalidation, p)}${m.live ? ' · P/L before fees' : ''}`;
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => view.onOpenPosition(p);
    return btn;
  }

  function activePositions(state, view) {
    const all = [...(state.positions || [])].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    if (!all.length) return [];
    const list = all.filter((p) => view.matchesAsset(p.market));
    const hidden = all.length - list.length;
    return [
      el('div', { className: 'opp-rail-head' }, [el('h3', { className: 'opp-section', textContent: 'Active positions' }),
        el('span', { className: 'count', textContent: hidden ? `${list.length} / ${all.length}` : String(all.length) })]),
      el('div', { className: 'opp-positions' }, [...list.map((p) => positionRow(p, state, view)),
        ...(hidden ? [el('p', { className: 'opp-muted', textContent: `${hidden} open position${hidden === 1 ? '' : 's'} hidden by the ${view.assetFilter} filter` })] : [])]),
    ];
  }

  // ---------- Queue ----------
  function railCard(o, active, view) {
    const dir = o.direction === 'short' ? 'Short' : 'Long';
    const btn = el('button', { type: 'button', className: `opp-card${active ? ' is-active' : ''}` }, [
      SD.scannerDetail.badge(o.asset),
      el('div', { className: 'opp-card-body' }, [
        el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol(o) }),
        el('span', { className: 'opp-card-meta', textContent: `${dir} — ${o.setupType || 'Setup'}` }),
        ...(o.smallAccountCap ? [el('span', { className: 'opp-moon is-small-cap', textContent: '1-Contract Cap', title: `${o.smallAccountLabel}: risks $${Number(o.dollarRisk).toFixed(0)} to the stop` })] : []),
        ...(o.speculative ? [el('span', { className: 'opp-moon', textContent: 'Speculative Moonshot', title: `Micro-sized: ${Math.round((o.speculativeScale || 0) * 100)}% of normal risk` })] : []),
        el('span', { className: 'opp-card-sub' }, [`${String(o.timeframe || '—').toUpperCase()} `,
          el('span', { className: 'scan-state is-ready', textContent: view.inFlight.has(o.id) ? 'Sending…' : 'Ready' }),
          ` · ${age(o.stagedAt)} ago`]),
      ]),
      el('span', { className: 'opp-card-chev', textContent: '›' }),
    ]);
    btn.title = `${o.strategyId} · staged ${age(o.stagedAt)} ago`;
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => view.onSelectSetup(o.id);
    return btn;
  }

  // ---------- Market Watch ----------
  // "Heating up" symbols (watch-heat.js): near a trigger, queued, held, or charted.
  // keep(symbol) applies the rail's filters. { symbols, heat, caption }.
  function watchList(state, { selected, searching, keep }) {
    const list = SD.watchHeat.heating(state, { selected, searching, keep });
    return { symbols: list.map((x) => x.symbol), heat: new Map(list.map((x) => [x.symbol, x])), caption: SD.watchHeat.caption(state, list) };
  }

  function watchButton(symbol, state, active, watch, view) {
    const p = state.prices && state.prices[symbol];
    const ref = !(p > 0) && state.refPrices && state.refPrices[symbol]; // last close while the feed is quiet
    const shown = p > 0 ? p : ref && ref.price;
    const market = marketOf(symbol);
    const px = el('span', { className: `opp-watch-px${ref ? ' is-stale' : ''}`, textContent: shown > 0 ? price(shown, { market, entryPrice: shown }) : '—' });
    if (ref) px.title = `Last close, ${new Date(ref.time).toLocaleString()} (no live price: market closed or feed quiet)`;
    const h = watch.heat.get(symbol);
    const btn = el('button', { type: 'button', className: `opp-watch${active ? ' is-active' : ''}`, title: h && h.title ? h.title : '' }, [
      el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol({ asset: symbol, market }) }),
      ...(h && h.tag ? [el('span', { className: `opp-heat is-${h.reason}`, textContent: h.tag })] : []),
      px,
    ]);
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => view.onWatch(symbol);
    return btn;
  }

  // Empty queue: the scanner is still working; point at its log (Scanner tab).
  function logLink(state, view) {
    const checked = (state.scanLog || []).filter((e) => e.kind === 'scan').reduce((n, e) => n + (e.checked || 0), 0);
    const b = el('button', { type: 'button', className: 'scan-link opp-log-link',
      textContent: checked ? `Last pass made ${checked} checks: see why nothing qualified →` : 'See the live scanner log →' });
    b.onclick = view.onScannerLog;
    return b;
  }

  // view: { assetFilter, searchRaw, searching, filtered, real, visible, activeId,
  //   watch, watchSymbol, isWatch, inFlight, matchesAsset, onSearch, onFilter,
  //   onSelectSetup, onWatch, onOpenPosition, onScannerLog }
  function rail(state, view) {
    const emptyText = view.real.length ? 'No setups match these filters.' : 'No setups pending. Watching the market until a strategy proposes one.';
    return el('aside', { className: 'opp-rail' }, [
      searchBox(view),
      segmented(RAIL_TOGGLE, view.assetFilter, 'opp-segmented', view.onFilter),
      ...activePositions(state, view),
      el('div', { className: 'opp-rail-head' }, [el('h3', { className: 'opp-section', textContent: 'Queue' }),
        el('span', { className: 'count', textContent: view.filtered ? `${view.visible.length} / ${view.real.length}` : String(view.real.length) })]),
      el('div', { className: 'opp-queue' }, view.visible.length ? view.visible.map((o) => railCard(o, o.id === view.activeId, view))
        : [el('p', { className: 'opp-muted', textContent: emptyText }), logLink(state, view)]),
      el('h3', { className: 'opp-section opp-watch-head', textContent: 'Market watch · heating up' }),
      el('p', { className: 'opp-heat-caption', textContent: view.searching ? 'Searching all monitored symbols' : view.watch.caption }),
      el('div', { className: 'opp-watchlist' }, view.watch.symbols.length
        ? view.watch.symbols.map((s) => watchButton(s, state, view.isWatch && s === view.watchSymbol, view.watch, view))
        : [el('p', { className: 'opp-muted', textContent: 'No symbols match.' })]),
    ]);
  }

  SD.oppRail = { rail, watchList, segmented };
})();
