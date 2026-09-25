// SignalDesk client shell: tab routing and the server WebSocket. Views live in
// client/views/*; shared helpers in client/lib/ui.js. All decisions stay on the server.
(() => {
  const SD = window.SignalDesk;
  const { $ } = SD.ui;
  const DEFAULT_HOST = '127.0.0.1:3000'; // used when the page is opened from disk

  // Zero-trust sign-in: the server's /login sets an HttpOnly session cookie that
  // the page, the API and the WebSocket all carry automatically. The token is
  // never kept in page storage (older builds stored it: removed here).
  try { localStorage.removeItem('signaldesk.accessToken'); } catch { /* storage blocked */ }
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host || DEFAULT_HOST}/ws`;
  const API_BASE = location.protocol === 'file:' ? `http://${DEFAULT_HOST}` : '';
  const toLogin = () => { if (location.protocol !== 'file:') location.href = '/login'; };
  SD.api = {
    async getJson(path) {
      const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
      if (res.status === 401) { toLogin(); throw new Error('sign in required'); }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body;
    },
  };
  const TABS = ['today', 'opportunities', 'portfolio', 'journal', 'settings'];
  const DEFAULT_TAB = 'opportunities';

  let socket = null;
  const VENUE_KEY = 'signaldesk.venue';
  let currentTab = null;

  // ---------- Shared client state (server snapshots; read by Today and Opportunities) ----------
  const state = { settings: null, broker: null, positions: [], journal: [], pending: [], rejections: null, watchlist: null, intelligence: null, prices: null, refPrices: null, scan: null, scanLog: [], pilotActions: [], macro: [], holdings: null, universe: null, proximity: null, saved: [],
    // Venue filter shared by Today and Portfolio (lib/venue.js); remembered per device.
    activeVenue: (() => { try { return localStorage.getItem(VENUE_KEY) || 'paper'; } catch { return 'paper'; } })() };
  const upsert = (list, item) => [...list.filter((o) => o.id !== item.id), item];
  const STATE_UPDATES = {
    'orders:snapshot': (orders) => { state.pending = orders || []; },
    'order:staged': (order) => { if (order && order.id) state.pending = upsert(state.pending, order); },
    QUEUE_UPDATED: (orders) => { state.pending = orders || []; },
    POSITIONS_UPDATED: (positions) => { state.positions = positions || []; },
    JOURNAL_UPDATED: (trades) => { state.journal = trades || []; },
    SETTINGS_UPDATED: (settings) => { state.settings = settings; },
    BROKER_STATE: (broker) => { state.broker = broker; },
    REJECTION_STATS: (stats) => { state.rejections = stats; },
    WATCHLIST_UPDATED: (items) => { state.watchlist = items || []; },
    DASHBOARD_INTELLIGENCE: (intel) => { state.intelligence = intel; },
    PRICES_UPDATED: (prices) => { state.prices = prices || {}; },
    REFERENCE_PRICES: (closes) => { state.refPrices = closes || {}; }, // last closes of quiet stocks (display only)
    SCAN_STATUS: (scan) => { state.scan = scan; }, // pipeline pass timing + fresh price times
    SCAN_LOG: (log) => { state.scanLog = log || []; }, // live scanner log (Scanner tab), once per pass
    PILOT_ACTIONS: (list) => { state.pilotActions = list || []; }, // Portfolio Pilot SELL / TRIM (Approvals)
    PILOT_MATRIX: (m) => { state.pilotMatrix = m; }, // HOLD / ADD / TRIM / SELL + ROTATE per holding
    MACRO_EVENTS: (list) => { state.macro = list || []; }, // FOMC / CPI / FDA calendar (News & Catalysts)
    NEWS_SENTIMENT: (r) => SD.sentiment.received(r), // 0-100 gauge for the charted symbol
    SAVED_SETUPS: (list) => { state.saved = list || []; }, // bookmarks (Opportunities → Saved)
    UNIVERSE: (u) => { state.universe = u; SD.scannerData.setNames(u && u.names); }, // 83 monitored symbols + names
    TRIGGER_PROXIMITY: (p) => { state.proximity = p; }, // heating-up list for Market Watch
    BROKER_HOLDINGS: (h) => { state.holdings = h; SD.venue.received(h); }, // last Sync Broker snapshot (read-only)
    EXTERNAL_HOLDINGS: (x) => { state.external = x; }, // manual (Robinhood / other) + broker-synced holdings with protective levels
    MOONSHOT_RADAR: (r) => { state.moonshotRadar = r; }, // watchlist gems by the 100-point Moonshot score (Opportunities → Moonshots)
    GEM_CATALOG: (c) => { state.gemCatalog = c; SD.scannerData.setGemNames(c && c.names); }, // every tradable Coinbase spot coin (chart / picker)
    OPTIONS_PLANS: (list) => { state.optionsPlans = list || []; }, // after-hours options plans (Approvals; stage at the open)
  };

  // State-driven views: rendered on entering their tab and on every state change
  // (or connection change) while visible.
  function refreshView() {
    if (currentTab === 'today') SD.today.renderToday($('today-root'), state);
    if (currentTab === 'opportunities') SD.opportunities.render($('opportunities-root'), state);
    if (currentTab === 'portfolio') SD.portfolio.render($('portfolio-root'), state);
    SD.mobile.sync(currentTab, state); // iPhone tab bar (active tab, Approvals badge) + status bar
  }

  // ---------- Tab navigation (hash-based, so reload keeps the tab) ----------
  // Accepts "opportunities" or a deep link "opportunities?tab=approvals" (alert emails)
  // / "opportunities?tab=setups" (the iPhone tab bar).
  function showTab(hash) {
    const [name, query] = String(hash || '').split('?');
    const sub = name === 'opportunities' && new URLSearchParams(query || '').get('tab');
    if (sub === 'approvals') SD.opportunities.openApprovals();
    if (sub === 'setups') SD.opportunities.openSetups();
    const tab = TABS.includes(name) ? name : DEFAULT_TAB;
    currentTab = tab;
    refreshView();
    for (const t of TABS) $(`tab-${t}`).hidden = t !== tab;
    document.querySelectorAll('.nav-link').forEach((a) => {
      const active = a.dataset.tab === tab;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('page-title').textContent = $(`tab-${tab}`).dataset.title;
  }
  document.querySelectorAll('.nav-link').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', `#${a.dataset.tab}`);
    showTab(a.dataset.tab);
  }));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1))); // back/forward

  // ---------- WebSocket ----------
  const isOnline = () => !!socket && socket.readyState === WebSocket.OPEN;
  const transport = { isOnline, send: (msg) => socket.send(JSON.stringify(msg)) };
  SD.opportunities.init(transport);
  // Shared actions for lib/venue.js (the Today + Portfolio venue controls).
  SD.app = {
    isOnline,
    send: (msg) => { if (isOnline()) transport.send(msg); },
    refresh: () => refreshView(),
    showTab: (hash) => showTab(hash), // the iPhone tab bar (lib/mobile.js)
    setVenue(v) {
      if (!SD.venue.KEYS.has(v)) return;
      state.activeVenue = v;
      try { localStorage.setItem(VENUE_KEY, v); } catch { /* storage blocked: this session only */ }
      refreshView();
    },
  };
  SD.portfolio.init(transport);
  SD.settings.init(transport);

  const HANDLERS = {
    JOURNAL_UPDATED: (trades) => SD.journal.render(trades || []),
    ACTION_FAILED: (payload) => (payload && ['CLOSE_POSITION', 'ADOPT_POSITION', 'RELEASE_POSITION'].includes(payload.type)
      ? (SD.portfolio.actionFailed(payload), payload.type === 'CLOSE_POSITION' && SD.opportunities.actionFailed(payload))
      : SD.opportunities.actionFailed(payload)),
    POSITIONS_UPDATED: () => SD.portfolio.positionsUpdated(), // closes a pending adoption form
    ADOPTION_SUGGESTIONS: (r) => SD.portfolioAdopt.suggestions(r), // auto-filled stop/target
    ALLOCATION_PROPOSAL: (proposal) => SD.portfolio.renderAllocation(proposal),
    SETTINGS_UPDATED: (settings) => SD.settings.render(settings),
    SETTINGS_ERROR: (payload) => SD.settings.error(payload),
    LEDGER_RESET: (r) => SD.settings.resetDone(r),
    PRICES_UPDATED: (prices) => SD.liveChart.record(prices), // builds candles even while another tab is open
  };

  function setConn(state, label) {
    $('conn').dataset.state = state;
    $('conn-label').textContent = label;
  }

  let backoff = 1000;
  function connect() {
    setConn('connecting', 'Connecting…');
    const ws = new WebSocket(WS_URL);
    socket = ws;
    ws.addEventListener('open', () => { backoff = 1000; setConn('open', 'Live'); refreshView(); });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const handler = HANDLERS[msg.type];
      if (handler) handler(msg.payload);
      const update = STATE_UPDATES[msg.type];
      if (update) { update(msg.payload); refreshView(); }
    });
    ws.addEventListener('close', () => {
      // Refused because the sign-in expired or is missing? Then go sign in.
      fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' }).then((r) => { if (r.status === 401) toLogin(); }).catch(() => {});
      setConn('closed', `Offline · retry ${backoff / 1000}s`);
      refreshView(); // disables the action buttons while offline
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  }

  showTab(location.hash.slice(1));
  SD.journal.render([]);
  connect();
})();
