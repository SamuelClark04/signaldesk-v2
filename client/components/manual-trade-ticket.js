// Manual Trade Ticket (Phase 60): the [+ Manual Trade] button next to the symbol
// picker opens this ticket, pre-filled with the charted asset.
//   Stock (Paper)   long / short, $ size (default $300), stop (1.5 x ATR) + T1 / T2
//   Crypto          Paper or Live @ Coinbase (live USD cash shown; only while Settings
//                   has Coinbase on LIVE; long only), $ size (default $20), stop / T1
//   Options         the 25 optionables (manual-options-ticket.js)
// Every number shown comes from the SERVER (MANUAL_TRADE_PREVIEW: the real risk engine,
// fee model and sizing), re-asked 300 ms after each edit; the open button sends the
// same ticket (MANUAL_TRADE_OPEN) and the server re-prices it on live data. A modal on
// <body>: the page's re-render on every tick never touches it.
// Exposes window.SignalDesk.manualTicket: { button(asset, ctx), open(asset), received(type, payload) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, signed } = SD.ui;

  const MODES = [['stock', 'Stock (Paper)'], ['crypto', 'Crypto'], ['options', 'Options']];
  let t = null; // the open ticket's state
  let root = null;
  let seq = 0;
  let timer = null;
  const req = (type, extra) => { const requestId = ++seq; SD.app.send({ type, requestId, ...extra }); return requestId; };
  const num = (x) => (x === '' || x === null || x === undefined ? NaN : Number(x));
  const optionable = (a) => { const u = SD.app.state && SD.app.state.universe; return !!(u && (u.optionableStocks || []).includes(a)); };

  function fresh(asset, mode) {
    return { asset, mode, direction: 'long', venue: 'paper', amount: '', stop: '', t1: '', t2: '', touched: {}, defaults: null, defReq: 0, preview: null, prevReq: 0,
      busy: false, openReq: 0, result: null, opt: SD.manualOptionsTicket.fresh() };
  }

  // opts.moonshot: { score } from the Moonshot Radar (Phase 60B): sized at the Smart Investment Amount.
  function open(asset, opts = {}) {
    const a = String(asset || 'SPY').toUpperCase();
    t = { ...fresh(a, a.includes('-') ? 'crypto' : 'stock'), moonshot: a.includes('-') && opts.moonshot ? { score: opts.moonshot.score ?? null } : null };
    loadDefaults();
    render();
  }
  function close() { clearTimeout(timer); t = null; if (root) root.remove(); root = null; }

  function setMode(mode) {
    const keep = t.asset;
    t = { ...fresh(keep, mode), venue: t.venue, moonshot: t.moonshot };
    if (mode === 'options') SD.manualOptionsTicket.enter(t, api); else loadDefaults();
    render();
  }

  function loadDefaults() {
    if (t.mode === 'options') return;
    t.defReq = req('MANUAL_TRADE_DEFAULTS', { mode: t.mode, asset: t.asset, direction: t.direction, venue: t.venue, moonshot: t.moonshot });
  }

  function ticket() {
    if (t.mode === 'options') return SD.manualOptionsTicket.ticket(t);
    return { mode: t.mode, asset: t.asset, direction: t.direction, venue: t.venue, amount: num(t.amount), stop: num(t.stop), t1: num(t.t1), t2: t.venue === 'live' ? null : num(t.t2), moonshot: t.moonshot };
  }
  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (t) { t.prevReq = req('MANUAL_TRADE_PREVIEW', { ticket: ticket() }); } }, 300);
  }
  const api = { req, render: () => render(), schedulePreview };

  // Server replies (app.js).
  function received(type, p) {
    if (!t || !p) return;
    if (type === 'MANUAL_TRADE_DEFAULTS' && p.requestId === t.defReq) {
      t.defaults = p;
      if (p.ok) for (const k of ['amount', 'stop', 't1', 't2']) if (!t.touched[k] && p[k] !== null && p[k] !== undefined) t[k] = String(p[k]);
      schedulePreview();
    } else if (type === 'MANUAL_TRADE_PREVIEW' && p.requestId === t.prevReq) {
      t.preview = p;
      // Moonshot ticket (Phase 60B): until the user edits it, the size follows the risk
      // engine's live Smart Investment Amount (it moves with the price vs the stop).
      const ms = t.defaults && t.defaults.moonshot;
      if (ms && !ms.error && !t.touched.amount && p.ok && p.engineMax > 0) {
        if (Math.abs(num(t.amount) - p.engineMax) / p.engineMax > 0.005) { t.amount = String(Math.floor(p.engineMax * 100) / 100); schedulePreview(); }
        Object.assign(ms, { amount: num(t.amount), risk: p.dollarRisk });
      }
    } else if (type === 'MANUAL_TRADE_RESULT' && p.requestId === t.openReq) {
      t.busy = false;
      t.result = p;
      if (p.ok) setTimeout(() => { if (t && t.result === p) close(); }, 1800);
    } else if (type === 'MANUAL_OPTIONS') {
      SD.manualOptionsTicket.received(t, p, api);
    } else return;
    render();
  }

  // ---------- Rendering (focus and caret restored by element id) ----------
  const field = (id, label, key, opts = {}) => {
    const input = el('input', { id: `mt-${id}`, className: 'input mt-input', type: 'text', inputMode: 'decimal', value: t[key], placeholder: opts.placeholder || '', disabled: !!opts.disabled });
    input.oninput = () => { t[key] = input.value; t.touched[key] = true; schedulePreview(); };
    return el('label', { className: 'mt-field' }, [el('span', { className: 'mt-label', textContent: label }),
      el('span', { className: 'input-wrap' }, [...(opts.prefix ? [el('span', { className: 'input-prefix', textContent: opts.prefix })] : []), input])]);
  };
  const seg = (items, active, onPick, cls = '') => el('div', { className: `mt-seg ${cls}`, role: 'radiogroup' }, items.map(([k, label, disabled]) => {
    const b = el('button', { type: 'button', className: `mt-seg-btn${k === active ? ' is-active' : ''}`, textContent: label, disabled: !!disabled });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === active));
    b.onclick = () => { if (k !== active) onPick(k); };
    return b;
  }));
  const kv = (k, v, cls = '') => el('div', { className: 'mt-kv' }, [el('span', { textContent: k }), el('strong', { className: cls, textContent: v })]);
  const pnl = (x) => (Number.isFinite(x) ? signed(x, money) : '—');
  const cls = (x) => (x > 0 ? 'pnl-pos' : x < 0 ? 'pnl-neg' : '');

  function linearForm() {
    const d = t.defaults;
    const live = t.venue === 'live';
    const rows = [];
    if (t.mode === 'crypto') {
      rows.push(el('div', { className: 'mt-row' }, [el('span', { className: 'mt-label', textContent: 'Venue' }),
        seg([['paper', 'Paper'], ['live', `Live @ Coinbase${d && d.ok && live && d.coinbaseCash !== null ? ` · ${money(d.coinbaseCash)} USD cash` : ''}`, !(d && d.liveAllowed)]], t.venue, (v) => {
          t.venue = v; if (v === 'live') t.direction = 'long'; t.preview = null; loadDefaults(); render();
        })]));
      if (d && d.ok && !d.liveAllowed) rows.push(el('p', { className: 'mt-note', textContent: 'Live @ Coinbase is off: Settings has Coinbase on PAPER.' }));
      const ms = d && d.moonshot;
      if (ms) rows.push(el('p', { className: `mt-note mt-moon${ms.error ? ' is-warn' : ''}`, textContent: ms.error ? `Moonshot sizing unavailable: ${ms.error}`
        : `Moonshot Smart Investment Amount: ${money(ms.amount)} = ${Math.round(ms.scale * 100)}% of normal risk (radar ${ms.score ?? '—'}/100; risks ${money(ms.risk)} at the stop).` }));
    }
    rows.push(el('div', { className: 'mt-row' }, [el('span', { className: 'mt-label', textContent: 'Direction' }),
      seg([['long', 'LONG'], ['short', 'SHORT', live]], t.direction, (v) => { t.direction = v; t.touched = { amount: t.touched.amount }; loadDefaults(); render(); }, 'mt-dir')]));
    rows.push(el('div', { className: 'mt-grid' }, [
      field('amount', 'Dollar size', 'amount', { prefix: '$' }),
      field('stop', `Stop loss${d && d.stopBasis === 'fee floor' ? ' (fee-gate minimum)' : d && d.atr ? ` (1.5 × ATR ${d.atr.toFixed(d.price >= 1 ? 2 : 6)})` : ''}`, 'stop'),
      field('t1', live ? 'Take profit (bracket)' : 'Target T1', 't1'),
      ...(live ? [] : [field('t2', 'Target T2 (optional)', 't2')]),
    ]));
    return rows;
  }

  function linearPreview() {
    const p = t.preview;
    const d = t.defaults;
    const px = p && p.price ? p.price : d && d.price;
    const head = el('div', { className: 'mt-live' }, [el('span', { textContent: `${t.asset} ${px ? `@ ${px}` : ''}` }),
      el('span', { className: 'mt-k', textContent: p && p.priceBasis ? p.priceBasis : d && d.ok && !d.live ? 'last close (no live price)' : 'live' })]);
    if (!p) return [head, el('p', { className: 'mt-note', textContent: 'Pricing…' })];
    if (!p.ok) return [head, el('p', { className: 'mt-error', textContent: p.error })];
    const unit = t.mode === 'stock' ? 'Shares' : 'Coins';
    return [head, el('div', { className: 'mt-grid mt-out' }, [
      kv(unit, `${t.mode === 'stock' ? p.qty.toFixed(4).replace(/\.?0+$/, '') : p.qty.toFixed(8).replace(/\.?0+$/, '')} · ${money(p.notional)}`),
      kv('Risk ($) at the stop', money(p.dollarRisk), 'pnl-neg'),
      kv('Target net ($) at T1', pnl(p.t1Net), cls(p.t1Net)),
      ...(p.t2Net !== null ? [kv('Net at T2 / plan', `${pnl(p.t2Net)} / ${pnl(p.planNet)}`, cls(p.t2Net))] : []),
      kv('Fees (est.)', money(p.fees)),
      kv('Net R:R (T1)', p.rr ? `${p.rr.toFixed(2)} : 1` : '—'),
    ]), ...(p.aboveEngineMax ? [el('p', { className: 'mt-note is-warn', textContent: `Above the risk engine's ${money(p.engineMax)} max safe size.` })] : [])];
  }

  function actions() {
    const tk = ticket();
    const live = t.venue === 'live' && t.mode === 'crypto';
    const label = t.mode === 'stock' ? 'Open Paper Stock Trade' : t.mode === 'options' ? 'Open Paper Options Trade' : live ? 'Place LIVE Order @ Coinbase' : 'Open Paper Crypto Trade';
    const ok = t.preview && t.preview.ok && t.preview.live !== false && SD.app.isOnline() && !t.busy && (t.mode !== 'options' || tk.spec);
    const b = el('button', { type: 'button', id: 'mt-open', className: `btn btn-solid mt-go${live ? ' is-live' : ''}`, textContent: t.busy ? 'Opening…' : label, disabled: !ok });
    b.onclick = () => {
      const p = t.preview;
      if (live && !window.confirm(`Place a LIVE order at Coinbase?\n\nBUY ${p.qty} ${t.asset} (${money(p.notional)}) at market\nStop ${tk.stop} · Take profit ${tk.t1} (bracket at Coinbase)\n\nThis uses real money.`)) return;
      t.busy = true;
      t.result = null;
      t.openReq = req('MANUAL_TRADE_OPEN', { ticket: { ...tk, confirmLive: live } });
      render();
    };
    const res = t.result;
    return el('div', { className: 'mt-actions' }, [b,
      ...(res ? [el('p', { className: res.ok ? 'mt-ok' : 'mt-error', textContent: res.ok ? `Opened: ${res.position.positionSize} ${res.position.asset} (${res.position.execution}${res.position.brokerId ? ` · ${res.position.brokerId}` : ''})` : res.error })] : [])]);
  }

  function render() {
    if (!t) return;
    const focus = document.activeElement && document.activeElement.id;
    const caret = focus && document.activeElement.selectionStart;
    const assetIn = el('input', { id: 'mt-asset', className: 'input mt-asset', type: 'text', value: t.asset, spellcheck: false, autocomplete: 'off' });
    assetIn.onchange = () => {
      const a = assetIn.value.trim().toUpperCase();
      if (!a || a === t.asset) return;
      const mode = a.includes('-') ? 'crypto' : t.mode === 'crypto' || (t.mode === 'options' && !optionable(a)) ? 'stock' : t.mode;
      t.asset = a;
      t.moonshot = null; // another coin: no radar score
      setMode(mode);
    };
    const modes = MODES.map(([k, label]) => [k, label, (k === 'options' && !optionable(t.asset)) || (k === 'crypto') !== t.asset.includes('-')]);
    const body = t.mode === 'options' ? SD.manualOptionsTicket.section(t, api) : [...linearForm(), ...linearPreview()];
    const panel = el('div', { className: 'mt-panel', role: 'dialog', ariaModal: 'true', ariaLabel: 'Manual trade ticket' }, [
      el('header', { className: 'mt-head' }, [el('strong', { textContent: 'Manual Trade' }), assetIn,
        el('button', { type: 'button', className: 'btn mt-x', textContent: '×', title: 'Close', onclick: close })]),
      seg(modes, t.mode, setMode, 'mt-modes'),
      el('div', { className: 'mt-body' }, body),
      actions(),
      el('p', { className: 'mt-foot', textContent: 'Sized and checked by the risk engine and the order guard, like any setup. Paper unless you pick Live @ Coinbase.' }),
    ]);
    const next = el('div', { className: 'mt-overlay', id: 'mt-overlay' }, [panel]);
    next.onclick = (e) => { if (e.target === next) close(); };
    if (root) root.replaceWith(next); else document.body.append(next);
    root = next;
    const f = focus && document.getElementById(focus);
    if (f && f.closest('#mt-overlay')) { f.focus(); try { if (caret !== null && caret !== undefined) f.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && t) close(); });

  function button(asset) {
    const b = el('button', { type: 'button', className: 'btn btn-solid mt-launch', textContent: '+ Manual Trade', title: `Open a manual trade ticket for ${asset}` });
    b.onclick = () => open(asset);
    return b;
  }

  SD.manualTicket = { button, open, close, received, isOpen: () => !!t };
})();
