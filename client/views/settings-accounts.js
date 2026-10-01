// Settings > Accounts & Connections (Phase 73): paste each broker / exchange / email key, [Test & Save]:
// the server tests it against the venue, stores it in the encrypted vault and hot-reloads the
// connectors (security/accounts.js). The browser never receives a secret: only configured / source /
// a masked preview. Also: the welcome banner when no broker is connected yet, the Settings note on how
// "Alpaca mode" and "Paper broker" relate, and the paper-bankroll note (Settings + Today).
// Exposes window.SignalDesk.accounts: { init, status, result, explain, paperNote }.
(() => {
  const SD = window.SignalDesk;
  const { el, money } = SD.ui;
  let transport = { isOnline: () => false, send: () => {} };
  let current = null; // last ACCOUNTS_STATUS
  const busy = new Set(); // providers with a Test & Save in flight
  const notes = new Map(); // provider -> { ok, text }
  const drafts = new Map(); // provider -> { field: value } typed, not yet saved (never persisted)
  const LABEL = { key: 'API key', secret: 'Secret key', keyName: 'API key name', privateKey: 'Private key (EC, PEM)', passphrase: 'Passphrase', email: 'Gmail address', appPassword: 'App Password', alertTo: 'Send links to (optional)', apiKey: 'API key' };
  const SECRET = new Set(['secret', 'privateKey', 'passphrase', 'appPassword', 'apiKey']); // apiKey: the AI Analyst keys (Phase 84)
  const $ = (id) => document.getElementById(id);

  function card(id, p) {
    const draft = drafts.get(id) || {};
    const inputs = p.fields.map((f) => {
      const multi = f === 'privateKey';
      const input = el(multi ? 'textarea' : 'input', { className: 'input acct-input', ...(multi ? { rows: 3 } : { type: SECRET.has(f) ? 'password' : f === 'email' || f === 'alertTo' ? 'email' : 'text' }),
        placeholder: p.configured ? 'saved: paste new keys to replace' : LABEL[f] || f, value: draft[f] || '', autocomplete: 'off', spellcheck: false });
      input.addEventListener('input', () => { drafts.set(id, { ...(drafts.get(id) || {}), [f]: input.value }); });
      return el('label', { className: 'field acct-field' }, [el('span', { className: 'field-label', textContent: LABEL[f] || f }), input]);
    });
    const note = notes.get(id);
    const state = p.configured ? `Connected${p.source === 'env' ? ' (from .env)' : ''} · ${p.preview || ''}${p.test && p.test.warning ? ' · ⚠ unfunded' : ''}` : 'Not connected';
    const save = el('button', { type: 'button', className: 'btn btn-primary', textContent: busy.has(id) ? 'Testing…' : 'Test & Save', disabled: busy.has(id) || !transport.isOnline() || (current && current.vault && !current.vault.tokenSet) });
    save.onclick = () => {
      const fields = drafts.get(id) || {};
      if (!p.fields.filter((f) => !(p.optional || []).includes(f)).every((f) => String(fields[f] || '').trim())) { notes.set(id, { ok: false, text: 'Fill in every field (keys are only kept once the test passes).' }); return render(); }
      busy.add(id); notes.delete(id);
      transport.send({ type: 'SAVE_ACCOUNT', provider: id, fields });
      return render();
    };
    const remove = p.source === 'vault' ? el('button', { type: 'button', className: 'btn acct-remove', textContent: 'Remove', disabled: busy.has(id) }) : null;
    if (remove) remove.onclick = () => { if (window.confirm(`Remove the saved ${p.label} keys from SignalDesk's vault?`)) { busy.add(id); transport.send({ type: 'REMOVE_ACCOUNT', provider: id }); render(); } };
    return el('div', { className: `acct-card${p.configured ? ' is-on' : ''}` }, [
      el('div', { className: 'acct-head' }, [el('strong', { textContent: p.label }), el('span', { className: `acct-state${p.configured ? ' is-on' : ''}`, textContent: state })]),
      el('p', { className: 'acct-hint', textContent: p.hint }),
      el('div', { className: 'acct-fields' }, inputs),
      el('div', { className: 'acct-actions' }, [save, ...(remove ? [remove] : []),
        ...(note ? [el('span', { className: `settings-status ${note.ok ? 'is-ok' : 'is-error'}`, textContent: note.text })] : p.test && p.test.detail ? [el('span', { className: 'settings-status', textContent: p.test.detail })] : [])]),
    ]);
  }

  function render() {
    const box = $('settings-accounts');
    if (box) {
      const head = el('div', { className: 'panel-header' }, [el('h2', { className: 'panel-title', textContent: 'Accounts & Connections' }),
        el('span', { className: 'panel-hint', textContent: 'Keys are tested with the venue, then stored encrypted on this server (never shown again, never sent to the browser). Saved keys apply at once: no restart.' })]);
      if (!current) box.replaceChildren(head, el('p', { className: 'settings-facts', textContent: 'Waiting for the server…' }));
      else {
        const v = current.vault || {};
        const warn = !v.tokenSet ? 'Set LAN_ACCESS_TOKEN (24+ random characters) in the server\'s .env first: the vault is encrypted with it.' : v.locked ? `Vault locked: ${v.reason}` : null;
        box.replaceChildren(head, ...(warn ? [el('p', { className: 'live-warning acct-warn', textContent: warn })] : []),
          el('div', { className: 'acct-grid' }, Object.entries(current.providers).map(([id, p]) => card(id, p))));
      }
    }
    const banner = $('welcome-banner');
    if (banner) {
      banner.hidden = !current || current.anyBroker;
      if (!banner.hidden) {
        const go = el('a', { className: 'btn btn-primary', href: '#settings', textContent: 'Connect an account' });
        banner.replaceChildren(el('div', {}, [el('strong', { textContent: 'Welcome to SignalDesk' }),
          el('span', { textContent: ' No broker is connected yet. Paste your Alpaca Paper keys (free, $100k virtual money) in Settings > Accounts & Connections to start; add Coinbase / Kraken / OKX any time.' })]), go);
      }
    }
  }

  // How "Alpaca mode" and "Paper broker" relate, for the current settings.
  function explain(s) {
    const box = $('settings-mode-explain');
    const bank = $('settings-bankroll-note');
    if (!s) return;
    if (bank) bank.textContent = `Alpaca Paper holds $100k virtual cash, but SignalDesk sizes paper trades strictly off your Paper Bankroll cap (${money(s.bankroll)}).`;
    if (!box) return;
    const p = current && current.providers;
    const live = s.stockMode === 'live';
    const lines = live
      ? [`Alpaca mode LIVE: approved stock orders are REAL orders in your Alpaca Live account (AK... keys), sized from its equity. The Paper broker setting is not used.`,
        p && !p.alpacaLive.configured ? '⚠ No Alpaca Live keys are connected: add them under Accounts & Connections.' : p && p.alpacaLive.test && p.alpacaLive.test.warning ? `⚠ ${p.alpacaLive.test.warning}` : '']
      : [s.paperStockBroker === 'internal' ? 'Alpaca mode Paper + Paper broker Simulated: stock / options trades fill inside SignalDesk (no broker account), sized from the Paper Bankroll.'
        : 'Alpaca mode Paper + Paper broker Alpaca Paper: stock / options trades execute in your Alpaca Paper account (PK... keys), sized from the Paper Bankroll, never from its $100k.',
      'Switch Alpaca mode to LIVE to trade real money with your Alpaca Live account; both key pairs can be connected at once.'];
    box.textContent = lines.filter(Boolean).join(' ');
  }

  // Today (Paper / Combined): the sizing note when an Alpaca Paper account is connected.
  function paperNote(state) {
    if (SD.venue.current(state) === 'crypto' || !(state.settings && state.settings.bankroll > 0)) return null;
    if (!(state.holdings && state.holdings.alpacaPaper && state.holdings.alpacaPaper.ok) && !(current && current.providers.alpacaPaper.configured)) return null;
    return el('p', { className: 'today-paper-note', textContent: `Alpaca Paper holds $100k virtual cash, but SignalDesk sizes paper trades strictly off your Paper Bankroll cap (${money(state.settings.bankroll)}).` });
  }

  function status(s) { current = s; render(); explain(SD.app && SD.app.state && SD.app.state.settings); }
  function result(r) {
    busy.delete(r.provider);
    if (r.ok) drafts.delete(r.provider);
    notes.set(r.provider, { ok: !!r.ok, text: `${r.ok ? '✓' : '✕'} ${r.detail}${r.warning ? ` · ⚠ ${r.warning}` : ''}` });
    render();
  }
  function init(t) { transport = t; render(); }

  SD.accounts = { init, status, result, explain, paperNote };
})();
