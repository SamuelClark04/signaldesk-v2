// Journal > Backtest (Phase 77): replay a strategy's live rules over past bars (server/backtest). Pick a rule and a
// window, [Run Backtest]; progress lines while the server downloads / replays, then the report: trades, win rate,
// total / average R, profit factor, max drawdown, best / worst symbols, recent trades and what the replay leaves out.
// Market data only: a backtest never places an order. Exposes window.SignalDesk.backtest.
(() => {
  const SD = window.SignalDesk;
  const { $, el, clock } = SD.ui;
  let transport = { isOnline: () => false, send: () => {} };
  let catalog = null;
  let pending = null; // requestId of the run in flight

  const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
  const r2 = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const px = (x) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const status = (text, kind = '') => { const s = $('backtest-status'); s.textContent = text; s.className = `settings-status${kind ? ` is-${kind}` : ''}`; };

  function online() { if (transport.isOnline()) transport.send({ type: 'GET_BACKTESTS' }); }

  function received(c) {
    catalog = c;
    const sel = $('backtest-rule');
    const was = sel.value;
    sel.replaceChildren(...c.rules.map((r) => el('option', { value: r.id, textContent: `${r.label} · ${r.market}` })),
      ...c.unavailable.map((u) => el('option', { value: u.id, disabled: true, textContent: `${u.why.split(':')[0]}: not replayable`, title: u.why })));
    if (was && c.rules.some((r) => r.id === was)) sel.value = was;
    pickDays();
    $('backtest-unavailable').textContent = `Not replayable: ${c.unavailable.map((u) => u.why).join('. ')}.`;
    if (c.running && !pending) status(`A backtest is running on the server (${c.running.split('|').slice(0, 2).join(', ')} days).`);
  }

  function pickDays() {
    if (!catalog) return;
    const rule = catalog.rules.find((r) => r.id === $('backtest-rule').value) || catalog.rules[0];
    $('backtest-days').replaceChildren(...catalog.days.map((d) => el('option', { value: String(d), textContent: `Last ${d} days`, selected: d === rule.defaultDays })));
  }

  function run() {
    if (!transport.isOnline()) return status('Offline: cannot reach the server.', 'error');
    if (pending) return undefined;
    pending = `bt-${Date.now()}`;
    $('backtest-run').disabled = true;
    status('Starting…');
    transport.send({ type: 'RUN_BACKTEST', rule: $('backtest-rule').value, days: Number($('backtest-days').value), requestId: pending });
    return undefined;
  }

  function progress(p) { if (p && p.requestId === pending) status(`${p.text}…`); }

  const kpi = (label, value, cls = '', title = '') => el('div', { className: `bt-kpi ${cls}`, title }, [el('span', { className: 'bt-kpi-label', textContent: label }), el('strong', { textContent: value })]);

  function result(r) {
    if (!r || r.requestId !== pending) return;
    pending = null;
    $('backtest-run').disabled = false;
    if (!r.ok) { status(r.error || 'The backtest failed.', 'error'); return; }
    status(`${r.label}: ${r.from} → ${r.to}, ${r.symbols} symbols, ${r.strictness}${r.cached ? ' (from the last run)' : `, ${(r.runtimeMs / 1000).toFixed(0)} s`}.`, 'ok');
    const pf = r.profitFactor === null ? (r.wins ? '∞' : '—') : r.profitFactor.toFixed(2);
    const out = $('backtest-report');
    out.replaceChildren(
      el('div', { className: 'bt-kpis' }, [kpi('Trades', `${r.trades}${r.open ? ` (+${r.open} open)` : ''}`), kpi('Win rate', pct(r.winRate)),
        kpi('Total', r2(r.totalR), r.totalR >= 0 ? 'pnl-pos' : 'pnl-neg', 'Net of fees, in R (1R = the planned risk of a trade)'), kpi('Average', r2(r.avgR), (r.avgR || 0) >= 0 ? 'pnl-pos' : 'pnl-neg', 'Expectancy per trade'),
        kpi('Profit factor', pf, r.profitFactor !== null && r.profitFactor < 1 ? 'pnl-neg' : '', 'Gross wins ÷ gross losses (R)'),
        kpi('Max drawdown', `-${r.maxDrawdownR.toFixed(2)}R`, 'pnl-neg', 'Deepest peak-to-trough of the cumulative R curve (closed trades, in exit order)')]),
      el('p', { className: 'settings-note', textContent: r.trades < 30 ? `Only ${r.trades} closed trade(s): too few to trust the numbers either way.` : `${r.trades} closed trades.`
        + (r.open ? ` ${r.open} still open at the end (${r2(r.openR)} marked, not counted).` : '') }),
      ...(r.bySymbol.length ? [el('p', { className: 'bt-line', textContent: `Best: ${r.bySymbol.slice(0, 5).map((x) => `${x.symbol} ${r2(x.totalR)} (${x.trades})`).join(', ')}`
        + (r.bySymbol.length > 5 ? ` · Worst: ${r.bySymbol.slice(-3).reverse().map((x) => `${x.symbol} ${r2(x.totalR)} (${x.trades})`).join(', ')}` : '') })] : []),
      ...(r.recent.length ? [el('div', { className: 'table-wrap' }, el('table', { className: 'data-table bt-trades' }, [
        el('thead', {}, el('tr', {}, ['Opened', 'Symbol', 'Setup', 'Entry', 'Stop', 'T1', 'Exit', 'Net R'].map((h, i) => el('th', { className: i >= 3 && i !== 6 ? 'num' : '', textContent: h })))),
        el('tbody', {}, r.recent.slice(0, 12).map((t) => el('tr', {}, [el('td', { textContent: day(t.openedAt) }), el('td', { textContent: t.symbol }), el('td', { textContent: t.tag }),
          el('td', { className: 'num', textContent: px(t.entry) }), el('td', { className: 'num', textContent: px(t.stop) }), el('td', { className: 'num', textContent: px(t.t1) }),
          el('td', { textContent: t.exit }), el('td', { className: `num ${t.netR >= 0 ? 'pnl-pos' : 'pnl-neg'}`, textContent: r2(t.netR) })]))),
      ]))] : []),
      el('p', { className: 'bt-line', textContent: `Signals not taken: ${Object.entries(r.skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()} ${v}`).join(', ') || 'none'}.` }),
      el('ul', { className: 'bt-notes' }, r.notes.map((n) => el('li', { textContent: n }))),
      el('p', { className: 'bt-line sub', textContent: `Run ${clock(r.at)}.` }));
  }

  $('backtest-run').addEventListener('click', run);
  $('backtest-rule').addEventListener('change', pickDays);

  SD.backtest = { init: (t) => { transport = t; }, online, received, progress, result };
})();
