// Settings > Risk Management > Portfolio limits (Phase 77, risk/portfolio-risk.js): the open-risk ceiling (% of
// the bankroll a book may have at risk across its open trades) and the most bullish / bearish equity trades at
// once. Phase 81 entry shields: Macro News Shield (+ crypto), max trades per sector, daily loss kill switch ($).
// Each saves the moment it changes (UPDATE_SETTINGS through settings.js). Exposes window.SignalDesk.portfolioRiskSettings.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;
  let saved = null;

  function field(id, label, value, { min, max, step, suffix, onCommit, hint }) {
    const input = $(id) || el('input', { id, className: 'input', type: 'number', min: String(min), max: String(max), step: String(step), inputMode: 'decimal' });
    if (document.activeElement !== input) input.value = String(value);
    input.onchange = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < min || v > max) { input.value = String(value); return; }
      if (Math.abs(v - value) > 1e-9) onCommit(v);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
    return el('label', { className: 'field' }, [el('span', { className: 'field-label', textContent: label }),
      el('span', { className: 'input-wrap' }, [input, el('span', { className: 'input-prefix', textContent: suffix })]), el('span', { className: 'settings-note', textContent: hint })]);
  }

  function toggle(label, on, hint, onFlip) {
    const t = el('button', { type: 'button', className: `settings-toggle${on ? ' is-on' : ''}`, textContent: on ? 'On' : 'Off' });
    t.setAttribute('role', 'switch');
    t.setAttribute('aria-checked', String(on));
    t.setAttribute('aria-label', label);
    t.onclick = () => onFlip(!on);
    return el('div', { className: `settings-strategy${on ? '' : ' is-off'}` }, [t, el('div', {}, [el('strong', { textContent: label }), el('span', { className: 'settings-note', textContent: hint })])]);
  }

  function render(settings) {
    if (settings) saved = settings;
    const box = $('settings-portfolio-risk');
    if (!saved) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    const pct = Math.round((saved.maxOpenRiskPct || 0.06) * 1000) / 10;
    const dir = saved.maxEquityPerDirection || 2;
    box.replaceChildren(
      field('settings-open-risk', 'Portfolio open-risk ceiling (% of the bankroll)', pct, { min: 0.5, max: 50, step: 0.5, suffix: '%',
        hint: `New setups are held back while a book's open trades already risk this much: ${money((saved.bankroll || 0) * pct / 100)} of the stocks / options bankroll, `
          + `${money((saved.cryptoBankroll || 0) * pct / 100)} of crypto (a live book: of its live equity).`,
        onCommit: (v) => SD.settings.request({ maxOpenRiskPct: Math.round(v * 10) / 1000 }) }),
      field('settings-direction-limit', 'Max equity trades per direction', dir, { min: 1, max: 20, step: 1, suffix: 'each',
        hint: `At most ${dir} bullish and ${dir} bearish stock / options trades open or waiting in Approvals at once (a put spread is bearish).`,
        onCommit: (v) => SD.settings.request({ maxEquityPerDirection: Math.round(v) }) }),
      // Phase 81: entry shields (new entries only: stops, targets and closes always work).
      toggle('Macro News Shield', saved.macroShield !== false, 'No new stock / options entries from 30 min before to 15 min after CPI, PCE, payrolls, the unemployment rate and FOMC.',
        (v) => SD.settings.request({ macroShield: v })),
      toggle('Apply Macro Shield to Crypto', saved.macroShieldCrypto === true, 'Also pause new crypto entries during those windows (off: crypto keeps trading).',
        (v) => SD.settings.request({ macroShieldCrypto: v })),
      field('settings-sector-cap', 'Max trades per sector', saved.maxTradesPerSector || 1, { min: 1, max: 20, step: 1, suffix: 'each',
        hint: 'Stock / options trades open or staged at once in one sector group (e.g. AMZN, GOOGL and NVDA are all Technology).',
        onCommit: (v) => SD.settings.request({ maxTradesPerSector: Math.round(v) }) }),
      field('settings-daily-loss', 'Daily loss kill switch ($)', Number.isFinite(saved.dailyLossLimit) ? saved.dailyLossLimit : 150, { min: 0, max: 1000000, step: 10, suffix: '$',
        hint: `When today's realized + unrealized P/L (all accounts) reaches -${money(Number.isFinite(saved.dailyLossLimit) ? saved.dailyLossLimit : 150)}, no new entries until tomorrow. 0 = off.`,
        onCommit: (v) => SD.settings.request({ dailyLossLimit: Math.round(v * 100) / 100 }) }));
  }

  SD.portfolioRiskSettings = { render };
})();
