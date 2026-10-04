// Settings > Risk Management > Portfolio limits (Phase 77, risk/portfolio-risk.js): the open-risk ceiling (% of
// the bankroll a book may have at risk across its open trades) and the most bullish / bearish equity trades at
// once. Phase 81 entry shields: Macro News Shield (+ crypto), max trades per sector, daily loss kill switch ($). Phase 89: the optional
// daily profit target and the max automated positions per book.
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
      // Phase 87: options entry pacing (risk/option-pacing.js).
      field('settings-option-pacing', 'Max automated option entries per day', Number.isFinite(saved.maxOptionEntriesPerDay) ? saved.maxOptionEntriesPerDay : 2, { min: 0, max: 50, step: 1, suffix: 'a day',
        hint: 'Option signals fire in clusters on one market move: at most this many new automated option trades a day, and none within 60 min of one in the '
          + 'same direction. 0 = off (both rules; e.g. to stress-test on paper).',
        onCommit: (v) => SD.settings.request({ maxOptionEntriesPerDay: Math.round(v) }) }),
      // Phase 83: one kill switch per book: a bad paper day never pauses live entries, and the reverse.
      ...[['Paper', 'dailyLossLimitPaper', 150, 'paper'], ['Live', 'dailyLossLimitLive', 25, 'real-money']].map(([name, key, def, what]) => {
        const v = Number.isFinite(saved[key]) ? saved[key] : def;
        return field(`settings-daily-loss-${name.toLowerCase()}`, `Daily loss kill switch: ${name} ($)`, v, { min: 0, max: 1000000, step: 5, suffix: '$',
          hint: `When today's ${what} P/L (realized + unrealized) reaches -${money(v)}, no new ${name.toLowerCase()} entries until tomorrow. 0 = off.`,
          onCommit: (x) => SD.settings.request({ [key]: Math.round(x * 100) / 100 }) });
      }),
      // Phase 89: optional daily profit target (stops new automated entries for the day; never forces or resizes a trade).
      toggle('Daily profit target', saved.dailyProfitTargetOn === true, `Off by default. On: once a book's REALIZED P/L today reaches ${money(saved.dailyProfitTarget || 200)}, `
        + 'no new automated entries in that book until tomorrow. It only stops entries: it never forces a trade, loosens a filter, increases a size or closes a trade. '
        + 'Zero-trade days are normal; a daily target is not a promise of daily profit.', (v) => SD.settings.request({ dailyProfitTargetOn: v })),
      field('settings-daily-target', 'Daily profit target ($)', saved.dailyProfitTarget || 200, { min: 1, max: 1000000, step: 10, suffix: '$',
        hint: 'Per book (paper and live separately), realized net P/L of the New York day.', onCommit: (x) => SD.settings.request({ dailyProfitTarget: Math.round(x * 100) / 100 }) }),
      // Phase 89: cross-market limits (risk/exposure-limits.js).
      field('settings-max-positions', 'Max automated positions open at once', Number.isInteger(saved.maxOpenPositions) ? saved.maxOpenPositions : 0, { min: 0, max: 100, step: 1, suffix: 'each',
        hint: `Per book, every market, open + waiting in Approvals. 0 = off. Options + crypto paper risk together is also capped at the ${pct}% ceiling of the combined `
          + `${money((saved.bankroll || 0) + (saved.cryptoBankroll || 0))} paper bankrolls.`, onCommit: (v) => SD.settings.request({ maxOpenPositions: Math.round(v) }) }));
  }

  SD.portfolioRiskSettings = { render };
})();
