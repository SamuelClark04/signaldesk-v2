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
  const { el, price, money } = SD.ui;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let subTab = 'setups';
  let activeId = null;
  const inFlight = new Set(); // ids with an APPROVE/REJECT awaiting the server
  const closing = new Set(); // position ids with a CLOSE_POSITION awaiting the server (same id as the order)
  let notice = null;
  let noticeTimer = null;
  let mounted = null; // { container, state } of the last render, for local re-renders

  const describe = (error) => SD.oppApprovals.describeFailure(error); // order-guard / broker reasons in plain words
  const M = () => SD.oppMobile; // iPhone: segmented panes + sticky Approve bar (opportunities-mobile.js)

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
  function send(type, id, extra = {}) {
    // Only an id that is in the REAL queue can ever be sent (defence in depth).
    if (!mounted || !mounted.state.pending.some((o) => o.id === id)) return;
    if (!transport.isOnline() || inFlight.has(id)) return;
    inFlight.add(id);
    transport.send({ type, id, ...extra });
    rerender();
  }

  // Approve at the setup's Trade Amount ($) (trade-amount.js): the amount goes to
  // the server, which re-sizes the order; above the risk engine's size it must be
  // confirmed here first (and the server refuses it unconfirmed).
  function onApprove(staged, { live, broker }) {
    const t = SD.tradeAmount.resolve(staged, live);
    if (t.state === 'blocked') return showNotice(`Not sent: ${t.note}`);
    const o = t.order;
    const pct = (x) => `${((x / o.sizingBankroll) * 100).toFixed(2)}% of the bankroll`;
    if (t.state === 'above' && !window.confirm(`Trade ${money(o.notional)} of ${o.asset}? That is above the risk engine's max safe size (${money(staged.notional)}).\n\n`
      + `Loss at the stop: ${money(o.dollarRisk)} (${pct(o.dollarRisk)}) instead of ${money(staged.dollarRisk)} (${pct(staged.dollarRisk)}).`)) return undefined;
    if (live && !window.confirm(`Place a LIVE order at ${broker}?\n\n${o.direction.toUpperCase()} ${o.positionSize} ${o.asset} (${money(o.notional)})\n`
      + `Stop ${o.invalidation} · Target ${o.targets && o.targets[0] ? o.targets[0].price : '—'}\n\nThis uses real money.`)) return undefined;
    return send('APPROVE', o.id, t.amount === null ? {} : { amount: t.amount, confirmed: t.state === 'above' });
  }
  const onDismiss = (o) => send('REJECT', o.id);

  // HUD manual exit (paper only; the server refuses LIVE). Same confirm as Portfolio.
  // WYSIWYG (Phase 59): the confirm shows the server's exit quote and the close sends its
  // `at`, so the Journal books exactly that net (re-quoted only if it is over 45 s old).
  function onClosePosition(p, m) {
    if (!transport.isOnline() || closing.has(p.id)) return;
    const q = p.exitQuote;
    const est = q ? `Books ${q.net >= 0 ? '+' : '−'}$${Math.abs(q.net).toFixed(2)} net (mid P&L ${q.midGross >= 0 ? '+' : '−'}$${Math.abs(q.midGross).toFixed(2)}, exit spread and fees included).`
      : `Mark: ${m.gross === null || m.gross === undefined ? '—' : `${m.gross >= 0 ? '+' : '−'}$${Math.abs(m.gross).toFixed(2)} gross`}.`;
    if (!window.confirm(`Manual exit: close ${p.direction.toUpperCase()} ${p.asset} (paper) now at the live price ${price(m.price, p)}?\n\n${est}\n\nThis overrides the stop and targets.`)) return;
    closing.add(p.id);
    transport.send({ type: 'CLOSE_POSITION', id: p.id, quoteAt: q ? q.at : null });
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
  // 'moonshots' (Phase 55): Setups and Scanner show the Moonshot Radar (moonshots-panel.js).
  let assetFilter = 'all'; // 'all' | 'stocks' | 'crypto' | 'options' | 'moonshots'
  let search = ''; // lower-cased, for matching
  let searchRaw = ''; // exactly as typed, for the input box
  const TOP_TABS = [['stocks', 'Stocks'], ['crypto', 'Crypto'], ['options', 'Options'], ['moonshots', 'Moonshots']];

  const matchesAsset = (market) => assetFilter === 'all' || market === assetFilter || (assetFilter === 'moonshots' && market === 'crypto');
  // Options trade on stock underlyings, so the Options filter watches stocks; Moonshots watch coins.
  const watchMarketOk = (market) => assetFilter === 'all' || market === ({ options: 'stocks', moonshots: 'crypto' }[assetFilter] || assetFilter);
  const matchesSearch = (...fields) => !search || fields.some((f) => String(f || '').toLowerCase().includes(search));

  function setFilter(value) {
    assetFilter = value;
    rerender();
  }

  // ---------- Chart rotation (command center) ----------
  // Every ROTATE_MS the chart moves to the next queued setup / Market Watch symbol
  // (the rail's current list, in its order). Pause / Play in the toolbar (kept per
  // browser). It never switches while the pointer is over the rail or the risk &
  // execution panel, while an action is in flight, or while the symbol picker is
  // open; any click in the workspace restarts the countdown.
  const ROTATE_MS = 12000;
  let rotation = []; // [{ id } | { symbol }] from the last Setups render
  const rotator = SD.autoCycle({
    periodMs: ROTATE_MS, key: 'signaldesk.chartRotation',
    canRun: () => !!(mounted && mounted.container.offsetParent && subTab === 'setups' && assetFilter !== 'moonshots' && !M().isMobile() && rotation.length > 1 && !inFlight.size
      && !document.querySelector('.opp-rail:hover, .opp-right:hover, .trade-hud:hover') && !(document.activeElement && document.activeElement.id === 'opp-symbol-select')
      && !(document.activeElement && document.activeElement.classList.contains('ta-input'))), // typing a Trade Amount
    advance: () => {
      const i = rotation.findIndex((r) => (r.id ? r.id === activeId : !activeId && r.symbol === watchSymbol));
      const next = rotation[(i + 1) % rotation.length];
      if (next.id) { activeId = next.id; manualWatch = false; } else { watchSymbol = next.symbol; activeId = null; manualWatch = true; }
      rerender();
    },
  });
  function rotationButton() {
    const on = rotator.playing();
    const b = el('button', { type: 'button', className: `btn opp-rotate${on ? ' is-on' : ''}`, textContent: on ? '⏸ Pause rotation' : '▶ Play rotation',
      title: on ? `Auto-rotating the chart every ${ROTATE_MS / 1000}s through the queue and Market Watch` : 'Chart rotation paused' });
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => { rotator.setPlaying(!on); rerender(); };
    return b;
  }

  // Rail clicks (opportunities-rail.js): a queued setup, a watch symbol, or an open
  // position (charted as Market Watch, where the Active Trade HUD shows it).
  // On an iPhone a tap also jumps to the pane that shows it: a setup's Order & Risk, a symbol's Chart.
  const onSelectSetup = (id) => { activeId = id; manualWatch = false; M().setPane('order'); rerender(); };
  const onWatch = (symbol) => { watchSymbol = symbol; activeId = null; manualWatch = true; M().setPane('chart'); rerender(); };
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
    rotation = [...visible.map((o) => ({ id: o.id })), ...watchable.filter((s) => !visible.some((o) => o.asset === s)).map((symbol) => ({ symbol }))];

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
      rerender, // Trade Amount changes
    };
    const analysis = SD.setupAnalysis.analysis(active, { state, livePrice: ctx.livePrice, refPrice: ctx.refPrice, rerender });
    const grid = el('div', { className: 'opp-grid m-panes', dataset: { pane: M().pane() } }, [M().tag(rail, 'queue'), M().tag(SD.oppDetail.center(active, ctx), 'chart'),
      M().tag(SD.oppDetail.right(active, ctx), 'order'), M().tag(analysis, 'chart')]);
    return M().wrap(grid, { rerender, bar: SD.oppDetail.actionBar(active, ctx) });
  }

  // Scanner / Saved: Review and Watch jump back into the Setups workspace; bookmarks toggle.
  const nav = {
    onReview: (id) => { activeId = id; manualWatch = false; subTab = 'setups'; if (assetFilter === 'moonshots') assetFilter = 'crypto'; M().setPane('order'); rerender(); },
    onWatch: (symbol) => { watchSymbol = symbol; activeId = null; manualWatch = true; subTab = 'setups'; if (assetFilter === 'moonshots') assetFilter = 'crypto'; M().setPane('chart'); rerender(); },
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
      onReview: nav.onReview, onWatch: nav.onWatch, rerender,
      sendAction: (type, id) => { if (!transport.isOnline() || inFlight.has(id)) return; inFlight.add(id); transport.send({ type, id }); rerender(); } });
  }

  function render(container, state) {
    if (!container.dataset.rotationHooked) { // a click in the workspace restarts the rotation countdown
      container.dataset.rotationHooked = '1';
      container.addEventListener('pointerdown', () => rotator.reset());
      container.addEventListener('input', () => rotator.reset());
    }
    mounted = { container, state };
    SD.tradeAmount.prune(state.pending);
    // Briefly hold re-renders while the chart's symbol picker is in use (symbol-picker.js).
    if (SD.symbolPicker.holding(container, rerender)) return;
    // Re-renders replace the DOM (every keystroke, every price tick): keep the
    // search box or a Trade Amount input focused with the caret where it was.
    const act = document.activeElement;
    const focusSel = act && act.id === 'opp-search' ? '#opp-search'
      : act && act.dataset && act.dataset.focusKey && container.contains(act) ? `[data-focus-key="${CSS.escape(act.dataset.focusKey)}"]` : null;
    const caret = focusSel ? [act.selectionStart, act.selectionEnd] : null;
    const pageY = window.scrollY;
    const SCROLLERS = ['.opp-positions', '.opp-queue', '.opp-watchlist', '.cfeed-list']; // scrollable lists keep their position too (+ the Catalyst Feed)
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
    // [Moonshots] on Setups or Scanner: the live Moonshot Radar replaces the workspace.
    const moon = assetFilter === 'moonshots' && (subTab === 'setups' || subTab === 'scanner');
    const moonCtx = { state, online: transport.isOnline(), inFlight, onApprove, onDismiss, rerender, onReview: nav.onReview, onRunScan: () => nav.send({ type: 'RUN_SCAN' }) };
    container.replaceChildren(
      // The Scanner has its own Market filter; Setups (and the radar) get "Scan markets" + the asset tabs.
      el('div', { className: 'opp-toolbar' }, subTab === 'scanner' && !moon ? [tabs]
        : [tabs, el('div', { className: 'opp-toolbar-right' }, [...(subTab === 'setups' && !moon ? [rotationButton()] : []), scanBtn, assetTabs])]),
      ...(notice ? [el('div', { className: 'notice opp-notice', textContent: notice })] : []),
      moon ? SD.moonshots.render(state, moonCtx) : subTab === 'setups' ? setups(state) : subTab === 'approvals' ? approvals(state) : subTab === 'scanner' ? scanner(state)
        : SD.oppSaved.render(state, { ...nav, online: transport.isOnline() }),
    );

    const input = focusSel && container.querySelector(focusSel);
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(caret[0], caret[1]);
      window.scrollTo(window.scrollX, pageY);
    }
    SCROLLERS.forEach((sel, i) => { const n = container.querySelector(sel); if (n && !n.dataset.fresh) n.scrollTop = scrolls[i]; });
  }

  // Keep "staged N ago" fresh while the tab is on screen.
  setInterval(() => { if (mounted && mounted.container.offsetParent) rerender(); }, 30000);

  SD.opportunities = {
    init: (t) => { transport = t; },
    render,
    actionFailed,
    select: (id) => { activeId = id; manualWatch = false; subTab = 'setups'; M().setPane('order'); },
    openApprovals: () => { subTab = 'approvals'; },
    openSetups: () => { subTab = 'setups'; }, // the iPhone tab bar's "Setups"
    subTab: () => subTab,
  };
})();
