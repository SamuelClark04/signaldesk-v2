// Settings tab: Risk Management (risk profile, strategy strictness, max capital
// per trade, bankroll, paper/live execution venues). Strictness and the capital
// cap are sent the moment they are clicked (no Save needed); the server applies
// them from the next 60 s scan.
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
  let draftProfile = null; // risk profile picked but not saved yet (null = the saved one)
  const PROFILE_LABEL = { conservative: 'Conservative', balanced: 'Balanced', aggressive: 'Aggressive' };
  const pctText = (x) => `${(x * 100).toFixed(1)}%`;

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
    $('settings-risk').querySelectorAll('button').forEach((b) => { b.disabled = on; });
    $('settings-strictness').querySelectorAll('button').forEach((b) => { b.disabled = on; });
    $('settings-capital').querySelectorAll('button').forEach((b) => { b.disabled = on; });
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

  // Save Settings sends the risk profile and the bankroll together.
  function saveForm(e) {
    e.preventDefault();
    const bankroll = Number($('settings-bankroll').value);
    if (!Number.isFinite(bankroll) || bankroll <= 0) return setStatus('Enter a bankroll above $0.', 'error');
    const payload = { bankroll };
    if (draftProfile && saved && draftProfile !== saved.riskProfile) payload.riskProfile = draftProfile;
    return request(payload);
  }

  // Risk profile: segmented radio buttons; percentages come from the server.
  function renderRisk() {
    const box = $('settings-risk');
    if (!saved || !saved.riskProfiles) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    const current = draftProfile || saved.riskProfile;
    box.replaceChildren(...Object.entries(saved.riskProfiles).map(([key, pct]) => {
      const b = el('button', { type: 'button', className: `settings-risk-opt is-${key}${key === current ? ' is-active' : ''}`, disabled: pending }, [
        el('strong', { textContent: PROFILE_LABEL[key] || key }), el('span', { textContent: `${pctText(pct)} per trade` })]);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === current));
      b.onclick = () => {
        draftProfile = key === saved.riskProfile ? null : key;
        setStatus(draftProfile ? 'Unsaved: press Save Settings to apply.' : '');
        renderRisk();
        renderFacts();
      };
      return b;
    }));
  }

  // Strategy strictness: sent immediately on click (server-confirmed state only;
  // the button that looks active is always the saved level). Labels and numbers
  // come from the server (settings.strictnessLevels).
  function renderStrictness() {
    const box = $('settings-strictness');
    if (!saved || !saved.strictnessLevels) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    box.replaceChildren(...Object.entries(saved.strictnessLevels).map(([key, lv]) => {
      const active = key === saved.strictness;
      const b = el('button', { type: 'button', className: `settings-risk-opt is-${key}${active ? ' is-active' : ''}`, disabled: pending }, [
        el('strong', { textContent: lv.label }),
        el('span', { textContent: `Crypto target ${lv.targetR}R · resistance ${lv.resistanceLookbackDays ? `last ${lv.resistanceLookbackDays} days` : 'full history'}` })]);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(active));
      b.onclick = () => { if (!active) request({ strictness: key }); };
      return b;
    }));
  }

  // Max Capital Per Trade: the risk engine's automatic cap on one position's
  // notional (options: premium), however tight the stop. Sent immediately; the
  // choices come from the server (settings.maxCapitalChoices).
  function renderCapital() {
    const box = $('settings-capital');
    if (!saved || !saved.maxCapitalChoices) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    box.replaceChildren(...saved.maxCapitalChoices.map((pct) => {
      const active = pct === saved.maxCapitalPct;
      const b = el('button', { type: 'button', className: `settings-risk-opt${pct > 0.15 ? ' is-aggressive' : ''}${active ? ' is-active' : ''}`, disabled: pending }, [
        el('strong', { textContent: `${Math.round(pct * 100)}%` }), el('span', { textContent: `${money(saved.bankroll * pct)} max per trade` })]);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(active));
      b.onclick = () => { if (!active) request({ maxCapitalPct: pct }); };
      return b;
    }));
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
    if (!saved) { $('settings-facts').replaceChildren('Waiting for the server…'); return; }
    const pct = saved.riskPct;
    $('settings-facts').replaceChildren('Saved: ', el('strong', { textContent: `${PROFILE_LABEL[saved.riskProfile] || saved.riskProfile} (${pctText(pct)})` }),
      ' risk on a ', el('strong', { textContent: money(saved.bankroll) }), ' paper bankroll, so each new trade risks up to ',
      el('strong', { textContent: money(saved.bankroll * pct) }), ' at its stop and uses at most ',
      el('strong', { textContent: `${Math.round((saved.maxCapitalPct || 0.1) * 100)}% (${money(saved.bankroll * (saved.maxCapitalPct || 0.1))})` }),
      ' of the bankroll (change any single trade with its Trade Amount). Staged setups and open positions keep the size they were given. Strictness: ',
      el('strong', { textContent: (saved.strictnessLevels && saved.strictnessLevels[saved.strictness] || {}).label || saved.strictness || 'strict' }),
      ' (sizing, the fee gate, the capital cap and the earnings shields are the same at every level).');
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
    if (draftProfile === saved.riskProfile) draftProfile = null; // saved: no longer a draft
    renderModes();
    renderRisk();
    renderStrictness();
    renderCapital();
    renderFacts();
  }

  function error({ error: message, settings }) {
    setPending(false);
    setStatus(message || 'Settings were not saved.', 'error');
    if (settings) saved = settings;
    renderModes();
    renderRisk();
    renderStrictness();
    renderCapital();
    renderFacts();
  }

  // Paper reset: typed confirmation, then the server wipes the paper book.
  $('settings-reset').addEventListener('click', () => {
    const s = $('settings-reset-status');
    if (!transport.isOnline()) { s.textContent = 'Offline: cannot reach the server.'; return; }
    const typed = window.prompt('Reset the PAPER ledger?\n\nThis deletes every paper position, closed paper trade and journal entry, all staged setups '
      + 'and Pilot proposals. LIVE/adopted positions are kept. A backup file is saved on the server.\n\nType RESET to confirm:');
    if (typed === null) return;
    if (typed.trim() !== 'RESET') { s.textContent = 'Not reset: the confirmation word did not match.'; s.className = 'settings-status is-error'; return; }
    s.textContent = 'Resetting…'; s.className = 'settings-status';
    transport.send({ type: 'RESET_LEDGER', confirm: 'RESET' });
  });
  function resetDone(r) {
    const s = $('settings-reset-status');
    if (!r || !r.ok) { s.textContent = `Not reset: ${(r && r.error) || 'no reply'}`; s.className = 'settings-status is-error'; return; }
    const n = r.removed;
    s.textContent = `Paper ledger reset: removed ${n.positions} position(s), ${n.trades} trade(s), ${n.pending} staged setup(s).`
      + `${r.keptLive.positions ? ` Kept ${r.keptLive.positions} LIVE position(s).` : ''} Backup saved on the server.`;
    s.className = 'settings-status is-ok';
  }

  $('settings-form').addEventListener('submit', saveForm);
  for (const m of MODE_SELECTS) $(m.id).addEventListener('change', () => changeMode(m));
  renderFacts();
  renderRisk();
  renderStrictness();
  renderCapital();

  SD.settings = {
    init: (t) => { transport = t; },
    render,
    error,
    resetDone,
  };
})();
