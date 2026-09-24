// Portfolio → adopt an external Coinbase holding (or stop managing one).
// The inline form collects quantity, stop, target and a strategy label and
// sends ADOPT_POSITION; the server re-checks everything against the synced
// holding and the live price. WATCH ONLY: SignalDesk alerts at the levels but
// places no orders at Coinbase. The form state survives the re-render on every
// price tick (portfolio.js restores focus by element id).
// Exposes window.SignalDesk.portfolioAdopt.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price } = SD.ui;

  const STRATEGIES = [['adopted-hold', 'Long-term hold (1D)'], ['adopted-swing', 'Swing (4h)'], ['adopted-trend', 'Trend follow (1h)']];
  const form = { asset: null, qty: '', stop: '', target: '', strategy: 'adopted-hold', error: '', pending: false };
  let pendingTimer = null;

  const coin = (asset) => asset.replace('-USD', '');
  const open = (row) => Object.assign(form, { asset: row.p.asset, qty: String(row.p.freeQty), stop: '', target: '', strategy: 'adopted-hold', error: '', pending: false });
  const close = () => Object.assign(form, { asset: null, error: '', pending: false });

  // A synced holding with a quantity SignalDesk does not manage yet can be adopted.
  const canAdopt = (row) => row.p.execution === 'BROKER' && row.p.broker === 'Coinbase' && row.p.freeQty > 0;
  const isOpen = (row) => form.asset === row.p.asset;

  function button(row, opts) {
    const b = el('button', { type: 'button', className: `btn ${isOpen(row) ? '' : 'btn-solid'} pf-adopt-btn`, textContent: isOpen(row) ? 'Cancel' : 'Adopt Position',
      title: `Have SignalDesk watch ${row.p.freeQty} ${coin(row.p.asset)} with your stop and target (alerts only; no orders)` });
    b.onclick = (e) => { e.stopPropagation(); if (isOpen(row)) close(); else open(row); opts.rerender(); };
    return b;
  }

  // Capital at risk / reward preview, from the CURRENT form values and live price.
  function previewText(live) {
    const qty = Number(form.qty); const stop = Number(form.stop); const target = Number(form.target);
    const atRisk = live > 0 && stop > 0 && stop < live && qty > 0 ? (live - stop) * qty : null;
    const reward = live > 0 && target > live && qty > 0 ? (target - live) * qty : null;
    return `Capital at risk if the stop is hit: ${atRisk === null ? '—' : money(atRisk)} · Reward at target: ${reward === null ? '—' : money(reward)}`;
  }

  // Typing updates the form state and the preview in place (no re-render, so focus stays).
  function input(id, key, placeholder, live) {
    const i = el('input', { id, type: 'number', step: 'any', min: '0', className: 'scan-input', placeholder, value: form[key] });
    i.oninput = () => {
      form[key] = i.value;
      const pv = document.getElementById('adopt-preview');
      if (pv) pv.textContent = previewText(live);
    };
    return i;
  }

  function formRow(row, colSpan, opts) {
    const live = opts.livePrice(row.p.asset);
    const strategy = el('select', { id: 'adopt-strategy', className: 'scan-select' }, STRATEGIES.map(([v, l]) => el('option', { value: v, textContent: l })));
    strategy.value = form.strategy;
    strategy.onchange = () => { form.strategy = strategy.value; };
    const submit = el('button', { type: 'submit', className: 'btn btn-solid', textContent: form.pending ? 'Adopting…' : 'Adopt & watch', disabled: form.pending || !opts.online });
    const f = el('form', { className: 'pf-adopt-form', noValidate: true }, [
      el('label', {}, [el('span', { textContent: `Quantity (max ${row.p.freeQty})` }), input('adopt-qty', 'qty', String(row.p.freeQty), live)]),
      el('label', {}, [el('span', { textContent: `Stop loss (below ${live > 0 ? price(live, row.p) : '—'})` }), input('adopt-stop', 'stop', 'below the live price', live)]),
      el('label', {}, [el('span', { textContent: 'Take profit (T1)' }), input('adopt-target', 'target', 'above the live price', live)]),
      el('label', {}, [el('span', { textContent: 'Strategy' }), strategy]),
      submit,
    ]);
    f.onsubmit = (e) => {
      e.preventDefault();
      // Read everything NOW: the form may have been drawn several price ticks ago.
      const nowLive = opts.livePrice(row.p.asset);
      const qty = Number(form.qty); const stop = Number(form.stop); const target = Number(form.target);
      const problem = !(nowLive > 0) ? 'No live price for this coin: SignalDesk could not watch it.'
        : !(qty > 0 && qty <= row.p.freeQty * (1 + 1e-9)) ? `Quantity must be above 0 and at most ${row.p.freeQty}.`
          : !(stop > 0 && stop < nowLive) ? 'Stop loss must be below the live price.'
            : !(target > nowLive) ? 'Take profit must be above the live price.' : '';
      if (problem) { form.error = problem; return opts.rerender(); }
      Object.assign(form, { pending: true, error: '' });
      opts.send({ type: 'ADOPT_POSITION', payload: { asset: row.p.asset, size: qty, avgEntryPrice: row.p.fillPrice, stopLoss: stop, takeProfit: target, strategy: form.strategy } });
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { if (form.pending) { form.pending = false; form.error = 'No response from the server. Try again.'; opts.rerender(); } }, 10000);
      return opts.rerender();
    };
    return el('tr', { className: 'pf-adopt-row' }, el('td', { colSpan }, [
      el('div', { className: 'pf-adopt-head' }, [el('strong', { textContent: `Adopt ${coin(row.p.asset)} from your Coinbase account` }),
        el('span', { textContent: `Live ${live > 0 ? price(live, row.p) : '—'} · Coinbase average entry ${row.p.fillPrice > 0 ? price(row.p.fillPrice, row.p) : 'unknown'}` })]),
      f,
      el('p', { className: 'pf-adopt-preview', id: 'adopt-preview', textContent: previewText(live) }),
      ...(form.error ? [el('p', { className: 'pf-error', textContent: form.error })] : []),
      el('p', { className: 'pf-adopt-note', textContent: 'SignalDesk will watch this holding and alert you near the stop and at your stop or target. '
        + 'It places NO orders at Coinbase: nothing sells automatically, and to exit you still sell at Coinbase.' }),
    ]));
  }

  // "Stop managing" for each adopted position inside a synced holding.
  function releaseList(row, opts) {
    const adopted = (row.p.tracked || []).filter((t) => t.adopted);
    if (!adopted.length) return null;
    return el('div', { className: 'pf-adopted' }, [el('h4', { className: 'pf-h4', textContent: 'Adopted by SignalDesk (alerts only)' }),
      ...adopted.map((t) => {
        const b = el('button', { type: 'button', className: 'btn pf-close', textContent: 'Stop managing', disabled: !opts.online });
        b.onclick = () => {
          if (!window.confirm(`Stop managing ${t.positionSize} ${coin(t.asset)}?\n\nSignalDesk stops watching its stop and target. Your coins at Coinbase are not touched.`)) return;
          opts.send({ type: 'RELEASE_POSITION', id: t.id });
        };
        return el('div', { className: 'pf-kv' }, [el('span', { textContent: `${t.positionSize} ${coin(t.asset)} · stop ${price(t.invalidation, t)} · T1 ${price(t.targets[0].price, t)}` }), b]);
      })]);
  }

  // app.js: a POSITIONS_UPDATED after our ADOPT_POSITION means it was recorded.
  function positionsUpdated() { if (form.pending) { clearTimeout(pendingTimer); close(); } }
  function failed(error) { clearTimeout(pendingTimer); form.pending = false; form.error = String(error).replace(/^ADOPT_REJECTED: /, ''); }

  SD.portfolioAdopt = { canAdopt, isOpen, button, formRow, releaseList, positionsUpdated, failed };
})();
