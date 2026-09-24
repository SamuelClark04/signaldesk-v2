// Opportunities tab: sub-navigation (Setups / Scanner / Saved) and the Setups
// workspace: queue rail (left), analysis (center), risk & execution (right).
// With no setup selected it shows Market Watch: live prices, nothing executable.
// The server is the source of truth: buttons send APPROVE / REJECT intents (the
// same messages the order guard, live routing and ORDER_BUSY lock protect), and
// a setup leaves the rail only when the server's QUEUE_UPDATED removes it.
// Exposes window.SignalDesk.opportunities.
(() => {
  const SD = window.SignalDesk;
  const { el, age, price } = SD.ui;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let subTab = 'setups';
  let activeId = null;
  const inFlight = new Set(); // ids with an APPROVE/REJECT awaiting the server
  let notice = null;
  let noticeTimer = null;
  let mounted = null; // { container, state } of the last render, for local re-renders

  // Order-guard and broker reasons from the server, in plain words.
  const FAIL_REASONS = {
    EXPIRED: 'setup is older than 30 minutes and was discarded',
    PRICE_ESCAPED: 'price moved past the entry zone and the setup was discarded',
    INVALIDATED: 'price is already through the stop and the setup was discarded',
    NO_LIVE_PRICE: 'no fresh price available; still pending, try again shortly',
    LIVE_OPTIONS_UNSUPPORTED: 'live options execution is not supported yet (strikes are simulated). Nothing was sent; '
      + 'the order is still pending (set Alpaca mode to Paper to fill it on paper)',
    ORDER_BUSY: 'an action for this order is already in progress',
    LIVE_CLOSE_UNSUPPORTED: 'it is a LIVE position: close it at the broker (its exits are orders there)',
  };
  function describe(error) {
    if (FAIL_REASONS[error]) return FAIL_REASONS[error];
    const [code, ...rest] = String(error).split(': ');
    if (code === 'LIVE_ORDER_FAILED') return `live order rejected, nothing was filled (${rest.join(': ')})`;
    if (code === 'LIVE_UNRECORDED') return `CHECK YOUR BROKER NOW: ${rest.join(': ')}`;
    if (code === 'SIZED_FOR_OTHER_VENUE') return `nothing was sent: this setup was ${rest.join(': ')}. Dismiss it; the next scan re-proposes it sized from the live account`;
    return error;
  }

  // Market Watch: when no queued setup is selected, the workspace follows a live
  // symbol instead. It is NOT a candidate: no id, no levels, no size, so nothing
  // can be approved from it (see send() and the right panel).
  const DEFAULT_WATCH = 'BTC-USD'; // crypto streams 24/7, so there is always a live price
  let watchSymbol = DEFAULT_WATCH;
  let manualWatch = false; // user picked a watch symbol while setups exist
  const marketOf = (symbol) => (symbol.includes('-') ? 'crypto' : 'stocks');
  const marketWatch = (symbol) => ({ isWatch: true, asset: symbol, market: marketOf(symbol), setupType: 'Market Watch', timeframe: '1h' });

  const rerender = () => { if (mounted) render(mounted.container, mounted.state); };

  function showNotice(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; rerender(); }, 10000);
    rerender();
  }

  // ---------- Actions (intents only) ----------
  function send(type, id) {
    // Only an id that is in the REAL queue can ever be sent (defence in depth).
    if (!mounted || !mounted.state.pending.some((o) => o.id === id)) return;
    if (!transport.isOnline() || inFlight.has(id)) return;
    inFlight.add(id);
    transport.send({ type, id });
    rerender();
  }

  function onApprove(o, { live, broker }) {
    if (live && !window.confirm(`Place a LIVE order at ${broker}?\n\n${o.direction.toUpperCase()} ${o.positionSize} ${o.asset}\n`
      + `Stop ${o.invalidation} · Target ${o.targets && o.targets[0] ? o.targets[0].price : '—'}\n\nThis uses real money.`)) return;
    send('APPROVE', o.id);
  }
  const onDismiss = (o) => send('REJECT', o.id);

  // HUD manual exit (paper only; the server refuses LIVE). Same confirm as Portfolio.
  function onClosePosition(p, m) {
    if (!transport.isOnline() || inFlight.has(p.id)) return;
    const est = m.gross === null ? 'Options are booked at their value at expiry for this underlying price.'
      : `Estimated P/L: ${m.gross >= 0 ? '+' : '−'}$${Math.abs(m.gross).toFixed(2)} gross${m.net === null ? '' : `, ${m.net >= 0 ? '+' : '−'}$${Math.abs(m.net).toFixed(2)} after fees`}.`;
    if (!window.confirm(`Manual exit: close ${p.direction.toUpperCase()} ${p.asset} (paper) now at the live price ${price(m.price, p)}?\n\n${est}\n\nThis overrides the stop and targets.`)) return;
    inFlight.add(p.id);
    transport.send({ type: 'CLOSE_POSITION', id: p.id });
    rerender();
  }

  function actionFailed({ type, id, error }) {
    inFlight.delete(id);
    const who = (mounted && mounted.state.pending.find((o) => o.id === id)) || { asset: String(id).split(':')[2] || id };
    showNotice(`${{ APPROVE: 'Approval', REJECT: 'Dismiss', CLOSE_POSITION: 'Close', SAVE_SETUP: 'Save', UNSAVE_SETUP: 'Remove bookmark' }[type] || 'Action'} failed for ${who.asset}: ${describe(error)}`);
  }

  // ---------- Rail: queue cards + market watch list ----------
  function railCard(o, active) {
    const dir = o.direction === 'short' ? 'Short' : 'Long';
    const btn = el('button', { type: 'button', className: `opp-card${active ? ' is-active' : ''}` }, [
      SD.scannerDetail.badge(o.asset),
      el('div', { className: 'opp-card-body' }, [
        el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol(o) }),
        el('span', { className: 'opp-card-meta', textContent: `${dir} — ${o.setupType || 'Setup'}` }),
        el('span', { className: 'opp-card-sub' }, [`${String(o.timeframe || '—').toUpperCase()} `,
          el('span', { className: 'scan-state is-ready', textContent: inFlight.has(o.id) ? 'Sending…' : 'Ready' }),
          ` · ${age(o.stagedAt)} ago`]),
      ]),
      el('span', { className: 'opp-card-chev', textContent: '›' }),
    ]);
    btn.title = `${o.strategyId} · staged ${age(o.stagedAt)} ago`;
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => { activeId = o.id; manualWatch = false; rerender(); };
    return btn;
  }

  // ---------- Filters (one shared state drives the rail toggle and the top tabs) ----------
  let assetFilter = 'all'; // 'all' | 'stocks' | 'crypto' | 'options'
  let search = ''; // lower-cased, for matching
  let searchRaw = ''; // exactly as typed, for the input box
  const RAIL_TOGGLE = [['all', 'All'], ['stocks', 'Stocks'], ['crypto', 'Crypto']];
  const TOP_TABS = [['stocks', 'Stocks'], ['crypto', 'Crypto'], ['options', 'Options']];

  const matchesAsset = (market) => assetFilter === 'all' || market === assetFilter;
  // Options trade on stock underlyings, so the Options filter watches stocks.
  const watchMarketOk = (market) => assetFilter === 'all' || market === (assetFilter === 'options' ? 'stocks' : assetFilter);
  const matchesSearch = (...fields) => !search || fields.some((f) => String(f || '').toLowerCase().includes(search));

  function setFilter(value) {
    assetFilter = value;
    rerender();
  }

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

  function searchBox() {
    const input = el('input', { type: 'search', className: 'opp-search', placeholder: 'Search setups...', value: searchRaw, id: 'opp-search' });
    input.setAttribute('aria-label', 'Search setups and symbols');
    input.addEventListener('input', () => { search = input.value.trim().toLowerCase(); searchRaw = input.value; rerender(); });
    return el('label', { className: 'opp-search-wrap' }, input);
  }

  // Every symbol with a price source: the default, the watchlist, streamed prices, last closes.
  // "Heating up" only (watch-heat.js): near a trigger, queued, held, or on the chart.
  let heat = new Map(); // symbol -> { reason, tag, title } for the rows being drawn
  function watchSymbols(state) {
    const list = SD.watchHeat.heating(state, { selected: watchSymbol, searching: !!search,
      keep: (s) => watchMarketOk(marketOf(s)) && matchesSearch(s, s.replace('-', '/'), SD.scannerData.nameOf(s)) });
    heat = new Map(list.map((x) => [x.symbol, x]));
    watchCaption = SD.watchHeat.caption(state, list);
    return list.map((x) => x.symbol);
  }
  let watchCaption = '';

  function watchButton(symbol, state, active) {
    const p = state.prices && state.prices[symbol];
    const ref = !(p > 0) && state.refPrices && state.refPrices[symbol]; // last close while the feed is quiet
    const shown = p > 0 ? p : ref && ref.price;
    const market = marketOf(symbol);
    const px = el('span', { className: `opp-watch-px${ref ? ' is-stale' : ''}`, textContent: shown > 0 ? price(shown, { market, entryPrice: shown }) : '—' });
    if (ref) px.title = `Last close, ${new Date(ref.time).toLocaleString()} (no live price: market closed or feed quiet)`;
    const h = heat.get(symbol);
    const btn = el('button', { type: 'button', className: `opp-watch${active ? ' is-active' : ''}`, title: h && h.title ? h.title : '' }, [
      el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol({ asset: symbol, market }) }),
      ...(h && h.tag ? [el('span', { className: `opp-heat is-${h.reason}`, textContent: h.tag })] : []),
      px,
    ]);
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => { watchSymbol = symbol; activeId = null; manualWatch = true; rerender(); };
    return btn;
  }

  // ---------- Setups workspace (3 columns, always) ----------
  function setups(state) {
    const real = [...state.pending].sort((a, b) => b.stagedAt - a.stagedAt);
    for (const id of inFlight) if (!real.some((o) => o.id === id) && !(state.positions || []).some((p) => p.id === id)) inFlight.delete(id);
    const visible = real.filter((o) => matchesAsset(o.market)
      && matchesSearch(o.asset, SD.oppDetail.displaySymbol(o), o.setupType, o.strategyId, o.timeframe, o.thesis));
    const watchable = watchSymbols(state);

    // Selection follows the filters: never keep something the filters hide.
    if (!visible.some((o) => o.id === activeId)) activeId = !manualWatch && visible.length ? visible[0].id : null;
    if (!activeId && !watchable.includes(watchSymbol) && watchable.length) watchSymbol = watchable[0];
    const active = visible.find((o) => o.id === activeId) || marketWatch(watchSymbol);

    const filtered = assetFilter !== 'all' || search;
    const emptyText = real.length
      ? 'No setups match these filters.'
      : 'No setups pending. Watching the market until a strategy proposes one.';
    const rail = el('aside', { className: 'opp-rail' }, [
      searchBox(),
      segmented(RAIL_TOGGLE, assetFilter === 'options' ? null : assetFilter, 'opp-segmented', setFilter),
      el('div', { className: 'opp-rail-head' }, [el('h3', { className: 'opp-section', textContent: 'Queue' }),
        el('span', { className: 'count', textContent: filtered ? `${visible.length} / ${real.length}` : String(real.length) })]),
      el('div', { className: 'opp-queue' }, visible.length ? visible.map((o) => railCard(o, o.id === activeId))
        : [el('p', { className: 'opp-muted', textContent: emptyText })]),
      el('h3', { className: 'opp-section opp-watch-head', textContent: 'Market watch · heating up' }),
      el('p', { className: 'opp-heat-caption', textContent: search ? 'Searching all monitored symbols' : watchCaption }),
      el('div', { className: 'opp-watchlist' }, watchable.length
        ? watchable.map((s) => watchButton(s, state, active.isWatch && s === watchSymbol))
        : [el('p', { className: 'opp-muted', textContent: 'No symbols match.' })]),
    ]);
    const ctx = {
      livePrice: state.prices ? state.prices[active.asset] : null,
      refPrice: state.refPrices ? state.refPrices[active.asset] : null,
      settings: state.settings,
      state, // venue bankrolls for the risk panel (synced holdings, broker state)
      online: transport.isOnline(),
      busy: !active.isWatch && inFlight.has(active.id),
      onApprove,
      onDismiss,
      onClosePosition,
      closing: inFlight,
      isSaved,
      onToggleSave,
      onPickSymbol,
      onPickerClosed: rerender, // catch up on updates held while the picker was open
    };
    const analysis = SD.setupAnalysis.analysis(active, { state, livePrice: ctx.livePrice, refPrice: ctx.refPrice, rerender });
    return el('div', { className: 'opp-grid' }, [rail, SD.oppDetail.center(active, ctx), SD.oppDetail.right(active, ctx), analysis]);
  }

  // Scanner / Saved: Review and Watch jump back into the Setups workspace; bookmarks toggle.
  const nav = {
    onReview: (id) => { activeId = id; manualWatch = false; subTab = 'setups'; rerender(); },
    onWatch: (symbol) => { watchSymbol = symbol; activeId = null; manualWatch = true; subTab = 'setups'; rerender(); },
    send: (msg) => { if (transport.isOnline()) transport.send(msg); },
    rerender: () => rerender(),
  };
  const isSaved = (id) => ((mounted && mounted.state.saved) || []).some((s) => s.id === id);
  const onToggleSave = (o) => nav.send({ type: isSaved(o.id) ? 'UNSAVE_SETUP' : 'SAVE_SETUP', id: o.id });
  // Chart symbol picker: a queued setup for it opens as a setup, else Market Watch.
  // Filters/search that would hide the pick are cleared, so it can't bounce back.
  function onPickSymbol(symbol) {
    if (!watchMarketOk(marketOf(symbol)) || !matchesSearch(symbol, symbol.replace('-', '/'))) { assetFilter = 'all'; search = ''; searchRaw = ''; }
    const queued = mounted && mounted.state.pending.find((o) => o.asset === symbol && matchesAsset(o.market));
    if (queued) { activeId = queued.id; manualWatch = false; } else { watchSymbol = symbol; activeId = null; manualWatch = true; }
    rerender();
  }

  function scanner(state) {
    const host = el('div', { className: 'opp-scanner' });
    SD.oppScanner.renderScanner(host, state, { ...nav, market: assetFilter, onMarket: setFilter, matchesAsset, online: transport.isOnline(),
      onRunScan: () => nav.send({ type: 'RUN_SCAN' }), isSaved, onToggleSave });
    return host;
  }

  function render(container, state) {
    mounted = { container, state };
    // Briefly hold re-renders while the chart's symbol picker is in use (symbol-picker.js).
    if (SD.symbolPicker.holding(container, rerender)) return;
    // Re-renders replace the DOM (every keystroke, every price tick): keep the
    // search box focused with the caret where it was.
    const focused = document.activeElement && document.activeElement.id === 'opp-search';
    const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const SCROLLERS = ['.opp-queue', '.opp-watchlist']; // scrollable lists keep their position too
    const scrolls = SCROLLERS.map((sel) => { const n = container.querySelector(sel); return n ? n.scrollTop : 0; });

    const tabs = el('div', { className: 'opp-subnav' }, ['setups', 'scanner', 'saved'].map((t) => {
      const b = el('button', { type: 'button', className: `opp-subtab${t === subTab ? ' is-active' : ''}`, textContent: t[0].toUpperCase() + t.slice(1) });
      b.setAttribute('aria-pressed', String(t === subTab));
      b.onclick = () => { subTab = t; rerender(); };
      return b;
    }));
    const scanBtn = el('button', { type: 'button', className: 'btn opp-scan-btn', textContent: 'Scan markets' });
    scanBtn.onclick = () => { subTab = 'scanner'; rerender(); };
    // Top-right asset tabs: clicking the active tab again clears the filter.
    const assetTabs = segmented(TOP_TABS, assetFilter, 'opp-asset-tabs', (v) => setFilter(v === assetFilter ? 'all' : v));
    container.replaceChildren(
      // The Scanner has its own Market filter; Setups gets "Scan markets" + the asset tabs.
      el('div', { className: 'opp-toolbar' }, subTab === 'scanner' ? [tabs] : [tabs, el('div', { className: 'opp-toolbar-right' }, [scanBtn, assetTabs])]),
      ...(notice ? [el('div', { className: 'notice opp-notice', textContent: notice })] : []),
      subTab === 'setups' ? setups(state) : subTab === 'scanner' ? scanner(state) : SD.oppSaved.render(state, { ...nav, online: transport.isOnline() }),
    );

    const input = container.querySelector('#opp-search');
    if (input && focused) {
      input.focus();
      input.setSelectionRange(caret[0], caret[1]);
    }
    SCROLLERS.forEach((sel, i) => { const n = container.querySelector(sel); if (n) n.scrollTop = scrolls[i]; });
  }

  // Keep "staged N ago" fresh while the tab is on screen.
  setInterval(() => { if (mounted && mounted.container.offsetParent) rerender(); }, 30000);

  SD.opportunities = {
    init: (t) => { transport = t; },
    render,
    actionFailed,
    select: (id) => { activeId = id; manualWatch = false; subTab = 'setups'; },
  };
})();
