// SignalDesk client shell: tab routing and the server WebSocket. Views live in
// client/views/*; shared helpers in client/lib/ui.js. All decisions stay on the server.
(() => {
  const SD = window.SignalDesk;
  const { $ } = SD.ui;
  const DEFAULT_HOST = '127.0.0.1:3000'; // used when the page is opened from disk

  // LAN access token (phone on Wi-Fi): arrives once as ?token=..., is kept on this
  // device, and is removed from the address bar so it isn't left on screen.
  const TOKEN_KEY = 'signaldesk.accessToken';
  const accessToken = (() => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* storage blocked: use for this session */ }
      params.delete('token');
      const query = params.toString();
      history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
      return fromUrl;
    }
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  })();
  const isLocalPage = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host || DEFAULT_HOST}/ws`
    + (accessToken ? `?token=${encodeURIComponent(accessToken)}` : '');
  // Read-only HTTP API (chart history). LAN devices send the token as a header.
  const API_BASE = location.protocol === 'file:' ? `http://${DEFAULT_HOST}` : '';
  SD.api = {
    async getJson(path) {
      const res = await fetch(`${API_BASE}${path}`, { headers: accessToken ? { 'X-SignalDesk-Token': accessToken } : {} });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body;
    },
  };
  const TABS = ['today', 'opportunities', 'portfolio', 'journal', 'settings'];
  const DEFAULT_TAB = 'opportunities';

  let socket = null;
  let currentTab = null;

  // ---------- Shared client state (server snapshots; read by Today and Opportunities) ----------
  const state = { settings: null, broker: null, positions: [], journal: [], pending: [], rejections: null, watchlist: null, intelligence: null, prices: null, refPrices: null };
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
  };

  // State-driven views: rendered on entering their tab and on every state change
  // (or connection change) while visible.
  function refreshView() {
    if (currentTab === 'today') SD.today.renderToday($('today-root'), state);
    if (currentTab === 'opportunities') SD.opportunities.render($('opportunities-root'), state);
  }

  // ---------- Tab navigation (hash-based, so reload keeps the tab) ----------
  function showTab(name) {
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
  SD.portfolio.init(transport);
  SD.settings.init(transport);

  const HANDLERS = {
    POSITIONS_UPDATED: (positions) => SD.portfolio.render(positions || []),
    JOURNAL_UPDATED: (trades) => SD.journal.render(trades || []),
    ACTION_FAILED: (payload) => SD.opportunities.actionFailed(payload),
    ALLOCATION_PROPOSAL: (proposal) => SD.portfolio.renderAllocation(proposal),
    SETTINGS_UPDATED: (settings) => SD.settings.render(settings),
    SETTINGS_ERROR: (payload) => SD.settings.error(payload),
    BROKER_STATE: (state) => SD.portfolio.renderBrokerState(state),
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
      // A LAN page without a token will always be refused: say why instead of "Offline".
      setConn('closed', !isLocalPage && !accessToken
        ? 'No access token: open the link printed by the server'
        : `Offline · retry ${backoff / 1000}s`);
      refreshView(); // disables the action buttons while offline
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  }

  showTab(location.hash.slice(1));
  SD.portfolio.render([]);
  SD.journal.render([]);
  connect();
})();
