// SignalDesk client shell: tab navigation, server WebSocket, Approvals Queue.
// Read-only view of ledger state; all decisions stay on the server.
(() => {
  const DEFAULT_HOST = '127.0.0.1:3000'; // used when the page is opened from disk
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host || DEFAULT_HOST}/ws`;
  const TABS = ['today', 'opportunities', 'portfolio', 'journal', 'settings'];
  const DEFAULT_TAB = 'opportunities';

  const $ = (id) => document.getElementById(id);
  const pending = new Map(); // candidate id -> staged order
  const expanded = new Set(); // candidate ids with the detail row open
  const inFlight = new Set(); // candidate ids with an APPROVE/REJECT awaiting the server
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

  // ---------- Formatting ----------
  const decimals = (o) => (o.market === 'crypto' ? (o.entryPrice < 10 ? 4 : 2) : 2);
  const price = (x, o) => (Number.isFinite(x) ? x.toFixed(decimals(o)) : '—');
  const money = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : '—');
  const size = (o) => (o.market === 'stocks' ? String(o.positionSize) : o.positionSize.toFixed(6));

  function age(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  // Build elements with textContent only: headlines and theses are untrusted text.
  function el(tag, { dataset, ...props } = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(node.dataset, dataset);
    for (const c of [].concat(children)) node.append(c);
    return node;
  }
  const td = (text, className = '') => el('td', { textContent: text, className });

  // ---------- Approvals Queue ----------
  // Send an intent only. The row stays until the server's QUEUE_UPDATED removes it.
  function sendAction(type, id) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    inFlight.add(id);
    socket.send(JSON.stringify({ type, id }));
    renderQueue();
  }

  function actionButton(type, label, className, id) {
    const offline = !socket || socket.readyState !== WebSocket.OPEN;
    const btn = el('button', {
      className,
      textContent: label,
      disabled: inFlight.has(id) || offline,
      title: offline ? 'Offline' : '',
    });
    btn.addEventListener('click', () => sendAction(type, id));
    return btn;
  }

  function renderRow(o) {
    const dir = o.direction === 'short' ? 'short' : 'long';
    const catalyst = o.catalyst && o.catalyst.headline
      ? `${o.catalyst.headline} (${o.catalyst.sentimentScore > 0 ? '+' : ''}${o.catalyst.sentimentScore})`
      : (o.catalyst && o.catalyst.type) || '—';

    const row = el('tr', { className: 'row', title: 'Show thesis' }, [
      el('td', {}, [el('span', { className: 'asset', textContent: o.asset }),
        el('span', { className: 'sub', textContent: o.market })]),
      el('td', {}, [o.setupType || '—', el('span', { className: 'sub', textContent: `${o.strategyId} · ${o.timeframe}` })]),
      el('td', {}, el('span', { className: `badge-${dir}`, textContent: dir })),
      td(`${price(o.entryZone.min, o)} – ${price(o.entryZone.max, o)}`, 'num'),
      td(price(o.invalidation, o), `num text-${dir === 'long' ? 'short' : 'long'}`),
      td((o.targets || []).map((t) => price(t.price, o)).join(' / ') || '—', `num text-${dir}`),
      td(size(o), 'num'),
      td(money(o.dollarRisk), 'num'),
      td(`${o.feeDrag.toFixed(2)}R`, 'num'),
      el('td', { className: 'catalyst', textContent: catalyst, title: catalyst }),
      el('td', { className: 'num age', textContent: age(o.stagedAt), dataset: { ts: o.stagedAt } }),
      el('td', {}, el('div', { className: 'actions' }, [
        actionButton('APPROVE', 'Approve', 'btn btn-approve', o.id),
        actionButton('REJECT', 'Reject', 'btn btn-reject', o.id),
      ])),
    ]);
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (expanded.has(o.id)) expanded.delete(o.id); else expanded.add(o.id);
      renderQueue();
    });

    if (!expanded.has(o.id)) return [row];
    const detail = el('tr', { className: 'detail-row' }, el('td', { colSpan: 12 }, el('div', { className: 'detail' }, [
      el('p', { textContent: o.thesis || 'No thesis provided.' }),
      el('ul', {}, (o.confirmationCriteria || []).map((c) => el('li', { textContent: c }))),
    ])));
    return [row, detail];
  }

  function renderQueue() {
    const orders = [...pending.values()].sort((a, b) => b.stagedAt - a.stagedAt);
    $('queue-body').replaceChildren(...orders.flatMap(renderRow));
    $('queue-count').textContent = orders.length;
    $('queue-empty').hidden = orders.length > 0;
  }

  // Receive staged orders from the server and render them.
  function receiveStagedOrders(orders, { replace = false } = {}) {
    if (replace) {
      pending.clear();
      inFlight.clear();
    }
    for (const o of [].concat(orders)) if (o && o.id) pending.set(o.id, o);
    for (const id of expanded) if (!pending.has(id)) expanded.delete(id);
    renderQueue();
  }

  // Keep the Age column fresh without a full re-render.
  setInterval(() => {
    document.querySelectorAll('td.age').forEach((c) => { c.textContent = age(Number(c.dataset.ts)); });
  }, 15000);

  // ---------- WebSocket ----------
  const HANDLERS = {
    'orders:snapshot': (orders) => receiveStagedOrders(orders, { replace: true }),
    'order:staged': (order) => receiveStagedOrders(order),
    QUEUE_UPDATED: (orders) => receiveStagedOrders(orders, { replace: true }),
    ACTION_FAILED: ({ type, id, error }) => {
      console.warn(`[signaldesk] ${type} ${id} failed: ${error}`);
      inFlight.delete(id);
      renderQueue();
    },
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
    ws.addEventListener('open', () => { backoff = 1000; setConn('open', 'Live'); renderQueue(); });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const handler = HANDLERS[msg.type];
      if (handler) handler(msg.payload);
    });
    ws.addEventListener('close', () => {
      setConn('closed', `Offline · retry ${backoff / 1000}s`);
      renderQueue(); // disables the action buttons while offline
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  }

  showTab(location.hash.slice(1));
  renderQueue();
  connect();
})();
