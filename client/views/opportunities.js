// Opportunities tab: sub-navigation (Setups / Scanner / Saved) and the Setups
// workspace: queue rail (left), analysis (center), risk & execution (right).
// The server is the source of truth: buttons send APPROVE / REJECT intents (the
// same messages the order guard, live routing and ORDER_BUSY lock protect), and
// a setup leaves the rail only when the server's QUEUE_UPDATED removes it.
// Exposes window.SignalDesk.opportunities.
(() => {
  const SD = window.SignalDesk;
  const { el, age } = SD.ui;

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
    ORDER_BUSY: 'an approval for this order is already in progress',
  };
  function describe(error) {
    if (FAIL_REASONS[error]) return FAIL_REASONS[error];
    const [code, ...rest] = String(error).split(': ');
    if (code === 'LIVE_ORDER_FAILED') return `live order rejected, nothing was filled (${rest.join(': ')})`;
    if (code === 'LIVE_UNRECORDED') return `CHECK YOUR BROKER NOW: ${rest.join(': ')}`;
    return error;
  }

  const rerender = () => { if (mounted) render(mounted.container, mounted.state); };

  function showNotice(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; rerender(); }, 10000);
    rerender();
  }

  // ---------- Actions (intents only) ----------
  function send(type, id) {
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

  function actionFailed({ type, id, error }) {
    inFlight.delete(id);
    const who = (mounted && mounted.state.pending.find((o) => o.id === id)) || { asset: String(id).split(':')[2] || id };
    showNotice(`${type === 'APPROVE' ? 'Approval' : 'Dismiss'} failed for ${who.asset}: ${describe(error)}`);
  }

  // ---------- Rail ----------
  function railCard(o, active) {
    const dir = o.direction === 'short' ? 'short' : 'long';
    const btn = el('button', { type: 'button', className: `opp-card${active ? ' is-active' : ''}` }, [
      el('div', { className: 'opp-card-top' }, [
        el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol(o) }),
        el('span', { className: `badge-${dir}`, textContent: dir }),
      ]),
      el('div', { className: 'opp-card-meta', textContent: `${o.setupType || 'Setup'} · ${o.timeframe || '—'}` }),
      el('div', { className: 'opp-card-sub', textContent: `${o.strategyId} · staged ${age(o.stagedAt)} ago${inFlight.has(o.id) ? ' · sending…' : ''}` }),
    ]);
    btn.setAttribute('aria-pressed', String(active));
    btn.onclick = () => { activeId = o.id; rerender(); };
    return btn;
  }

  // ---------- Setups workspace ----------
  function setups(state) {
    const pending = [...state.pending].sort((a, b) => b.stagedAt - a.stagedAt);
    for (const id of inFlight) if (!pending.some((o) => o.id === id)) inFlight.delete(id);
    if (!pending.some((o) => o.id === activeId)) activeId = pending.length ? pending[0].id : null;
    const active = pending.find((o) => o.id === activeId);

    const rail = el('aside', { className: 'opp-rail' }, [
      el('div', { className: 'opp-rail-head' }, [el('h3', { className: 'opp-section', textContent: 'Queue' }),
        el('span', { className: 'count', textContent: String(pending.length) })]),
      ...(pending.length ? pending.map((o) => railCard(o, o.id === activeId))
        : [el('p', { className: 'opp-muted', textContent: 'No setups pending. New ones appear here as the risk engine approves them.' })]),
    ]);
    if (!active) {
      return el('div', { className: 'opp-grid is-empty' }, [rail,
        el('div', { className: 'opp-empty', textContent: 'Select a setup to review it. The queue is empty right now.' })]);
    }
    const ctx = {
      livePrice: state.prices ? state.prices[active.asset] : null,
      settings: state.settings,
      online: transport.isOnline(),
      busy: inFlight.has(active.id),
      onApprove,
      onDismiss,
    };
    return el('div', { className: 'opp-grid' }, [rail, SD.oppDetail.center(active, ctx), SD.oppDetail.right(active, ctx)]);
  }

  const PLACEHOLDER = {
    scanner: 'Scanner is not built yet. It will list setups the strategies are forming but have not proposed.',
    saved: 'Saved setups are not built yet.',
  };

  function render(container, state) {
    mounted = { container, state };
    const tabs = el('div', { className: 'opp-subnav' }, ['setups', 'scanner', 'saved'].map((t) => {
      const b = el('button', { type: 'button', className: `opp-subtab${t === subTab ? ' is-active' : ''}`, textContent: t[0].toUpperCase() + t.slice(1) });
      b.setAttribute('aria-pressed', String(t === subTab));
      b.onclick = () => { subTab = t; rerender(); };
      return b;
    }));
    container.replaceChildren(
      tabs,
      ...(notice ? [el('div', { className: 'notice opp-notice', textContent: notice })] : []),
      subTab === 'setups' ? setups(state) : el('div', { className: 'placeholder', textContent: PLACEHOLDER[subTab] }),
    );
  }

  // Keep "staged N ago" fresh while the tab is on screen.
  setInterval(() => { if (mounted && mounted.container.offsetParent) rerender(); }, 30000);

  SD.opportunities = {
    init: (t) => { transport = t; },
    render,
    actionFailed,
    select: (id) => { activeId = id; subTab = 'setups'; },
  };
})();
