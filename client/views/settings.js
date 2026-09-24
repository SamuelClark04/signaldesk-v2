// Settings tab: Risk Management (bankroll + paper/live execution venues).
// Sends requested changes; the server validates, persists and broadcasts
// SETTINGS_UPDATED to every client. The header badge and LIVE warnings are
// driven only by server-confirmed settings, never by unsaved UI state.
// Exposes window.SignalDesk.settings.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;

  const MODE_SELECTS = [
    { id: 'settings-stock-mode', key: 'stockMode', venue: 'Alpaca (stocks/options)', short: 'Stocks' },
    { id: 'settings-crypto-mode', key: 'cryptoMode', venue: 'Coinbase (crypto)', short: 'Crypto' },
  ];

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let saved = null; // last settings confirmed by the server
  let pending = false; // an UPDATE_SETTINGS is awaiting the server's reply
  let pendingTimer = null;

  function setStatus(text, kind = '') {
    const s = $('settings-status');
    s.textContent = text;
    s.classList.toggle('is-error', kind === 'error');
    s.classList.toggle('is-ok', kind === 'ok');
  }

  function setPending(on) {
    pending = on;
    $('settings-save').disabled = on;
    for (const m of MODE_SELECTS) $(m.id).disabled = on;
    clearTimeout(pendingTimer);
    if (on) {
      pendingTimer = setTimeout(() => {
        setPending(false);
        setStatus('No response from the server. Try again.', 'error');
        renderModes(); // put the selects back to the confirmed values
      }, 10000);
    }
  }

  function request(payload) {
    if (!transport.isOnline()) {
      setStatus('Offline: cannot reach the server.', 'error');
      renderModes();
      return;
    }
    setPending(true);
    setStatus('Saving…');
    transport.send({ type: 'UPDATE_SETTINGS', payload });
  }

  function saveBankroll(e) {
    e.preventDefault();
    const bankroll = Number($('settings-bankroll').value);
    if (!Number.isFinite(bankroll) || bankroll <= 0) return setStatus('Enter a bankroll above $0.', 'error');
    request({ bankroll });
  }

  // Going LIVE is the one change that needs an explicit confirmation.
  function changeMode(m) {
    const value = $(m.id).value;
    if (value === 'live' && !window.confirm(`Switch ${m.venue} to LIVE?\n\nApproved ${m.short.toLowerCase()} orders will be `
      + 'routed to the broker instead of the paper ledger.')) {
      renderModes();
      return;
    }
    request({ [m.key]: value });
  }

  // ---------- Rendering (server-confirmed state only) ----------
  function renderModes() {
    if (!saved) return;
    const live = MODE_SELECTS.filter((m) => saved[m.key] === 'live');
    for (const m of MODE_SELECTS) {
      $(m.id).value = saved[m.key];
      $(m.id).classList.toggle('is-live', saved[m.key] === 'live');
    }

    const badge = $('mode-badge');
    badge.textContent = !live.length ? 'Paper'
      : live.length === MODE_SELECTS.length ? 'LIVE' : `LIVE · ${live.map((m) => m.short).join(' + ')}`;
    badge.classList.toggle('is-live', live.length > 0);
    badge.title = MODE_SELECTS.map((m) => `${m.venue}: ${saved[m.key].toUpperCase()}`).join('\n');

    const warn = $('settings-live-warning');
    warn.hidden = !live.length;
    warn.textContent = live.length
      ? `LIVE: approvals for ${live.map((m) => m.short.toLowerCase()).join(' and ')} route to the broker, not the paper ledger.`
      : '';
  }

  function renderFacts() {
    $('settings-facts').replaceChildren(...(saved
      ? ['Saved bankroll ', el('strong', { textContent: money(saved.bankroll) }),
        '. The risk engine sizes every new trade to risk 1% of it.']
      : ['Waiting for the server…']));
  }

  // Server truth arrived (on connect, after our save, or after another client's save).
  function render(settings) {
    const wasPending = pending;
    setPending(false);
    saved = settings;

    // Don't clobber what the user is typing unless this is the reply to their own save.
    const input = $('settings-bankroll');
    const editing = document.activeElement === input && Number(input.value) !== saved.bankroll;
    if (!editing || wasPending) input.value = String(saved.bankroll);

    if (wasPending) setStatus('Saved.', 'ok');
    renderModes();
    renderFacts();
  }

  function error({ error: message, settings }) {
    setPending(false);
    setStatus(message || 'Settings were not saved.', 'error');
    if (settings) saved = settings;
    renderModes();
    renderFacts();
  }

  $('settings-form').addEventListener('submit', saveBankroll);
  for (const m of MODE_SELECTS) $(m.id).addEventListener('change', () => changeMode(m));
  renderFacts();

  SD.settings = {
    init: (t) => { transport = t; },
    render,
    error,
  };
})();
