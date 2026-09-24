// Settings tab: Risk Management. Sends the requested bankroll; the server
// validates, persists and broadcasts SETTINGS_UPDATED to every client.
// Exposes window.SignalDesk.settings.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  let saved = null; // last settings confirmed by the server
  let pendingTimer = null;

  function setStatus(text, kind = '') {
    const s = $('settings-status');
    s.textContent = text;
    s.classList.toggle('is-error', kind === 'error');
    s.classList.toggle('is-ok', kind === 'ok');
  }

  function save(e) {
    e.preventDefault();
    const bankroll = Number($('settings-bankroll').value);
    if (!Number.isFinite(bankroll) || bankroll <= 0) return setStatus('Enter a bankroll above $0.', 'error');
    if (!transport.isOnline()) return setStatus('Offline: cannot reach the server.', 'error');
    $('settings-save').disabled = true;
    setStatus('Saving…');
    transport.send({ type: 'UPDATE_SETTINGS', payload: { bankroll } });
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      $('settings-save').disabled = false;
      setStatus('No response from the server. Try again.', 'error');
    }, 10000);
  }

  function renderFacts() {
    $('settings-facts').replaceChildren(...(saved
      ? ['Saved bankroll ', el('strong', { textContent: money(saved.bankroll) }),
        '. The risk engine sizes every new trade to risk 1% of it.']
      : ['Waiting for the server…']));
  }

  // Server truth arrived (on connect, after our save, or after another client's save).
  function render(settings) {
    const wasPending = $('settings-save').disabled;
    clearTimeout(pendingTimer);
    $('settings-save').disabled = false;
    saved = settings;

    // Don't clobber what the user is typing unless this is the reply to their own save.
    const input = $('settings-bankroll');
    const editing = document.activeElement === input && Number(input.value) !== saved.bankroll;
    if (!editing || wasPending) input.value = String(saved.bankroll);

    if (wasPending) setStatus('Saved.', 'ok');
    renderFacts();
  }

  function error({ error: message, settings }) {
    clearTimeout(pendingTimer);
    $('settings-save').disabled = false;
    setStatus(message || 'Settings were not saved.', 'error');
    if (settings) saved = settings;
    renderFacts();
  }

  $('settings-form').addEventListener('submit', save);
  renderFacts();

  SD.settings = {
    init: (t) => { transport = t; },
    render,
    error,
  };
})();
