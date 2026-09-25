// Venue filter shared by Today and Portfolio: the Combined / Live / External / Paper
// toggle, the Sync Broker button and its status line. The active venue lives in
// the global client state (state.activeVenue, owned by app.js), so switching it
// on one tab applies everywhere.
//   'paper'    SignalDesk's paper ledger (all markets)
//   'crypto'   "Live / External": the synced Coinbase / Alpaca accounts (Sync
//              Broker) + manual holdings at other brokers (Robinhood...)
//   'combined' all of it, without counting SignalDesk's live trades twice
// Exposes window.SignalDesk.venue.
(() => {
  const SD = window.SignalDesk;
  const { el, money, clock } = SD.ui;

  const VENUES = [['combined', 'Combined'], ['crypto', 'Live / External'], ['paper', 'Paper']];
  const LABEL = { combined: 'Paper + live + external', crypto: 'Live broker + external holdings', paper: 'Paper ledger' };
  const KEYS = new Set(VENUES.map(([k]) => k));

  let syncRequested = false; // pressed, waiting for BROKER_HOLDINGS
  let syncTimer = null;

  const current = (state) => (KEYS.has(state.activeVenue) ? state.activeVenue : 'paper');

  function toggle(state) {
    const active = current(state);
    const group = el('div', { className: 'pf-venues-toggle' }, VENUES.map(([key, label]) => {
      const b = el('button', { type: 'button', className: `pf-venue-seg${key === active ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(key === active));
      b.onclick = () => SD.app.setVenue(key);
      return b;
    }));
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Venue');
    return group;
  }

  function syncButton(state) {
    const h = state.holdings || {};
    const online = SD.app.isOnline();
    const busy = !!syncRequested || h.syncing;
    const b = el('button', { type: 'button', className: 'btn pf-sync', textContent: busy ? 'Syncing…' : '⟳ Sync Broker', disabled: busy || !online,
      title: online ? 'Fetch your Coinbase and Alpaca holdings (read-only)' : 'Offline' });
    b.onclick = () => {
      syncRequested = true;
      SD.app.send({ type: 'SYNC_PORTFOLIO' });
      clearTimeout(syncTimer); // never leave the button stuck if no answer comes
      syncTimer = setTimeout(() => { syncRequested = false; SD.app.refresh(); }, 15000);
      SD.app.refresh();
    };
    return b;
  }

  function status(state) {
    const h = state.holdings || {};
    const cb = h.coinbase;
    if (h.notice) return h.notice;
    const al = h.alpaca;
    const manual = ((state.external && state.external.holdings) || []).length;
    const extra = `${al && al.ok ? ` · Alpaca ${al.positions.length}` : al && al.status === 'error' ? ' · Alpaca sync failed' : ''}${manual ? ` · ${manual} manual` : ''}`;
    if (!cb || cb.status === 'never') return `Coinbase not synced yet · paper prices are live${extra}`;
    if (!cb.ok) return `Coinbase sync failed (${clock(cb.syncedAt)}): ${cb.error}${extra}`;
    return `Coinbase synced ${clock(cb.syncedAt)} · ${cb.positions.length} holding${cb.positions.length === 1 ? '' : 's'} · ${money(cb.cash)} cash${extra}`;
  }

  // Toggle + Sync Broker (+ optional extra buttons) with the status line under them.
  function controls(state, extra = []) {
    return el('div', { className: 'pf-header-right' }, [
      el('div', { className: 'pf-header-actions' }, [toggle(state), syncButton(state), ...extra]),
      el('span', { className: 'pf-sub', textContent: status(state) }),
    ]);
  }

  // app.js calls this for every BROKER_HOLDINGS: a finished answer (result or
  // "a sync just ran") releases the button.
  function received(h) {
    if (h && !h.syncing) { syncRequested = false; clearTimeout(syncTimer); }
  }

  SD.venue = { controls, current, received, LABEL, KEYS };
})();
