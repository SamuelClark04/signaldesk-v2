// SignalDesk client shell: tab routing and the server WebSocket. Views live in
// client/views/*; shared helpers in client/lib/ui.js. All decisions stay on the server.
(() => {
  const SD = window.SignalDesk;
  const { $ } = SD.ui;
  const DEFAULT_HOST = '127.0.0.1:3000'; // used when the page is opened from disk
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host || DEFAULT_HOST}/ws`;
  const TABS = ['today', 'opportunities', 'portfolio', 'journal', 'settings'];
  const DEFAULT_TAB = 'opportunities';

  let socket = null;

  // ---------- Tab navigation (hash-based, so reload keeps the tab) ----------
  function showTab(name) {
    const tab = TABS.includes(name) ? name : DEFAULT_TAB;
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
  SD.queue.init(transport);
  SD.portfolio.init(transport);
  SD.settings.init(transport);

  const HANDLERS = {
    'orders:snapshot': (orders) => SD.queue.receive(orders, { replace: true }),
    'order:staged': (order) => SD.queue.receive(order),
    QUEUE_UPDATED: (orders) => SD.queue.receive(orders, { replace: true }),
    POSITIONS_UPDATED: (positions) => SD.portfolio.render(positions || []),
    JOURNAL_UPDATED: (trades) => SD.journal.render(trades || []),
    ACTION_FAILED: (payload) => SD.queue.actionFailed(payload),
    ALLOCATION_PROPOSAL: (proposal) => SD.portfolio.renderAllocation(proposal),
    SETTINGS_UPDATED: (settings) => SD.settings.render(settings),
    SETTINGS_ERROR: (payload) => SD.settings.error(payload),
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
    ws.addEventListener('open', () => { backoff = 1000; setConn('open', 'Live'); SD.queue.render(); });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const handler = HANDLERS[msg.type];
      if (handler) handler(msg.payload);
    });
    ws.addEventListener('close', () => {
      setConn('closed', `Offline · retry ${backoff / 1000}s`);
      SD.queue.render(); // disables the action buttons while offline
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  }

  showTab(location.hash.slice(1));
  SD.queue.render();
  SD.portfolio.render([]);
  SD.journal.render([]);
  connect();
})();
