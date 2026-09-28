// Edit an open long's stop / T1 (Phase 70D), on the position card: [✎ Edit stop / T1] opens an
// inline form (stop, T1, their % from the live bid and the R:R), with a one-click suggestion from
// the live bid (standard crypto: stop -4%, Moonshot -5.5%; T1 at 2.5R). A stop only TIGHTENS (moves
// up, under the bid); T1 must be above the bid. Apply sends EDIT_LEVELS; LIVE positions confirm
// first (the venue's resting stop is canceled and re-placed: server level-edit.js). Drafts survive
// the card's re-renders; no answer in TIMEOUT_MS or a reconnect frees the form.
// Exposes window.SignalDesk.levelEditor: { block(p, m, ctx), received(r), reset() }.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const TIMEOUT_MS = 35000;
  const drafts = new Map(); // position id -> { stop, t1, focus }
  const busy = new Map(); // position id -> its timeout
  const toast = (text, ok) => SD.liveClose.toast(text, ok);
  const live = (p) => p.execution === 'LIVE' && !p.adopted;
  const pctOf = (x, bid) => (bid > 0 && x > 0 ? `${x >= bid ? '+' : '−'}${Math.abs((x / bid - 1) * 100).toFixed(1)}%` : '');
  const bidOf = (p, m) => { const b = SD.app && SD.app.state && SD.app.state.bids; return b && b[p.asset] > 0 ? b[p.asset] : m && m.price > 0 ? m.price : null; };
  const editable = (p) => p.direction !== 'short' && p.market !== 'options' && (!live(p) || ['Coinbase', 'Kraken', 'OKX'].includes(p.broker)) && !p.marketExitPending;
  const decimals = (p) => SD.ui.decimalsFor(p.fillPrice || p.entryPrice || 1);

  function suggestion(p, bid) {
    const pct = p.speculative || /Moonshot/i.test(`${p.tag || ''} ${p.setupType || ''}`) ? 0.055 : 0.04;
    const stop = bid * (1 - pct);
    return { stop: Number(stop.toFixed(decimals(p))), t1: Number((bid + 2.5 * (bid - stop)).toFixed(decimals(p))), pct };
  }

  function send(p, stop, t1, bid) {
    if (busy.has(p.id) || !SD.app.isOnline()) return;
    const ch = [stop !== p.invalidation ? `the stop from ${price(p.invalidation, p)} UP to ${price(stop, p)} (${pctOf(stop, bid)})` : '', t1 ? `T1 to ${price(t1, p)} (${pctOf(t1, bid)})` : ''].filter(Boolean).join(' and ');
    if (live(p) && !window.confirm(`Move ${ch} on ${p.positionSize} ${p.asset.replace(/-USDC?$/, '')} at ${p.broker}?\n\n`
      + (stop !== p.invalidation || p.broker === 'Coinbase' ? `SignalDesk cancels the resting ${p.broker === 'Coinbase' ? 'stop/target bracket' : 'stop'} at ${p.broker}, waits for the coins and places the new one. If ${p.broker} refuses it, the original stop is put back. ` : '')
      + (p.broker !== 'Coinbase' ? `T1 is taken by SignalDesk (a market sell when the bid reaches it).` : ''))) return;
    busy.set(p.id, setTimeout(() => { if (!busy.has(p.id)) return; busy.delete(p.id); toast('Level edit timed out — check the position (and the broker) before retrying', false); SD.app.refresh(); }, TIMEOUT_MS));
    SD.app.send({ type: 'EDIT_LEVELS', id: p.id, ...(stop !== p.invalidation ? { stop } : {}), ...(t1 ? { t1 } : {}) });
    SD.app.refresh();
  }

  function block(p, m, ctx) {
    if (!editable(p)) return null;
    const bid = bidOf(p, m);
    const t1Now = p.targets && p.targets[0] && p.targets[0].price;
    const d = drafts.get(p.id);
    if (!d) {
      const b = el('button', { type: 'button', className: 'btn lv-edit-btn', disabled: !(ctx && ctx.online) || busy.has(p.id), textContent: busy.has(p.id) ? 'Moving levels…' : '✎ Edit stop / T1',
        title: 'Tighten the stop (up only) and / or move T1' });
      b.onclick = () => { drafts.set(p.id, { stop: String(p.invalidation), t1: String(t1Now || ''), focus: null }); SD.app.refresh(); };
      return b;
    }
    const inp = (key) => {
      const i = el('input', { className: 'input lv-input', type: 'number', step: 'any', inputMode: 'decimal', value: d[key] });
      i.oninput = () => { d[key] = i.value; d.focus = key; };
      if (d.focus === key) requestAnimationFrame(() => { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch { /* number input */ } });
      return i;
    };
    const stop = Number(d.stop);
    const t1 = Number(d.t1);
    const rr = stop > 0 && t1 > 0 && bid > stop ? ((t1 - bid) / (bid - stop)).toFixed(2) : '—';
    const sug = bid > 0 ? suggestion(p, bid) : null;
    const apply = el('button', { type: 'button', className: 'btn btn-solid', disabled: busy.has(p.id) || !(ctx && ctx.online), textContent: busy.has(p.id) ? 'Moving…' : 'Apply' });
    apply.onclick = () => {
      if (!(stop > 0) || !(t1 > 0)) return toast('Enter a stop and a T1', false);
      if (stop < p.invalidation) return toast(`A stop can only be tightened: it is ${price(p.invalidation, p)}`, false);
      send(p, stop, t1 !== t1Now ? t1 : null, bid);
    };
    const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Cancel' });
    cancel.onclick = () => { drafts.delete(p.id); SD.app.refresh(); };
    const preset = sug ? el('button', { type: 'button', className: 'lwc-tool lv-suggest', textContent: `Suggested: stop −${(sug.pct * 100).toFixed(1)}% · T1 2.5R`,
      title: `Stop ${price(sug.stop, p)} · T1 ${price(sug.t1, p)} from the bid ${price(bid, p)}` }) : null;
    if (preset) preset.onclick = () => { d.stop = String(Math.max(sug.stop, p.invalidation)); d.t1 = String(sug.t1); d.focus = null; SD.app.refresh(); };
    return el('div', { className: 'lv-form' }, [
      el('div', { className: 'lv-row' }, [el('label', { className: 'lv-field' }, ['Stop', inp('stop'), el('span', { className: 'lv-pct text-short', textContent: pctOf(stop, bid) })]),
        el('label', { className: 'lv-field' }, ['T1', inp('t1'), el('span', { className: 'lv-pct text-long', textContent: pctOf(t1, bid) })])]),
      el('div', { className: 'lv-row' }, [el('span', { className: 'lv-note', textContent: `From the bid ${bid ? price(bid, p) : '—'} · reward : risk ${rr} : 1 · the stop only moves up` }), ...(preset ? [preset] : [])]),
      el('div', { className: 'lv-row' }, [apply, cancel]),
    ]);
  }

  function received(r) {
    if (!r) return;
    clearTimeout(busy.get(r.id)); busy.delete(r.id);
    if (!r.ok) toast(`Level edit failed: ${r.error}`, false);
    else if (r.alreadyClosed) toast(`Not moved: ${r.detail}`, true);
    else { drafts.delete(r.id); toast(`Levels updated: stop ${r.stop}${r.t1 ? ` · T1 ${r.t1}` : ''}${r.venue !== 'ledger' ? ` (${r.broker} ${r.venue === 'coinbase' ? 'bracket' : 'stop'} re-placed)` : ''}.`, true); }
    SD.app.refresh();
  }

  function reset() {
    if (!busy.size) return;
    for (const [id, t] of busy) { clearTimeout(t); busy.delete(id); }
    toast('Connection was lost during a level edit: check the position before retrying.', false);
  }

  SD.levelEditor = { block, received, reset };
})();
