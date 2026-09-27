// Profit ratchet buttons (Phase 68), on the position card and the chart HUD. The server
// (ratchet.js) sends each long's plan (p.ratchet: 1R, the +1.0R / +1.5R triggers and the stop
// each one locks); the button appears when a trigger was touched (or is reached on this tick)
// and the new stop is still under the bid:
//   [🛡️ Lock Break-Even (+0.05R)]  stop -> fee break-even + 0.05R
//   [🛡️ Lock Profit (+0.5R)]       stop -> entry + 0.5R
// One click sends RATCHET_STOP; LIVE Coinbase positions confirm first (the bracket is canceled
// and re-placed at the new stop). The server re-checks everything; a stop only ever moves up.
// No answer in TIMEOUT_MS or a reconnect frees the button. Once locked: a short status line.
// Exposes window.SignalDesk.ratchet: { offer(p, bid), button(p, m, ctx), status(p), received(r), reset() }.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const TIMEOUT_MS = 35000;
  const busy = new Map(); // position id -> its timeout
  const toast = (text, ok) => SD.liveClose.toast(text, ok);
  const bidOf = (p, m) => { const b = SD.app && SD.app.state && SD.app.state.bids; return b && b[p.asset] > 0 ? b[p.asset] : m && m.price > 0 ? m.price : null; };
  const live = (p) => p.execution === 'LIVE' && !p.adopted && (p.broker === 'Coinbase' || p.broker === 'Kraken'); // + Kraken Pro (69A)

  // Mirror of ratchet.offer on the server: 'B' over 'A'.
  function offer(p, bid) {
    const pl = p.ratchet;
    if (!pl || !(bid > 0)) return null;
    for (const k of ['B', 'A']) {
      const s = pl[k];
      if ((pl.reached[k] || bid >= s.trigger) && s.stop > p.invalidation * (1 + 1e-9) && s.stop < bid) return k;
    }
    return null;
  }

  function free(id) { clearTimeout(busy.get(id)); busy.delete(id); }

  function request(p, k) {
    if (busy.has(p.id) || !SD.app.isOnline()) return;
    const s = p.ratchet[k];
    if (live(p) && !window.confirm(`${s.label}: move the ${p.broker} stop on ${p.positionSize} ${p.asset.replace(/-USDC?$/, '')} from ${price(p.invalidation, p)} UP to ${price(s.stop, p)}?\n\n`
      + `SignalDesk cancels the stop${p.broker === 'Kraken' ? '' : '/target bracket'} at ${p.broker}, waits for the coins to be released and places a new one at the new stop${p.broker === 'Kraken' ? '' : ' (same target)'}. `
      + 'If Coinbase refuses the new stop, the original stop is put back.')) return;
    busy.set(p.id, setTimeout(() => {
      if (!busy.has(p.id)) return;
      free(p.id);
      toast('Stop move timed out — check the position (and Coinbase) before retrying', false);
      SD.app.refresh();
    }, TIMEOUT_MS));
    SD.app.send({ type: 'RATCHET_STOP', id: p.id, step: k });
    SD.app.refresh();
  }

  function button(p, m, ctx) {
    const k = offer(p, bidOf(p, m));
    const pending = busy.has(p.id);
    if (!k && !pending) return null;
    const s = k ? p.ratchet[k] : null;
    const b = el('button', { type: 'button', className: 'btn ratchet-btn', disabled: pending || !(ctx && ctx.online) || !!p.marketExitPending,
      textContent: pending ? 'Moving the stop…' : `🛡️ ${s.label}`,
      title: s ? `Stop ${price(p.invalidation, p)} → ${price(s.stop, p)} (+${k === 'A' ? '1.0' : '1.5'}R reached at ${price(s.trigger, p)}). A stop only ever moves up.` : '' });
    b.onclick = () => request(p, k);
    return b;
  }

  // "🛡️ Stop locked at 0.005305 (Lock Profit (+0.5R))" once a step was taken.
  function status(p) {
    if (!p.ratchetStep || !p.ratchet) return null;
    return el('p', { className: 'ratchet-status', textContent: `🛡️ Stop locked at ${price(p.invalidation, p)} (${p.ratchet[p.ratchetStep].label}); original stop ${price(p.ratchet.initialStop, p)}` });
  }

  function received(r) {
    if (!r) return;
    free(r.id);
    if (!r.ok) toast(`Stop move failed: ${r.error}`, false);
    else if (r.alreadyClosed) toast(`Not moved: ${r.detail}`, true);
    else toast(`${r.label}: stop ${r.from} → ${r.stop}${r.venue !== 'ledger' ? ` (${r.broker || 'Coinbase'} ${r.venue === 'kraken' ? 'stop' : 'bracket'} re-placed)` : ''}.`, true);
    SD.app.refresh();
  }

  function reset() {
    if (!busy.size) return;
    for (const id of [...busy.keys()]) free(id);
    toast('Connection was lost during a stop move: check the position before retrying.', false);
  }

  SD.ratchet = { offer, button, status, received, reset, busy: (id) => busy.has(id), TIMEOUT_MS };
})();
