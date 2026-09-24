// Portfolio tab shell: Holdings | Portfolio Pilot sub-tabs, header, KPI cards,
// the manual Close flow and the execution-venue cards (BROKER_STATE).
// State-driven like Today/Opportunities: app.js calls render(container, state)
// on every state change while the tab is visible (so P/L re-marks every tick).
// Pieces: portfolio-table.js (holdings, P/L), portfolio-pilot.js (pilot, allocator).
// Exposes window.SignalDesk.portfolio.
(() => {
  const SD = window.SignalDesk;
  const { el, price, money, signed, pnlClass, clock } = SD.ui;
  const T = () => SD.portfolioTable;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let mounted = null; // { container, state }
  let subTab = 'holdings';
  // Venue filter. 'paper' is SignalDesk's own paper ledger (all markets);
  // 'crypto' is the synced Coinbase account; 'combined' sums both.
  let venue = 'paper';
  const VENUES = [['combined', 'Combined'], ['crypto', 'Live Crypto'], ['paper', 'Paper']];
  const VENUE_LABEL = { combined: 'Paper + Coinbase', crypto: 'Coinbase account', paper: 'Paper ledger' };
  let selectedId = null;
  let notice = '';
  let noticeTimer = null;
  const closing = new Set(); // position ids with a CLOSE_POSITION in flight

  const rerender = () => { if (mounted) render(mounted.container, mounted.state); };
  function showNotice(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; rerender(); }, 10000);
    rerender();
  }

  const REASONS = {
    NO_LIVE_PRICE: 'no fresh price right now, so it cannot close at a known price',
    LIVE_CLOSE_UNSUPPORTED: 'it is a LIVE position: close it at the broker (its bracket orders are there)',
    ORDER_BUSY: 'a close is already in progress',
  };

  function onClose(p, m) {
    if (!transport.isOnline()) return showNotice('Offline: cannot reach the server.');
    if (p.execution === 'LIVE') return showNotice(`${p.asset}: ${REASONS.LIVE_CLOSE_UNSUPPORTED}.`);
    if (!m.live) return showNotice(`${p.asset}: ${REASONS.NO_LIVE_PRICE}.`);
    const est = m.gross === null ? 'Options are booked at their value at expiry (intrinsic) for this underlying price.'
      : `Estimated P/L: ${signed(m.gross, money)} gross, ${m.net === null ? '—' : signed(m.net, money)} after estimated fees.`;
    const ok = window.confirm(`Close ${p.direction.toUpperCase()} ${p.asset} (paper) at the live price ${price(m.price, p)}?\n\n${est}\n\n`
      + 'The server closes it at the freshest price it has, which may differ slightly.');
    if (!ok) return undefined;
    closing.add(p.id);
    transport.send({ type: 'CLOSE_POSITION', id: p.id });
    return rerender();
  }

  function actionFailed({ id, error }) {
    closing.delete(id);
    const pos = mounted && (mounted.state.positions || []).find((x) => x.id === id);
    const reason = Object.keys(REASONS).find((k) => String(error).startsWith(k));
    showNotice(`Close failed for ${pos ? pos.asset : id}: ${reason ? REASONS[reason] : error}.`);
  }

  // ---------- Header + KPIs ----------
  function header() {
    const [title, sub] = subTab === 'pilot'
      ? ['Portfolio Pilot', 'Review your holdings against the market. Change only when the evidence warrants it.']
      : ['Portfolio', 'Open positions from the ledger, marked to live prices.'];
    const btn = el('button', { type: 'button', className: 'btn btn-solid pf-head-btn', textContent: subTab === 'pilot' ? 'View holdings' : 'Review with Pilot' });
    btn.onclick = () => { subTab = subTab === 'pilot' ? 'holdings' : 'pilot'; rerender(); };
    const toggle = el('div', { className: 'pf-venues-toggle', role: 'group', ariaLabel: 'Venue' }, VENUES.map(([key, label]) => {
      const b = el('button', { type: 'button', className: `pf-venue-seg${key === venue ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(key === venue));
      b.onclick = () => { venue = key; rerender(); };
      return b;
    }));
    return el('div', { className: 'pf-header' }, [
      el('div', {}, [el('h2', { className: 'pf-title', textContent: title }), el('p', { className: 'pf-subtitle', textContent: sub })]),
      el('div', { className: 'pf-header-right' }, [
        el('div', { className: 'pf-header-actions' }, [toggle, syncButton(), btn]),
        el('span', { className: 'pf-sub', textContent: syncStatus() }),
      ]),
    ]);
  }

  // ---------- Sync Broker (SYNC_PORTFOLIO -> BROKER_HOLDINGS) ----------
  let syncRequested = false;
  const holdings = () => (mounted.state.holdings || {});
  function syncButton() {
    const busy = syncRequested || holdings().syncing;
    const b = el('button', { type: 'button', className: 'btn pf-sync', textContent: busy ? 'Syncing…' : '⟳ Sync Broker', disabled: busy || !transport.isOnline(),
      title: transport.isOnline() ? 'Fetch your Coinbase holdings (read-only)' : 'Offline' });
    b.onclick = () => { syncRequested = true; transport.send({ type: 'SYNC_PORTFOLIO' }); setTimeout(() => { syncRequested = false; rerender(); }, 15000); rerender(); };
    return b;
  }
  function syncStatus() {
    const h = holdings();
    const cb = h.coinbase;
    if (h.notice) return h.notice;
    if (!cb || cb.status === 'never') return 'Coinbase not synced yet · paper prices are live';
    if (!cb.ok) return `Coinbase sync failed (${clock(cb.syncedAt)}): ${cb.error}`;
    return `Coinbase synced ${clock(cb.syncedAt)} · ${cb.positions.length} holding${cb.positions.length === 1 ? '' : 's'} · ${money(cb.cash)} cash`;
  }

  function kpis(t) {
    if (venue === 'crypto' && !t.synced) {
      return el('div', { className: 'pf-card pf-empty-venue' }, [el('strong', { textContent: 'Coinbase not synced' }),
        el('span', { className: 'pf-sub', textContent: 'Press Sync Broker to load your real Coinbase holdings (read-only). Until then this view lists only the LIVE trades SignalDesk opened itself, without account totals.' })]);
    }
    const card = (label, value, sub, cls = '') => el('div', { className: 'pf-kpi' }, [el('span', { className: 'pf-kpi-label', textContent: label }),
      el('strong', { className: `pf-kpi-value ${cls}`, textContent: value }), el('span', { className: 'pf-kpi-sub', textContent: sub })]);
    const liveNote = t.live ? ` · ${t.live} LIVE position${t.live === 1 ? '' : 's'} not in totals (broker account not synced)` : '';
    const parts = [...(t.usePaper ? [`paper ${money(t.bankroll)} bankroll ${t.realized >= 0 ? '+' : '−'} ${money(Math.abs(t.realized))} realized`] : []),
      ...(t.useCb ? [`Coinbase holdings + ${money(t.cbCash)} cash (sync ${clock(t.syncedAt)})`] : [])];
    return el('div', { className: 'pf-kpis' }, [
      card('Account value', money(t.accountValue), `${parts.join(' · ')}${liveNote}`),
      card('Holdings value', money(t.holdingsValue), t.unmarked ? `${t.unmarked} position(s) without a P/L mark` : t.useCb ? 'Live prices; Coinbase coins without one at their sync value' : 'Open positions at live prices'),
      // Each setup is sized on its own (up to the bankroll in notional), so open
      // positions can commit more than the bankroll: say so instead of hiding it.
      !t.usePaper ? card('Spendable cash', money(t.cash), 'Coinbase USD + USDC balance at the last sync')
        : t.cash >= 0 ? card('Spendable cash', money(t.cash), `Not committed to open positions${t.useCb ? ' (paper) + Coinbase cash' : ` (${money(t.committed)} committed)`}`)
        : card('Spendable cash', `−${money(-t.cash)}`, `Over-committed: ${money(t.paperCost)} in open paper positions vs a ${money(t.bankroll)} bankroll${t.useCb ? ' (Coinbase cash included)' : ''}`, 'pnl-neg'),
      card('Unrealized P/L', signed(t.unrealized, money), t.unrealizedPct === null ? 'No open paper positions' : `${T().pct(t.unrealizedPct)} of cost · before est. exit fees`, pnlClass(t.unrealized)),
    ]);
  }

  // ---------- Execution venues (BROKER_STATE) ----------
  function venues(state) {
    const b = state.broker;
    if (!b || !b.venues) return null;
    const tiles = Object.values(b.venues).map((v) => {
      const live = v.mode === 'live';
      const failed = live && !v.ok;
      const value = !live ? money(b.bankroll) : failed ? '—' : money(v.buyingPower);
      const sub = !live ? 'Paper bankroll: approvals fill in the paper ledger' : failed ? `Account unavailable: ${v.error}`
        : `${v.balances ? `USD ${money(v.balances.USD)} + USDC ${money(v.balances.USDC)}` : `Cash ${money(v.cash)} · equity ${money(v.equity)}${v.tradingBlocked ? ' · TRADING BLOCKED' : ''}`} · as of ${clock(v.fetchedAt)}`;
      return el('div', { className: `pf-venue-tile${live ? ' is-live' : ''}${failed ? ' is-error' : ''}` }, [
        el('span', { className: 'pf-kpi-label', textContent: `${live ? 'LIVE' : 'Paper'} · ${v.label} · ${v.markets}` }),
        el('strong', { className: 'pf-kpi-value', textContent: value }), el('span', { className: 'pf-kpi-sub', textContent: sub })]);
    });
    return el('section', { className: 'pf-card' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Execution venues' }),
        el('span', { className: 'pf-sub', textContent: `Position sizing uses the paper bankroll (${money(b.bankroll)}) for every venue` })]),
      el('div', { className: 'pf-venues' }, tiles),
    ]);
  }

  // ---------- Render ----------
  function render(container, state) {
    mounted = { container, state };
    for (const id of closing) if (!(state.positions || []).some((p) => p.id === id)) closing.delete(id); // closed
    const focusId = document.activeElement && document.activeElement.id === SD.portfolioPilot.focusId ? SD.portfolioPilot.focusId : null;
    const data = T().metrics(state, venue);
    if (state.holdings && !state.holdings.syncing) syncRequested = false;
    if (!data.rows.some((r) => r.p.id === selectedId)) selectedId = data.rows.length ? data.rows[0].p.id : null;
    const online = transport.isOnline();
    const onSelect = (id) => { selectedId = id; rerender(); };

    const tabs = el('nav', { className: 'pf-subnav' }, [['holdings', 'Holdings'], ['pilot', 'Portfolio Pilot']].map(([key, label]) => {
      const b = el('button', { type: 'button', className: `pf-subtab${key === subTab ? ' is-active' : ''}`, textContent: label });
      b.onclick = () => { subTab = key; rerender(); };
      return b;
    }));
    const body = subTab === 'pilot'
      ? SD.portfolioPilot.pilotView(data, { state, venueLabel: VENUE_LABEL[venue], selectedId, onSelect, onClose, online, rerender,
        onHoldings: (id) => { selectedId = id; subTab = 'holdings'; rerender(); }, send: (msg) => transport.send(msg) })
      : el('div', { className: 'pf-holdings-view' }, [
        kpis(data.totals),
        el('div', { className: 'pf-grid' }, [
          T().holdingsTable(data, { selectedId, onSelect, onClose, closing, online }),
          el('div', { className: 'pf-side' }, [T().exposure(data), T().attention(data, { onSelect, onPilot: () => { subTab = 'pilot'; rerender(); } })]),
        ]),
        T().details(data.rows.find((r) => r.p.id === selectedId), state),
        venues(state),
      ].filter(Boolean));

    container.replaceChildren(tabs, header(), ...(notice ? [el('div', { className: 'notice opp-notice', textContent: notice })] : []), body);
    if (focusId) { const input = document.getElementById(focusId); if (input) input.focus(); }
  }

  SD.portfolio = {
    init: (t) => { transport = t; },
    render,
    actionFailed,
    renderAllocation: (proposal) => { SD.portfolioPilot.allocationResult(proposal); rerender(); },
  };
})();
