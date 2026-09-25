// Portfolio → "+ Add External Holding (Robinhood / Other)": the inline form for
// holdings at brokers SignalDesk cannot reach (manual) and the Edit / Remove
// actions on their Holdings rows; also custom stop / T1 for a broker-synced
// holding ("Levels"). REST (server/execution/external-api.js), same-origin with
// the session cookie; the server pushes EXTERNAL_HOLDINGS to every client after
// each change, so nothing here keeps holdings of its own.
//   add     Symbol, Shares / qty (0.0001), Avg price (blank: the live price),
//           Account label (default Robinhood), optional Stop / T1 override
//   edit    the same fields for one manual holding (blank Stop / T1 = the Pilot's)
//   levels  Stop / T1 only, for a Coinbase / Alpaca holding bought outside SignalDesk
// Inputs carry ids so portfolio.js keeps focus across its re-renders.
// Exposes window.SignalDesk.externalForm.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;

  const FIELDS = [['symbol', 'Symbol', 'NVDA or BTC-USD'], ['quantity', 'Shares / qty', '1.25'], ['avgCost', 'Avg price', 'blank = live price'],
    ['brokerLabel', 'Account', 'Robinhood'], ['customStop', 'Stop (optional)', 'Pilot level'], ['customT1', 'T1 (optional)', 'Pilot level']];
  let form = null; // { mode: 'add'|'edit'|'levels', id, target, values, busy, error }

  const open = (mode, p, values, rerender) => { form = { mode, id: p ? p.id : null, target: p, values, busy: false, error: '' }; rerender(); };
  const close = (rerender) => { form = null; rerender(); };
  const isEditing = (p) => !!form && form.mode !== 'add' && form.id === p.id;
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function save(rerender) {
    const v = form.values;
    form.busy = true; form.error = ''; rerender();
    try {
      if (form.mode === 'levels') {
        const [venue] = form.target.id.split(':');
        await call('PUT', `/api/portfolio/external-broker/${venue}/${encodeURIComponent(form.target.asset)}`, { customStop: num(v.customStop), customT1: num(v.customT1) });
      } else {
        const body = { symbol: v.symbol, quantity: num(v.quantity), avgCost: num(v.avgCost), brokerLabel: v.brokerLabel, customStop: num(v.customStop), customT1: num(v.customT1) };
        if (form.mode === 'add') await call('POST', '/api/portfolio/external', body);
        else await call('PUT', `/api/portfolio/external/${encodeURIComponent(form.target.ref)}`, body);
      }
      form = null;
    } catch (err) {
      form.busy = false; form.error = err.message;
    }
    rerender();
  }

  function fields(rerender) {
    const shown = form.mode === 'levels' ? FIELDS.slice(4) : FIELDS;
    return shown.map(([key, label, hint]) => {
      const input = el('input', { className: 'input', id: `ext-${key}`, value: form.values[key] ?? '', placeholder: hint, autocomplete: 'off', spellcheck: false,
        inputMode: key === 'symbol' || key === 'brokerLabel' ? 'text' : 'decimal', disabled: form.busy });
      input.oninput = () => { form.values[key] = input.value; };
      return el('label', { className: 'field pf-ext-field' }, [el('span', { className: 'field-label', textContent: label }), input]);
    });
  }

  function panel(rerender) {
    const title = form.mode === 'add' ? 'Add a holding held outside SignalDesk' : form.mode === 'edit' ? `Edit ${form.target.asset} (${form.target.broker})`
      : `Stop / T1 for ${form.target.asset} at ${form.target.broker}`;
    const ok = el('button', { type: 'button', className: 'btn btn-solid', textContent: form.busy ? 'Saving…' : form.mode === 'add' ? 'Add holding' : 'Save', disabled: form.busy });
    ok.onclick = () => save(rerender);
    const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Cancel', disabled: form.busy });
    cancel.onclick = () => close(rerender);
    return el('div', { className: 'pf-ext-form' }, [
      el('strong', { className: 'pf-ext-title', textContent: title }),
      el('div', { className: 'pf-ext-fields' }, fields(rerender)),
      el('p', { className: 'pf-sub', textContent: form.mode === 'levels' ? 'Blank = the Pilot\'s protective levels (8-18% structural stop, T1 2.5R, T2 4.5R).'
        : 'SignalDesk tracks its live price, gives it the Pilot\'s protective stop / T1 / T2 (unless you set your own), counts it in the Pilot matrix and "What to Buy", '
          + 'and turns sells / trims into instruction cards in Approvals: you trade at your broker, then confirm there. No order is ever sent to it.' }),
      ...(form.error ? [el('p', { className: 'pf-ext-error', textContent: form.error })] : []),
      el('div', { className: 'pf-ext-actions' }, [ok, cancel]),
    ]);
  }

  // The "+ Add" button, plus the add form when it is open.
  function bar(opts) {
    const b = el('button', { type: 'button', className: 'btn pf-ext-add', textContent: '+ Add External Holding (Robinhood / Other)', disabled: !!form && form.mode === 'add' });
    b.onclick = () => open('add', null, { brokerLabel: 'Robinhood' }, opts.rerender);
    return el('div', { className: 'pf-ext-bar' }, [b, ...(form && form.mode === 'add' ? [panel(opts.rerender)] : [])]);
  }

  // Row actions: Edit / Remove for a manual holding, Levels for a synced one.
  function rowActions(p, opts) {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    if (p.external === 'manual') {
      const edit = el('button', { type: 'button', className: 'btn pf-close', textContent: 'Edit' });
      const raw = (((opts.state || {}).external || {}).holdings || []).find((h) => h.id === p.ref) || {};
      edit.onclick = stop(() => open('edit', p, { symbol: p.asset, quantity: String(p.positionSize), avgCost: String(p.fillPrice), brokerLabel: p.broker,
        customStop: raw.customStop ? String(raw.customStop) : '', customT1: raw.customT1 ? String(raw.customT1) : '' }, opts.rerender));
      const del = el('button', { type: 'button', className: 'btn pf-close', textContent: 'Remove' });
      del.onclick = stop(() => {
        if (!window.confirm(`Remove ${p.positionSize} ${p.asset} (${p.broker}) from SignalDesk?\n\nThis only stops tracking it: nothing is sold at ${p.broker}.`)) return;
        call('DELETE', `/api/portfolio/external/${encodeURIComponent(p.ref)}`).catch((err) => window.alert(`Not removed: ${err.message}`));
      });
      return [edit, del];
    }
    const lv = el('button', { type: 'button', className: 'btn pf-close', textContent: 'Levels', title: 'Set your own stop / T1 for this holding' });
    lv.onclick = stop(() => open('levels', p, { customStop: '', customT1: '' }, opts.rerender));
    return [lv];
  }

  // Edit / levels form as a table row under its holding.
  const formRow = (colSpan, opts) => el('tr', { className: 'pf-ext-row' }, el('td', { colSpan }, panel(opts.rerender)));

  SD.externalForm = { bar, rowActions, formRow, isEditing };
})();
