// Approvals Queue view (Opportunities tab). Holds only display state; the
// server's snapshots are the truth. Exposes window.SignalDesk.queue.
(() => {
  const SD = window.SignalDesk;
  const { $, el, td, price, money, size, age } = SD.ui;

  const pending = new Map(); // candidate id -> staged order
  const expanded = new Set(); // candidate ids with the detail row open
  const inFlight = new Set(); // candidate ids with an APPROVE/REJECT awaiting the server
  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()

  // Order-guard reasons from the server, in plain words.
  const FAIL_REASONS = {
    EXPIRED: 'setup is older than 30 minutes and was discarded',
    PRICE_ESCAPED: 'price moved past the entry zone and the setup was discarded',
    INVALIDATED: 'price is already through the stop and the setup was discarded',
    NO_LIVE_PRICE: 'no fresh price available; still pending, try again shortly',
    LIVE_OPTIONS_UNSUPPORTED: 'live options execution is not supported yet (strikes are simulated). Nothing was sent; '
      + 'the order is still pending (set Alpaca mode to Paper to fill it on paper)',
    ORDER_BUSY: 'an approval for this order is already in progress',
  };

  // Broker errors arrive as "CODE: detail"; known codes get plain words.
  function describe(error) {
    if (FAIL_REASONS[error]) return FAIL_REASONS[error];
    const [code, ...rest] = String(error).split(': ');
    const detail = rest.join(': ');
    if (code === 'LIVE_ORDER_FAILED') return `live order rejected, nothing was filled (${detail})`;
    if (code === 'LIVE_UNRECORDED') return `CHECK YOUR BROKER NOW: ${detail}`;
    return error;
  }

  // Send an intent only. The row stays until the server's QUEUE_UPDATED removes it.
  function sendAction(type, id) {
    if (!transport.isOnline()) return;
    inFlight.add(id);
    transport.send({ type, id });
    render();
  }

  function actionButton(type, label, className, id) {
    const offline = !transport.isOnline();
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
      render();
    });

    if (!expanded.has(o.id)) return [row];
    const detail = el('tr', { className: 'detail-row' }, el('td', { colSpan: 12 }, el('div', { className: 'detail' }, [
      el('p', { textContent: o.thesis || 'No thesis provided.' }),
      el('ul', {}, (o.confirmationCriteria || []).map((c) => el('li', { textContent: c }))),
    ])));
    return [row, detail];
  }

  function render() {
    const orders = [...pending.values()].sort((a, b) => b.stagedAt - a.stagedAt);
    $('queue-body').replaceChildren(...orders.flatMap(renderRow));
    $('queue-count').textContent = orders.length;
    $('queue-empty').hidden = orders.length > 0;
  }

  // Receive staged orders from the server and render them.
  function receive(orders, { replace = false } = {}) {
    if (replace) {
      pending.clear();
      inFlight.clear();
    }
    for (const o of [].concat(orders)) if (o && o.id) pending.set(o.id, o);
    for (const id of expanded) if (!pending.has(id)) expanded.delete(id);
    render();
  }

  let noticeTimer = null;
  function showNotice(text) {
    const n = $('queue-notice');
    n.textContent = text;
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, 8000);
  }

  function actionFailed({ type, id, error }) {
    console.warn(`[signaldesk] ${type} ${id} failed: ${error}`);
    inFlight.delete(id);
    showNotice(`${type === 'APPROVE' ? 'Approval' : 'Rejection'} failed for ${id.split(':')[2] || id}: ${describe(error)}`);
    render();
  }

  // Keep the Age column fresh without a full re-render.
  setInterval(() => {
    document.querySelectorAll('td.age').forEach((c) => { c.textContent = age(Number(c.dataset.ts)); });
  }, 15000);

  SD.queue = {
    init: (t) => { transport = t; },
    render,
    receive,
    actionFailed,
  };
})();
