// [Close at Coinbase] (Phase 60): the manual exit for a LIVE Coinbase position, on the
// Open Position panel and the chart's trade pill. The server (coinbase-exit.js) cancels
// the position's stop/target bracket at Coinbase, waits until Coinbase confirms it and
// releases the coins, market-sells the exact quantity and books the real fill as
// MANUAL_CLOSE @ Coinbase. Nothing is sold if the bracket cannot be canceled; a refused
// sell puts the bracket back. One confirmation (real money), one close in flight each.
// Phase 67:
//   - a close with no answer after TIMEOUT_MS (35 s) frees its button ("Close request timed
//     out — check Coinbase or retry"); a reconnect frees every close in flight (the answer
//     went to the old connection)
//   - armor(p): the UNARMORED warning (no stop/target working at the broker) or the SELL
//     UNCONFIRMED notice, for the position card and the trade HUD; watch(positions) toasts
//     each position the moment it becomes UNARMORED
// Phase 69A: Kraken Pro positions close the same way (the server acts on the position's venue);
// every label names the position's broker.
// Exposes window.SignalDesk.liveClose: { can(p), button(p, m, ctx), received(result), reset(), armor(p), watch(list) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, signed } = SD.ui;

  const TIMEOUT_MS = 35000;
  const busy = new Set();
  const timers = new Map(); // position id -> its close's timeout
  const can = (p) => p.execution === 'LIVE' && ['Coinbase', 'Kraken', 'OKX'].includes(p.broker) && p.market === 'crypto'; // + Kraken (69A), OKX (69B)
  const B = (p) => (p && p.broker) || 'Coinbase';
  const coin = (p) => p.asset.replace(/-USDC?$/, '');

  function toast(text, ok) {
    const n = el('div', { className: `lc-toast${ok ? ' is-ok' : ' is-error'}`, role: 'status', textContent: text });
    document.body.append(n);
    setTimeout(() => n.remove(), ok ? 7000 : 12000);
  }

  function free(id) {
    busy.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  function request(p, m) {
    if (busy.has(p.id) || !SD.app.isOnline()) return;
    const live = m && m.price > 0 ? m.price : null;
    const q = p.exitQuote;
    const f = SD.netPnl.figures(p, m); // Phase 65: the same tick as the button
    const est = f && Number.isFinite(f.cashout) ? `~${money(f.cashout)} into your ${B(p)} cash: ${SD.netPnl.cashoutMath(p, m)}; net ${signed(f.net, money)} after all fees`
      : q && Number.isFinite(q.cashout) ? `~${money(q.cashout)} into your ${B(p)} cash: ${SD.netPnl.cashoutMath(p, m)}; net ${signed(q.net, money)} after all fees`
      : live ? `~${money(p.positionSize * live)} at ${price(live, p)} before fees (${signed((live - p.fillPrice) * p.positionSize, money)} vs entry)` : 'at the market price';
    const steps = p.adopted ? `It has no SignalDesk stop/target at ${B(p)}, so this is a plain market sell.`
      : `1) cancel its stop${B(p) !== 'Coinbase' ? '' : '/target bracket'} at ${B(p)}, 2) wait until ${B(p)} releases the coins, 3) market-sell them. If the bracket cannot be canceled nothing is sold; if the sell is refused the bracket is put back.`;
    if (!window.confirm(`SELL ${p.positionSize} ${coin(p)} at ${B(p)} now (LIVE, real money)?\n\n${steps}\n\nProceeds ${est}.`)) return;
    busy.add(p.id);
    timers.set(p.id, setTimeout(() => {
      if (!busy.has(p.id)) return;
      free(p.id);
      toast(`Close request timed out — check ${B(p)} or retry`, false);
      SD.app.refresh();
    }, TIMEOUT_MS));
    SD.app.send({ type: 'CLOSE_LIVE_COINBASE_POSITION', id: p.id });
    SD.app.refresh();
  }

  function received(r) {
    if (!r) return;
    free(r.id);
    const t = r.trade;
    const where = t ? B(t) : 'the broker';
    if (!r.ok) toast(`Close at ${where === 'the broker' ? 'the broker' : where} failed for ${String(r.id || '').split(':')[2] || r.id}: ${r.error}`, false);
    else if (r.pending) toast(`Sell sent to ${where} and still working: it is booked as soon as it fills.`, true);
    else if (r.alreadyClosed) toast(`Already closed at ${where}: ${r.detail}`, true);
    else if (t) toast(`Sold ${t.positionSize} ${coin(t)} at ${where} @ ${price(t.exitPrice, t)}: net ${signed(t.netPnl, money)} (fees ${money(t.fees)}). In the Journal as ${t.exitReason}.${r.detail ? ` ${r.detail}` : ''}`, !r.detail);
    SD.app.refresh();
  }

  // The socket (re)opened: an answer sent to the old connection is lost, so no button stays "Closing…".
  function reset() {
    if (!busy.size) return;
    for (const id of [...busy]) free(id);
    toast('Connection was lost during a Close at the broker: check the position (and the broker) before retrying.', false);
    SD.app.refresh();
  }

  // Phase 67: nothing protects this position at the broker, or a sell's outcome is unknown.
  function armor(p) {
    if (p.stopGap) { // Phase 68: Coinbase's stop-limit sells at most 5% under the trigger
      return el('div', { className: 'armor-warn', role: 'alert' }, [el('strong', { textContent: 'STOP_GAP_UNFILLED: ' }),
        `Live price fell > 5% below stop threshold without fill; check Coinbase order book (bid ${price(p.stopGap.bid, p)}, stop ${price(p.stopGap.stop, p)}).`]);
    }
    if (p.marketExitPending) {
      return el('div', { className: 'armor-warn', role: 'alert' }, [el('strong', { textContent: 'SELL UNCONFIRMED: ' }),
        `a market sell was sent to ${p.broker} without a clear answer. SignalDesk checks ${p.broker} every pass and books the sale or re-places the stop/target. Check ${p.broker}.`]);
    }
    if (p.bracketStatus !== 'UNARMORED') return null;
    return el('div', { className: 'armor-warn', role: 'alert' }, [el('strong', { textContent: `UNARMORED: Stop/target bracket is not active on ${p.broker}` }),
      `${p.bracketDetail ? ` (${p.bracketDetail})` : ''}. Set a stop there or close the position.`]);
  }

  let flagged = null; // ids UNARMORED on the last update (null: none seen yet)
  function watch(positions) {
    const now = new Set((positions || []).flatMap((p) => [p.bracketStatus === 'UNARMORED' ? `u:${p.id}` : null, p.stopGap ? `g:${p.id}` : null]).filter(Boolean));
    for (const p of positions || []) {
      if (now.has(`u:${p.id}`) && !(flagged && flagged.has(`u:${p.id}`))) toast(`${p.asset}: UNARMORED: Stop/target bracket is not active on ${p.broker}. Set a stop there or close the position.`, false);
      if (now.has(`g:${p.id}`) && !(flagged && flagged.has(`g:${p.id}`))) toast(`${p.asset}: STOP_GAP_UNFILLED: Live price fell > 5% below stop threshold without fill; check Coinbase order book.`, false);
    }
    flagged = now;
  }

  // Phase 61: the button carries what the sale deposits (cashout: size x the best bid (Phase 63)
  // less the exact taker fee, from the server's exit quote) and the round-trip net P&L.
  // Each amount is one unbreakable piece: the sign never wraps away from its figure.
  const label = (p, m) => {
    const q = p.exitQuote;
    const f = SD.netPnl.figures(p, m); // Phase 65: re-marked on the client's current tick (same as the hero)
    const cash = f && Number.isFinite(f.cashout) ? f.cashout : q && q.cashout;
    const net = f && Number.isFinite(f.net) ? f.net : q && q.net;
    if (!Number.isFinite(cash) || !Number.isFinite(net)) return [`Close at ${B(p)}`];
    const nw = (t) => el('span', { className: 'no-wrap', textContent: t });
    return [`Close at ${B(p)} (`, nw(`${money(cash)} cashout`), ' · ', nw(`${signed(net, money)} net`), ')'];
  };

  function button(p, m, ctx) {
    const closing = busy.has(p.id);
    const math = SD.netPnl.cashoutMath(p, m); // Phase 63: the cashout arithmetic (best bid − the exact Coinbase fee) on hover
    const b = el('button', { type: 'button', className: 'btn hud-exit is-armed is-live-close', disabled: closing || !ctx.online || !!p.marketExitPending,
      title: `${math ? `${math}
` : ''}${p.adopted ? `Market-sell this holding at ${B(p)} (real money)` : `Cancel its stop/target at ${B(p)}, then market-sell it (real money)`}` },
    closing ? [`Closing at ${B(p)}…`] : p.marketExitPending ? [`Sell being confirmed at ${B(p)}…`] : label(p, m));
    b.onclick = () => request(p, m);
    return b;
  }

  SD.liveClose = { can, button, received, reset, armor, watch, toast, busy: (id) => busy.has(id), TIMEOUT_MS };
})();
