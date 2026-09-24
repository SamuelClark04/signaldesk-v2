// Opportunities tab: sub-navigation (Setups / Approvals / Scanner / Saved) and the Setups
// workspace: rail (left, opportunities-rail.js: active positions, queue, market
// watch), analysis (center), risk & execution (right).
// With no setup selected it shows Market Watch: live prices, nothing executable.
// The server is the source of truth: buttons send APPROVE / REJECT intents (the
// same messages the order guard, live routing and ORDER_BUSY lock protect), and
// a setup leaves the rail only when the server's QUEUE_UPDATED removes it.
// Exposes window.SignalDesk.opportunities.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let subTab = 'setups';
  let activeId = null;
  const inFlight = new Set(); // ids with an APPROVE/REJECT awaiting the server
  const closing = new Set(); // position ids with a CLOSE_POSITION awaiting the server (same id as the order)
  let notice = null;
  let noticeTimer = null;
  let mounted = null; // { container, state } of the last render, for local re-renders

  // Order-guard and broker reasons from the server, in plain words.
  const FAIL_REASONS = {
    EXPIRED: 'setup is older than 30 minutes and was discarded',
    PRICE_ESCAPED: 'price moved past the entry zone and the setup was discarded',
    INVALIDATED: 'price is already through the stop and the setup was discarded',
    NO_LIVE_PRICE: 'no fresh price available; still pending, try again shortly',
    LIVE_OPTIONS_UNSUPPORTED: 'live options orders are not wired to Alpaca yet (the contract and prices are real; the order routing is not). Nothing was sent; '
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
    if (!transport.isOnline() || closing.has(p.id)) return;
    const est = m.gross === null ? 'Options are booked at the contract’s real bid when a fresh quote exists, otherwise at its modelled bid.'
      : `Estimated P/L: ${m.gross >= 0 ? '+' : '−'}$${Math.abs(m.gross).toFixed(2)} gross${m.net === null ? '' : `, ${m.net >= 0 ? '+' : '−'}$${Math.abs(m.net).toFixed(2)} after fees`}.`;
    if (!window.confirm(`Manual exit: close ${p.direction.toUpperCase()} ${p.asset} (paper) now at the live price ${price(m.price, p)}?\n\n${est}\n\nThis overrides the stop and targets.`)) return;
    closing.add(p.id);
    transport.send({ type: 'CLOSE_POSITION', id: p.id });
    rerender();
  }

  function actionFailed({ type, id, error }) {
    inFlight.delete(id);
    closing.delete(id);
    const who = (mounted && mounted.state.pending.find((o) => o.id === id)) || { asset: String(id).split(':')[2] || id };
    const label = { APPROVE: 'Approval', REJECT: 'Dismiss', CLOSE_POSITION: 'Close', SAVE_SETUP: 'Save', UNSAVE_SETUP: 'Remove bookmark', APPROVE_ACTION: 'Pilot action', DISMISS_ACTION: 'Dismiss' }[type];
    showNotice(`${label || 'Action'} failed for ${who.asset}: ${describe(error)}`);
  }

  // ---------- Filters (one shared state drives the rail toggle and the top tabs) ----------
  let assetFilter = 'all'; // 'all' | 'stocks' | 'crypto' | 'options'
  let search = ''; // lower-cased, for matching
  let searchRaw = ''; // exactly as typed, for the input box
  const TOP_TABS = [['stocks', 'Stocks'], ['crypto', 'Crypto'], ['options', 'Options']];

  const matchesAsset = (market) => assetFilter === 'all' || market === assetFilter;
  // Options trade on stock underlyings, so the Options filter watches stocks.
  const watchMarketOk = (market) => assetFilter === 'all' || market === (assetFilter === 'options' ? 'stocks' : assetFilter);
  const matchesSearch = (...fields) => !search || fields.some((f) => String(f || '').toLowerCase().includes(search));

  function setFilter(value) {
    assetFilter = value;
    rerender();
  }

  // Rail clicks (opportunities-rail.js): a queued setup, a watch symbol, or an open
  // position (charted as Market Watch, where the Active Trade HUD shows it).
  const onSelectSetup = (id) => { activeId = id; manualWatch = false; rerender(); };
  const onWatch = (symbol) => { watchSymbol = symbol; activeId = null; manualWatch = true; rerender(); };
  function onOpenPosition(p) {
    if (!matchesAsset(p.market) || !watchMarketOk(marketOf(p.asset)) || !matchesSearch(p.asset, p.asset.replace('-', '/'))) { assetFilter = 'all'; search = ''; searchRaw = ''; }
    onWatch(p.asset);
  }
  function onSearch(value) { search = value.trim().toLowerCase(); searchRaw = value; rerender(); }

  // ---------- Setups workspace (3 columns, always) ----------
  function setups(state) {
    const real = [...state.pending].sort((a, b) => b.stagedAt - a.stagedAt);
    for (const id of inFlight) if (!real.some((o) => o.id === id) && !(state.pilotActions || []).some((a) => a.id === id)) inFlight.delete(id); // resolved
    for (const id of closing) if (!(state.positions || []).some((p) => p.id === id)) closing.delete(id); // closed
    const visible = real.filter((o) => matchesAsset(o.market)
      && matchesSearch(o.asset, SD.oppDetail.displaySymbol(o), o.setupType, o.strategyId, o.timeframe, o.thesis));
    const watch = SD.oppRail.watchList(state, { selected: watchSymbol, searching: !!search,
      keep: (sym) => watchMarketOk(marketOf(sym)) && matchesSearch(sym, sym.replace('-', '/'), SD.scannerData.nameOf(sym)) });
    const watchable = watch.symbols;

    // An executed setup becomes a position: keep its chart (and HUD) on screen.
    const executed = activeId && (state.positions || []).find((p) => p.id === activeId);
    if (executed) { watchSymbol = executed.asset; activeId = null; manualWatch = true; }
    // Selection follows the filters: never keep something the filters hide.
    if (!visible.some((o) => o.id === activeId)) activeId = !manualWatch && visible.length ? visible[0].id : null;
    if (!activeId && !watchable.includes(watchSymbol) && watchable.length) watchSymbol = watchable[0];
    const active = visible.find((o) => o.id === activeId) || marketWatch(watchSymbol);

    const rail = SD.oppRail.rail(state, { assetFilter, searchRaw, searching: !!search, filtered: assetFilter !== 'all' || !!search,
      real, visible, activeId, watch, watchSymbol, isWatch: !!active.isWatch, inFlight, matchesAsset,
      onSearch, onFilter: setFilter, onSelectSetup, onWatch, onOpenPosition, onScannerLog: () => { subTab = 'scanner'; rerender(); } });
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
      closing,
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

  // Approvals: one-click approve for every staged setup and Pilot SELL / TRIM.
  function approvals(state) {
    for (const id of inFlight) if (!state.pending.some((o) => o.id === id) && !(state.pilotActions || []).some((a) => a.id === id)) inFlight.delete(id);
    return SD.oppApprovals.render(state, { state, online: transport.isOnline(), inFlight, onApprove, onDismiss, matchesAsset,
      onReview: nav.onReview,
      sendAction: (type, id) => { if (!transport.isOnline() || inFlight.has(id)) return; inFlight.add(id); transport.send({ type, id }); rerender(); } });
  }

  function render(container, state) {
    mounted = { container, state };
    // Briefly hold re-renders while the chart's symbol picker is in use (symbol-picker.js).
    if (SD.symbolPicker.holding(container, rerender)) return;
    // Re-renders replace the DOM (every keystroke, every price tick): keep the
    // search box focused with the caret where it was.
    const focused = document.activeElement && document.activeElement.id === 'opp-search';
    const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const SCROLLERS = ['.opp-positions', '.opp-queue', '.opp-watchlist']; // scrollable lists keep their position too
    const scrolls = SCROLLERS.map((sel) => { const n = container.querySelector(sel); return n ? n.scrollTop : 0; });

    const waiting = SD.oppApprovals.count(state);
    const tabs = el('div', { className: 'opp-subnav' }, ['setups', 'approvals', 'scanner', 'saved'].map((t) => {
      const b = el('button', { type: 'button', className: `opp-subtab${t === subTab ? ' is-active' : ''}`, textContent: t[0].toUpperCase() + t.slice(1) });
      if (t === 'approvals' && waiting) b.append(el('span', { className: 'opp-subtab-count', textContent: String(waiting) }));
      b.setAttribute('aria-pressed', String(t === subTab));
      b.onclick = () => { subTab = t; rerender(); };
      return b;
    }));
    const scanBtn = el('button', { type: 'button', className: 'btn opp-scan-btn', textContent: 'Scan markets' });
    scanBtn.onclick = () => { subTab = 'scanner'; rerender(); };
    // Top-right asset tabs: clicking the active tab again clears the filter.
    const assetTabs = SD.oppRail.segmented(TOP_TABS, assetFilter, 'opp-asset-tabs', (v) => setFilter(v === assetFilter ? 'all' : v));
    container.replaceChildren(
      // The Scanner has its own Market filter; Setups gets "Scan markets" + the asset tabs.
      el('div', { className: 'opp-toolbar' }, subTab === 'scanner' ? [tabs] : [tabs, el('div', { className: 'opp-toolbar-right' }, [scanBtn, assetTabs])]),
      ...(notice ? [el('div', { className: 'notice opp-notice', textContent: notice })] : []),
      subTab === 'setups' ? setups(state) : subTab === 'approvals' ? approvals(state) : subTab === 'scanner' ? scanner(state)
        : SD.oppSaved.render(state, { ...nav, online: transport.isOnline() }),
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
    openApprovals: () => { subTab = 'approvals'; },
  };
})();
